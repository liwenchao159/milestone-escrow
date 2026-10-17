/**
 * 事实采集器（Fact Collector）
 *
 * 这是本方案在技术上最关键的组件，直接对应可行性评估中的「断点 2：验收环境由单方控制」。
 *
 * 传统做法的漏洞：
 *   甲方自己部署一个永远返回 200 的接口，去中心化预言机会忠实地把这个谎话送上链。
 *
 * 本方案的处理：
 *   1. 采集器只做**客观测量**，不持有任何判定逻辑——它不知道通过阈值是多少，
 *      因为阈值只存在于链上的 ruleSet 中，采集器签名时也读不到。
 *   2. 事实采集**可复现**：每条事实都附带原始样本（probe 明细、CI 原始日志摘要），
 *      任何第三方都能拿同一份采样重新测量。
 *   3. 事实报告**哈希上链**：报告哈希写入链上后可被审计复算。
 *   4. **挑战期兜底**：即使采集器出错，一方仍可在 3 天内挑战并由仲裁者裁决。
 *
 * 信任模型：
 *   采集器可以「撒谎」，但撒谎是可被检测的（重测不一致 → 挑战 → 仲裁）。
 *   采集器无法「操纵判定」（阈值与权重在链上且不可变）。
 *   这比「追求绝对可信的预言机」务实得多——后者在链下现实里不存在。
 */

import { createHash } from 'crypto';

export interface FactMeasurement {
  key: string;
  label: string;
  dimension: 'test' | 'api' | 'field';
  /** 测得值，万分比（9000 = 90%） */
  value: number;
  /** 原始样本，供第三方复核 */
  samples: ProbeSample[];
  measuredAt: number;
}

export interface ProbeSample {
  /** 探测目标的可复现标识（不含密钥） */
  target: string;
  ok: boolean;
  /** 毫秒延迟 */
  latencyMs: number;
  detail?: string;
}

export interface FactReport {
  projectId: number;
  milestoneIndex: number;
  ruleSetId: string;
  measurements: FactMeasurement[];
  /** 整份报告的规范化哈希 */
  reportHash: string;
  collectorVersion: string;
  createdAt: number;
}

const COLLECTOR_VERSION = '1.0.0';

/**
 * 计算报告哈希。使用规范化 JSON，保证同一份事实无论字段顺序如何都得到同一哈希。
 */
export function hashReport(report: Omit<FactReport, 'reportHash'>): string {
  const canonical = JSON.stringify({
    ruleSetId: report.ruleSetId,
    measurements: report.measurements
      .map((m) => ({
        key: m.key,
        value: m.value,
        measuredAt: m.measuredAt,
        // 只哈希样本摘要，不哈希完整样本，避免报告哈希随时间戳抖动
        sampleCount: m.samples.length,
        okCount: m.samples.filter((s) => s.ok).length,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
  return '0x' + createHash('sha256').update(canonical).digest('hex').slice(0, 64);
}

/**
 * 采集器配置。每一项对应规则模板中的一项事实。
 */
export interface CollectorConfig {
  /** CI 结果来源 */
  ci?: {
    /** 约定的「必测」用例组，不可被单方缩减 */
    requiredSuites: string[];
    /** CI API 端点（部署在第三方环境，不由甲乙方任何一方控制） */
    endpoint: string;
  };
  /** 接口可用性探测 */
  probe?: {
    /** 探测目标列表 */
    targets: string[];
    /** 探测轮次。轮次越多越难伪造 */
    rounds: number;
    intervalMs: number;
    /** 期望的 HTTP 状态码 */
    expectStatus: number[];
  };
  /** 契约字段覆盖 */
  contract?: {
    /** OpenAPI / JSON Schema 契约地址 */
    schemaUrl: string;
    /** 被测接口的响应 */
    responseUrl: string;
  };
}

/**
 * 采集 CI 测试通过率。
 *
 * @dev 只统计 requiredSuites 中约定的用例。甲方无法通过「只跑 3 个文件」
 *      来虚增通过率——必测清单在项目创建时即锁定。
 */
export async function collectTestPassRate(cfg: NonNullable<CollectorConfig['ci']>): Promise<FactMeasurement> {
  const samples: ProbeSample[] = [];
  let passed = 0;
  let total = 0;

  for (const suite of cfg.requiredSuites) {
    const started = Date.now();
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suite }),
        signal: AbortSignal.timeout(15000),
      });
      const body: any = await res.json();
      const suitePassed = Number(body?.passed ?? 0);
      const suiteTotal = Number(body?.total ?? 0);
      passed += suitePassed;
      total += suiteTotal;
      samples.push({
        target: `ci:${suite}`,
        ok: res.ok,
        latencyMs: Date.now() - started,
        detail: `${suitePassed}/${suiteTotal}`,
      });
    } catch (e: any) {
      samples.push({ target: `ci:${suite}`, ok: false, latencyMs: Date.now() - started, detail: e.message });
    }
  }

  const value = total > 0 ? Math.round((passed / total) * 10000) : 0;
  return {
    key: 'testPassRate',
    label: '必测用例通过率',
    dimension: 'test',
    value,
    samples,
    measuredAt: Date.now(),
  };
}

/**
 * 采集接口可用率。多轮次探测，轮次越多，单次偶发成功的概率越低。
 */
export async function collectApiAvailability(cfg: NonNullable<CollectorConfig['probe']>): Promise<FactMeasurement> {
  const samples: ProbeSample[] = [];
  let okCount = 0;
  const total = cfg.targets.length * cfg.rounds;

  for (let r = 0; r < cfg.rounds; r++) {
    for (const target of cfg.targets) {
      const started = Date.now();
      try {
        const res = await fetch(target, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
          redirect: 'error', // 防重定向绕过
        });
        const ok = cfg.expectStatus.includes(res.status);
        if (ok) okCount++;
        samples.push({ target, ok, latencyMs: Date.now() - started, detail: `HTTP ${res.status}` });
      } catch (e: any) {
        samples.push({ target, ok: false, latencyMs: Date.now() - started, detail: e.message });
      }
    }
    if (r < cfg.rounds - 1) {
      await new Promise((r2) => setTimeout(r2, cfg.intervalMs));
    }
  }

  return {
    key: 'apiAvailability',
    label: '接口可用率',
    dimension: 'api',
    value: total > 0 ? Math.round((okCount / total) * 10000) : 0,
    samples,
    measuredAt: Date.now(),
  };
}

/**
 * 采集契约字段覆盖率。
 *
 * @dev 用「契约声明的必填字段」作为分母，而非响应中出现的字段数。
 *      这防止乙方通过返回一个巨大的字段集合来虚增覆盖率。
 */
export async function collectFieldCoverage(cfg: NonNullable<CollectorConfig['contract']>): Promise<FactMeasurement> {
  const samples: ProbeSample[] = [];

  try {
    const [schemaRes, respRes] = await Promise.all([
      fetch(cfg.schemaUrl, { signal: AbortSignal.timeout(15000) }),
      fetch(cfg.responseUrl, { signal: AbortSignal.timeout(15000) }),
    ]);

    const schema: any = await schemaRes.json();
    const response: any = await respRes.json();

    // 契约必填字段路径（简化处理：取顶层 required）
    const required: string[] = schema?.required ?? [];
    const actualKeys: string[] = Object.keys(response ?? {});

    const covered = required.filter((k) => actualKeys.includes(k));

    // 采样：为每个必填字段记录一条
    for (const field of required) {
      samples.push({
        target: `field:${field}`,
        ok: actualKeys.includes(field),
        latencyMs: 0,
      });
    }

    return {
      key: 'fieldCoverage',
      label: '契约字段覆盖率',
      dimension: 'field',
      value: required.length > 0 ? Math.round((covered.length / required.length) * 10000) : 0,
      samples,
      measuredAt: Date.now(),
    };
  } catch (e: any) {
    return {
      key: 'fieldCoverage',
      label: '契约字段覆盖率',
      dimension: 'field',
      value: 0,
      samples: [{ target: 'contract', ok: false, latencyMs: 0, detail: e.message }],
      measuredAt: Date.now(),
    };
  }
}

/**
 * 执行一次完整采集，产出可上链的事实报告。
 */
export async function collectFacts(
  projectId: number,
  milestoneIndex: number,
  ruleSetId: string,
  cfg: CollectorConfig
): Promise<FactReport> {
  const tasks: Promise<FactMeasurement>[] = [];
  if (cfg.ci) tasks.push(collectTestPassRate(cfg.ci));
  if (cfg.probe) tasks.push(collectApiAvailability(cfg.probe));
  if (cfg.contract) tasks.push(collectFieldCoverage(cfg.contract));

  const measurements = await Promise.all(tasks);

  const base = {
    projectId,
    milestoneIndex,
    ruleSetId,
    measurements,
    collectorVersion: COLLECTOR_VERSION,
    createdAt: Date.now(),
  };

  return { ...base, reportHash: hashReport(base) };
}

/**
 * 本地复算：用同一份事实在本地重算得分，供审计比对链上结论。
 *
 * 这是「可复算」承诺的具体实现——任何人都能验证链上结论没有算错。
 */
export function recompute(
  measurements: FactMeasurement[],
  rule: { threshold: number; required: Record<string, number>; weights: Record<string, number> }
): { score: number; passed: boolean; gates: Record<string, boolean> } {
  const get = (dim: string) => measurements.find((m) => m.dimension === dim)?.value ?? 0;

  const gates = {
    test: get('test') >= rule.required.test,
    api: get('api') >= rule.required.api,
    field: get('field') >= rule.required.field,
  };

  const weighted = Math.floor(
    (get('test') * rule.weights.test + get('api') * rule.weights.api + get('field') * rule.weights.field) / 10000
  );
  const score = Math.round((weighted + 50) / 100);

  return { score, passed: gates.test && gates.api && gates.field && score >= rule.threshold, gates };
}
