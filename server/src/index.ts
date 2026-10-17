/**
 * 验收编排服务
 *
 * 职责边界（重要）：
 *   本服务**不做判定**。判定逻辑 100% 在链上评估器合约中。
 *   本服务只做三件事：采集客观事实 / 计算报告哈希 / 调用链上合约。
 *
 * 合规声明：
 *   本服务不托管资金、不处理任何法币或代币转移。
 *   仅完成「验收结论存证」这一环节。
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { collectFacts, recompute, CollectorConfig, FactMeasurement } from './collector';
import { RULE_TEMPLATES, getTemplate, REJECTED_DELIVERABLES, DeliverableType } from './ruleTemplates';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ─────────────────────────── 规则模板 API ───────────────────────────

/** 列出全部验收规则模板 */
app.get('/api/rules', (_req, res) => {
  res.json({ templates: RULE_TEMPLATES });
});

/** 获取单个模板 */
app.get('/api/rules/:id', (req, res) => {
  const tpl = getTemplate(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'template not found' });
  res.json(tpl);
});

/** 明确拒绝的主观交付类型 —— 范围克制原则的显式声明 */
app.get('/api/rules/rejected', (_req, res) => {
  res.json({ rejected: REJECTED_DELIVERABLES });
});

/**
 * 交付类型匹配校验：防止主观需求被硬塞进自动验收。
 * 这是方案「刻意只做可机器校验交付」原则的执行点。
 */
app.post('/api/validate-deliverable', (req, res) => {
  const { deliverableType, templateId } = req.body || {};
  const tpl = getTemplate(templateId);
  if (!tpl) return res.status(404).json({ error: 'template not found' });

  if (tpl.deliverableType !== deliverableType) {
    return res.status(400).json({
      acceptable: false,
      reason: `该模板适用于「${tpl.applicableDeliverable}」，与提交的交付类型「${deliverableType}」不匹配`,
      suggestedTemplates: RULE_TEMPLATES.filter((t) => t.deliverableType === deliverableType).map((t) => t.id),
    });
  }

  return res.json({ acceptable: true, template: tpl.id });
});

// ─────────────────────────── 采集与评估 API ───────────────────────────

/**
 * 采集事实并返回报告（含哈希）。
 * 注意：本接口**不自动提交链上**，仅返回结果供确认——
 * 因为采集结果直接影响放款，需要人工确认环节。
 */
app.post('/api/collect', async (req, res) => {
  try {
    const { projectId, milestoneIndex, ruleSetId, collectorConfig } = req.body || {};
    if (projectId == null || milestoneIndex == null || !ruleSetId) {
      return res.status(400).json({ error: 'missing projectId / milestoneIndex / ruleSetId' });
    }

    const report = await collectFacts(
      Number(projectId),
      Number(milestoneIndex),
      ruleSetId,
      (collectorConfig || {}) as CollectorConfig
    );

    // 本地预演判定，让用户提交前就能看到结果
    const tpl = RULE_TEMPLATES.find((t) => t.id === ruleSetId);
    const preview = tpl
      ? recompute(report.measurements, {
          threshold: tpl.passThreshold,
          required: tpl.required,
          weights: tpl.weights,
        })
      : null;

    return res.json({ report, preview });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * 独立复算接口：任何人拿到事实报告，都可验证结论是否算错。
 * 这是「可复算」承诺的对外实现。
 */
app.post('/api/recompute', (req, res) => {
  const { measurements, ruleSetId } = req.body || {};
  const tpl = getTemplate(ruleSetId);
  if (!tpl) return res.status(404).json({ error: 'template not found' });

  const result = recompute(measurements as FactMeasurement[], {
    threshold: tpl.passThreshold,
    required: tpl.required,
    weights: tpl.weights,
  });

  return res.json({ ruleSet: tpl.id, ...result });
});

/**
 * 评估预览：不实际采集，直接问「若事实是 X/Y/Z，结论会是什么」。
 * 用于前端实时反馈，帮助双方在签约前理解规则含义。
 */
app.post('/api/preview', (req, res) => {
  const { ruleSetId, test, api, field } = req.body || {};
  const tpl = getTemplate(ruleSetId);
  if (!tpl) return res.status(404).json({ error: 'template not found' });

  const result = recompute(
    [
      { key: 't', dimension: 'test', value: test ?? 0, label: '', samples: [], measuredAt: 0 },
      { key: 'a', dimension: 'api', value: api ?? 0, label: '', samples: [], measuredAt: 0 },
      { key: 'f', dimension: 'field', value: field ?? 0, label: '', samples: [], measuredAt: 0 },
    ],
    { threshold: tpl.passThreshold, required: tpl.required, weights: tpl.weights }
  );

  return res.json({
    ruleSet: tpl.id,
    ...result,
    gatesExplanation: {
      test: result.gates.test ? '达标' : `未达标（需 ≥ ${(tpl.required.test / 100).toFixed(1)}%）`,
      api: result.gates.api ? '达标' : `未达标（需 ≥ ${(tpl.required.api / 100).toFixed(1)}%）`,
      field: result.gates.field ? '达标' : `未达标（需 ≥ ${(tpl.required.field / 100).toFixed(1)}%）`,
    },
  });
});

// ─────────────────────────── 项目流程 API ───────────────────────────

/**
 * 创建项目时的规则锁定请求校验。
 * 校验通过后返回规则哈希供双签。
 */
app.post('/api/project/prepare', (req, res) => {
  const { client, provider, arbitrator, ruleSetId, milestoneCount } = req.body || {};
  const tpl = getTemplate(ruleSetId);

  if (!tpl) return res.status(400).json({ error: '未选择有效的验收规则模板' });
  if (!client || !provider || !arbitrator) {
    return res.status(400).json({ error: '缺少 client / provider / arbitrator 地址' });
  }
  if (client === provider) return res.status(400).json({ error: '甲方与乙方不能是同一地址' });
  if (provider === arbitrator || client === arbitrator) {
    return res.status(400).json({ error: '仲裁者必须独立于甲乙双方' });
  }
  if (!milestoneCount || milestoneCount < 1 || milestoneCount > 100) {
    return res.status(400).json({ error: '里程碑数量需在 1-100 之间' });
  }

  // 规则哈希：模板 id + 版本，锁定后不可变更
  const ruleHash = 'template:' + tpl.id;

  return res.json({
    ruleHash,
    template: tpl,
    message: '规则已选定。规则哈希将写入链上，双方签署后生效且不可单方变更。',
    nextStep: '请甲乙双方分别调用 escrow.signRule() 完成签署',
  });
});

/** 项目进度与状态查询说明 */
app.get('/api/project/:id/status-guide', (req, res) => {
  res.json({
    projectId: req.params.id,
    states: {
      Draft: '规则拟定中，等待双方签署',
      Active: '规则已锁定，可提交交付',
      Completed: '全部里程碑已终结',
      Cancelled: '项目已取消',
    },
    milestoneStates: {
      Pending: '待提交',
      Submitted: '已提交，等待评估',
      Challenged: '已被挑战，等待仲裁',
      Passed: '验收通过，挑战期内',
      Failed: '验收不通过',
      FinalizedPassed: '已终结：验收通过，凭证已铸发',
      FinalizedFailed: '已终结：验收不通过，无凭证',
    },
    reminder: '挑战期 3 天内双方均可发起挑战；挑战期内不可 finalize。',
  });
});

// ─────────────────────────── 健康检查 ───────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'milestone-escrow-server',
    compliance: '不做资金托管，仅存证与验收结论',
    templates: RULE_TEMPLATES.length,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`验收编排服务已启动: http://localhost:${PORT}`);
  console.log(`规则模板: ${RULE_TEMPLATES.length} 个`);
  console.log('合规声明: 不托管资金、不处理法币或代币转移');
});
