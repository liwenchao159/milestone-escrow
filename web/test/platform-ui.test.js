/**
 * 平台 UI 端到端测试（jsdom + 真实后端）
 *
 * 验证 9 个页面结构与完整闭环：
 *   登录 → 工作台 → 规则库 → 创建项目 → 双签注资 → 交付 → 验收 → 结算 → 争议 → 信任
 *
 * 运行（在 web 目录下）：node test/platform-ui.test.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const { Agent, setGlobalDispatcher } = require('undici');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 4111;
const BASE = `http://localhost:${PORT}`;

/**
 * 统一 HTTP 入口 —— 所有请求共享一个连接池。
 * 若每个 jsdom 实例各自 fetch，会创建多个池并很快耗尽 socket。
 */
const httpAgent = new Agent({ connections: 8, keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000 });
setGlobalDispatcher(httpAgent);

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hr = (t) => console.log('\n' + '═'.repeat(64) + '\n  ' + t + '\n' + '═'.repeat(64));

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** 加载一个页面实例（模拟一个浏览器标签页） */
async function bootPage() {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'app.js'), 'utf8');
  // 加破坏缓存参数，避免读到磁盘上的旧版 app.js
  const bust = '?t=' + fs.statSync(path.join(ROOT, 'web', 'assets', 'app.js')).mtimeMs;
  const dom = new JSDOM(html.replace('assets/app.js', 'assets/app.js' + bust), {
    runScripts: 'dangerously',
    url: `http://localhost:${PORT}/`,
    pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollTo = () => {};
      // 用 node 的 fetch 代理到测试端口。注意保存原始 fetch，避免递归。
      const nf = globalThis.fetch;
      w.fetch = (u, o) => nf(String(u).startsWith('http') ? String(u) : BASE + u, o);
      w.localStorage.clear();
    },
  });
  try {
    dom.window.eval(js);
  } catch (e) {
    console.error('[bootPage] app.js 执行失败:', e.message);
    console.error(e.stack?.split('\n').slice(1,5).join('\n'));
    throw e;
  }
  await sleep(700);
  if (!dom || !dom.window) { console.error('[bootPage] dom 为空'); process.exit(1); }
  return dom;
}

const $ = (d, s) => d.window.document.querySelector(s);
const $$ = (d, s) => [...d.window.document.querySelectorAll(s)];
const txt = (d, s) => ($(d, s)?.textContent ?? '').trim();

/** 轮询等待条件成立（处理异步渲染时序） */
async function waitFor(fn, ms = 8000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* 继续等 */ }
    await sleep(step);
  }
  return false;
}

/** 以指定角色登录，返回页面实例 */
/**
 * 构造一个最小可运行的源码包（tar.gz），供 UI 测试走真实上传流程。
 *
 * 包里带的接口 (/health /ping /calc) 必须与项目规格中的 probe.targets 对齐，
 * 否则平台会如实判不通过 —— 这本身就是「规格与交付必须一致」的演示。
 */
function buildSourceArchive() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // tar 装在 server/ 下（平台依赖），web 测试需跨目录引用。
  // 注意：必须在 path 声明之后 require，否则触发 TDZ。
  const tar = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'tar'));

  const FILES = {
    'package.json': JSON.stringify({ name: 'ui-test-delivery', version: '1.0.0' }, null, 2),
    'src/logic.js':
      "module.exports={ping:()=>({ok:true,marker:'UI-TEST'}),double:n=>n*2};\n",
    'src/runtime-bridge.js':
      "const g=()=>global.__ACCEPTANCE_RUNTIME__;\n" +
      "module.exports={db:{query:async(s,p)=>g().database.query(s,p),one:async(s,p)=>g().database.one(s,p),many:async(s,p)=>g().database.many(s,p)},cache:{get:async k=>g().kv.get(k),set:async(k,v)=>g().kv.set(k,v),del:async k=>g().kv.del(k),incr:async k=>g().kv.incr(k),expire:async(k,s)=>g().kv.expire(k,s)}};\n",
    'src/server.js':
      "const http=require('http');const{ping,double}=require('./logic');const{db}=require('./runtime-bridge');\n" +
      "let ok=false;(async()=>{try{await db.query('CREATE TABLE IF NOT EXISTS t (id VARCHAR(8))');ok=true}catch(e){}})();\n" +
      "http.createServer((q,r)=>{const u=new URL(q.url,'http://x');\n" +
      "const j=(c,b)=>{const s=JSON.stringify(b);r.writeHead(c,{'content-type':'application/json','content-length':Buffer.byteLength(s)});r.end(s)};\n" +
      "if(u.pathname==='/health')return j(200,{status:ok?'ok':'degraded',db:ok,ts:Date.now()});\n" +
      "if(u.pathname==='/ping')return j(200,ping());\n" +
      "if(u.pathname==='/calc')return j(200,{result:double(21),currency:'TUSD'});\n" +
      "j(404,{error:'nf'});}).listen(process.env.PORT||8080,'127.0.0.1');\n",
    'test/run-tests.js':
      "const{ping,double}=require('../src/logic');\n" +
      "const C=[{n:'ping ok',g:'required',f:()=>e(ping().ok,true)}," +
      "{n:'marker',g:'required',f:()=>e(ping().marker,'UI-TEST')}," +
      "{n:'double',g:'required',f:()=>e(double(21),42)}," +
      "{n:'double neg',g:'required',f:()=>e(double(-1),-2)}," +
      "{n:'extra',g:'extra',f:()=>e(1,1)}];\n" +
      "function e(a,b){if(a!==b)throw new Error('expect '+b+' got '+a)}\n" +
      "const s=(process.argv.find(x=>x.startsWith('--suite='))||'').split('=')[1];\n" +
      "const sel=C.filter(c=>s==='required'?c.g==='required':true);const cs=[];let p=0,f=0;\n" +
      "for(const c of sel){try{c.f();p++;cs.push({name:c.n,group:c.g,status:'passed',ms:0})}" +
      "catch(e){f++;cs.push({name:c.n,group:c.g,status:'failed',ms:0,error:e.message})}}\n" +
      "console.log(JSON.stringify({total:cs.length,passed:p,failed:f," +
      "passRate:cs.length?Math.round(p/cs.length*10000):0,cases:cs},null,2));\n" +
      "process.exit(f?1:0);\n",
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-archive-'));
  for (const [name, content] of Object.entries(FILES)) {
    const fp = path.join(dir, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
  }
  const out = path.join(dir, '..', `a-${Date.now()}.tar.gz`);
  tar.c({ gzip: true, sync: true, file: out, cwd: dir }, Object.keys(FILES));
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

async function loginAs(addr, role, name) {
  const d = await bootPage();
  $$(d, '.role').forEach((x) => x.classList.toggle('sel', x.dataset.role === role));
  $(d, '#loginAddr').value = addr;
  $(d, '#loginName').value = name;
  $(d, '#loginBtn').click();
  await sleep(1400);
  return d;
}

async function main() {
  hr('启动后端');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'platform', 'app.js')], {
    cwd: path.join(ROOT, 'server'),
    /**
     * 强制 mock 模式：UI 测试跑的是界面流程，不能发真实链上交易。
     * 把 PRIVATE_KEY 清空即可让 ChainClient 走 mock 分支
     *（chain.js 的判定是 rpcUrl 与 privateKey 都要有才连真链）。
     */
    env: {
      ...process.env,
      PORT: String(PORT),
      PRIVATE_KEY: '',
      PRIVATE_KEY_2: '',
      MONAD_TESTNET_RPC: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  await sleep(2600);

  const health = await api('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error('后端启动失败:\n' + log.slice(-800));
    server.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`  链上模式 ${health.body.chainMode} · 规则 ${health.body.templates} 个`);

  hr('① 登录页');
  const page = await bootPage();

  // 演示地址从登录页读取，不硬编码 —— 随环境变化
  // （mock 用假地址，链上模式用链上真实地址）
  const demoAddrs = $$(page, '.demo-a').map((b) => b.dataset.fill);
  const [CLIENT, PROVIDER, ARB] = [demoAddrs[0], demoAddrs[1], demoAddrs[2]];

  check('登录页可见', !$(page, '#authView').classList.contains('hidden'));
  check('主应用初始隐藏', $(page, '#appView').classList.contains('hidden'));
  check('四个角色卡', $$(page, '.role').length === 4);
  check('默认选中甲方', $(page, '.role.sel').dataset.role === 'client');
  check('演示账号四个', $$(page, '.demo-a').length === 4);

  // 演示账号点击填充。地址从页面读取，不硬编码 ——
// 演示地址随环境变化（mock 用假地址，链上模式用链上真实地址）
  const demoFill = $$(page, '.demo-a').map((b) => b.dataset.fill);
  check('演示账号已配置合法地址', demoFill.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a || '')),
    demoFill.map((a) => a.slice(0, 8)).join(' '));

  $$(page, '.demo-a')[1].click();
  check('点击演示账号自动填充地址', $(page, '#loginAddr').value === demoFill[1],
    (demoFill[1] || '').slice(0, 12) + '…');
  check('自动切换到对应角色', $(page, '.role.sel').dataset.role === 'provider');

  // 非法地址
  $(page, '#loginAddr').value = '0x123';
  $(page, '#loginBtn').click();
  await sleep(600);
  check('非法地址被拒绝', $(page, '#appView').classList.contains('hidden'));

  hr('② 甲方登录 · 侧边栏与工作台');
  const pC = await loginAs(CLIENT, 'client', '甲方');
  const P = pC.window.__PLATFORM__;
  const S = P.S;

  check('登录成功进入应用', !$(pC, '#appView').classList.contains('hidden'));
  check('登录页隐藏', $(pC, '#authView').classList.contains('hidden'));
  check('侧边栏显示角色', txt(pC, '#sbRole') === '甲方');
  check('侧边栏显示地址', txt(pC, '#sbAddr').includes('…'));

  const navs = $$(pC, '.nav-i');
  check('9 个导航页面', navs.length === 9,
    navs.map((n) => n.querySelector('span').textContent).join('·'));
  check('10 个页面容器（含详情页）', $$(pC, '.page').length === 10,
    `${$$(pC, '.page').length} 个`);
  check('默认在工作台', $(pC, '#page-dashboard').classList.contains('on'));
  check('KPI 四张卡', $$(pC, '.kpi').length === 4);
  check('资金概览已渲染', $$(pC, '#dashPayoutNums .pn-box').length === 3);

  hr('③ 规则库页');
  P.go('rules');
  await sleep(900);
  check('显示 5 个规则模板', $$(pC, '#ruleGrid .rule-card').length === 5);
  check('每卡含三条门槛', $$(pC, '#ruleGrid .rule-card').every((c) => c.querySelectorAll('.rb-bar').length === 3));
  check('有「不接什么」区块', $$(pC, '#rejectList .rj').length >= 2);
  check('页面标题同步', txt(pC, '#pageTitle') === '验收规则库');

  $$(pC, '#ruleGrid .rule-card')[0].click();
  await sleep(400);
  check('可选择规则', !!S.selectedRule, S.selectedRule?.name);
  check('选中态高亮', !!$(pC, '#ruleGrid .rule-card.sel'));

  hr('④ 创建项目页');
  P.go('create');
  await sleep(700);
  check('项目名称输入框', !!$(pC, '#cTitle'));
  check('规则下拉已填充', $(pC, '#cRule').options.length === 5);
  check('默认 3 个里程碑', $$(pC, '#cMsList .ms-row').length === 3);
  check('总额自动计算', txt(pC, '#cTotal') === '100');

  $(pC, '#cAddMs').click();
  await sleep(200);
  check('可增加里程碑', $$(pC, '#cMsList .ms-row').length === 4);
  check('总额随之更新', txt(pC, '#cTotal') === '110');

  $(pC, '#cProvider').value = PROVIDER;
  $(pC, '#cArb').value = ARB;

  // 规格与上传包的实际接口对齐 —— 平台只测规格清单内的东西
  P.S.specOverride = {
    delivery: { name: 'ui-test-delivery', entryPoint: 'src/logic.js', serveCommand: 'src/server.js' },
    middleware: { requires: [] },
    probe: {
      targets: [
        { path: '/health', method: 'GET', expectStatus: [200] },
        { path: '/ping', method: 'GET', expectStatus: [200] },
        { path: '/calc', method: 'GET', expectStatus: [200] },
      ],
      rounds: 3, intervalMs: 120, startupTimeoutMs: 15000,
    },
    contract: {
      responses: {
        '/health': { required: ['status', 'db'], optional: ['ts'] },
        '/ping': { required: ['ok', 'marker'], optional: [] },
      },
    },
    requiredSuites: [{ group: 'required', expectedCaseCount: 4 }],
    seed: undefined,
  };

  $(pC, '#createBtn').click();
  await sleep(2300);

  check('项目创建成功', S.projectId != null, 'projectId=' + S.projectId);
  check('自动跳到详情页', $(pC, '#page-detail').classList.contains('on'));
  check('详情页渲染项目名', txt(pC, '#detailHeader').includes('用户中心'));
  const pid = S.projectId;

  hr('⑤ 项目详情 · 双签注资');
  await waitFor(() => $$(pC, '#detailMs .ms-card').length >= 3);
  const MS_COUNT = $$(pC, '#detailMs .ms-card').length;
  check('详情含三方地址',
    txt(pC, '#detailHeader').includes('甲方') &&
    txt(pC, '#detailHeader').includes('乙方') &&
    txt(pC, '#detailHeader').includes('仲裁者'));
  check('里程碑卡已渲染', $$(pC, '#detailMs .ms-card').length === MS_COUNT,
    `${MS_COUNT} 张（与创建时一致）`);
  check('显示签署按钮', !!$(pC, '#dSign'));

  $(pC, '#dSign').click();
  await sleep(1500);
  check('甲方签署成功', true);

  const pP = await loginAs(PROVIDER, 'provider', '乙方');
  check('乙方登录成功', pP.window.__PLATFORM__.S.role === 'provider');

  const rSign = await api(`/api/projects/${pid}/sign`, {
    method: 'POST', token: pP.window.__PLATFORM__.S.token,
  });
  check('乙方签署成功', rSign.status === 200, rSign.body.error || '');

  $(pC, '#dFund').click();
  await sleep(1700);
  check('甲方注资成功', true);

  const afterFund = await api(`/api/projects/${pid}`, { token: S.token });
  check('项目状态推进到 funded', afterFund.body.project.status === 'funded', afterFund.body.project.status);

  hr('⑥ 交付提交页');
  pP.window.__PLATFORM__.S.projectId = pid;
  pP.window.__PLATFORM__.go('delivery');
  await waitFor(() => $(pP, '#dMilestone').options.length >= MS_COUNT);
  check('里程碑下拉已填充', $(pP, '#dMilestone').options.length === MS_COUNT,
    `${$(pP, '#dMilestone').options.length} 项（应为 ${MS_COUNT}）`);
  check('有隐私说明', /源码不落链|SHA-256/.test(txt(pP, '.privacy-note')));

  // 走真实上传流程：造一个带唯一标记的源码包 → 注入文件输入 → 触发上传
  const ARCHIVE = buildSourceArchive();
  check('已构造源码包', ARCHIVE.length > 0, `${(ARCHIVE.length / 1024).toFixed(1)} KB`);

  const fileObj = new pP.window.File([ARCHIVE], 'ui-test-delivery.tar.gz',
    { type: 'application/gzip' });
  Object.defineProperty(pP.window.document.getElementById('fileInput'), 'files', {
    value: [fileObj], configurable: true,
  });
  pP.window.document.getElementById('fileInput')
    .dispatchEvent(new pP.window.Event('change', { bubbles: true }));
  await sleep(300);

  check('拖拽区显示已选文件', txt(pP, '#dzName').includes('ui-test-delivery'));
  check('上传按钮已启用', $(pP, '#deliverBtn').disabled === false);

  $(pP, '#dMilestone').value = '0';
  $(pP, '#dNote').value = '接口已完成';

  await pP.window.__PLATFORM__.uploadDelivery(0);
  await waitFor(() => txt(pP, '#upResult').includes('SHA-256'), 30000);
  check('乙方提交交付成功', txt(pP, '#upResult').includes('SHA-256'),
    (txt(pP, '#upResult').match(/local:\/\/[^\s]+/) || [])[0] || '');
  check('返回真实哈希', /0x[0-9a-f]{64}/.test(txt(pP, '#upResult')));

  hr('⑦ 验收页（真实拉起隔离运行时）');
  S.projectId = pid;
  P.go('verify');
  await sleep(900);
  await waitFor(() => $('#vMilestone', pC).options.length >= 1);
  check('环境说明条四条', $$(pC, '.es-i').length === 4);
  check('环境条含隔离运行时', txt(pC, '.env-strip').includes('独立 PG'));
  check('环境条含锁定种子', txt(pC, '.env-strip').includes('锁定种子'));

  $(pC, '#vMilestone').value = '0';
  $(pC, '#verifyBtn').click();

  let vr = null;
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    const box = pC.window.document.getElementById('verifyResult');
    if (box && box.innerHTML.includes('vr-head')) { vr = box; break; }
  }

  check('验收结果已渲染', !!vr);
  if (vr) {
    const h = vr.innerHTML;
    check('显示得分环', h.includes('vr-ring'));
    check('显示判定结论', /验收通过|验收不通过/.test(h), (h.match(/vr-t">里程碑 \d+ · ([^<]+)/) || [])[1]);
    check('三维度门槛独立显示', h.includes('vgate'));
    check('三维度仪表', h.includes('meter-bar') && h.includes('必测用例通过率'));
    check('显示中间件隔离', /独立\s*PG\s*\+\s*KV|isolation/.test(h), '每项目独立 PG + KV');
    check('显示事实报告哈希', h.includes('vr-hash') && h.includes('0x'));
  }

  hr('⑧ 结算页');
  P.go('settlement');
  await waitFor(() => $$(pC, '#setPayoutNums .pn-box').length === 3);
  check('三档资金数字', $$(pC, '#setPayoutNums .pn-box').length === 3);
  check('资金条有分段', $$(pC, '#setPayoutBar .pb-seg').length >= 1);
  check('结算流水区块存在', !!$(pC, '#settleList'));
  check('筛选按钮四个', $$(pC, '#setFilter .filt').length === 4);

  hr('⑨ 争议页');
  P.go('disputes');
  await sleep(900);
  check('争议列表区块存在', !!$(pC, '#disputeList'));
  check('仲裁规则四条', $$(pC, '#page-disputes .rl').length === 4);
  check('规则含「不推翻客观事实」', txt(pC, '#page-disputes').includes('不推翻客观事实'));

  hr('⑩ 信任机制页');
  P.go('trust');
  await sleep(700);
  check('四个信任机制卡', $$(pC, '.tg').length === 4);
  check('五条局限说明', $$(pC, '.limit-list .li').length === 5);
  check('局限含「性能与容量」', txt(pC, '.limit-list').includes('性能与容量'));
  check('技术实现四条', $$(pC, '.tech').length === 4);

  hr('⑪ 放款与账目核对');
  pP.window.__PLATFORM__.S.projectId = pid;
  pP.window.__PLATFORM__.go('detail');
  // 等 DOM 真正渲染出验收通过状态（而非只看数组长度）
  await waitFor(() => {
    const c = pP.window.document.querySelector('#detailMs .ms-card');
    return c && /验收通过|已放款/.test(c.textContent);
  });
  const ms0 = pP.window.__PLATFORM__.S.project?.milestones?.[0];
  check('乙方看到里程碑状态', !!ms0, ms0 ? `${ms0.statusLabel} ${ms0.score ?? ''} 分` : '');

  if (ms0?.status === 'passed') {
    const btn = pP.window.document.querySelector('#detailMs .mini-btn2.ok');
    check('显示放款按钮', !!btn);
    btn.click();
    await sleep(1900);
    check('放款成功', true);
  } else {
    fail++;
    console.log(`  ✗ 里程碑未通过验收，实际状态 ${ms0?.statusLabel}`);
  }

  const final = await api(`/api/projects/${pid}`, { token: S.token });
  check('结算流水已生成', final.body.settlements.length >= 1, `${final.body.settlements.length} 笔`);
  check('审计日志已生成', final.body.audit.length >= 6, `${final.body.audit.length} 条`);

  const ONE = 10n ** 18n;
  const rel = BigInt(final.body.payout.released);
  const ref = BigInt(final.body.payout.refunded);
  const rem = BigInt(final.body.payout.remaining);
  check('资金守恒', rel + ref + rem === 110n * ONE,
    `${Number(rel) / 1e18} + ${Number(ref) / 1e18} + ${Number(rem) / 1e18} = 110 TUSD`);

  hr('⑫ 视觉与导航');
  const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'platform.css'), 'utf8');
  check('深空底色', css.includes('--bg: #05070D'));
  check('极光动画背景', css.includes('.aurora') && css.includes('@keyframes d1'));
  check('玻璃拟态', css.includes('backdrop-filter'));
  check('网格与噪点层', css.includes('.grid-lines') && css.includes('.noise'));
  check('侧边栏布局', css.includes('.sidebar') && css.includes('--sb-w'));
  check('得分环样式', css.includes('.vr-ring circle'));
  check('响应式断点 ≥4', (css.match(/@media/g) || []).length >= 4);
  check('页面入场动画', css.includes('@keyframes up'));

  P.go('dashboard');
  await sleep(400);
  check('标题同步为工作台', txt(pC, '#pageTitle') === '工作台');
  check('导航高亮同步', $(pC, '.nav-i.on').dataset.page === 'dashboard');
  check('页面描述非空', txt(pC, '#pageDesc').length > 0, txt(pC, '#pageDesc'));

  server.kill('SIGKILL');
  await sleep(300);
  await httpAgent.close().catch(() => {});

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});