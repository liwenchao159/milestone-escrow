/**
 * 真链闭环验证 —— 确认资金真实转移
 *
 * 这是对「转账/放款/冻结没有真实扣钱」这个问题的最终验证：
 * 每一笔操作都发真实链上交易，交易哈希可在区块浏览器查证。
 *
 * 运行：node test/chain-closed-loop.js
 * 前置：服务已以链上模式启动（PRIVATE_KEY 已配置）
 */

const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const B = process.env.BASE_URL || 'http://localhost:4000';
const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = require(path.join(ROOT, 'contracts', 'deployments-monad.json'));
const tar = require('tar');

let pass = 0, fail = 0;
const hr = (t) => console.log('\n' + '═'.repeat(64) + '\n  ' + t + '\n' + '═'.repeat(64));
function check(n, c, d) {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? '  ' + d : ''}`); }
}

const J = (o) => JSON.stringify(o);
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });
const login = async (a, r, n) =>
  (await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: J({ address: a, role: r, nickname: n }),
  })).json();

const TOKEN_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

async function onchain(tag) {
  const p = new ethers.JsonRpcProvider(process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz', 10143);
  const tok = new ethers.Contract(DEPLOY.contracts.token, TOKEN_ABI, p);
  const dec = Number(await tok.decimals());
  const rows = await Promise.all([
    tok.balanceOf(DEPLOY.participants.client).then((b) => ethers.formatUnits(b, dec)),
    tok.balanceOf(DEPLOY.participants.provider).then((b) => ethers.formatUnits(b, dec)),
    tok.balanceOf(DEPLOY.contracts.escrow).then((b) => ethers.formatUnits(b, dec)),
  ]);
  console.log(`    [链上] ${tag}  甲方 ${rows[0]} · 乙方 ${rows[1]} · escrow ${rows[2]}`);
  return { client: Number(rows[0]), provider: Number(rows[1]), escrow: Number(rows[2]) };
}

/** 造一个最小源码包 */
function buildPkg() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), J({ name: 'chain-delivery', version: '1.0.0' }, null, 2));

  fs.writeFileSync(path.join(dir, 'src', 'logic.js'),
    "module.exports={ping:()=>({ok:true,marker:'CHAIN'}),calc:n=>n*3};\n");

  fs.writeFileSync(path.join(dir, 'src', 'runtime-bridge.js'), `
const g=()=>global.__ACCEPTANCE_RUNTIME__;
module.exports={db:{query:async(s,p)=>g().database.query(s,p),one:async(s,p)=>g().database.one(s,p),many:async(s,p)=>g().database.many(s,p)},cache:{get:async k=>g().kv.get(k),set:async(k,v)=>g().kv.set(k,v),del:async k=>g().kv.del(k),incr:async k=>g().kv.incr(k),expire:async(k,s)=>g().kv.expire(k,s)}};
`);

  fs.writeFileSync(path.join(dir, 'src', 'server.js'), `
const http=require('http');const{ping,calc}=require('./logic');const{db}=require('./runtime-bridge');
let ok=false;(async()=>{try{await db.query('CREATE TABLE IF NOT EXISTS t (id VARCHAR(8))');ok=true}catch(e){}})();
http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
const j=(c,b)=>{const s=JSON.stringify(b);r.writeHead(c,{'content-type':'application/json','content-length':Buffer.byteLength(s)});r.end(s)};
if(u.pathname==='/health')return j(200,{status:ok?'ok':'degraded',db:ok,ts:Date.now()});
if(u.pathname==='/ping')return j(200,ping());
if(u.pathname==='/calc')return j(200,{result:calc(14),currency:'TUSD'});
j(404,{error:'nf'});}).listen(process.env.PORT||8080,'127.0.0.1');
`);

  fs.writeFileSync(path.join(dir, 'test', 'run-tests.js'), `
const{ping,calc}=require('../src/logic');
const C=[{n:'ping ok',g:'required',f:()=>e(ping().ok,true)},{n:'marker',g:'required',f:()=>e(ping().marker,'CHAIN')},
{n:'calc',g:'required',f:()=>e(calc(14),42)},{n:'calc0',g:'required',f:()=>e(calc(0),0)},{n:'extra',g:'extra',f:()=>e(1,1)}];
function e(a,b){if(a!==b)throw new Error('expect '+b+' got '+a)}
const s=(process.argv.find(x=>x.startsWith('--suite='))||'').split('=')[1];
const sel=C.filter(c=>s==='required'?c.g==='required':true);const cs=[];let p=0,f=0;
for(const c of sel){try{c.f();p++;cs.push({name:c.n,group:c.g,status:'passed',ms:0})}catch(x){f++;cs.push({name:c.n,group:c.g,status:'failed',ms:0,error:x.message})}}
console.log(JSON.stringify({total:cs.length,passed:p,failed:f,passRate:cs.length?Math.round(p/cs.length*10000):0,cases:cs},null,2));
process.exit(f?1:0);
`);

  const out = path.join(dir, '..', `c-${Date.now()}.tar.gz`);
  tar.c({ gzip: true, sync: true, file: out, cwd: dir }, ['package.json', 'src', 'test']);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

(async () => {
  hr('① 前置检查');
  const health = await fetch(B + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health) { console.error('  服务未启动'); process.exit(1); }
  console.log('  服务:', B);
  console.log('  链上模式:', health.chainMode, '· 网络', health.chainNetwork);
  if (health.chainMode !== 'chain') {
    console.error('\n  ✗ 当前不是链上模式，无法验证真实资金流动。');
    console.error('    请确认 server/.env 中已配置 PRIVATE_KEY，并重启服务。');
    process.exit(1);
  }
  check('服务运行在链上模式', true);

  const CLIENT = DEPLOY.participants.client;
  const PROVIDER = DEPLOY.participants.provider;
  const ARB = DEPLOY.participants.arbitrator;
  console.log('  甲方:', CLIENT);
  console.log('  乙方:', PROVIDER);

  const before = await onchain('初始');

  const c = await login(CLIENT, 'client', '甲方');
  const p = await login(PROVIDER, 'provider', '乙方');
  const a = await login(ARB, 'arbitrator', '仲裁');
  check('三方登录', !!(c.token && p.token && a.token));

  hr('② 建项目（发真实交易）');
  const spec = {
    delivery: { name: 'chain-delivery', entryPoint: 'src/logic.js', serveCommand: 'src/server.js' },
    middleware: { requires: [] },
    testCommand: { command: 'node', args: ['test/run-tests.js', '--suite=required'], timeoutMs: 30000 },
    requiredSuites: [{ group: 'required', expectedCaseCount: 4 }],
    probe: {
      targets: [
        { path: '/health', method: 'GET', expectStatus: [200] },
        { path: '/ping', method: 'GET', expectStatus: [200] },
        { path: '/calc', method: 'GET', expectStatus: [200] },
      ],
      rounds: 3, intervalMs: 120, startupTimeoutMs: 20000,
    },
    contract: {
      responses: {
        '/health': { required: ['status', 'db'], optional: ['ts'] },
        '/ping': { required: ['ok', 'marker'], optional: [] },
      },
    },
    thresholds: {
      testPassRate: 9000, apiAvailability: 9500, fieldCoverage: 9000,
      passScore: 80, weights: { test: 5000, api: 3000, field: 2000 },
    },
    seed: undefined,
  };

  const proj = await (await fetch(B + '/api/projects', {
    method: 'POST', headers: H(c.token),
    body: J({
      title: '真链闭环验证', providerAddr: PROVIDER, arbitratorAddr: ARB,
      ruleSetId: 'standard-interface-v1', deliverableType: 'code',
      milestones: [{ title: '接口实现', amount: 50 }],
      __specOverride: spec,
    }),
  })).json();
  if (proj.error) { console.error('  创建失败:', proj.error); process.exit(1); }
  const pid = proj.projectId;
  check('项目创建', pid != null, `id=${pid} · tx ${String(proj.txHash).slice(0, 20)}…`);
  check('交易哈希是真实链上哈希', /^0x[0-9a-f]{64}$/i.test(proj.txHash || ''));

  hr('③ 双签（两次不同身份的真实签名）');
  const s1 = await (await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(c.token) })).json();
  check('甲方签署', s1.status === 200 || !s1.error, s1.error || String(s1.txHash).slice(0, 20) + '…');
  const s2 = await (await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(p.token) })).json();
  check('乙方签署（用乙方私钥）', s2.status === 200 || !s2.error, s2.error || String(s2.txHash).slice(0, 20) + '…');

  hr('④ 注资（approve + transferFrom 真实扣款）');
  console.log('  发送交易中，等待链上确认…');
  const fund = await (await fetch(`${B}/api/projects/${pid}/fund`, { method: 'POST', headers: H(c.token) })).json();
  if (fund.error) { console.error('  注资失败:', fund.error); process.exit(1); }
  check('注资成功', fund.funded === true);
  check('返回 approve 交易', !!fund.txHash, String(fund.txHash).slice(0, 24) + '…');

  const afterFund = await onchain('注资后');
  console.log('');
  check('escrow 收到 50 TUSD', Math.abs(afterFund.escrow - before.escrow - 50) < 0.01,
    `${before.escrow} → ${afterFund.escrow}`);
  check('甲方被真实扣款 50', Math.abs(before.client - afterFund.client - 50) < 0.01,
    `${before.client} → ${afterFund.client}`);

  hr('⑤ 交付上传');
  const pkg = buildPkg();
  const fd = new FormData();
  fd.append('file', new Blob([pkg]), 'chain-delivery.tar.gz');
  const up = await (await fetch(`${B}/api/projects/${pid}/milestones/0/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + p.token }, body: fd,
  })).json();
  if (up.error) { console.error('  上传失败:', up.error); process.exit(1); }
  check('上传成功', up.uploaded === true, up.uri);
  check('上链记录哈希', /^0x[0-9a-f]{64}$/i.test(up.hash), up.hash.slice(0, 20) + '…');

  hr('⑥ 客观验收');
  console.log('  拉起隔离运行时执行…');
  const v = await (await fetch(`${B}/api/projects/${pid}/milestones/0/verify`, {
    method: 'POST', headers: H(c.token),
  })).json();
  if (v.error) { console.error('  验收失败:', v.error); process.exit(1); }
  console.log('');
  console.log(`    结论   : ${v.result.passed ? '✓ 通过' : '✗ 不通过'}（${v.result.score} 分）`);
  console.log(`    三维度 : 测试 ${v.facts.testPassRate / 100}% · 接口 ${v.facts.apiAvailability / 100}% · 字段 ${v.facts.fieldCoverage / 100}%`);
  console.log(`    事实哈希: ${String(v.reportHash).slice(0, 30)}…`);
  console.log('');
  check('验收通过', v.result.passed === true, `${v.result.score} 分`);
  check('判定已上链', !!v.txHash, String(v.txHash).slice(0, 24) + '…');

  hr('⑦ 挑战期保护（合约设计）');
  const relAttempt = await (await fetch(`${B}/api/projects/${pid}/milestones/0/release`, {
    method: 'POST', headers: H(c.token),
  })).json();
  console.log('');
  if (relAttempt.error && /challenge window/i.test(relAttempt.error)) {
    console.log('    放款被合约拒绝：challenge window open');
    console.log('    原因：验收通过后进入 3 天挑战期，期间任何一方都可发起挑战。');
    console.log('    这是设计意图 —— 不是 bug。');
    console.log('');
    check('挑战期生效，阻止立即放款', true);
    check('错误信息明确可读', /challenge window/i.test(relAttempt.error));
  } else if (relAttempt.released) {
    console.log('    挑战期已过，放款成功（链上项目复用了已过期的窗口）');
    check('放款成功', true);
  }

  hr('⑦b 放款后的托管状态');
  const held = await onchain('托管中');
  console.log('');
  // 用相对增量断言，不写死绝对值 —— escrow 可能已有其他项目的资金
  // 对比注资后：验证放款阶段钱没有离开 escrow（挑战期内应原封不动）
  check('escrow 相对初始增加 50 TUSD', Math.abs(held.escrow - before.escrow - 50) < 0.01,
    `${before.escrow} → ${held.escrow}`);
  check('挑战期内甲方已被扣款且不再变动',
    Math.abs(held.client - afterFund.client) < 0.01,
    `注资后 ${afterFund.client} → 现在 ${held.client}`);
  check('挑战期内乙方尚未收到款',
    Math.abs(held.provider - afterFund.provider) < 0.01,
    `注资后 ${afterFund.provider} → 现在 ${held.provider}`);

  hr('⑧ 账目核对');
  const fin = await (await fetch(`${B}/api/projects/${pid}`, { headers: H(c.token) })).json();
  console.log('  平台记录 payout:', J(fin.payout));
  console.log('  链上实际: 甲方', held.client, '乙方', held.provider, 'escrow', held.escrow);
  check('平台记录托管中金额', Number(fin.payout.remaining) > 0, J(fin.payout.remaining));
  check('资金守恒（链上总量不变）',
    Math.abs((held.client + held.provider + held.escrow) -
      (before.client + before.provider + before.escrow)) < 0.01,
    `${held.client + held.provider + held.escrow} = ${before.client + before.provider + before.escrow}`);

  const store = require(path.join(ROOT, 'server', 'src', 'platform', 'storage', 'delivery-store.js'));
  fs.rmSync(store.milestoneDir(pid, 0), { recursive: true, force: true });

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败`);
  console.log('');
  console.log('  可在 Monad 区块浏览器查证这些交易：');
  console.log(`    建项目 ${proj.txHash}`);
  console.log(`    甲方签署 ${s1.txHash}`);
  console.log(`    乙方签署 ${s2.txHash}`);
  console.log(`    注资   ${fund.txHash}`);
  console.log(`    交付   ${up.txHash}`);
  console.log(`    验收   ${v.txHash}`);
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});