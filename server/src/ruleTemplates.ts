/**
 * 验收规则模板库
 *
 * 这是本方案最重要的差异化：规则不由甲方单方定义，而是从标准化模板中选取，
 * 且选定后经甲乙双签锁定在链上。这是评估报告中"漏洞 1"的直接解法。
 */

export type Dimension = 'test' | 'api' | 'field';

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  passThreshold: number; // 通过分数线 0-100
  required: Record<Dimension, number>; // 硬门槛（万分比，如 9000 = 90%）
  weights: Record<Dimension, number>; // 权重（和为 10000）
  applicableDeliverable: string;
  /** 采集器需要抓取的事实项 */
  facts: FactSpec[];
  /** 该模板适用的交付类型，用于匹配 */
  deliverableType: DeliverableType;
}

export type DeliverableType = 'code' | 'data' | 'doc' | 'design';

export interface FactSpec {
  key: string;
  dimension: Dimension;
  label: string;
  /** 采集方式：代码仓库 CI、HTTP 探测、文档解析 */
  collector: 'ci' | 'http' | 'doc';
  unit: string;
  description: string;
}

/**
 * 内置规则模板。每个模板都经过审慎设计，
 * 三个维度的门槛相互制衡，避免单维度被做成放行通道。
 */
export const RULE_TEMPLATES: RuleSet[] = [
  {
    id: 'standard-interface-v1',
    name: '标准接口开发（推荐默认）',
    description:
      '面向 REST/GraphQL 接口开发。要求必测用例通过、接口实际可用、字段覆盖完整。' +
      '三维度均为可客观复算的事实，不接受主观评分。',
    passThreshold: 80,
    required: { test: 9000, api: 9500, field: 9000 },
    weights: { test: 5000, api: 3000, field: 2000 },
    deliverableType: 'code',
    applicableDeliverable: '后端接口开发 / API 集成',
    facts: [
      {
        key: 'testPassRate',
        dimension: 'test',
        label: '必测用例通过率',
        collector: 'ci',
        unit: '%',
        description: 'CI 中被双方约定为「必测」的那一组用例的通过比例。',
      },
      {
        key: 'apiAvailability',
        dimension: 'api',
        label: '接口可用率',
        collector: 'http',
        unit: '%',
        description: '在评测窗口内对线上接口发起 N 次探测的成功比例。',
      },
      {
        key: 'fieldCoverage',
        dimension: 'field',
        label: '契约字段覆盖率',
        collector: 'doc',
        unit: '%',
        description: '响应结构实际返回的字段数 / OpenAPI 契约声明的必填字段数。',
      },
    ],
  },
  {
    id: 'data-pipeline-v1',
    name: '数据处理与管道',
    description:
      '面向 ETL / 数据清洗类交付。侧重数据完整性与口径一致性，可用性要求略降。',
    passThreshold: 78,
    required: { test: 9200, api: 8500, field: 9500 },
    weights: { test: 3000, api: 2500, field: 4500 },
    deliverableType: 'data',
    applicableDeliverable: '数据清洗 / ETL / 数据标注',
    facts: [
      {
        key: 'testPassRate',
        dimension: 'test',
        label: '校验脚本通过率',
        collector: 'ci',
        unit: '%',
        description: '数据校验规则（行数、唯一性、非空率等）的通过比例。',
      },
      {
        key: 'apiAvailability',
        dimension: 'api',
        label: '管道任务成功率',
        collector: 'http',
        unit: '%',
        description: '调度任务在观测窗口内的成功执行比例。',
      },
      {
        key: 'fieldCoverage',
        dimension: 'field',
        label: '口径一致率',
        collector: 'doc',
        unit: '%',
        description: '输出字段口径与约定口径文档一致的项占比。',
      },
    ],
  },
  {
    id: 'strict-release-v1',
    name: '严格发布（高风险交付）',
    description:
      '适用于安全敏感、影响面大的交付。三维度门槛全部拉高，且要求接口层近乎完美。',
    passThreshold: 92,
    required: { test: 9800, api: 9900, field: 9800 },
    weights: { test: 4500, api: 3500, field: 2000 },
    deliverableType: 'code',
    applicableDeliverable: '核心链路改造 / 安全相关',
    facts: [
      {
        key: 'testPassRate',
        dimension: 'test',
        label: '全量用例通过率',
        collector: 'ci',
        unit: '%',
        description: '全量测试套件的通过比例，不允许只跑必测子集。',
      },
      {
        key: 'apiAvailability',
        dimension: 'api',
        label: '服务可用率',
        collector: 'http',
        unit: '%',
        description: '严格模式下的服务可用性统计。',
      },
      {
        key: 'fieldCoverage',
        dimension: 'field',
        label: '错误码与边界覆盖',
        collector: 'doc',
        unit: '%',
        description: '已实现并声明的错误码 / 边界处理项占比。',
      },
    ],
  },
  {
    id: 'lightweight-doc-v1',
    name: '轻量文档交付',
    description:
      '仅用于结构可枚举的技术文档（如 API 文档、接入指南）。' +
      '注意：观点、策略、创意类主观内容**不适用**任何自动验收。',
    passThreshold: 75,
    required: { test: 9000, api: 8000, field: 9000 },
    weights: { test: 2000, api: 1500, field: 6500 },
    deliverableType: 'doc',
    applicableDeliverable: 'API 文档 / 接入指南 / 技术说明',
    facts: [
      {
        key: 'testPassRate',
        dimension: 'test',
        label: '示例可执行率',
        collector: 'ci',
        unit: '%',
        description: '文档中代码示例可被自动编译执行的比例。',
      },
      {
        key: 'apiAvailability',
        dimension: 'api',
        label: '文档中引用接口的可达率',
        collector: 'http',
        unit: '%',
        description: '文档内引用的接口链接真实可访问的比例。',
      },
      {
        key: 'fieldCoverage',
        dimension: 'field',
        label: '必填章节覆盖率',
        collector: 'doc',
        unit: '%',
        description: '约定的必填章节实际存在的比例。',
      },
    ],
  },
  {
    id: 'balanced-4d-v1',
    name: '均衡四维',
    description:
      '门槛与分数线刻意拉开：三维刚过门槛（约 70 分）时仍低于 85 分线。' +
      '使「硬门槛全过但总分不够」成为可达状态，而非理论上的死代码。',
    passThreshold: 85,
    required: { test: 7000, api: 7000, field: 7000 },
    weights: { test: 3000, api: 3000, field: 4000 },
    deliverableType: 'code',
    applicableDeliverable: '中等风险的多维度交付',
    facts: [
      {
        key: 'testPassRate',
        dimension: 'test',
        label: '功能测试通过率',
        collector: 'ci',
        unit: '%',
        description: '常规功能用例，非全量。',
      },
      {
        key: 'apiAvailability',
        dimension: 'api',
        label: '接口可用率',
        collector: 'http',
        unit: '%',
        description: '常规探测轮次。',
      },
      {
        key: 'fieldCoverage',
        dimension: 'field',
        label: '交付完整度',
        collector: 'doc',
        unit: '%',
        description: '约定交付物清单的完成比例。',
      },
    ],
  },
];

export function getTemplate(id: string): RuleSet | undefined {
  return RULE_TEMPLATES.find((t) => t.id === id);
}

/**
 * 明确拒绝的主观交付类型。这是方案的范围克制原则——
 * 宁可拒绝生意，也不掉进 AI 主观判定的泥潭。
 */
export const REJECTED_DELIVERABLES: { type: DeliverableType; reason: string }[] = [
  { type: 'design', reason: '设计的主观性无法客观复算，强行量化会退化为 AI 主观判定' },
  { type: 'doc', reason: '观点、策略类文档无客观判定标准' },
];

export function isDeliverableAcceptable(type: DeliverableType, templateId: string): boolean {
  const tpl = getTemplate(templateId);
  if (!tpl) return false;
  return tpl.deliverableType === type;
}
