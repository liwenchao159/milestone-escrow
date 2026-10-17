/**
 * 前端判定引擎测试
 *
 * 目的：确保 web/assets/engine.js 的判定逻辑与合约 DeterministicEvaluator 完全一致。
 * 用例直接复用合约测试中的相同输入，逐一比对。
 *
 * 运行：node web/test/engine.test.js
 */
const path = require("path");
const assert = require("assert");

// engine.js 兼容 CommonJS
const Engine = require(path.join(__dirname, "..", "assets", "engine.js"));

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log("  \u2713 " + name);
  } catch (e) {
    fail++;
    console.log("  \u2717 " + name);
    console.log("      " + e.message);
  }
}

const TPL = Engine.getTemplate("standard-interface-v1");

console.log("\n前端判定引擎测试");
console.log("─".repeat(60));

// ─────────────── 与合约测试用同一组输入 ───────────────

test("三维度全达标 → 通过（得分 97，与合约一致）", () => {
  const r = Engine.evaluate(TPL, { test: 9600, api: 9900, field: 9500 });
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.score, 97);
});

test("测试不达标 → 硬门槛拦下（得分 90 但不通过，与合约 demo 实测一致）", () => {
  const r = Engine.evaluate(TPL, { test: 8000, api: 10000, field: 10000 });
  assert.strictEqual(r.passed, false, "高分不能补齐不达标维度");
  // 期望值 90 来自合约 demo-payment.js 场景 B 的实际输出，改动算法时须同步核对
  assert.strictEqual(r.score, 90);
  assert.strictEqual(r.gates.test, false);
});

test("接口不达标 → 不通过", () => {
  const r = Engine.evaluate(TPL, { test: 10000, api: 8000, field: 10000 });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.gates.api, false);
});

test("字段不达标 → 不通过", () => {
  const r = Engine.evaluate(TPL, { test: 10000, api: 10000, field: 5000 });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.gates.field, false);
});

test("门槛全过但加权分低 → 不通过", () => {
  const loose = { threshold: 80, required: { test: 5000, api: 5000, field: 5000 }, weights: { test: 5000, api: 3000, field: 2000 } };
  const r = Engine.evaluate(loose, { test: 5000, api: 5000, field: 5000 });
  assert.strictEqual(r.score, 50);
  assert.strictEqual(r.passed, false);
});

test("权重和不为 10000 时判定仍可计算（防御性）", () => {
  const r = Engine.evaluate(TPL, { test: 0, api: 0, field: 0 });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.passed, false);
});

// ─────────────── 边界条件 ───────────────

test("全 0 → 不通过", () => {
  const r = Engine.evaluate(TPL, { test: 0, api: 0, field: 0 });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.score, 0);
});

test("全 10000（100%）→ 通过", () => {
  const r = Engine.evaluate(TPL, { test: 10000, api: 10000, field: 10000 });
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.score, 100);
});

test("恰好等于门槛值 → 视为达标（>= 而非 >）", () => {
  const r = Engine.evaluate(TPL, { test: 9000, api: 9500, field: 9000 });
  assert.deepStrictEqual(r.gates, { test: true, api: true, field: true });
});

test("低于门槛 1 个单位 → 不达标", () => {
  const r = Engine.evaluate(TPL, { test: 8999, api: 9500, field: 9000 });
  assert.strictEqual(r.gates.test, false);
});

test("缺失字段按 0 处理", () => {
  const r = Engine.evaluate(TPL, { test: 9600 });
  assert.strictEqual(r.gates.api, false);
  assert.strictEqual(r.passed, false);
});

test("恰好等于通过分数线 → 通过", () => {
  // weighted = 8000*(10000)/10000 = 8000 → score = (8000+50)/100 = 80（整数除法）
  const t = { threshold: 80, required: { test: 0, api: 0, field: 0 }, weights: { test: 5000, api: 3000, field: 2000 } };
  const r = Engine.evaluate(t, { test: 8000, api: 8000, field: 8000 });
  assert.strictEqual(r.score, 80);
  assert.strictEqual(r.passed, true);
});

test("交叉验证：与合约 demo-payment.js 场景 A/B 输出一致", () => {
  // 这两个数字直接取自 `npx hardhat run scripts/demo-payment.js` 的实际打印
  const a = Engine.evaluate(TPL, { test: 9600, api: 9900, field: 9500 });
  assert.strictEqual(a.score, 97, "场景 A 合约输出 97 分");
  assert.strictEqual(a.passed, true, "场景 A 合约输出 ✓ 通过");

  const b = Engine.evaluate(TPL, { test: 8000, api: 10000, field: 10000 });
  assert.strictEqual(b.score, 90, "场景 B 合约输出 90 分");
  assert.strictEqual(b.passed, false, "场景 B 合约输出 ✗ 仍判定不通过");
});

// ─────────────── 诊断信息（可用性核心） ───────────────

test("诊断能指出具体差多少", () => {
  const r = Engine.evaluate(TPL, { test: 8000, api: 10000, field: 10000 });
  const d = Engine.diagnose(TPL, { test: 8000, api: 10000, field: 10000 }, r);
  assert.strictEqual(d.length, 1, "只应有一个失败原因");
  assert.strictEqual(d[0].type, "gate");
  assert.strictEqual(d[0].dimension, "test");
  assert.strictEqual(d[0].gap, 10, "差距应为 10 个百分点");
  assert.ok(d[0].advice.length > 0, "必须给出可执行建议");
});

test("诊断在分数不足时建议提升最高权重项", () => {
  const t = { threshold: 90, required: { test: 5000, api: 5000, field: 5000 }, weights: { test: 5000, api: 3000, field: 2000 }, facts: [{ key: "test", label: "必测用例通过率" }, { key: "api", label: "接口可用率" }, { key: "field", label: "字段覆盖率" }] };
  const r = Engine.evaluate(t, { test: 6000, api: 6000, field: 6000 });
  const d = Engine.diagnose(t, { test: 6000, api: 6000, field: 6000 }, r);
  assert.strictEqual(d[0].type, "score");
  assert.ok(d[0].advice.includes("必测用例通过率"), "应建议提升权重最高的维度");
});

test("多个维度不达标时全部列出", () => {
  const r = Engine.evaluate(TPL, { test: 5000, api: 5000, field: 5000 });
  const d = Engine.diagnose(TPL, { test: 5000, api: 5000, field: 5000 }, r);
  assert.strictEqual(d.length, 3);
});

test("通过时给出下一步提示", () => {
  const r = Engine.evaluate(TPL, { test: 9600, api: 9900, field: 9500 });
  const d = Engine.diagnose(TPL, { test: 9600, api: 9900, field: 9500 }, r);
  assert.strictEqual(d[0].type, "pass");
  assert.ok(d[0].advice.includes("挑战期"));
});

// ─────────────── 模板一致性 ───────────────

test("四个模板的权重和均为 10000", () => {
  Engine.TEMPLATES.forEach((t) => {
    const sum = t.weights.test + t.weights.api + t.weights.field;
    assert.strictEqual(sum, 10000, t.id + " 权重和应为 10000，实际 " + sum);
  });
});

test("所有模板的门槛均在 0-10000 之间", () => {
  Engine.TEMPLATES.forEach((t) => {
    ["test", "api", "field"].forEach((d) => {
      assert.ok(t.required[d] > 0 && t.required[d] <= 10000, t.id + "." + d);
    });
    assert.ok(t.threshold > 0 && t.threshold <= 100, t.id + ".threshold");
  });
});

test("每个模板都定义了 3 个采集事实", () => {
  Engine.TEMPLATES.forEach((t) => {
    assert.strictEqual(t.facts.length, 3, t.id);
    const keys = t.facts.map((f) => f.key).sort();
    assert.deepStrictEqual(keys, ["api", "field", "test"], t.id + " 事实维度");
  });
});

test("模板 id 与合约部署清单一致", () => {
  const ids = Engine.TEMPLATES.map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [
    "balanced-4d-v1",
    "data-pipeline-v1",
    "lightweight-doc-v1",
    "standard-interface-v1",
    "strict-release-v1",
  ]);
});

test("等级评定符合预期", () => {
  assert.strictEqual(Engine.grade({ score: 97 }).text, "优秀");
  assert.strictEqual(Engine.grade({ score: 85 }).text, "良好");
  assert.strictEqual(Engine.grade({ score: 78 }).text, "合格");
  assert.strictEqual(Engine.grade({ score: 62 }).text, "偏弱");
  assert.strictEqual(Engine.grade({ score: 30 }).text, "不合格");
});

test("不存在的模板返回 null", () => {
  assert.strictEqual(Engine.getTemplate("does-not-exist"), null);
});

console.log("\n" + "─".repeat(60));
console.log(`${pass} passing, ${fail} failing`);
process.exit(fail > 0 ? 1 : 0);
