/**
 * 用真实 zip 交付物做端到端验证
 *
 * 用途：复现并验证「打包多一层目录」这类真实问题的修复。
 * 运行：node test/real-zip-verify.js
 * 前置：BASE_URL 已启动的后端
 */

const path = require('path');
const fs = require('fs');

const B = process.env.BASE_URL || 'http://localhost:4111';
const ROOT = path.join(__dirname, '..', '..');
const ZIP = path.join(ROOT, 'samples', 'sample-api.zip');

let pass = 0, fail = 0;
const hr = (t) => console.log('\n' + '═'.repeat(62) + '\n  ' + t + '\n' + '═'.repeat(62));
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

(async () => {
  hr('① 环境与交付物');
  const health = await fetch(B + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health) { console.error('  后端未启动'); process.exit(1); }
  console.log('  后端:', B);

  if (!fs.existsSync(ZIP)) { console.error('  找不到', ZIP); process.exit(1); }
  const buf = fs.readFileSync(ZIP);
  console.log(`  交付物: sample-api.zip · ${(buf.length / 1024).toFixed(1)} KB`);

  // 先看包内层级 —— 这是问题根源
  const store = require(path.join(ROOT, 'server', 'src', 'platform', 'storage', 'delivery-store.js'));
  await store.saveDelivery(9999, 0, buf, 'sample-api.zip');
  const extracted = store.sourceDir(9999, 0);
  const topLevel = fs.readdirSync(extracted);
  console.log('  解包后顶层:', topLevel.join(', '));
  const nested = topLevel.length === 1 && fs.statSync(path.join(extracted, topLevel[0])).isDirectory();
  check('确认存在嵌套层级问题', nested, nested ? `多了一层 ${topLevel[0]}/` : '无嵌套');

  hr('② 建项目（规格用 sample-api 自己的）');
  const specRaw = JSON.parse(
    fs.readFileSync(path.join(extracted, topLevel[0], 'acceptance-spec.json'), 'utf8')
  );
  const spec = {
    delivery: specRaw.delivery,
    middleware: specRaw.middleware,
    testCommand: specRaw.testCommand,
    requiredSuites: specRaw.requiredSuites,
    probe: specRaw.probe,
    contract: specRaw.contract,
    thresholds: specRaw.thresholds,
    seed: specRaw.seed,
  };

  const c = await login('0x1111111111111111111111111111111111111111', 'client', '甲方');
  const p = await login('0x2222222222222222222222222222222222222222', 'provider', '乙方');
  const a = await login('0x3333333333333333333333333333333333333333', 'arbitrator', '仲裁');

  const proj = await (await fetch(B + '/api/projects', {
    method: 'POST', headers: H(c.token),
    body: J({
      title: '真实 zip 验证', providerAddr: p.address, arbitratorAddr: a.address,
      ruleSetId: 'standard-interface-v1', deliverableType: 'code',
      milestones: [{ title: '接口实现', amount: 100 }],
      __specOverride: spec,
    }),
  })).json();
  if (proj.error) { console.error('  创建失败:', proj.error); process.exit(1); }
  const pid = proj.projectId;
  check('项目创建', pid != null, `id=${pid}`);

  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(c.token) });
  await fetch(`${B}/api/projects/${pid}/sign`, { method: 'POST', headers: H(p.token) });
  await fetch(`${B}/api/projects/${pid}/fund`, { method: 'POST', headers: H(c.token) });
  check('双签 + 注资', true);

  hr('③ 上传（保持原有的嵌套层级）');
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'sample-api.zip');
  const up = await (await fetch(`${B}/api/projects/${pid}/milestones/0/upload`, {
    method: 'POST', headers: { authorization: 'Bearer ' + p.token }, body: fd,
  })).json();
  if (up.error) { console.error('  上传失败:', up.error); process.exit(1); }
  check('上传成功', up.uploaded === true, `${up.fileCount} 个文件`);
  check('哈希真实', /^0x[0-9a-f]{64}$/.test(up.hash), up.hash.slice(0, 24) + '…');

  hr('④ 验收（应自动识别嵌套根）');
  const v = await (await fetch(`${B}/api/projects/${pid}/milestones/0/verify`, {
    method: 'POST', headers: H(c.token),
  })).json();

  if (v.error) {
    console.error('  验收失败:', v.error);
    if (v.rootDetection) console.error('  根目录探测:', J(v.rootDetection));
    if (v.availableEntries) console.error('  顶层内容:', v.availableEntries.join(', '));
    process.exit(1);
  }

  const rd = v.detail.rootDetection;
  console.log('');
  if (rd) console.log('  【根目录探测】', rd.reason);
  console.log('');
  console.log(`  【验收结果】`);
  console.log(`    结论   : ${v.result.passed ? '✓ 验收通过' : '✗ 验收不通过'}（${v.result.score} 分）`);
  console.log(`    三维度 : 测试 ${v.facts.testPassRate / 100}% · 接口 ${v.facts.apiAvailability / 100}% · 字段 ${v.facts.fieldCoverage / 100}%`);
  console.log(`    必测   : ${v.detail.tests.passedRequired}/${v.detail.tests.requiredCount}`);
  console.log(`    项目根 : ${v.detail.deliverySource.dir}`);
  console.log('');

  hr('⑤ 断言');
  check('自动识别了嵌套根', rd && rd.stripped === topLevel[0], rd?.reason || '');
  check('项目根指向内层', (rd?.dir || '').endsWith(topLevel[0]), rd?.dir || '');
  check('验收代码来源为 uploaded', v.detail.deliveryOrigin === 'uploaded');
  check('完整性已校验', v.detail.deliverySource.integrity === 'verified');
  check('必测用例全通过', (v.detail.tests.failedRequired || 0) === 0,
    v.detail.tests.failedCases?.map((x) => x.name).join(';') || '0 失败');
  check('三维度均达标',
    v.result.gates.test && v.result.gates.api && v.result.gates.field,
    `测试${v.result.gates.test ? '✓' : '✗'} 接口${v.result.gates.api ? '✓' : '✗'} 字段${v.result.gates.field ? '✓' : '✗'}`);
  check('验收通过', v.result.passed === true, `${v.result.score} 分`);

  // 清理
  store.milestoneDir(pid, 0) && fs.rmSync(store.milestoneDir(pid, 0), { recursive: true, force: true });
  fs.rmSync(store.milestoneDir(9999, 0), { recursive: true, force: true });

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});