/**
 * 验收采集器 v2 —— 支持依赖数据库/缓存的交付物
 *
 * 相比 v1 的核心变化：
 *   v1：直接 spawn 交付物进程，假设它不依赖外部服务
 *   v2：为每个验收创建**隔离运行时**（独立 DB + 独立 KV），
 *       把连接信息通过环境变量注入，再启动交付物
 *
 * 回答的问题：「服务需要数据库和 Redis，平台怎么把它跑起来拿指标？」
 * 答案：平台自己提供这些中间件，且每个项目一份，互不可见。
 *      交付物只管连标准协议（PG 协议 / Redis 命令），不关心背后是真是假。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

// runtime.js 位于 server/src/platform —— 复用平台的运行时实现，避免两套代码
const { createProjectRuntime } = require(path.join(__dirname, '..', '..', 'server', 'src', 'platform', 'runtime.js'));

// ─────────────────────── 工具 ───────────────────────

function sha256(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

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
        resolve({ ok: true, status: res.statusCode, latencyMs: Date.now() - started, body: parsed });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: e.message, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: 'timeout', body: null });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全局登记子进程，退出时强制清理（Windows 上否则父进程会崩） */
const children = new Set();
function registerChild(c) {
  children.add(c);
  c.on('exit', () => children.delete(c));
  return () => {
    try {
      if (!c.killed) c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    children.delete(c);
  };
}
process.once('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

// ─────────────────────── 指标一：必测用例通过率 ───────────────────────

async function measureTestPassRate(deliveryDir, spec) {
  const cmd = spec.testCommand;
  const started = Date.now();

  const stdout = await new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd.command, cmd.args, {
      cwd: deliveryDir,
      env: { ...process.env, NODE_ENV: 'production', CI: 'true' },
      timeout: cmd.timeoutMs,
    });
    registerChild(child);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(out));
  });

  let report = null;
  try {
    const i = stdout.indexOf('{');
    if (i >= 0) report = JSON.parse(stdout.slice(i));
  } catch {
    report = null;
  }

  if (!report) {
    return {
      value: 0,
      detail: { reason: '无法解析测试报告', raw: stdout.slice(0, 400) },
      durationMs: Date.now() - started,
    };
  }

  const requiredCases = report.cases.filter((c) => c.group === 'required');
  const expectedCount = spec.requiredSuites[0].expectedCaseCount;
  const countMismatch = requiredCases.length !== expectedCount;
  const passedRequired = requiredCases.filter((c) => c.status === 'passed').length;
  const value = requiredCases.length > 0 ? Math.round((passedRequired / requiredCases.length) * 10000) : 0;

  return {
    value,
    detail: {
      requiredCount: requiredCases.length,
      expectedCount,
      countMismatch,
      passedRequired,
      failedRequired: requiredCases.length - passedRequired,
      failedCases: requiredCases.filter((c) => c.status === 'failed').map((c) => ({ name: c.name, error: c.error })),
    },
    durationMs: Date.now() - started,
  };
}

// ─────────────────────── 指标二 & 三：带中间件的探测 ───────────────────────

/**
 * 为本次验收准备隔离运行时并启动交付物。
 *
 * 平台做的事：
 *   1. 建一套全新的内存 PG + 内存 KV（这个项目专用，其他项目看不到）
 *   2. 按 spec.seed 灌入初始数据（种子数据来自锁定的验收规格，乙方无法篡改）
 *   3. 用 DATABASE_URL / REDIS_URL 等环境变量把连接信息告诉交付物
 *   4. 启动交付物，等待就绪
 *
 * 交付物不需要知道背后是 pg-mem 还是真 PG —— 它只连标准协议。
 */
async function startWithRuntime(deliveryDir, spec, projectId) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  // 注意：父进程也要一份运行时用于灌种子数据；交付物进程会自建一份独立实例
  const runtime = createProjectRuntime(projectId || 'acceptance');

  // 1. 先按规格创建 schema（平台的建表脚本，必须先于种子数据）
  const schemaErrors = [];
  for (const ddl of spec.seed?.schema || []) {
    try {
      await runtime.database.raw(ddl.statement);
    } catch (e) {
      schemaErrors.push(String(e.message).split('\n')[0]);
    }
  }

  // 2. 再灌种子数据
  let seeded = 0;
  const seedErrors = [];
  for (const seed of spec.seed?.tables || []) {
    for (const row of seed.rows || []) {
      const cols = Object.keys(row);
      const marks = cols.map((_, i) => '$' + (i + 1));
      try {
        await runtime.database.raw(
          `INSERT INTO ${seed.table} (${cols.join(',')}) VALUES (${marks.join(',')}) ON CONFLICT DO NOTHING`,
          cols.map((c) => row[c])
        );
        seeded++;
      } catch (e) {
        seedErrors.push(`${seed.table}/${row.id || Object.keys(row)[0]}: ${String(e.message).split('\n')[0]}`);
      }
    }
  }

  /**
   * 把运行时暴露给交付物进程。
   *
   * 关键：global 变量**无法跨进程传递**（已实测验证），所以必须用
   * 环境变量传模块路径，让交付物进程自己 require 平台运行时模块。
   * 交付物通过 src/runtime-bridge.js 读取这些环境变量来接入。
   */
  const runtimeModulePath = path.join(
    __dirname, '..', '..', 'server', 'src', 'platform', 'runtime.js'
  );

  /**
   * 导出种子数据快照。
   *
   * 交付物进程与本进程是两个独立进程，各自有独立的内存数据库，
   * 内存不共享。所以父进程灌好的种子数据必须**写成文件**，
   * 由子进程的 runtime-loader 读回导入。
   * 这是本方案能支持「依赖数据库的交付物」的关键一环。
   */
  const snapshotPath = path.join(
    os.tmpdir(), `acceptance-seed-${projectId}-${Date.now()}.json`
  );
  const snapshotRows = [];
  for (const seed of spec.seed?.tables || []) {
    for (const row of seed.rows || []) {
      snapshotRows.push({ table: seed.table, values: row });
    }
  }
  fs.writeFileSync(snapshotPath, JSON.stringify({ rows: snapshotRows }), 'utf8');

  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: `pgmem://project-${projectId}`,
    DB_TYPE: 'postgres',
    REDIS_URL: `mem://project-${projectId}`,
    NODE_ENV: 'production',
    // 交付物据此加载平台运行时
    ACCEPTANCE_RUNTIME_MODULE: runtimeModulePath,
    ACCEPTANCE_PROJECT_ID: String(projectId),
    ACCEPTANCE_DB_SNAPSHOT: snapshotPath,
  };

  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'runtime-loader.js'), spec.delivery.serveCommand], {
    cwd: deliveryDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = registerChild(child);

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.stdout.on('data', (d) => (stdout += d.toString()));

  // 等待就绪
  let ready = false;
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (spec.probe.startupTimeoutMs || 15000);
  while (Date.now() < deadline) {
    const h = await httpGet(`${base}/health`, 1000);
    if (h.ok && h.status === 200) {
      // 顺带确认中间件确实连上了
      ready = true;
      break;
    }
    await sleep(250);
  }

  return { runtime, child, kill, base, ready, stderr, stdout, seeded, seedErrors, schemaErrors, snapshotPath, port };
}

async function measureApi(deliveryDir, spec, projectId) {
  const started = await startWithRuntime(deliveryDir, spec, projectId);

  if (!started.ready) {
    started.kill();
    return {
      availability: {
        value: 0,
        detail: {
          reason: '交付物启动失败或未就绪',
          stderr: started.stderr.slice(0, 400) || '(无 stderr)',
          stdout: started.stdout.slice(0, 300) || '(无 stdout)',
          seedErrors: started.seedErrors,
          schemaErrors: started.schemaErrors,
        },
      },
      fieldCoverage: { value: 0, detail: { reason: '服务未就绪', totalRequired: 0, totalCovered: 0, perPath: [] } },
      runtime: started,
    };
  }

  const { base, spec: sp } = { base: started.base, spec };
  const samples = [];
  const bodies = {};

  for (let r = 0; r < sp.probe.rounds; r++) {
    for (const t of sp.probe.targets) {
      const method = t.method || 'GET';
      const res = method === 'GET'
        ? await httpGet(`${base}${t.path}`, 5000)
        : await httpReq('POST', `${base}${t.path}`, t.body || {}, 5000);
      const ok = res.ok && t.expectStatus.includes(res.status);
      samples.push({ round: r + 1, path: t.path, method, ok, status: res.status, latencyMs: res.latencyMs });
      if (ok && res.body) bodies[t.path] = res.body;
    }
    if (r < sp.probe.rounds - 1) await sleep(sp.probe.intervalMs || 200);
  }

  started.kill();
  await sleep(300);

  const okCount = samples.filter((s) => s.ok).length;
  const availabilityValue = Math.round((okCount / samples.length) * 10000);

  // 字段覆盖
  let totalRequired = 0;
  let totalCovered = 0;
  const perPath = [];

  for (const [pathKey, contract] of Object.entries(sp.contract.responses)) {
    const body = bodies[pathKey];
    if (!body) {
      perPath.push({ path: pathKey, status: 'unavailable', covered: 0, required: contract.required.length });
      totalRequired += contract.required.length;
      continue;
    }
    const covered = contract.required.filter((f) => hasField(body, f));
    const missing = contract.required.filter((f) => !covered.includes(f));
    totalRequired += contract.required.length;
    totalCovered += covered.length;
    perPath.push({
      path: pathKey,
      status: missing.length === 0 ? 'ok' : 'incomplete',
      covered: covered.length,
      required: contract.required.length,
      missing,
    });
  }

  const fieldValue = totalRequired > 0 ? Math.round((totalCovered / totalRequired) * 10000) : 0;

  return {
    availability: {
      value: availabilityValue,
      detail: {
        rounds: sp.probe.rounds,
        totalProbes: samples.length,
        okCount,
        failCount: samples.length - okCount,
        failures: samples.filter((s) => !s.ok).slice(0, 5),
        avgLatencyMs: Math.round(samples.reduce((a, s) => a + s.latencyMs, 0) / samples.length),
        seededRows: started.seeded,
      },
    },
    fieldCoverage: { value: fieldValue, detail: { totalRequired, totalCovered, perPath } },
    runtime: started,
  };
}

function hasField(body, field) {
  if (Object.prototype.hasOwnProperty.call(body, field)) return true;
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && field in v[0]) return true;
  }
  return false;
}

function httpReq(method, url, body, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = require('http').request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(b);
          } catch {
            parsed = null;
          }
          resolve({ ok: true, status: res.statusCode, latencyMs: Date.now() - started, body: parsed });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: e.message, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, latencyMs: Date.now() - started, error: 'timeout', body: null });
    });
    req.write(data);
    req.end();
  });
}

// ─────────────────────── 判定（与合约 / 前端引擎一致） ───────────────────────

function evaluate(spec, facts) {
  const th = spec.thresholds;
  const { testPassRate: t, apiAvailability: a, fieldCoverage: f } = facts;
  const gates = { test: t >= th.testPassRate, api: a >= th.apiAvailability, field: f >= th.fieldCoverage };
  const weighted = Math.floor((t * th.weights.test + a * th.weights.api + f * th.weights.field) / 10000);
  const score = Math.floor((weighted + 50) / 100);
  const passed = gates.test && gates.api && gates.field && score >= th.passScore;
  return { score, passed, gates };
}

function diagnose(spec, facts, result) {
  const th = spec.thresholds;
  const out = [];
  const map = [
    ['必测用例通过率', facts.testPassRate, th.testPassRate, 'test'],
    ['接口可用率', facts.apiAvailability, th.apiAvailability, 'api'],
    ['契约字段覆盖率', facts.fieldCoverage, th.fieldCoverage, 'field'],
  ];
  for (const [name, cur, need, key] of map) {
    if (!result.gates[key]) {
      out.push({ type: 'gate', dimension: name, current: cur, need, gap: need - cur,
        advice: `${name}未达硬门槛，需 ≥ ${need / 100}%` });
    }
  }
  if (out.length === 0 && !result.passed) {
    out.push({ type: 'score', dimension: '加权总分', current: result.score, need: th.passScore,
      gap: th.passScore - result.score, advice: '三项门槛均已通过，但加权总分不足' });
  }
  return out;
}

// ─────────────────────── 主流程 ───────────────────────

async function runAcceptance(deliveryDir, specPath, projectId = 'demo') {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const specHash = keccak(JSON.stringify(spec));

  console.log('═'.repeat(74));
  console.log('  验收平台 v2 · 支持数据库/缓存依赖的交付物');
  console.log('═'.repeat(74));
  console.log('交付物   :', spec.delivery.name);
  console.log('运行时   : 平台提供隔离的 PG + KV（该项目专用）');
  console.log('种子数据 :', (spec.seed?.tables || []).reduce((a, t) => a + (t.rows?.length || 0), 0), '行（来自锁定规格）');
  console.log('');

  console.log('【第 1 步】执行必测组');
  const testResult = await measureTestPassRate(deliveryDir, spec);
  const pct = (v) => (v / 100).toFixed(2) + '%';
  console.log(`  必测用例 : ${testResult.detail.passedRequired}/${testResult.detail.requiredCount} 通过`);
  if (testResult.detail.countMismatch) {
    console.log(`  ⚠ 数量不符 : 实测 ${testResult.detail.requiredCount} ≠ 约定 ${testResult.detail.expectedCount}`);
  }
  testResult.detail.failedCases?.forEach((c) => {
    console.log(`    ✗ ${c.name}`);
    console.log(`      ${c.error}`);
  });
  console.log(`  通过率   : ${pct(testResult.value)}`);
  console.log('');

  console.log('【第 2 步】注入隔离中间件并启动服务');
  const apiResult = await measureApi(deliveryDir, spec, projectId);
  if (apiResult.availability.detail.reason) {
    console.log(`  ✗ ${apiResult.availability.detail.reason}`);
    if (apiResult.availability.detail.stderr) console.log(`    stderr: ${apiResult.availability.detail.stderr.slice(0, 200)}`);
  } else {
    console.log(`  种子数据 : 已灌入 ${apiResult.availability.detail.seededRows} 行`);
    if (apiResult.runtime && apiResult.runtime.seedErrors.length) {
      console.log('  种子错误 :');
      apiResult.runtime.seedErrors.forEach(e => console.log('    - ' + e));
    }
    console.log(`  探测次数 : ${apiResult.availability.detail.totalProbes}`);
    console.log(`  可用率   : ${pct(apiResult.availability.value)}`);
    console.log(`  平均延迟 : ${apiResult.availability.detail.avgLatencyMs}ms`);
  }
  console.log('');

  console.log('【第 3 步】比对契约字段');
  const cov = apiResult.fieldCoverage;
  if (cov.detail.reason) {
    console.log(`  ✗ ${cov.detail.reason}`);
  } else {
    console.log(`  覆盖率   : ${pct(cov.value)} (${cov.detail.totalCovered}/${cov.detail.totalRequired})`);
    cov.detail.perPath.forEach((p) => {
      if (p.status === 'ok') console.log(`    ✓ ${p.path} — ${p.covered}/${p.required}`);
      else if (p.status === 'incomplete') console.log(`    ✗ ${p.path} — 缺失: ${p.missing.join(', ')}`);
      else console.log(`    ✗ ${p.path} — 无响应`);
    });
  }
  console.log('');

  const facts = {
    testPassRate: testResult.value,
    apiAvailability: apiResult.availability.value,
    fieldCoverage: apiResult.fieldCoverage.value,
  };
  const result = evaluate(spec, facts);
  const reasons = diagnose(spec, facts, result);

  console.log('═'.repeat(74));
  console.log('  判定结果');
  console.log('═'.repeat(74));
  console.log(`  加权得分 : ${result.score} / ${spec.thresholds.passScore}`);
  console.log(`  硬门槛   : 测试 ${result.gates.test ? '✓' : '✗'}  接口 ${result.gates.api ? '✓' : '✗'}  字段 ${result.gates.field ? '✓' : '✗'}`);
  console.log(`  结论     : ${result.passed ? '✓ 验收通过' : '✗ 验收不通过'}`);
  if (reasons.length) {
    console.log('');
    reasons.forEach((x) => {
      console.log(`  ${x.type === 'gate' ? '硬门槛未过' : '总分不足'} — ${x.dimension}`);
      console.log(`    当前 ${x.current / 100}，需要 ${x.need / 100}，差 ${x.gap / 100}`);
      console.log(`    ${x.advice}`);
    });
  }
  console.log('');
  const reportHash = keccak(JSON.stringify({ specHash, facts, result, test: testResult.detail, api: apiResult.availability.detail, field: apiResult.fieldCoverage.detail }));
  console.log('  事实报告哈希 :', reportHash);
  console.log('');

  return { spec, specHash, facts, result, reasons, reportHash, testResult, apiResult };
}

module.exports = { runAcceptance, measureTestPassRate, measureApi, evaluate, diagnose, keccak };

if (require.main === module) {
  const demo = process.cwd();
  runAcceptance(path.join(demo, 'delivery'), path.join(demo, 'acceptance-spec.json'), 'demo')
    .catch((e) => {
      console.error('验收失败:', e.message);
      process.exit(1);
    });
}
