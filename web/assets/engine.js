/**
 * 判定引擎 —— 前端与合约逻辑的唯一真相源
 *
 * 关键约束：本文件必须与 DeterministicEvaluator.sol 的判定完全一致。
 * test/engine.test.js 会用与合约测试相同的输入验证两者结果相同。
 *
 * 判定逻辑：
 *   1. 硬门槛：三维度各自必须 ≥ required 阈值，任一不达标直接否决
 *      —— 不能靠其他维度的高分补齐（这是防「甲方只挑软指标」的核心）
 *   2. 加权分：(test*wTest + api*wApi + field*wField) / 10000，四舍五入转百分比
 *   3. 通过条件：三门槛全过 且 加权分 ≥ threshold
 *
 * 所有数值单位为「万分比」：9000 = 90%
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Engine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 四个验收规则模板。与 server/src/ruleTemplates.ts 保持一致。 */
  var TEMPLATES = [
    {
      id: 'standard-interface-v1',
      name: '标准接口开发',
      tagline: '最常用 · 推荐作为起点',
      scenario: 'REST / GraphQL 接口开发',
      threshold: 80,
      required: { test: 9000, api: 9500, field: 9000 },
      weights: { test: 5000, api: 3000, field: 2000 },
      facts: [
        { key: 'test', label: '必测用例通过率', hint: '双方约定的必测测试组，不是全部用例' },
        { key: 'api', label: '接口可用率', hint: '多次探测的成功比例' },
        { key: 'field', label: '契约字段覆盖率', hint: '实际返回字段 / 契约声明的必填字段' },
      ],
    },
    {
      id: 'data-pipeline-v1',
      name: '数据处理与管道',
      tagline: '侧重数据完整性',
      scenario: 'ETL / 数据清洗 / 数据标注',
      threshold: 78,
      required: { test: 9200, api: 8500, field: 9500 },
      weights: { test: 3000, api: 2500, field: 4500 },
      facts: [
        { key: 'test', label: '校验脚本通过率', hint: '行数、唯一性、非空率等校验规则' },
        { key: 'api', label: '管道任务成功率', hint: '调度任务在观测窗口内的成功比例' },
        { key: 'field', label: '口径一致率', hint: '输出字段口径与约定文档的一致程度' },
      ],
    },
    {
      id: 'strict-release-v1',
      name: '严格发布',
      tagline: '高风险交付 · 门槛最高',
      scenario: '核心链路改造 / 安全相关',
      threshold: 92,
      required: { test: 9800, api: 9900, field: 9800 },
      weights: { test: 4500, api: 3500, field: 2000 },
      facts: [
        { key: 'test', label: '全量用例通过率', hint: '不允许只跑必测子集' },
        { key: 'api', label: '服务可用率', hint: '严格模式下的可用性统计' },
        { key: 'field', label: '错误码与边界覆盖', hint: '已实现并声明的错误处理项占比' },
      ],
    },
    {
      id: 'balanced-4d-v1',
      name: '均衡四维',
      tagline: '门槛与分数线拉开差距',
      scenario: '需要同时考察多个质量维度的中等风险交付',
      // 门槛与通过线刻意拉开：三维刚过门槛（约 70 分）时，仍低于 85 分线
      // 这样「硬门槛全过但总分不够」才是可达状态，而非理论上的死代码
      threshold: 85,
      required: { test: 7000, api: 7000, field: 7000 },
      weights: { test: 3000, api: 3000, field: 4000 },
      facts: [
        { key: 'test', label: '功能测试通过率', hint: '常规功能用例，非全量' },
        { key: 'api', label: '接口可用率', hint: '常规探测轮次' },
        { key: 'field', label: '交付完整度', hint: '约定交付物清单的完成比例' },
      ],
    },
    {
      id: 'lightweight-doc-v1',
      name: '轻量技术文档',
      tagline: '仅限结构可枚举的文档',
      scenario: 'API 文档 / 接入指南',
      threshold: 75,
      required: { test: 9000, api: 8000, field: 9000 },
      weights: { test: 2000, api: 1500, field: 6500 },
      facts: [
        { key: 'test', label: '示例可执行率', hint: '文档中代码示例可编译执行的比例' },
        { key: 'api', label: '引用接口可达率', hint: '文档内引用链接真实可访问的比例' },
        { key: 'field', label: '必填章节覆盖率', hint: '约定必填章节实际存在的比例' },
      ],
    },
  ];

  /** 明确不适用自动验收的交付类型 */
  var REJECTED = [
    { type: '设计 / 创意', reason: '设计的好坏没有客观标准，强行量化会退化成 AI 主观判定' },
    { type: '观点 / 策略类文档', reason: '没有可复算的验收依据' },
  ];

  function getTemplate(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  /**
   * 核心判定。与 DeterministicEvaluator.evaluate 逐字对应。
   * @param {object} tpl 规则模板
   * @param {object} facts {test, api, field} 单位万分比
   * @returns {{score:number, passed:boolean, gates:object, gateDetail:object}}
   */
  function evaluate(tpl, facts) {
    var test = facts.test || 0;
    var api = facts.api || 0;
    var field = facts.field || 0;

    // 硬门槛：任一不达标直接否决
    var gates = {
      test: test >= tpl.required.test,
      api: api >= tpl.required.api,
      field: field >= tpl.required.field,
    };

    // 加权分。必须与合约 DeterministicEvaluator.evaluate 逐字一致：
    //   weighted = (test*wT + api*wA + field*wF) / 10000   [整数除法，会截断]
    //   score    = (weighted + 50) / 100                  [整数除法，四舍五入到百分制]
    // 注意：不能在截断之后再加 50，否则会与合约产生偏差。
    var weighted =
      Math.floor((test * tpl.weights.test + api * tpl.weights.api + field * tpl.weights.field) / 10000);
    var score = Math.floor((weighted + 50) / 100);

    var passed = gates.test && gates.api && gates.field && score >= tpl.threshold;

    return {
      score: score,
      passed: passed,
      gates: gates,
      gateDetail: {
        test: { value: test, required: tpl.required.test, ok: gates.test },
        api: { value: api, required: tpl.required.api, ok: gates.api },
        field: { value: field, required: tpl.required.field, ok: gates.field },
      },
    };
  }

  /**
   * 找出「为什么没过」的主要原因，用于给用户可执行的建议。
   * 这是可用性的关键：不要只说「不通过」，要说「差什么、差多少」。
   */
  function diagnose(tpl, facts, result) {
    var reasons = [];

    // 1. 硬门槛未达标 —— 优先级最高，因为这是硬性否决
    ['test', 'api', 'field'].forEach(function (dim) {
      if (!result.gates[dim]) {
        var gap = tpl.required[dim] - (facts[dim] || 0);
        var factMeta = null;
        tpl.facts.forEach(function (f) {
          if (f.key === dim) factMeta = f;
        });
        reasons.push({
          type: 'gate',
          dimension: dim,
          label: factMeta ? factMeta.label : dim,
          message: factMeta.label + '未达硬门槛',
          current: (facts[dim] || 0) / 100,
          need: tpl.required[dim] / 100,
          gap: gap / 100,
          advice: '还差 ' + (gap / 100).toFixed(1) + ' 个百分点。硬门槛不可用其他维度的高分补齐。',
        });
      }
    });

    // 2. 门槛全过但分数不够
    if (reasons.length === 0 && result.score < tpl.threshold) {
      reasons.push({
        type: 'score',
        label: '加权总分',
        message: '三项门槛都过了，但加权分没到线',
        current: result.score,
        need: tpl.threshold,
        gap: tpl.threshold - result.score,
        advice: '再提 ' + (tpl.threshold - result.score) + ' 分。权重最高的是「' + highestWeightLabel(tpl) + '」，优先提升它最划算。',
      });
    }

    // 3. 全部通过
    if (reasons.length === 0) {
      reasons.push({
        type: 'pass',
        label: '全部达标',
        message: '三项硬门槛 + 加权分全部满足',
        current: result.score,
        need: tpl.threshold,
        gap: 0,
        advice: '进入 3 天挑战期。期满无异议即铸发履历凭证。',
      });
    }

    return reasons;
  }

  function highestWeightLabel(tpl) {
    var best = 'test';
    var bestVal = tpl.weights.test;
    ['api', 'field'].forEach(function (d) {
      if (tpl.weights[d] > bestVal) {
        bestVal = tpl.weights[d];
        best = d;
      }
    });
    var label = best;
    tpl.facts.forEach(function (f) {
      if (f.key === best) label = f.label;
    });
    return label;
  }

  /** 分数 → 等级，用于给非专业用户直观反馈 */
  function grade(result) {
    if (result.score >= 95) return { text: '优秀', cls: 'g' };
    if (result.score >= 85) return { text: '良好', cls: 'g' };
    if (result.score >= 75) return { text: '合格', cls: 'a' };
    if (result.score >= 60) return { text: '偏弱', cls: 'a' };
    return { text: '不合格', cls: 'r' };
  }

  return {
    TEMPLATES: TEMPLATES,
    REJECTED: REJECTED,
    getTemplate: getTemplate,
    evaluate: evaluate,
    diagnose: diagnose,
    grade: grade,
  };
});
