/**
 * 依赖交付物端到端验证
 *
 * 核心问题：交付物依赖第三方 npm 包时，验收还能不能跑起来？
 *
 * 造一个真实依赖 is-odd 的服务：
 *   - 上传 → 解包 → 受控安装依赖 → 隔离运行时里 require → 验收
 *
 * 运行：node test/dep-delivery-e2e.js
 * 前置：BASE_URL 指向已启动的后端（默认 4111）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar');

const B = process.env.BASE_URL || 'http://localhost:4111';
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const hr = (t) => console.log('\n' + '═'.repeat(62) + '\n  ' + t + '\n' + '═'.repeat(62));
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const J = (o) => JSON.stringify(o);
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });

const login = async (a, r, n) =>
  (await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: J({ address: a, role: r, nickname: n }),
  })).json();

/** 造一个依赖第三方包的交付物 */
function buildDepPackage(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-delivery-'));

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dep-delivery',
    version: '1.0.0',
    description: '演示依赖安装的交付物',
    main: 'src/logic.js',
    dependencies: { 'is-odd': '3.0.1' },
  }, null, 2));

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });

  // 真正 require 第三方包
  fs.writeFileSync(path.join(dir, 'src', 'logic.js'), `
const isOdd = require('is-odd');
const MARKER = ${J(marker)};

function classify(n) {
  // 依赖第三方库才能得到正确结果
  return { n, odd: Boolean(isOdd(n)), marker: MARKER };
}
function sum(nums) { return nums.reduce((a, b) => a + b, 0); }

module.exports = { MARKER, classify, sum };
`);

  fs.writeFileSync(path.join(dir, 'src', 'runtime-bridge.js'), `
const g = () => global.__ACCEPTANCE_RUNTIME__;
module.exports = {
  db: {
    query: async (s, p) => g().database.query(s, p),
    one: async (s, p) => g().database.one(s, p),
    many: async (s, p) => g().database.many(s, p),
  },
  cache: {
    get: async (k) => g().kv.get(k),
    set: async (k, v) => g().kv.set(k, v),
    del: async (k) => g().kv.del(k),
    incr: async (k) => g().kv.incr(k),
    expire: async (k, s) => g().kv.expire(k, s),
  },
  getRuntime: g,
};
`);

  fs.writeFileSync(path.join(dir, 'src', 'server.js'), `
const http = require('http');
const { classify, sum, MARKER } = require('./logic');
const { db } = require('./runtime-bridge');

let ready = false;
(async () => {
  try {
    await db.query('CREATE TABLE IF NOT EXISTS checks (id VARCHAR(16), ok INT)');
    ready = true;
  } catch (e) { console.error('[init]', e.message); }
})();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (c, b) => {
    const s = JSON.stringify(b);
    res.writeHead(c, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  if (u.pathname === '/health') return j(200, { status: ready ? 'ok' : 'degraded', db: ready, ts: Date.now() });
  if (u.pathname === '/classify') return j(200, { ...classify(21), marker: MARKER });
  if (u.pathname === '/sum') return j(200, { total: sum([1, 2, 3, 4]), currency: 'TUSD' });
  j(404, { error: 'not found' });
});
server.listen(process.env.PORT || 8080, '127.0.0.1', () => console.log('up', process.env.PORT));
`);

  // 测试里也真正 require 依赖
  fs.writeFileSync(path.join(dir, 'test', 'run-tests.js'), `
const isOdd = require('is-odd');
const { classify, sum, MARKER } = require('../src/logic');

const CASES = [
  { name: 'classify 21 为奇数（依赖 is-odd）', group: 'required', fn: () => eq(classify(21).odd, true) },
  { name: 'classify 20 为偶数（依赖 is-odd）', group: 'required', fn: () => eq(classify(20).odd, false) },
  { name: 'isOdd 直接可用', group: 'required', fn: () => eq(isOdd(7), true) },
  { name: 'classify 带标记', group: 'required', fn: () => eq(classify(1).marker, MARKER) },
  { name: 'sum 正确', group: 'required', fn: () => eq(sum([1, 2, 3, 4]), 10) },
  { name: '自测用例', group: 'extra', fn: () => eq(sum([]), 0) },
];

function eq(a, b) { if (a !== b) throw new Error('期望 ' + b + '，实际 ' + a); }

const suite = (process.argv.find((x) => x.startsWith('--suite=')) || '').split('=')[1];
const sel = CASES.filter((c) => (suite === 'required' ? c.group === 'required' : true));
const cases = []; let p = 0, f = 0;
for (const c of sel) {
  try { c.fn(); p++; cases.push({ name: c.name, group: c.group, status: 'passed', ms: 0 }); }
  catch (e) { f++; cases.push({ name: c.name, group: c.group, status: 'failed', ms: 0, error: e.message }); }
}
console.log(JSON.stringify({
  total: cases.length, passed: p, failed: f,
  passRate: cases.length ? Math.round((p / cases.length) * 10000) : 0,
  cases,
}, null, 2));
process.exit(f > 0 ? 1 : 0);
`);

  const out = path.join(dir, '..', `dep-${Date.now()}.tar.gz`);
  tar.c({ gzip: true, sync: true, file: out, cwd: dir },
    ['package.json', 'src', 'test']);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

(async () => {
  const MARKER = 'DEP-' + Date.now().toString(36).toUpperCase();
  console.log('  唯一标记:', MARKER);

  hr('① 环境检查');
  const health = await fetch(B + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error('  后端未启动。请先运行：');
    console.error('    cd server && PORT=4111 node src/platform/app.js');
    process.exit(1);
  }
  console.log('  后端:', B, '· 链上模式', health.chainMode);

  const c = await login('0x1111111111111111111111111111111111111111', 'client', '甲方');
  const p = await login('0x2222222222222222222222222222222222222222', 'provider', '乙方');
  const a = await login('0x3333333333333333333333333333333333333333', 'arbitrator', '仲裁');
  check('三方登录', !!(c.token && p.token && a.token));

  hr('② 建项目（规格与交付对齐）');
  const spec = {
    delivery: { name: 'dep-delivery', entryPoint: 'src/logic.js', serveCommand: 'src/server.js' },
    middleware: { requires: [] },
    testCommand: { command: 'node', args: ['test/run-tests.js', '--suite=required'], timeoutMs: 30000 },
    requiredSuites: [{ group: 'required', expectedCaseCount: 5 }],
    probe: {
      targets: [
        { path: '/health', method: 'GET', expectStatus: [200] },
        { path: '/classify', method: 'GET', expectStatus: [200] },
        { path: '/sum', method: 'GET', expectStatus: [200] },
      ],
      rounds: 3, intervalMs: 120, startupTimeoutMs: 20000,
    },
    contract: {
      responses: {
        '/health': { required: ['status', 'db'], optional: ['ts'] },
        '/classify': { required: ['n', 'odd', 'marker'], optional: [] },
        '/sum': { required: ['total', 'currency'], optional: [] },
      },
    },
    thresholds: {
      testPassRate: 9000, apiAvailability: 9500, fieldCoverage: 9000,
      passScore: 80, weights: { test: 5000, api: 3000, field: 2000 },
    },
    seed: undefined,
    dependencyInstall: { enabled: true, timeoutMs: 90000 },
  };

  const proj = await (await fetch(B + '/api/projects', {
    method: 'POST', headers: H(c.token),
    body: J({
      title: '依赖交付验证', providerAddr: p.address, arbitratorAddr: a.address,
      ruleSetId: 'standard-interface-v1', deliverableType: 'code',
      milestones: [{ title: '带依赖的实现', amount: 100 }],
      __specOverride: spec,
    }),
  })).json();
  if (proj.error) { console.error('  创建失败:', proj.error); process.exit(1); }
  const pid = proj.projectId;
  check('项目创建', pid != null, `id=${pid}`);

  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(c.token) });
  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(p.token) });
  const fund = await (await fetch(`${B}/api/projects/${pid}/fund`, { method: 'POST', headers: H(c.token) })).json();
  check('双签 + 注资', fund.funded === true, `${fund.total} TUSD`);

  hr('③ 上传带依赖的源码包');
  const pkg = buildDepPackage(MARKER);
  console.log(`  包大小: ${(pkg.length / 1024).toFixed(1)} KB（内含 dependencies: is-odd）`);

  const fd = new FormData();
  fd.append('file', new Blob([pkg]), 'dep-delivery.tar.gz');
  const up = await (await fetch(`${B}/api/projects/${pid}/milestones/0/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + p.token }, body: fd,
  })).json();
  if (up.error) { console.error('  上传失败:', up.error); process.exit(1); }
  check('上传成功', up.uploaded === true, up.uri);
  check('解包文件数', up.fileCount >= 5, `${up.fileCount} 个`);

  hr('④ 执行验收（含受控依赖安装）');
  console.log('  正在安装依赖并运行验收，首次可能需要 30–90 秒…');
  const t0 = Date.now();
  const v = await (await fetch(`${B}/api/projects/${pid}/milestones/0/verify`, {
    method: 'POST', headers: H(c.token),
  })).json();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (v.error) { console.error('  验收失败:', v.error); process.exit(1); }

  const dep = v.detail.dependencies;
  console.log('');
  console.log('  【依赖安装】');
  if (dep) {
    console.log(`    尝试安装   : ${dep.attempted}`);
    console.log(`    安装成功   : ${dep.success}`);
    console.log(`    包数量     : ${dep.packages}`);
    console.log(`    占用体积   : ${dep.sizeMB} MB`);
    console.log(`    耗时       : ${dep.durationMs}ms`);
    console.log(`    脚本已禁用 : ${dep.scriptsBlocked}`);
    if (dep.blocked?.length) console.log(`    被拦截     : ${dep.blocked.join(', ')}`);
  } else {
    console.log('    （未执行安装）');
  }
  console.log('');
  console.log(`  【验收结果】耗时 ${elapsed}s`);
  console.log(`    结论     : ${v.result.passed ? '✓ 验收通过' : '✗ 验收不通过'}（${v.result.score} 分）`);
  console.log(`    三维度   : 测试 ${v.facts.testPassRate / 100}% · 接口 ${v.facts.apiAvailability / 100}% · 字段 ${v.facts.fieldCoverage / 100}%`);
  console.log(`    必测用例 : ${v.detail.tests.passedRequired}/${v.detail.tests.requiredCount}`);
  console.log('');

  hr('⑤ 断言');
  check('依赖安装被触发', dep?.attempted === true);
  check('依赖安装成功', dep?.success === true, dep?.notes?.[0] || dep?.stderr?.slice(0, 100) || '');
  check('安装了 1 个包', dep?.packages === 1, `${dep?.packages} 个`);
  check('脚本执行已禁用', dep?.scriptsBlocked === true);
  check('未拦截任何包', !dep?.blocked?.length, dep?.blocked?.join(',') || '无');
  check('验收代码来源为 uploaded', v.detail.deliveryOrigin === 'uploaded');
  check('必测用例全通过', (v.detail.tests.failedRequired || 0) === 0,
    v.detail.tests.failedCases?.map((c) => c.name).join(';') || '0 失败');
  check('三维度均达标',
    v.result.gates.test && v.result.gates.api && v.result.gates.field,
    `测试${v.result.gates.test ? '✓' : '✗'} 接口${v.result.gates.api ? '✓' : '✗'} 字段${v.result.gates.field ? '✓' : '✗'}`);
  check('验收通过', v.result.passed === true, `${v.result.score} 分`);

  // 磁盘上验证 node_modules 真的生成了
  const store = require(path.join(ROOT, 'server', 'src', 'platform', 'storage', 'delivery-store.js'));
  const srcDir = store.sourceDir(pid, 0);
  check('node_modules 已生成', fs.existsSync(path.join(srcDir, 'node_modules', 'is-odd')));

  hr('⑥ 清理');
  fs.rmSync(store.milestoneDir(pid, 0), { recursive: true, force: true });
  check('交付物已清理', !store.hasDelivery(pid, 0));

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});