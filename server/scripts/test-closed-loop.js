/**
 * 闭环端到端验证
 *
 * 完整跑一遍：登录 → 建项目 → 双签 → 注资 → 交付 → 验收 → 结算
 * 每一步都是真实的 HTTP 调用 + 真实的隔离运行时 + 真实的判定逻辑。
 *
 * 运行：node scripts/test-closed-loop.js
 */

const { spawn } = require('child_process');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const APP = path.join(__dirname, '..', 'src', 'platform', 'app.js');

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

const hr = (t) => console.log('\n' + '═'.repeat(68) + '\n  ' + t + '\n' + '═'.repeat(68));

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  hr('启动平台服务');
  const server = spawn(process.execPath, [APP], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '4000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  await sleep(2500);
  const health = await api('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error('服务启动失败：\n' + serverLog);
    server.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`  链上模式: ${health.body.chainMode} (${health.body.chainNetwork})`);
  console.log(`  闭环步骤: ${health.body.flow.join(' → ')}`);

  // ── 1. 登录 ──
  hr('步骤 1 · 登录（四方角色）');
  const CLIENT = '0x1111111111111111111111111111111111111111';
  const PROVIDER = '0x2222222222222222222222222222222222222222';
  const ARB = '0x3333333333333333333333333333333333333333';
  const COLLECTOR = '0x4444444444444444444444444444444444444444';

  const rClient = await api('/api/auth/login', { method: 'POST', body: { address: CLIENT, nickname: '甲方', role: 'client' } });
  check('甲方登录', rClient.status === 200 && rClient.body.token, rClient.body.error || '');
  const rProvider = await api('/api/auth/login', { method: 'POST', body: { address: PROVIDER, nickname: '乙方', role: 'provider' } });
  check('乙方登录', rProvider.status === 200 && rProvider.body.token, rProvider.body.error || '');
  const rArb = await api('/api/auth/login', { method: 'POST', body: { address: ARB, nickname: '仲裁者', role: 'arbitrator' } });
  check('仲裁者登录', rArb.status === 200 && rArb.body.token);
  const rColl = await api('/api/auth/login', { method: 'POST', body: { address: COLLECTOR, nickname: '采集器', role: 'collector' } });
  check('采集器登录（自动授权链上）', rColl.status === 200 && rColl.body.token);

  const auth = { client: rClient.body.token, provider: rProvider.body.token, arb: rArb.body.token };

  // 未登录访问
  const noAuth = await api('/api/projects');
  check('未登录被拒绝', noAuth.status === 401);

  // ── 2. 选规则 ──
  hr('步骤 2 · 选择验收规则');
  const rules = await api('/api/rules');
  check('规则列表', rules.status === 200 && rules.body.templates.length >= 5, `${rules.body.templates?.length} 个模板`);
  check('声明拒绝的主观类型', rules.body.rejected?.length >= 2);

  const mismatch = await api('/api/rules/validate', { method: 'POST', body: { deliverableType: 'design', ruleSetId: 'standard-interface-v1' } });
  check('设计类交付被拒绝', mismatch.status === 400, mismatch.body.reason || '');

  const ok = await api('/api/rules/validate', { method: 'POST', body: { deliverableType: 'code', ruleSetId: 'standard-interface-v1' } });
  check('代码类 + 标准接口规则匹配', ok.status === 200 && ok.body.acceptable);

  // ── 3. 建项目 ──
  hr('步骤 3 · 创建项目');
  const badProject = await api('/api/projects', {
    method: 'POST', token: auth.client,
    body: { title: 'X', providerAddr: CLIENT, arbitratorAddr: ARB, ruleSetId: 'standard-interface-v1', milestones: [{ title: 'a', amount: 10 }] },
  });
  check('甲方乙方同地址被拒', badProject.status === 400, badProject.body.error || '');

  const project = await api('/api/projects', {
    method: 'POST', token: auth.client,
    body: {
      title: '用户中心接口开发',
      providerAddr: PROVIDER,
      arbitratorAddr: ARB,
      ruleSetId: 'standard-interface-v1',
      deliverableType: 'code',
      milestones: [
        { title: '接口实现', amount: 40 },
        { title: '联调与自测', amount: 30 },
        { title: '文档与交接', amount: 30 },
      ],
    },
  });
  check('项目创建成功', project.status === 200 && project.body.projectId != null, project.body.error || '');
  const pid = project.body.projectId;
  check('生成验收规格哈希', !!project.body.specHash, project.body.specHash?.slice(0, 20) + '...');
  check('总额计算', project.body.total === 100, `${project.body.total} TUSD`);
  check('记录链上交易', !!project.body.txHash);

  const outsider = await api('/api/projects', {
    method: 'POST', token: (await api('/api/auth/login', { method: 'POST', body: { address: '0x5555555555555555555555555555555555555555', role: 'client' } })).body.token,
    body: { title: 'Y', providerAddr: PROVIDER, arbitratorAddr: ARB, ruleSetId: 'standard-interface-v1', milestones: [{ title: 'a', amount: 10 }] },
  });
  check('其他人也能建项目（平台开放）', outsider.status === 200);

  // ── 4. 双签 + 注资 ──
  hr('步骤 4 · 双签与注资');
  const wrongSigner = await api(`/api/projects/${pid}/sign`, { method: 'POST', token: auth.arb });
  check('仲裁者无权签署', wrongSigner.status === 403, wrongSigner.body.error || '');

  const s1 = await api(`/api/projects/${pid}/sign`, { method: 'POST', token: auth.client });
  check('甲方签署', s1.status === 200);
  const s2 = await api(`/api/projects/${pid}/sign`, { method: 'POST', token: auth.provider });
  check('乙方签署', s2.status === 200);

  const fund = await api(`/api/projects/${pid}/fund`, { method: 'POST', token: auth.client });
  check('甲方注资', fund.status === 200 && fund.body.funded, fund.body.error || `${fund.body.total} TUSD`);

  // ── 5. 交付上传 ──
  hr('步骤 5 · 交付上传');
  const wrongDeliver = await api(`/api/projects/${pid}/milestones/0/deliver`, {
    method: 'POST', token: auth.client, body: { note: '甲方代提交' },
  });
  check('甲方不能代乙方交付', wrongDeliver.status === 403);

  const deliver = await api(`/api/projects/${pid}/milestones/0/deliver`, {
    method: 'POST', token: auth.provider,
    body: { note: '接口已完成', deliverableURI: 'storage://demo/m0' },
  });
  check('乙方提交交付', deliver.status === 200 && deliver.body.submitted, deliver.body.error || '');
  check('生成交付物哈希', !!deliver.body.hash, deliver.body.hash?.slice(0, 20) + '...');

  const doubleDeliver = await api(`/api/projects/${pid}/milestones/0/deliver`, {
    method: 'POST', token: auth.provider, body: {},
  });
  check('重复提交被拒', doubleDeliver.status === 400, doubleDeliver.body.error || '');

  // ── 6. 验收 ──
  hr('步骤 6 · 客观验收（平台跑代码）');
  console.log('  正在拉起隔离运行时并执行验收...');
  const verify = await api(`/api/projects/${pid}/milestones/0/verify`, { method: 'POST', token: auth.client });
  check('验收执行', verify.status === 200, verify.body.error || '');
  if (verify.status === 200) {
    const r = verify.body.result;
    console.log('');
    console.log(`    加权得分 : ${r.score}`);
    console.log(`    硬门槛   : 测试 ${r.gates.test ? '✓' : '✗'}  接口 ${r.gates.api ? '✓' : '✗'}  字段 ${r.gates.field ? '✓' : '✗'}`);
    console.log(`    事实值   : 测试 ${(verify.body.facts.testPassRate / 100).toFixed(1)}%  接口 ${(verify.body.facts.apiAvailability / 100).toFixed(1)}%  字段 ${(verify.body.facts.fieldCoverage / 100).toFixed(1)}%`);
    console.log(`    中间件   : ${verify.body.detail.runtime.isolation}，种子 ${verify.body.detail.runtime.seededRows} 行`);
    console.log(`    必测用例 : ${verify.body.detail.tests.passedRequired}/${verify.body.detail.tests.requiredCount}`);
    console.log(`    事实哈希 : ${verify.body.reportHash.slice(0, 24)}...`);
    console.log('');
    check('事实报告哈希已记录', !!verify.body.reportHash);
    check('判定已写入链上', !!verify.body.txHash);
    check('中间件隔离生效', verify.body.detail.runtime.isolation.includes('独立'));
  }

  const passed = verify.status === 200 && verify.body.result.passed;

  // ── 7. 结算 ──
  hr('步骤 7 · 结算');
  if (passed) {
    const release = await api(`/api/projects/${pid}/milestones/0/release`, { method: 'POST', token: auth.client });
    check('放款给乙方', release.status === 200 && release.body.released,
      release.body.error || `${release.body.amount} TUSD → ${release.body.to}`);
    check('付款汇总已生成', !!release.body.payoutSummary,
      `已放 ${release.body.payoutSummary?.released} / 已退 ${release.body.payoutSummary?.refunded} / 剩余 ${release.body.payoutSummary?.remaining}`);
  } else {
    const refund = await api(`/api/projects/${pid}/milestones/0/refund`, { method: 'POST', token: auth.client });
    check('退款给甲方', refund.status === 200 && refund.body.refunded,
      refund.body.error || `${refund.body.amount} TUSD → ${refund.body.to}`);
  }

  // ── 8. 完整链路：交付 + 验收 + 结算第二个里程碑 ──
  hr('步骤 8 · 第二个里程碑（走完整链路）');
  await api(`/api/projects/${pid}/milestones/1/deliver`, { method: 'POST', token: auth.provider, body: {} });
  const v2 = await api(`/api/projects/${pid}/milestones/1/verify`, { method: 'POST', token: auth.client });
  check('第二里程碑验收', v2.status === 200, v2.body.error || `得分 ${v2.body.result?.score}`);

  if (v2.status === 200 && v2.body.result.passed) {
    // 挑战流程
    const ch = await api(`/api/projects/${pid}/milestones/1/challenge`, {
      method: 'POST', token: auth.provider, body: { reason: 'dispute', note: '演示争议' },
    });
    check('乙方发起挑战', ch.status === 200, ch.body.error || '');
    const wrongArb = await api(`/api/projects/${pid}/milestones/1/arbitrate`, {
      method: 'POST', token: auth.client, body: { providerBps: 5000 },
    });
    check('非仲裁者不能裁定', wrongArb.status === 403);
    const arb = await api(`/api/projects/${pid}/milestones/1/arbitrate`, {
      method: 'POST', token: auth.arb, body: { providerBps: 7000 },
    });
    check('仲裁者按 70% 裁定', arb.status === 200 && arb.body.settled,
      arb.body.error || `乙方 ${arb.body.toProvider} / 甲方 ${arb.body.toClient}`);
  }

  // ── 9. 项目总览 ──
  hr('步骤 9 · 项目总览与审计');
  const detail = await api(`/api/projects/${pid}`, { token: auth.client });
  check('查询项目详情', detail.status === 200);
  check('里程碑状态齐全', detail.body.milestones?.length === 3, `${detail.body.milestones?.length} 个`);
  check('结算记录已生成', detail.body.settlements?.length >= 1, `${detail.body.settlements?.length} 笔`);
  check('审计日志已记录', detail.body.audit?.length >= 4, `${detail.body.audit?.length} 条`);
  check('资金汇总一致', detail.body.payout && Number.isFinite(detail.body.payout.remaining),
    `已放 ${detail.body.payout?.released} / 已退 ${detail.body.payout?.refunded} / 剩余 ${detail.body.payout?.remaining}`);

  console.log('\n  里程碑状态:');
  detail.body.milestones.forEach((m) => {
    console.log(`    [${m.idx}] ${m.title.padEnd(12)} ${String(m.amount).padStart(5)} TUSD  ${m.statusLabel}${m.score != null ? `  (${m.score} 分)` : ''}`);
  });

  console.log('\n  结算流水:');
  detail.body.settlements.forEach((s) => {
    console.log(`    ${s.type.padEnd(20)} ${String(s.amount).padStart(7)} → ${s.to.slice(0, 12)}...`);
  });

  console.log('\n  关键审计事件:');
  detail.body.audit.slice(0, 8).forEach((a) => {
    console.log(`    ${a.action.padEnd(24)} ${a.actor?.slice(0, 10)}...`);
  });

  // 资金守恒（链上金额单位为 wei，1 TUSD = 1e18）
  hr('资金守恒校验');
  const ONE = 10n ** 18n;
  const released = BigInt(detail.body.payout.released);
  const refunded = BigInt(detail.body.payout.refunded);
  const remaining = BigInt(detail.body.payout.remaining);
  const totalOnChain = 100n * ONE;
  const fmt = (v) => (Number(v) / 1e18).toFixed(2);
  check('已结算 + 未结算 = 项目总额', released + refunded + remaining === totalOnChain,
    `${fmt(released)} + ${fmt(refunded)} + ${fmt(remaining)} = ${fmt(released + refunded + remaining)} TUSD（应为 100）`);

  server.kill('SIGKILL');
  await sleep(300);

  hr('闭环验证结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败`);
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e.message, e.stack?.split('\n')[1]);
  process.exit(1);
});
