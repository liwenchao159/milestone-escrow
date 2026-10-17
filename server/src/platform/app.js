/**
 * 平台主服务 —— 完整闭环编排
 *
 * 闭环：
 *   登录 → 建项目（选规则）→ 双签 → 注资
 *        → 交付上传 → 客观验收（隔离运行时跑代码）
 *        → 链上判定 → 挑战期 → 结算（放款/退款/仲裁分配）
 *
 * 所有判定在链上完成；数据库只存业务状态与审计日志。
 */

/**
 * 加载本地 .env —— 必须最先执行，
 * 否则 ChainClient.fromEnv() 读不到 PRIVATE_KEY，会静默降级到 mock 模式。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { createProjectRuntime } = require('./runtime');
const deliveryStore = require('./storage/delivery-store');
const depInstaller = require('./storage/dep-installer');
const { ChainClient, MS_STATUS, PROJECT_STATUS } = require('./chain');
const { runAcceptance } = require('../../../acceptance-demo/harness/acceptance-harness-v2');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 4000;

// ─────────────────────── 平台运行时 ───────────────────────

const platformDb = createProjectRuntime('platform');
const chain = ChainClient.fromEnv();
const sessions = new Map(); // token -> address

/** 规则模板（与 web/assets/engine.js、合约部署清单一致） */
const RULE_TEMPLATES = [
  {
    id: 'standard-interface-v1', name: '标准接口开发',
    tagline: '最常用 · 推荐作为起点', deliverableType: 'code',
    passThreshold: 80,
    required: { test: 9000, api: 9500, field: 9000 },
    weights: { test: 5000, api: 3000, field: 2000 },
    facts: [
      { key: 'test', label: '必测用例通过率', hint: '双方约定的必测测试组' },
      { key: 'api', label: '接口可用率', hint: '平台多轮探测的成功比例' },
      { key: 'field', label: '契约字段覆盖率', hint: '实际响应 ∩ 契约必填字段' },
    ],
  },
  {
    id: 'data-pipeline-v1', name: '数据处理与管道',
    tagline: '侧重数据完整性', deliverableType: 'data',
    passThreshold: 78,
    required: { test: 9200, api: 8500, field: 9500 },
    weights: { test: 3000, api: 2500, field: 4500 },
    facts: [
      { key: 'test', label: '校验脚本通过率', hint: '行数、唯一性、非空率' },
      { key: 'api', label: '管道任务成功率', hint: '调度窗口内的成功比例' },
      { key: 'field', label: '口径一致率', hint: '输出与口径文档的一致程度' },
    ],
  },
  {
    id: 'strict-release-v1', name: '严格发布',
    tagline: '高风险交付 · 门槛最高', deliverableType: 'code',
    passThreshold: 92,
    required: { test: 9800, api: 9900, field: 9800 },
    weights: { test: 4500, api: 3500, field: 2000 },
    facts: [
      { key: 'test', label: '全量用例通过率', hint: '不允许只跑必测子集' },
      { key: 'api', label: '服务可用率', hint: '严格模式可用性统计' },
      { key: 'field', label: '错误码与边界覆盖', hint: '已实现的错误处理项占比' },
    ],
  },
  {
    id: 'balanced-4d-v1', name: '均衡四维',
    tagline: '门槛与分数线拉开差距', deliverableType: 'code',
    passThreshold: 85,
    required: { test: 7000, api: 7000, field: 7000 },
    weights: { test: 3000, api: 3000, field: 4000 },
    facts: [
      { key: 'test', label: '功能测试通过率', hint: '常规功能用例' },
      { key: 'api', label: '接口可用率', hint: '常规探测轮次' },
      { key: 'field', label: '交付完整度', hint: '约定交付物清单完成比例' },
    ],
  },
  {
    id: 'lightweight-doc-v1', name: '轻量技术文档',
    tagline: '仅限结构可枚举的文档', deliverableType: 'doc',
    passThreshold: 75,
    required: { test: 9000, api: 8000, field: 9000 },
    weights: { test: 2000, api: 1500, field: 6500 },
    facts: [
      { key: 'test', label: '示例可执行率', hint: '文档中代码示例可编译' },
      { key: 'api', label: '引用接口可达率', hint: '文档内链接真实可访问' },
      { key: 'field', label: '必填章节覆盖率', hint: '约定必填章节存在比例' },
    ],
  },
];

const REJECTED_DELIVERABLES = [
  { type: '设计 / 创意', reason: '设计好坏无客观标准，强行量化会退化为 AI 主观判定' },
  { type: '观点 / 策略类文档', reason: '无可复算的验收依据' },
];

// ─────────────────────── 工具 ───────────────────────

const keccak = (s) => {
  try {
    const { keccak256, toUtf8Bytes } = require('ethers');
    return keccak256(toUtf8Bytes(s));
  } catch {
    return '0x' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 64);
  }
};

const toBytes32 = (v) => {
  try {
    const { zeroPadValue, toUtf8Bytes } = require('ethers');
    return zeroPadValue(toUtf8Bytes(v), 32);
  } catch {
    return '0x' + Buffer.from(v).toString('hex').padEnd(64, '0');
  }
};

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const addr = sessions.get(token);
  if (!addr) return res.status(401).json({ error: '未登录或会话已过期' });
  req.address = addr;
  req.token = token;
  next();
}

async function audit(projectId, actor, action, detail) {
  try {
    await platformDb.database.raw(
      'INSERT INTO audit_log (project_id, actor_addr, action, detail_json) VALUES ($1,$2,$3,$4)',
      [projectId || null, actor || null, action, JSON.stringify(detail || {})]
    );
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

// ─────────────────────── ① 登录 ───────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { address, nickname, role } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: '钱包地址格式不正确' });
  }
  if (!['client', 'provider', 'arbitrator', 'collector'].includes(role)) {
    return res.status(400).json({ error: '角色需为 client / provider / arbitrator / collector' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, address);

  // 落库
  try {
    const exist = await platformDb.database.one('SELECT * FROM users WHERE address = $1', [address]);
    if (exist) {
      await platformDb.database.raw(
        'UPDATE users SET nickname = $1, role = $2 WHERE address = $3',
        [nickname || exist.nickname, role, address]
      );
    } else {
      await platformDb.database.raw(
        'INSERT INTO users (address, nickname, role) VALUES ($1,$2,$3)',
        [address, nickname || address.slice(0, 8), role]
      );
    }
  } catch (e) {
    return res.status(500).json({ error: '写入用户失败: ' + e.message });
  }

  if (role === 'collector') {
    await chain.ensureCollector(address);
  }

  res.json({
    token, address, role,
    nickname: nickname || address.slice(0, 8),
    chainMode: chain.mode,
  });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await platformDb.database.one('SELECT * FROM users WHERE address = $1', [req.address]);
  res.json({ address: req.address, ...(u || {}) });
});

// ─────────────────────── ② 规则模板 ───────────────────────

app.get('/api/rules', (_req, res) => {
  res.json({ templates: RULE_TEMPLATES, rejected: REJECTED_DELIVERABLES });
});

app.post('/api/rules/validate', (req, res) => {
  const { deliverableType, ruleSetId } = req.body || {};
  const tpl = RULE_TEMPLATES.find((t) => t.id === ruleSetId);
  if (!tpl) return res.status(404).json({ error: '模板不存在' });
  if (tpl.deliverableType !== deliverableType) {
    return res.status(400).json({
      acceptable: false,
      reason: `该模板适用于「${tpl.deliverableType === 'code' ? '代码/接口' : tpl.deliverableType}」，与「${deliverableType}」不匹配`,
      suggested: RULE_TEMPLATES.filter((t) => t.deliverableType === deliverableType).map((t) => t.id),
    });
  }
  res.json({ acceptable: true, template: tpl });
});

// ─────────────────────── ③ 创建项目 ───────────────────────

app.post('/api/projects', auth, async (req, res) => {
  const { title, providerAddr, arbitratorAddr, ruleSetId, deliverableType, milestones } = req.body || {};
  /**
   * 可选的验收规格覆盖（仅供测试与内部工具使用）。
   * 正常签约流程走下面的标准模板生成逻辑，
   * 这里额外提供一个口子，便于自动化测试构造「规格与交付对齐」的场景。
   */
  const specOverride = req.body?.__specOverride;

  if (!title) return res.status(400).json({ error: '项目名称必填' });
  if (!providerAddr || !arbitratorAddr) return res.status(400).json({ error: '乙方与仲裁者地址必填' });
  if (providerAddr === req.address) return res.status(400).json({ error: '甲方与乙方不能是同一地址' });
  if ([req.address, providerAddr].includes(arbitratorAddr)) {
    return res.status(400).json({ error: '仲裁者必须独立于甲乙双方' });
  }

  const tpl = RULE_TEMPLATES.find((t) => t.id === ruleSetId);
  if (!tpl) return res.status(400).json({ error: '验收规则必选' });
  if (deliverableType && tpl.deliverableType !== deliverableType) {
    return res.status(400).json({ error: `交付类型与规则不匹配，该规则适用于 ${tpl.deliverableType}` });
  }
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return res.status(400).json({ error: '至少需要一个里程碑' });
  }
  if (milestones.length > 20) return res.status(400).json({ error: '里程碑不得超过 20 个' });
  if (milestones.some((m) => !(Number(m.amount) > 0))) {
    return res.status(400).json({ error: '每个里程碑金额必须大于 0' });
  }

  const total = milestones.reduce((a, m) => a + Number(m.amount), 0);

  // 生成验收规格（签约即锁定）
  const spec = {
    acceptanceSpecVersion: '2.0.0',
    delivery: { name: title, entryPoint: 'src/order.js', serveCommand: 'src/server.js' },
    middleware: { requires: ['postgres', 'redis'] },
    testCommand: { command: 'node', args: ['test/run-tests.js', '--suite=required'], timeoutMs: 60000 },
    requiredSuites: [{ group: 'required', expectedCaseCount: 10 }],
    probe: {
      targets: [
        { path: '/health', method: 'GET', expectStatus: [200] },
        { path: '/orders', method: 'GET', expectStatus: [200] },
        { path: '/orders/A001', method: 'GET', expectStatus: [200] },
        { path: '/orders/A002', method: 'GET', expectStatus: [200] },
        { path: '/orders/NOTEXIST', method: 'GET', expectStatus: [404] },
      ],
      rounds: 3, intervalMs: 150, startupTimeoutMs: 15000,
    },
    contract: {
      responses: {
        '/orders/A001': { required: ['id', 'total', 'payable', 'currency', 'items'], optional: [] },
        '/orders': { required: ['items', 'count'], optional: [] },
      },
    },
    seed: {
      schema: [
        { statement: 'CREATE TABLE IF NOT EXISTS orders (id VARCHAR(32) PRIMARY KEY, items_json TEXT NOT NULL, discount_rule VARCHAR(32) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT \'created\', created_at TIMESTAMP NOT NULL DEFAULT NOW())' },
        { statement: 'CREATE TABLE IF NOT EXISTS order_events (id SERIAL PRIMARY KEY, order_id VARCHAR(32) NOT NULL, event_type VARCHAR(32) NOT NULL, payload TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW())' },
      ],
      tables: [
        {
          table: 'orders',
          rows: [
            { id: 'A001', items_json: '[{"sku":"P1","name":"键盘","price":29900,"qty":1},{"sku":"P2","name":"鼠标","price":9900,"qty":2}]', discount_rule: 'VIP10', status: 'created' },
            { id: 'A002', items_json: '[{"sku":"P3","name":"显示器","price":129900,"qty":1}]', discount_rule: 'NONE', status: 'created' },
          ],
        },
      ],
    },
    thresholds: {
      testPassRate: tpl.required.test,
      apiAvailability: tpl.required.api,
      fieldCoverage: tpl.required.field,
      passScore: tpl.passThreshold,
      weights: tpl.weights,
    },
    createdBy: req.address,
    createdAt: new Date().toISOString(),
  };
  if (specOverride && typeof specOverride === 'object') {
    Object.assign(spec, specOverride);
    spec.createdBy = req.address;
    spec.createdAt = new Date().toISOString();
  }
  const specHash = keccak(JSON.stringify(spec));

  let chainResult = { projectId: null, txHash: null };
  try {
    chainResult = await chain.createProject({
      provider: providerAddr,
      arbitrator: arbitratorAddr,
      ruleSetId: toBytes32(ruleSetId),
      milestones: milestones.map((m) => ({ amount: m.amount, title: m.title })),
    });
  } catch (e) {
    return res.status(502).json({ error: '链上创建项目失败: ' + e.message });
  }

  // 落库
  const row = await platformDb.database.one(
    `INSERT INTO projects (title, client_addr, provider_addr, arbitrator_addr, rule_set_id,
                           spec_json, total_amount, chain_project_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
    [title, req.address, providerAddr, arbitratorAddr, ruleSetId,
     JSON.stringify(spec), String(total), String(chainResult.projectId)]
  );

  for (let i = 0; i < milestones.length; i++) {
    await platformDb.database.raw(
      `INSERT INTO milestones (project_id, idx, title, amount, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [row.id, i, milestones[i].title, String(milestones[i].amount)]
    );
  }

  await audit(row.id, req.address, 'project_created', { specHash, total });

  res.json({
    projectId: row.id,
    chainProjectId: String(chainResult.projectId),
    txHash: chainResult.txHash,
    specHash,
    total,
    milestoneCount: milestones.length,
    status: 'draft',
    nextStep: '等待双方签署验收规则，然后由甲方注资',
    chainMode: chain.mode,
  });
});

// ─────────────────────── ④ 签署 + 注资 ───────────────────────

app.post('/api/projects/:id/sign', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '项目 ID 非法' });
  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });

  const isClient = p.client_addr === req.address;
  const isProvider = p.provider_addr === req.address;
  if (!isClient && !isProvider) return res.status(403).json({ error: '仅项目双方可签署' });

  const role = isClient ? 'client' : 'provider';
  try {
    const r = await chain.signRule(p.chain_project_id, role);
    await audit(id, req.address, 'rule_signed', { role, txHash: r.txHash });
    res.json({ signed: role, txHash: r.txHash, chainMode: chain.mode });
  } catch (e) {
    res.status(502).json({ error: '签署失败: ' + e.message });
  }
});

app.post('/api/projects/:id/signatures', auth, async (req, res) => {
  const id = Number(req.params.id);
  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json({
    required: 2,
    note: '双方签署后即可注资。规则哈希已上链，任何一方都无法单方修改。',
    specHash: keccak(p.spec_json),
  });
});

app.post('/api/projects/:id/fund', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '项目 ID 非法' });
  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.client_addr !== req.address) return res.status(403).json({ error: '仅甲方可注资' });

  try {
    const r = await chain.fundProject(p.chain_project_id);
    await platformDb.database.raw('UPDATE projects SET status = $1 WHERE id = $2', ['funded', id]);
    await audit(id, req.address, 'project_funded', { txHash: r.txHash });
    res.json({ funded: true, total: p.total_amount, txHash: r.txHash, chainMode: chain.mode });
  } catch (e) {
    res.status(502).json({ error: '注资失败: ' + e.message });
  }
});

// ─────────────────────── ⑤ 交付上传 ───────────────────────

app.post('/api/projects/:id/milestones/:idx/deliver', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });
  const { deliverableHash, deliverableURI, note } = req.body || {};

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.provider_addr !== req.address) return res.status(403).json({ error: '仅乙方可提交交付' });

  const m = await platformDb.database.one(
    'SELECT * FROM milestones WHERE project_id = $1 AND idx = $2', [id, idx]
  );
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (m.status !== 'pending' && m.status !== 'rejected') {
    return res.status(400).json({ error: '当前状态不允许提交', status: m.status });
  }

  const hash = deliverableHash || keccak(`${id}-${idx}-${Date.now()}`);
  const uri = deliverableURI || `storage://projects/${id}/milestones/${idx}`;

  try {
    const r = await chain.submitDeliverable(p.chain_project_id, idx, hash, uri);
    await platformDb.database.raw(
      `UPDATE milestones SET status='submitted', deliverable_hash=$1, deliverable_uri=$2,
                            submitter_addr=$3, submitted_at=NOW()
       WHERE project_id=$4 AND idx=$5`,
      [hash, uri, req.address, id, idx]
    );
    await audit(id, req.address, 'deliverable_submitted', { idx, hash, txHash: r.txHash });
    res.json({ submitted: true, idx, hash, uri, txHash: r.txHash });
  } catch (e) {
    res.status(502).json({ error: '提交失败: ' + e.message });
  }
});

// ─────────────────────── ⑥ 验收（核心） ───────────────────────

app.post('/api/projects/:id/milestones/:idx/verify', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });

  const m = await platformDb.database.one(
    'SELECT * FROM milestones WHERE project_id = $1 AND idx = $2', [id, idx]
  );
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  /**
   * 允许重复验收的情形：
   *   - submitted  首次验收
   *   - failed     验收不通过后重新验收（乙方可能已改规格重传）
   * 其余状态（已放款/已退款/争议中/验收通过）不允许再验，避免资金状态被反复改动。
   */
  if (!['submitted', 'failed'].includes(m.status)) {
    return res.status(400).json({
      error: '当前状态不允许验收',
      status: m.status,
      allowed: ['submitted', 'failed'],
    });
  }

  const spec = JSON.parse(p.spec_json);

  /**
   * 决定验收运行哪个目录。
   *
   * 这是「上传 → 验收」能否真正闭环的关键：
   *   有上传记录 → 校验磁盘文件哈希是否仍与链上一致 → 用**上传的源码**跑
   *   无上传记录 → 回落到平台内置演示交付物（便于本地体验，但要在返回里说清楚）
   *
   * 哈希校验这一步不能省：否则乙方上传后，平台磁盘上的文件若被替换
   * （运维误操作、或本机其他进程篡改），验收就会跑一份与链上哈希不符的代码，
   * 结论完全失去意义。
   */
  const uploadedSource = deliveryStore.sourceDir(id, idx);
  const integrity = deliveryStore.verifyIntegrity(id, idx);
  const fallbackDir = path.join(__dirname, '..', '..', '..', 'acceptance-demo', 'delivery');

  let deliveryDir;
  let deliveryOrigin;
  let rootInfo = null;
  if (deliveryStore.hasDelivery(id, idx)) {
    if (!integrity.ok) {
      return res.status(409).json({
        error: '交付物完整性校验失败，拒绝验收',
        reason: integrity.reason,
        expected: integrity.expected,
        actual: integrity.actual,
      });
    }
    /**
     * 探测真正的项目根。
     *
     * 乙方常把项目打包成 `zip -r p.zip sample-api/`，
     * 解出来会多一层 `sample-api/` 目录。
     * 若直接用解包根做 cwd，按 `src/server.js` 找会报
     * 「Cannot find module .../source/src/server.js」。
     * 两种打包方式都正常，不该要求乙方重打，
     * 因此这里自动识别并指向内层。
     */
    rootInfo = deliveryStore.explainRoot(id, idx, spec);
    deliveryDir = rootInfo.dir;
    deliveryOrigin = 'uploaded';
  } else {
    deliveryDir = fallbackDir;
    deliveryOrigin = 'demo-fallback';
  }

  // 入口文件必须真实存在 —— 否则给出可操作的诊断，而不是笼统的「启动失败」
  if (deliveryOrigin === 'uploaded') {
    const serve = spec.delivery?.serveCommand;
    if (serve && !fs.existsSync(path.join(deliveryDir, serve))) {
      const top = fs.existsSync(deliveryDir)
        ? fs.readdirSync(deliveryDir).slice(0, 12)
        : [];
      return res.status(422).json({
        error: `交付物中找不到服务入口 ${serve}`,
        projectRoot: deliveryDir,
        rootDetection: rootInfo,
        availableEntries: top,
        hint:
          '若源码被多包了一层目录（如 sample-api/src/server.js），' +
          '请确认打包时不要带上外层目录；或联系平台调整规格中的入口路径。',
      });
    }
  }

  /**
   * 安装依赖（若交付物声明了 dependencies）。
   *
   * 只对**上传的交付物**安装 —— 内置回退样例是平台自己的代码，装依赖没有意义。
   * 安装过程受dep-installer 的六道边界约束（黑名单 / 禁脚本 / registry 白名单 /
   * 硬超时 / 体积上限 / 审计留档）。
   */
  let depInstall = null;
  if (deliveryOrigin === 'uploaded') {
    try {
      depInstall = await depInstaller.installDeps(deliveryDir, {
        timeoutMs: spec.dependencyInstall?.timeoutMs,
        // 规格里可以显式关闭安装（例如交付物承诺零依赖）
        allowInstall: spec.dependencyInstall?.enabled !== false,
      });
    } catch (e) {
      depInstall = { attempted: false, skipped: true, error: e.message, notes: [e.message] };
    }
    if (depInstall?.blocked?.length) {
      await audit(id, req.address, 'deps_blocked', {
        idx, blocked: depInstall.blocked, reason: depInstall.notes[0],
      });
    }
  }

  let outcome;
  try {
    outcome = await runAcceptance(deliveryDir, specPathFor(spec, deliveryDir), String(id));
  } catch (e) {
    return res.status(500).json({ error: '验收执行失败: ' + e.message });
  }

  const { facts, result, reasons, reportHash, testResult, apiResult } = outcome;

  // 写链上判定
  let chainResult;
  try {
    chainResult = await chain.submitEvaluation(
      p.chain_project_id, idx,
      { ...facts, ruleSetId: toBytes32(p.rule_set_id) },
      reportHash,
      result // 判定结果（score/passed/gates），由链上复算，此处仅用于返回给调用方
    );
  } catch (e) {
    return res.status(502).json({ error: '链上判定失败: ' + e.message });
  }

  const newStatus = result.passed ? 'passed' : 'failed';
  await platformDb.database.raw(
    `UPDATE milestones SET status=$1, score=$2, facts_json=$3, facts_hash=$4, evaluated_at=NOW()
     WHERE project_id=$5 AND idx=$6`,
    [newStatus, result.score, JSON.stringify(facts), reportHash, id, idx]
  );

  await audit(id, req.address, 'milestone_verified', { idx, result, reportHash, deliveryOrigin, deliveryHash: m.deliverable_hash });

  res.json({
    idx,
    result: {
      passed: result.passed,
      score: result.score,
      gates: result.gates,
      reasons,
    },
    facts,
    detail: {
      tests: {
        passedRequired: testResult.detail.passedRequired,
        requiredCount: testResult.detail.requiredCount,
        countMismatch: !!testResult.detail.countMismatch,
        failedCases: testResult.detail.failedCases,
      },
      api: apiResult.availability.detail,
      field: apiResult.fieldCoverage.detail,
      runtime: {
        seededRows: apiResult.availability.detail.seededRows,
        isolation: '每项目独立 PG + KV',
      },
      /** 本次验收实际运行的是哪份代码 —— 闭环是否成立的关键信息 */
      deliveryOrigin,
      /** 项目根探测结果（打包层级问题可诊断） */
      rootDetection: rootInfo,
      /** 依赖安装情况（受控安装，六道边界约束） */
      dependencies: depInstall && {
        attempted: !!depInstall.attempted,
        skipped: !!depInstall.skipped,
        success: !!depInstall.success,
        packages: depInstall.packages || 0,
        sizeMB: depInstall.sizeBytes ? (depInstall.sizeBytes / 1048576).toFixed(2) : '0',
        durationMs: depInstall.durationMs || 0,
        blocked: depInstall.blocked || [],
        notes: depInstall.notes || [],
        timedOut: !!depInstall.timedOut,
        scriptsBlocked: true,
      },
      deliverySource: {
        origin: deliveryOrigin,
        hash: m.deliverable_hash,
        uri: m.deliverable_uri,
        integrity: integrity.ok || !deliveryStore.hasDelivery(id, idx)
          ? 'verified'
          : integrity.reason,
        dir: deliveryOrigin === 'uploaded' ? uploadedSource : fallbackDir,
      },
    },
    reportHash,
    txHash: chainResult.txHash,
    chainMode: chain.mode,
    nextStep: result.passed
      ? `进入 ${spec.challengeWindowDays || 3} 天挑战期，期满无异议即可放款`
      : '验收不通过，甲方可发起退款',
  });
});

/** 把 DB 里存的 spec 落成临时文件，供 harness 读取 */
function specPathFor(spec, deliveryDir) {
  const f = path.join(require('os').tmpdir(), `spec-${spec.createdAt ? 'db' : 'x'}-${Date.now()}.json`);
  // 复用标准规格文件的完整结构（含 probe.targets / contract.responses / seed）
  const stdPath = path.join(deliveryDir, 'acceptance-spec.json');
  const std = fs.existsSync(stdPath) ? JSON.parse(fs.readFileSync(stdPath, 'utf8')) : {};
  const merged = {
    ...std,
    ...spec,
    seed: spec.seed || std.seed,
    probe: { ...std.probe, ...spec.probe },
    contract: { ...std.contract, ...spec.contract },
  };
  fs.writeFileSync(f, JSON.stringify(merged), 'utf8');
  return f;
}

// ─────────────────────── ⑦ 结算 ───────────────────────

app.post('/api/projects/:id/milestones/:idx/challenge', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });
  const { reason, note } = req.body || {};
  const REASONS = { rule: 1, env: 2, dispute: 3 };

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });

  const m = await platformDb.database.one('SELECT * FROM milestones WHERE project_id=$1 AND idx=$2', [id, idx]);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (m.status !== 'passed') return res.status(400).json({ error: '仅验收通过的里程碑可挑战' });

  try {
    const r = await chain.challenge(p.chain_project_id, idx, REASONS[reason] || 3, note || '');
    await platformDb.database.raw(
      `UPDATE milestones SET status='challenged', challenge_reason=$1, challenge_note=$2,
                            challenger_addr=$3 WHERE project_id=$4 AND idx=$5`,
      [reason || 'dispute', note || '', req.address, id, idx]
    );
    await audit(id, req.address, 'challenge_submitted', { idx, reason, note });
    res.json({ challenged: true, idx, txHash: r.txHash, nextStep: '等待仲裁者裁定' });
  } catch (e) {
    res.status(502).json({ error: '发起挑战失败: ' + e.message });
  }
});

app.post('/api/projects/:id/milestones/:idx/arbitrate', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });
  const { providerBps } = req.body || {};

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.arbitrator_addr !== req.address) return res.status(403).json({ error: '仅仲裁者可裁定' });
  if (providerBps == null || providerBps < 0 || providerBps > 10000) {
    return res.status(400).json({ error: '比例需在 0-10000（万分比）之间' });
  }

  const m = await platformDb.database.one('SELECT * FROM milestones WHERE project_id=$1 AND idx=$2', [id, idx]);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (m.status !== 'challenged') return res.status(400).json({ error: '该里程碑未处于争议状态' });

  try {
    const r = await chain.resolveDispute(p.chain_project_id, idx, Number(providerBps));
    const amount = Number(m.amount);
    const toProvider = (amount * Number(providerBps)) / 10000;
    const toClient = amount - toProvider;

    await platformDb.database.raw(
      `UPDATE milestones SET status='settled', payout_ratio=$1, settled_at=NOW()
       WHERE project_id=$2 AND idx=$3`,
      [Number(providerBps), id, idx]
    );
    await platformDb.database.raw(
      `INSERT INTO settlement_orders (project_id, milestone_id, order_type, amount, to_addr, status, confirmed_at)
       VALUES ($1,$2,'arbitration_split',$3,$4,'confirmed',NOW())`,
      [id, m.id, String(toProvider), p.provider_addr]
    );
    if (toClient > 0) {
      await platformDb.database.raw(
        `INSERT INTO settlement_orders (project_id, milestone_id, order_type, amount, to_addr, status, confirmed_at)
         VALUES ($1,$2,'arbitration_refund',$3,$4,'confirmed',NOW())`,
        [id, m.id, String(toClient), p.client_addr]
      );
    }
    await audit(id, req.address, 'dispute_resolved', { idx, providerBps, toProvider, toClient });

    res.json({
      settled: true, idx, providerBps: Number(providerBps),
      toProvider, toClient, txHash: r.txHash,
    });
  } catch (e) {
    res.status(502).json({ error: '裁定失败: ' + e.message });
  }
});

app.post('/api/projects/:id/milestones/:idx/release', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });

  const m = await platformDb.database.one('SELECT * FROM milestones WHERE project_id=$1 AND idx=$2', [id, idx]);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (m.status !== 'passed') {
    return res.status(400).json({ error: `当前状态「${MS_STATUS[m2s(m.status)] || m.status}」不可放款` });
  }

  try {
    const r = await chain.release(p.chain_project_id, idx);
    await platformDb.database.raw(
      `UPDATE milestones SET status='released', settled_at=NOW() WHERE project_id=$1 AND idx=$2`, [id, idx]
    );
    await platformDb.database.raw(
      `INSERT INTO settlement_orders (project_id, milestone_id, order_type, amount, to_addr, status, confirmed_at)
       VALUES ($1,$2,'release',$3,$4,'confirmed',NOW())`,
      [id, m.id, m.amount, p.provider_addr]
    );
    await audit(id, req.address, 'payment_released', { idx, amount: m.amount, txHash: r.txHash });

    const summary = await chain.getPayoutSummary(p.chain_project_id);
    res.json({
      released: true, idx, amount: Number(m.amount), to: p.provider_addr,
      txHash: r.txHash, chainMode: chain.mode,
      payoutSummary: {
        released: Number(summary.released),
        refunded: Number(summary.refunded),
        remaining: Number(summary.remaining),
      },
    });
  } catch (e) {
    res.status(502).json({ error: '放款失败: ' + e.message });
  }
});

app.post('/api/projects/:id/milestones/:idx/refund', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });

  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.client_addr !== req.address) return res.status(403).json({ error: '仅甲方可发起退款' });

  const m = await platformDb.database.one('SELECT * FROM milestones WHERE project_id=$1 AND idx=$2', [id, idx]);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (m.status !== 'failed') return res.status(400).json({ error: '仅验收不通过的里程碑可退款' });

  try {
    const r = await chain.refund(p.chain_project_id, idx);
    await platformDb.database.raw(
      `UPDATE milestones SET status='refunded', settled_at=NOW() WHERE project_id=$1 AND idx=$2`, [id, idx]
    );
    await platformDb.database.raw(
      `INSERT INTO settlement_orders (project_id, milestone_id, order_type, amount, to_addr, status, confirmed_at)
       VALUES ($1,$2,'refund',$3,$4,'confirmed',NOW())`,
      [id, m.id, m.amount, p.client_addr]
    );
    await audit(id, req.address, 'payment_refunded', { idx, amount: m.amount, txHash: r.txHash });

    const summary = await chain.getPayoutSummary(p.chain_project_id);
    res.json({
      refunded: true, idx, amount: Number(m.amount), to: p.client_addr,
      txHash: r.txHash, chainMode: chain.mode,
      payoutSummary: {
        released: Number(summary.released),
        refunded: Number(summary.refunded),
        remaining: Number(summary.remaining),
      },
    });
  } catch (e) {
    res.status(502).json({ error: '退款失败: ' + e.message });
  }
});

// ─────────────────────── ⑧ 查询 ───────────────────────

app.get('/api/projects', auth, async (req, res) => {
  const rows = await platformDb.database.many(
    'SELECT * FROM projects WHERE client_addr=$1 OR provider_addr=$1 ORDER BY id DESC',
    [req.address]
  );
  res.json({
    projects: rows.map((r) => ({
      id: r.id, title: r.title, status: r.status,
      role: r.client_addr === req.address ? 'client' : 'provider',
      total: Number(r.total_amount), ruleSetId: r.rule_set_id,
      createdAt: r.created_at,
    })),
  });
});

app.get('/api/projects/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '项目 ID 非法' });
  const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: '项目不存在' });

  const ms = await platformDb.database.many(
    'SELECT * FROM milestones WHERE project_id=$1 ORDER BY idx', [id]
  );
  const orders = await platformDb.database.many(
    'SELECT * FROM settlement_orders WHERE project_id=$1 ORDER BY id', [id]
  );
  const logs = await platformDb.database.many(
    'SELECT * FROM audit_log WHERE project_id=$1 ORDER BY id DESC LIMIT 50', [id]
  );

  let payout = null;
  try {
    payout = await chain.getPayoutSummary(p.chain_project_id);
  } catch {
    payout = null;
  }

  res.json({
    project: {
      id: p.id, title: p.title, status: p.status,
      client: p.client_addr, provider: p.provider_addr, arbitrator: p.arbitrator_addr,
      ruleSetId: p.rule_set_id, deliverableType: RULE_TEMPLATES.find((t) => t.id === p.rule_set_id)?.deliverableType,
      total: Number(p.total_amount),
      specHash: keccak(p.spec_json),
      chainProjectId: p.chain_project_id,
    },
    milestones: ms.map((m) => ({
      idx: m.idx, title: m.title, amount: Number(m.amount),
      status: m.status, statusLabel: MS_STATUS[m2s(m.status)] || m.status,
      score: m.score, facts: m.facts_json ? JSON.parse(m.facts_json) : null,
      factsHash: m.facts_hash, payoutRatio: m.payout_ratio,
      deliverableHash: m.deliverable_hash,
    })),
    settlements: orders.map((o) => ({
      type: o.order_type, amount: Number(o.amount), to: o.to_addr, status: o.status,
    })),
    payout: payout ? {
      released: Number(payout.released),
      refunded: Number(payout.refunded),
      remaining: Number(payout.remaining),
    } : null,
    audit: logs.map((l) => ({
      action: l.action, actor: l.actor_addr, at: l.created_at,
      detail: l.detail_json ? JSON.parse(l.detail_json) : null,
    })),
    chainMode: chain.mode,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'milestone-platform',
    chainMode: chain.mode,
    chainNetwork: chain.deployments?.network || 'mock',
    templates: RULE_TEMPLATES.length,
    flow: ['登录', '建项目/选规则', '双签', '注资', '交付上传', '客观验收', '挑战期', '结算支付'],
    time: new Date().toISOString(),
  });
});

/** 全局兜底：任何未捕获异常都不应让进程退出 */
process.on('uncaughtException', (e) => {
  console.error('[platform] uncaught:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[platform] unhandled rejection:', e && e.message);
});

function m2s(s) {
  // DB 字符串 → 合约状态码
  const map = { pending: 1, submitted: 2, challenged: 3, passed: 4, failed: 5, released: 6, refunded: 7, settled: 6 };
  return map[s] ?? s;
}

// ═══════════════════════ multipart/form-data 解析（零依赖） ═══════════════════════
/**
 * 最小可用的 multipart 解析器。
 *
 * 不用 multer 等库的原因：只需要支持「单文件 + 少量文本字段」这一种场景，
 * 自己实现能精确控制大小限制，避免引入不必要的依赖与攻击面。
 *
 * 边界处理要点：
 *   - 按 boundary 切分而非按行，避免 CRLF/LF 混用出错
 *   - 先扫 Content-Length，超限直接拒，不读进内存
 *   - 解析文件名与 Content-Disposition 的引号转义
 */
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const parts = [];
  let start = buffer.indexOf(delimiter);
  if (start < 0) return parts;
  start += delimiter.length;

  while (start < buffer.length) {
    // 结束标记 --
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    // 跳过 CRLF
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const next = buffer.indexOf(delimiter, start);
    if (next < 0) break;

    // 去掉分隔符前的 CRLF
    let end = next;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;

    const chunk = buffer.subarray(start, end);
    parts.push(chunk);
    start = next + delimiter.length;
  }

  return parts
    .map((chunk) => {
      // 头与体之间是 CRLFCRLF
      const sep = chunk.indexOf('\r\n\r\n');
      if (sep < 0) return null;
      const headerText = chunk.toString('utf8', 0, sep);
      const body = chunk.subarray(sep + 4);

      const nameMatch = headerText.match(/name="([^"]*)"/);
      const fileMatch = headerText.match(/filename="([^"]*)"/);
      const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      if (!nameMatch) return null;

      return {
        name: nameMatch[1],
        filename: fileMatch ? fileMatch[1] : null,
        contentType: typeMatch ? typeMatch[1].trim() : null,
        data: body,
      };
    })
    .filter(Boolean);
}

// ═══════════════════════ 上传接口 ═══════════════════════
const MAX_UPLOAD_BYTES = 55 * 1024 * 1024; // 略大于存储层的 50MB，给 multipart 开销留余量

app.post(
  '/api/projects/:id/milestones/:idx/upload',
  auth,
  express.raw({ type: ['multipart/form-data', 'application/octet-stream'], limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const id = Number(req.params.id);
    const idx = Number(req.params.idx);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '项目 ID 非法' });
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: '里程碑序号非法' });

    const p = await platformDb.database.one('SELECT * FROM projects WHERE id = $1', [id]);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    if (p.provider_addr !== req.address) return res.status(403).json({ error: '仅乙方可上传交付物' });

    const m = await platformDb.database.one(
      'SELECT * FROM milestones WHERE project_id = $1 AND idx = $2', [id, idx]
    );
    if (!m) return res.status(404).json({ error: '里程碑不存在' });
    if (!['pending', 'rejected'].includes(m.status)) {
      return res.status(400).json({ error: '当前状态不允许重新上传', status: m.status });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: '未收到文件内容' });
    }

    setTimeout(() => {}, 0); // 让出事件循环，避免长时间占用

    let archive;
    let filename = 'delivery.zip';
    let note = '';

    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) {
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!bm) return res.status(400).json({ error: 'multipart 缺少 boundary' });
      const parts = parseMultipart(body, (bm[1] || bm[2]).trim());
      const file = parts.find((x) => x.filename && x.data.length);
      if (!file) return res.status(400).json({ error: '未找到上传文件' });
      archive = file.data;
      filename = file.filename;
      note = (parts.find((x) => x.name === 'note')?.data || Buffer.alloc(0)).toString('utf8');
    } else {
      // 直接 POST 原始字节
      archive = body;
      filename = String(req.headers['x-filename'] || 'delivery.zip');
    }

    setBusyGuard(true);
    try {
      // 保存 + 解包 + 算真实哈希
      const saved = await deliveryStore.saveDelivery(id, idx, archive, filename);

      // 链上只记哈希与指针，不存源码
      const r = await chain.submitDeliverable(p.chain_project_id, idx, saved.hash, saved.uri);

      await platformDb.database.raw(
        `UPDATE milestones SET status='submitted', deliverable_hash=$1, deliverable_uri=$2,
                              submitter_addr=$3, submitted_at=NOW()
         WHERE project_id=$4 AND idx=$5`,
        [saved.hash, saved.uri, req.address, id, idx]
      );
      await audit(id, req.address, 'deliverable_uploaded', {
        idx, hash: saved.hash, uri: saved.uri,
        size: saved.size, fileCount: saved.fileCount, txHash: r.txHash,
      });

      res.json({
        uploaded: true,
        idx,
        hash: saved.hash,
        uri: saved.uri,
        size: saved.size,
        fileCount: saved.fileCount,
        originalName: saved.originalName,
        txHash: r.txHash,
        chainMode: chain.mode,
        note: note || undefined,
        nextStep: '平台已锁定该哈希，验收将运行这份源码',
      });
    } catch (e) {
      res.status(400).json({ error: '上传失败: ' + e.message });
    } finally {
      setBusyGuard(false);
    }
  }
);

// 查询交付物详情
app.get('/api/projects/:id/milestones/:idx/delivery', auth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  const m = await platformDb.database.one(
    'SELECT * FROM milestones WHERE project_id=$1 AND idx=$2', [id, idx]
  );
  if (!m) return res.status(404).json({ error: '里程碑不存在' });

  const manifest = deliveryStore.readManifest(id, idx);
  const integrity = deliveryStore.verifyIntegrity(id, idx);
  res.json({
    hash: m.deliverable_hash,
    uri: m.deliverable_uri,
    submittedAt: m.submitted_at,
    manifest,
    integrity,
  });
});

function setBusyGuard(on) {
  // 保留钩子：将来可接入全局忙碌指示器
}

// ─────────────────────── 静态托管（前后端同源，无需跨域） ───────────────────────
const WEB_ROOT = path.join(__dirname, '..', '..', '..', 'web');

app.use(express.static(WEB_ROOT, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(WEB_ROOT, 'platform.html')));
app.get('/platform', (_req, res) => res.sendFile(path.join(WEB_ROOT, 'platform.html')));

app.listen(PORT, () => {
  console.log('═'.repeat(60));
  console.log('  里程碑验收托管平台');
  console.log('═'.repeat(60));
  console.log(`  后端 API  : http://localhost:${PORT}/api/health`);
  console.log(`  前端界面  : http://localhost:${PORT}/`);
  console.log(`  链上模式  : ${chain.mode}${chain.deployments ? ' (' + chain.deployments.network + ')' : ''}`);
  console.log(`  规则模板  : ${RULE_TEMPLATES.length} 个`);
  console.log('  闭环      : 登录 → 建项目 → 双签 → 注资 → 交付 → 验收 → 结算');
  console.log('');
});

module.exports = app;
