/**
 * 上传 → 验收 闭环验证
 *
 * 回答一个关键问题：验收平台跑的到底是「上传的源码」还是「平台内置样例」？
 *
 * 本脚本故意上传一份**带唯一标记**的源码，
 * 若验收结果中出现该标记，则证明链路真正闭环。
 *
 * 用法：node test/upload-closed-loop.js   （需后端已启动，可用 PORT 指定）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar');

const B = process.env.BASE_URL || 'http://localhost:4011';

let pass = 0, fail = 0;
const hr = (t) => console.log('\n' + '═'.repeat(62) + '\n  ' + t + '\n' + '═'.repeat(62));
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const J = (o) => JSON.stringify(o);
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });

async function login(addr, role, name) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ address: addr, role, nickname: name }) });
  return r.json();
}

/** 打一个带唯一标记的源码包 */
async function buildMarkedPackage(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), J({
    name: 'uploaded-delivery', version: '1.0.0',
    scripts: { start: 'node src/server.js', test: 'node test/run-tests.js' },
  }, null, 2));

  // 纯逻辑：把标记编进返回值
  fs.writeFileSync(path.join(dir, 'src', 'logic.js'),
    `const MARKER = ${J(marker)};\n` +
    'function ping() { return { ok: true, marker: MARKER }; }\n' +
    'function double(n) { return n * 2; }\n' +
    'module.exports = { MARKER, ping, double };\n');

  fs.writeFileSync(path.join(dir, 'src', 'runtime-bridge.js'),
    "function getRuntime() {\n" +
    "  const rt = global.__ACCEPTANCE_RUNTIME__;\n" +
    "  if (!rt) throw new Error('运行时未注入');\n" +
    "  return rt;\n" +
    "}\n" +
    "module.exports = {\n" +
    "  db: {\n" +
    "    query: async (s, p) => getRuntime().database.query(s, p),\n" +
    "    one: async (s, p) => getRuntime().database.one(s, p),\n" +
    "    many: async (s, p) => getRuntime().database.many(s, p),\n" +
    "  },\n" +
    "  cache: {\n" +
    "    get: async (k) => getRuntime().kv.get(k),\n" +
    "    set: async (k, v) => getRuntime().kv.set(k, v),\n" +
    "    del: async (k) => getRuntime().kv.del(k),\n" +
    "    incr: async (k) => getRuntime().kv.incr(k),\n" +
    "    expire: async (k, s) => getRuntime().kv.expire(k, s),\n" +
    "  },\n" +
    "  getRuntime,\n" +
    "};\n");

  fs.writeFileSync(path.join(dir, 'src', 'server.js'), `
const http = require('http');
const { ping, double } = require('./logic');
const { db } = require('./runtime-bridge');
let ready = false;
(async () => {
  try {
    await db.query('CREATE TABLE IF NOT EXISTS items (id VARCHAR(32) PRIMARY KEY, n INT)');
    ready = true;
  } catch (e) { console.error('[init]', e.message); }
})();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (c, b) => { const s = JSON.stringify(b); res.writeHead(c, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
  if (u.pathname === '/health') return j(200, { status: ready ? 'ok' : 'degraded', db: ready, ts: Date.now() });
  if (u.pathname === '/ping') return j(200, ping());
  if (u.pathname === '/calc') return j(200, { result: double(21), currency: 'TUSD' });
  j(404, { error: 'not found' });
});
server.listen(process.env.PORT || 8080, '127.0.0.1', () => console.log('listening', process.env.PORT));
`);

  // 测试报告 —— 必须机器可读
  fs.writeFileSync(path.join(dir, 'test', 'run-tests.js'), `
const { ping, double, MARKER } = require('../src/logic');
const CASES = [
  { name: 'ping 返回 ok', group: 'required', fn: () => eq(ping().ok, true) },
  { name: 'ping 带标记', group: 'required', fn: () => eq(ping().marker, MARKER) },
  { name: 'double 正确', group: 'required', fn: () => eq(double(21), 42) },
  { name: 'double 负数', group: 'required', fn: () => eq(double(-1), -2) },
  { name: '额外用例', group: 'extra', fn: () => eq(typeof MARKER, 'string') },
];
function eq(a, b) { if (a !== b) throw new Error('期望 ' + b + '，实际 ' + a); }
const suite = (process.argv.find(x => x.startsWith('--suite=')) || '').split('=')[1];
const sel = CASES.filter(c => suite === 'required' ? c.group === 'required' : true);
const cases = []; let p = 0, f = 0;
for (const c of sel) {
  try { c.fn(); p++; cases.push({ name: c.name, group: c.group, status: 'passed', ms: 0 }); }
  catch (e) { f++; cases.push({ name: c.name, group: c.group, status: 'failed', ms: 0, error: e.message }); }
}
console.log(JSON.stringify({ total: cases.length, passed: p, failed: f,
  passRate: cases.length ? Math.round(p / cases.length * 10000) : 0, cases }, null, 2));
process.exit(f ? 1 : 0);
`);

  const out = path.join(dir, '..', `pkg-${Date.now()}.tar.gz`);
  await tar.c({ gzip: true, file: out, cwd: dir }, ['package.json', 'src', 'test']);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

(async () => {
  const MARKER = 'UPLOADED-' + Date.now().toString(36).toUpperCase();
  console.log('  唯一标记:', MARKER);

  hr('① 准备环境');
  const health = await fetch(B + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error('  后端未启动，请先运行: node src/platform/app.js');
    process.exit(1);
  }
  console.log('  后端:', B, '· 链上模式', health.chainMode);

  const c = await login('0x1111111111111111111111111111111111111111', 'client', '甲方');
  const p = await login('0x2222222222222222222222222222222222222222', 'provider', '乙方');
  const a = await login('0x3333333333333333333333333333333333333333', 'arbitrator', '仲裁');
  check('三方登录成功', !!(c.token && p.token && a.token));

  hr('② 建项目 · 双签 · 注资');
  // 规格要与上传包的实际接口对齐 ——
  // 平台只测规格清单内的东西，规格与交付不匹配时会如实判不通过（这正是期望行为）
  const spec = {
    acceptanceSpecVersion: '2.0.0',
    delivery: { name: 'uploaded-delivery', entryPoint: 'src/logic.js', serveCommand: 'src/server.js' },
    middleware: { requires: [] },
    testCommand: { command: 'node', args: ['test/run-tests.js', '--suite=required'], timeoutMs: 30000 },
    requiredSuites: [{ group: 'required', expectedCaseCount: 4 }],
    probe: {
      targets: [
        { path: '/health', method: 'GET', expectStatus: [200] },
        { path: '/ping', method: 'GET', expectStatus: [200] },
      ],
      rounds: 3, intervalMs: 120, startupTimeoutMs: 15000,
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
  };

  const proj = await (await fetch(B + '/api/projects', {
    method: 'POST', headers: H(c.token),
    body: J({
      title: '上传闭环验证', providerAddr: p.address, arbitratorAddr: a.address,
      ruleSetId: 'standard-interface-v1', deliverableType: 'code',
      milestones: [{ title: '接口实现', amount: 100 }],
      __specOverride: spec,
    }),
  })).json();
  if (proj.error) { console.error('  创建失败:', proj.error); process.exit(1); }
  const pid = proj.projectId;
  check('项目创建', pid != null, `id=${pid} · 规格 ${proj.specHash.slice(0, 16)}…`);

  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(c.token) });
  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(p.token) });
  const fund = await (await fetch(`${B}/api/projects/${pid}/fund`, { method: 'POST', headers: H(c.token) })).json();
  check('双签 + 注资', fund.funded, `${fund.total} TUSD 托管中`);

  hr('③ 上传源码包');
  const pkg = await buildMarkedPackage(MARKER);
  console.log(`  打包大小: ${(pkg.length / 1024).toFixed(1)} KB（含标记 ${MARKER}）`);

  const fd = new FormData();
  fd.append('file', new Blob([pkg]), 'uploaded-delivery.tar.gz');
  fd.append('note', '上传闭环验证包');

  const up = await (await fetch(`${B}/api/projects/${pid}/milestones/0/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + p.token }, body: fd,
  })).json();
  if (up.error) { console.error('  上传失败:', up.error); process.exit(1); }

  check('上传成功', up.uploaded === true);
  check('返回真实 SHA-256', /^0x[0-9a-f]{64}$/.test(up.hash), up.hash.slice(0, 26) + '…');
  check('本地指针不再是占位符', up.uri.startsWith('local://'), up.uri);
  check('解包出文件', up.fileCount >= 3, `${up.fileCount} 个文件`);
  check('记录链上交易', !!up.txHash, up.txHash);

  hr('④ 磁盘落盘验证');
  const store = require('../src/platform/storage/delivery-store.js');
  const srcDir = store.sourceDir(pid, 0);
  check('源码目录存在', fs.existsSync(srcDir), srcDir);
  const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).sort() : [];
  check('包含预期文件', files.includes('src') && files.includes('test'), files.join(', '));

  // 标记确实在磁盘上
  let markerFound = false;
  if (files.includes('src')) {
    const logic = fs.readFileSync(path.join(srcDir, 'src', 'logic.js'), 'utf8');
    markerFound = logic.includes(MARKER);
  }
  check('上传内容含唯一标记', markerFound, MARKER);

  const integrity = store.verifyIntegrity(pid, 0);
  check('完整性校验通过', integrity.ok, integrity.ok ? integrity.hash.slice(0, 20) + '…' : integrity.reason);

  hr('⑤ 篡改检测（改磁盘文件应拒绝验收）');
  {
    const archive = path.join(store.milestoneDir(pid, 0), 'archive.bin');
    const backup = fs.readFileSync(archive);
    fs.appendFileSync(archive, 'TAMPERED');

    const vT = await (await fetch(`${B}/api/projects/${pid}/milestones/0/verify`, {
      method: 'POST', headers: H(c.token),
    })).json();
    check('篡改后拒绝验收', vT.error && /完整性/.test(vT.error), vT.error || '未被拒绝');
    check('返回具体原因', !!vT.reason, vT.reason);
    check('返回期望哈希', !!vT.expected, vT.expected?.slice(0, 20) + '…');
    check('返回实际哈希', !!vT.actual, vT.actual?.slice(0, 20) + '…');

    const st = (await (await fetch(`${B}/api/projects/${pid}`, { headers: H(c.token) })).json()).milestones[0];
    check('篡改时状态未推进', st.status === 'submitted', `仍为 ${st.status}`);

    fs.writeFileSync(archive, backup);
    console.log('  （已恢复文件，继续正式验收）');
  }

  hr('⑥ 执行验收（关键：跑的是上传的代码）');
  console.log('  正在拉起隔离运行时并执行…');
  const v = await (await fetch(`${B}/api/projects/${pid}/milestones/0/verify`, {
    method: 'POST', headers: H(c.token),
  })).json();
  if (v.error) { console.error('  验收失败:', v.error); process.exit(1); }

  console.log('');
  console.log(`    结论 : ${v.result.passed ? '✓ 验收通过' : '✗ 验收不通过'}（${v.result.score} 分）`);
  console.log(`    三维度 : 测试 ${v.facts.testPassRate / 100}% · 接口 ${v.facts.apiAvailability / 100}% · 字段 ${v.facts.fieldCoverage / 100}%`);
  console.log('');

  check('验收代码来源为 uploaded', v.detail.deliveryOrigin === 'uploaded', v.detail.deliveryOrigin);
  check('验收目录 = 上传解包目录',
    v.detail.deliverySource.dir.replace(/\\/g, '/') === srcDir.replace(/\\/g, '/'),
    v.detail.deliverySource.dir);
  check('完整性状态为 verified', v.detail.deliverySource.integrity === 'verified');
  check('记录的事实哈希与上传哈希一致',
    v.detail.deliverySource.hash === up.hash, v.detail.deliverySource.hash?.slice(0, 24) + '…');

  hr('⑦ 结算（闭环终点）');
  const rel = await (await fetch(`${B}/api/projects/${pid}/milestones/0/release`, {
    method: 'POST', headers: H(c.token),
  })).json();
  check('放款成功', rel.released === true, rel.error || `${rel.amount} TUSD → ${rel.to?.slice(0, 12)}…`);
  const fin = await (await fetch(`${B}/api/projects/${pid}`, { headers: H(c.token) })).json();
  check('结算流水已生成', fin.settlements.length >= 1, `${fin.settlements.length} 笔`);
  const ONE = 10n ** 18n;
  check('资金守恒',
    BigInt(fin.payout.released) + BigInt(fin.payout.refunded) + BigInt(fin.payout.remaining) === 100n * ONE,
    `${Number(fin.payout.released) / 1e18} + ${Number(fin.payout.refunded) / 1e18} + ${Number(fin.payout.remaining) / 1e18} = 100 TUSD`);

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});