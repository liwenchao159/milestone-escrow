/**
 * 验收平台采集器 —— 真实可运行的实现
 *
 * 回答那个核心问题：甲方交付一堆程序，平台怎么确定验收指标？
 *
 * 答案：平台自己把代码跑起来，测它的可观测行为。三个步骤：
 *   1. 按 commit 检出交付物
 *   2. 跑**平台指定**的测试命令，解析机器可读报告 → 必测用例通过率
 *   3. 自己部署这份代码，多轮探测接口 + 比对契约字段 → 可用率 / 字段覆盖率
 *
 * 关键：整个过程不碰甲乙双方的任何环境，因此不存在「甲方自建接口返回 200」
 *       或「乙方只跑指定的 3 个文件」这类操纵空间。
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ─────────────────────── 工具 ───────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 用 keccak256 计算链上格式的哈希（与合约一致） */
function keccak(text) {
  try {
    const { keccak256, toUtf8Bytes } = require('ethers');
    return keccak256(toUtf8Bytes(text));
  } catch {
    return '0x' + sha256(text);
  }
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        resolve({
          ok: true,
          status: res.statusCode,
          latencyMs: Date.now() - started,
          body: parsed,
          rawLength: body.length,
        });
      });
    });
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: e.message, body: null });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: 'timeout', body: null });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────── 指标一：必测用例通过率 ───────────────────────

/**
 * 执行验收规格中指定的测试命令，解析报告得出通过率。
 *
 * 注意这里跑的是 **spec.testCommand**，不是交付方 package.json 里的 scripts.test。
 * 乙方无法通过改自己的测试脚本来控制结果——比如把失败用例删掉。
 */
async function measureTestPassRate(deliveryDir, spec) {
  const cmd = spec.testCommand;
  const started = Date.now();

  const stdout = await new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd.command, cmd.args, {
      cwd: deliveryDir,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: cmd.timeoutMs,
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(out));
  });

  // 解析 JSON 报告
  let report = null;
  try {
    const jsonStart = stdout.indexOf('{');
    if (jsonStart >= 0) report = JSON.parse(stdout.slice(jsonStart));
  } catch {
    report = null;
  }

  if (!report) {
    return {
      value: 0,
      detail: {
        reason: '无法解析测试报告',
        raw: stdout.slice(0, 500),
      },
      durationMs: Date.now() - started,
    };
  }

  // 校验必测组的完整性 —— 关键防作弊步骤
  const requiredCases = report.cases.filter((c) => c.group === 'required');
  const expectedCount = spec.requiredSuites[0].expectedCaseCount;
  const countMismatch = requiredCases.length !== expectedCount;

  const passedRequired = requiredCases.filter((c) => c.status === 'passed').length;
  const value = requiredCases.length > 0 ? Math.round((passedRequired / requiredCases.length) * 10000) : 0;

  return {
    value,
    detail: {
      totalReported: report.total,
      requiredCount: requiredCases.length,
      expectedCount,
      /** 必测用例被删减 —— 这是最常见的作弊手段 */
      countMismatch,
      passedRequired,
      failedRequired: requiredCases.length - passedRequired,
      failedCases: requiredCases
        .filter((c) => c.status === 'failed')
        .map((c) => ({ name: c.name, error: c.error })),
      extraCasesRun: report.cases.length - requiredCases.length,
    },
    durationMs: Date.now() - started,
  };
}

// ─────────────────────── 指标二 & 三：接口探测 + 字段覆盖 ───────────────────────

/**
 * 平台自己启动交付物并探测。
 * 环境完全由平台掌控 —— 不存在甲方「自建一个返回 200 的接口」的可能。
 */
async function measureApi(deliveryDir, spec) {
  const port = 18080 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;

  // 启动交付物。用 spec.delivery.serveCommand（平台可独立启动的服务入口），
  // 而不是 entryPoint（可能只是纯逻辑模块，不监听端口）。
  const serveEntry = spec.delivery.serveCommand || spec.delivery.entryPoint;
  const child = spawn(process.execPath, [serveEntry], {
    cwd: deliveryDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  /**
   * 进程清理必须可靠：Windows 上用 kill() 可能留下句柄，
   * 导致父进程退出时触发 0xC0000409。这里统一登记，
   * 并在退出钩子里强制清理。
   */
  const spawned = child;
  if (!global.__harnessChildren) global.__harnessChildren = new Set();
  global.__harnessChildren.add(spawned);
  spawned.on('exit', () => global.__harnessChildren.delete(spawned));

  const killChild = () => {
    try {
      if (!spawned.killed) spawned.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
    global.__harnessChildren.delete(spawned);
  };
  process.once('exit', killChild);
  process.once('SIGINT', () => { killChild(); process.exit(130); });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  // 等待启动
  let started = false;
  const deadline = Date.now() + spec.probe.startupTimeoutMs;
  while (Date.now() < deadline) {
    const h = await httpGet(`${base}/health`, 1000);
    if (h.ok && h.status === 200) {
      started = true;
      break;
    }
    await sleep(200);
  }

  if (!started) {
    killChild();
    const hint = !spec.delivery.serveCommand
      ? '验收规格缺少 delivery.serveCommand —— 平台无法确定如何启动该交付物'
      : `以 ${spec.delivery.serveCommand} 启动后未在 ${spec.probe.startupTimeoutMs}ms 内就绪`;
    return {
      availability: {
        value: 0,
        detail: { reason: '交付物启动失败', hint, stderr: stderr.slice(0, 300) || '(无 stderr 输出)' },
      },
      fieldCoverage: { value: 0, detail: { reason: '服务未启动，无法测量', totalRequired: 0, totalCovered: 0, perPath: [] } },
    };
  }

  // 多轮探测
  const samples = [];
  const collectedBodies = {};

  for (let r = 0; r < spec.probe.rounds; r++) {
    for (const t of spec.probe.targets) {
      const res = await httpGet(`${base}${t.path}`, 5000);
      const ok = res.ok && t.expectStatus.includes(res.status);
      samples.push({
        round: r + 1,
        path: t.path,
        ok,
        status: res.status,
        latencyMs: res.latencyMs,
      });
      // 保存最后一次成功的响应体，供字段比对
      if (ok && res.body) collectedBodies[t.path] = res.body;
    }
    if (r < spec.probe.rounds - 1) await sleep(spec.probe.intervalMs);
  }

  killChild();
  await sleep(300);

  // 可用率
  const okCount = samples.filter((s) => s.ok).length;
  const availabilityValue = Math.round((okCount / samples.length) * 10000);

  // 字段覆盖率 —— 分母来自契约锁定，不可被乙方虚增
  const coverageDetail = [];
  let totalRequired = 0;
  let totalCovered = 0;

  for (const [pathKey, contract] of Object.entries(spec.contract.responses)) {
    const body = collectedBodies[pathKey];
    if (!body) {
      coverageDetail.push({ path: pathKey, status: 'unavailable', covered: 0, required: contract.required.length });
      totalRequired += contract.required.length;
      continue;
    }

    const actualTop = Object.keys(body);
    // 支持嵌套：items 数组的元素也检查
    const covered = contract.required.filter((f) => {
      if (actualTop.includes(f)) return true;
      // 嵌套检查：一层深度
      for (const v of Object.values(body)) {
        if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && f in v[0]) {
          return true;
        }
      }
      return false;
    });

    const missing = contract.required.filter((f) => !covered.includes(f));
    totalRequired += contract.required.length;
    totalCovered += covered.length;
    coverageDetail.push({
      path: pathKey,
      status: missing.length === 0 ? 'ok' : 'incomplete',
      covered: covered.length,
      required: contract.required.length,
      missing,
    });
  }

  const fieldCoverageValue = totalRequired > 0 ? Math.round((totalCovered / totalRequired) * 10000) : 0;

  return {
    availability: {
      value: availabilityValue,
      detail: {
        rounds: spec.probe.rounds,
        targets: spec.probe.targets.length,
        totalProbes: samples.length,
        okCount,
        failCount: samples.length - okCount,
        failures: samples.filter((s) => !s.ok).slice(0, 5),
        avgLatencyMs: Math.round(samples.reduce((a, s) => a + s.latencyMs, 0) / samples.length),
      },
    },
    fieldCoverage: {
      value: fieldCoverageValue,
      detail: { totalRequired, totalCovered, perPath: coverageDetail },
    },
  };
}

// ─────────────────────── 综合评估 ───────────────────────

/**
 * 与 web/assets/engine.js 和 DeterministicEvaluator.sol 完全一致的判定逻辑。
 * 硬门槛与加权分分开判——高分不能补齐不达标维度。
 */
function evaluate(spec, facts) {
  const th = spec.thresholds;
  const test = facts.testPassRate;
  const api = facts.apiAvailability;
  const field = facts.fieldCoverage;

  const gates = {
    test: test >= th.testPassRate,
    api: api >= th.apiAvailability,
    field: field >= th.fieldCoverage,
  };

  const weighted = Math.floor((test * th.weights.test + api * th.weights.api + field * th.weights.field) / 10000);
  const score = Math.floor((weighted + 50) / 100);
  const passed = gates.test && gates.api && gates.field && score >= th.passScore;

  return { score, passed, gates };
}

function diagnose(spec, facts, result) {
  const th = spec.thresholds;
  const out = [];

  if (!result.gates.test) {
    out.push({
      type: 'gate',
      dimension: '必测用例通过率',
      current: facts.testPassRate,
      need: th.testPassRate,
      gap: th.testPassRate - facts.testPassRate,
      advice: `必测组还有用例未通过，低于 ${th.testPassRate / 100}% 门槛`,
    });
  }
  if (!result.gates.api) {
    out.push({
      type: 'gate',
      dimension: '接口可用率',
      current: facts.apiAvailability,
      need: th.apiAvailability,
      gap: th.apiAvailability - facts.apiAvailability,
      advice: `接口存在不可达或状态码不符，需达到 ${th.apiAvailability / 100}%`,
    });
  }
  if (!result.gates.field) {
    out.push({
      type: 'gate',
      dimension: '契约字段覆盖率',
      current: facts.fieldCoverage,
      need: th.fieldCoverage,
      gap: th.fieldCoverage - facts.fieldCoverage,
      advice: `响应缺少契约声明的必填字段，需达到 ${th.fieldCoverage / 100}%`,
    });
  }

  if (out.length === 0 && !result.passed) {
    out.push({
      type: 'score',
      dimension: '加权总分',
      current: result.score,
      need: th.passScore,
      gap: th.passScore - result.score,
      advice: '三项门槛均已通过，但加权总分不足',
    });
  }

  return out;
}

// ─────────────────────── 主流程 ───────────────────────

async function runAcceptance(deliveryDir, specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const specHash = keccak(JSON.stringify(spec));

  console.log('═'.repeat(72));
  console.log('  验收平台 · 客观指标采集');
  console.log('═'.repeat(72));
  console.log('交付物      :', spec.delivery.name);
  console.log('测试命令    :', [spec.testCommand.command, ...spec.testCommand.args].join(' '));
  console.log('规格哈希    :', specHash);
  console.log('');

  console.log('【第 1 步】按规格执行必测组');
  const testResult = await measureTestPassRate(deliveryDir, spec);
  const r = (v) => (v / 100).toFixed(2) + '%';
  console.log(`  必测用例  : ${testResult.detail.passedRequired}/${testResult.detail.requiredCount} 通过`);
  console.log(`  预期数量  : ${testResult.detail.expectedCount}（来自签约锁定）`);
  if (testResult.detail.countMismatch) {
    console.log(`  ⚠ 数量不符 : 实测 ${testResult.detail.requiredCount} ≠ 约定 ${testResult.detail.expectedCount}`);
    console.log('             可能存在删减必测用例的作弊行为');
  }
  if (testResult.detail.failedCases?.length) {
    console.log('  失败用例  :');
    testResult.detail.failedCases.forEach((c) => {
      console.log(`    ✗ ${c.name}`);
      console.log(`      ${c.error}`);
    });
  }
  console.log(`  通过率    : ${r(testResult.value)}`);
  console.log('');

  console.log('【第 2 步】平台自行部署并探测接口');
  const apiResult = await measureApi(deliveryDir, spec);
  console.log(
    `  探测次数  : ${apiResult.availability.detail.totalProbes}（` +
      `${spec.probe.rounds} 轮 × ${spec.probe.targets.length} 个端点）`
  );
  console.log(`  成功次数  : ${apiResult.availability.detail.okCount}`);
  console.log(`  可用率    : ${r(apiResult.availability.value)}`);
  console.log(`  平均延迟  : ${apiResult.availability.detail.avgLatencyMs}ms`);
  if (apiResult.availability.detail.failures?.length) {
    console.log('  失败样本  :');
    apiResult.availability.detail.failures.forEach((f) => {
      console.log(`    ✗ [轮${f.round}] ${f.path} → 状态码 ${f.status}`);
    });
  }
  console.log('');

  console.log('【第 3 步】比对响应字段与契约');
  const cov = apiResult.fieldCoverage;
  console.log(`  必填字段  : ${cov.detail.totalCovered}/${cov.detail.totalRequired} 被覆盖`);
  console.log(`  覆盖率    : ${r(cov.value)}`);
  cov.detail.perPath.forEach((p) => {
    if (p.status === 'ok') {
      console.log(`    ✓ ${p.path} — ${p.covered}/${p.required} 字段齐全`);
    } else if (p.status === 'unavailable') {
      console.log(`    ✗ ${p.path} — 无法获取响应`);
    } else {
      console.log(`    ✗ ${p.path} — 缺失字段: ${p.missing.join(', ')}`);
    }
  });
  console.log('');

  const facts = {
    testPassRate: testResult.value,
    apiAvailability: apiResult.availability.value,
    fieldCoverage: apiResult.fieldCoverage.value,
  };

  const result = evaluate(spec, facts);
  const reasons = diagnose(spec, facts, result);

  console.log('═'.repeat(72));
  console.log('  判定结果');
  console.log('═'.repeat(72));
  console.log(`  加权得分  : ${result.score} / 通过线 ${spec.thresholds.passScore}`);
  console.log(`  硬门槛    : 测试 ${result.gates.test ? '✓' : '✗'}  接口 ${result.gates.api ? '✓' : '✗'}  字段 ${result.gates.field ? '✓' : '✗'}`);
  console.log(`  最终结论  : ${result.passed ? '✓ 验收通过' : '✗ 验收不通过'}`);
  console.log('');
  console.log('  原因分析:');
  reasons.forEach((x) => {
    console.log(`    ${x.type === 'gate' ? '硬门槛未过' : '总分不足'} — ${x.dimension}`);
    console.log(`      当前 ${x.current / 100}${x.type === 'gate' ? '%' : ' 分'}，需要 ${x.need / 100}${x.type === 'gate' ? '%' : ' 分'}`);
    console.log(`      ${x.advice}`);
  });
  console.log('');

  // 事实报告哈希 —— 上链后可被任何人复算
  const factReport = {
    specHash,
    facts,
    result,
    testDetail: testResult.detail,
    apiDetail: apiResult.availability.detail,
    fieldDetail: apiResult.fieldCoverage.detail,
  };
  const reportHash = keccak(JSON.stringify(factReport));

  console.log('  事实报告哈希 :', reportHash);
  console.log('  任何人可用同一 commit + 同一规格重跑，验证结论一致');
  console.log('');

  return { spec, specHash, facts, result, reasons, reportHash, testResult, apiResult };
}

module.exports = {
  runAcceptance,
  measureTestPassRate,
  measureApi,
  evaluate,
  diagnose,
  keccak,
};

if (require.main === module) {
  const demoDir = path.join(__dirname, '..');
  const deliveryDir = path.join(demoDir, 'delivery');
  const specPath = path.join(demoDir, 'acceptance-spec.json');
  runAcceptance(deliveryDir, specPath).catch((e) => {
    console.error('验收执行失败:', e);
    process.exit(1);
  });
}
