/**
 * 零依赖测试运行器 —— 输出机器可读的 JSON 报告。
 *
 * 为什么要自己写：验收平台需要**跨项目一致**的报告格式，
 * 不能依赖交付方用什么测试框架。用 TAP/JUnit 也可以，但格式要约定。
 *
 * 用法：node test/run-tests.js [--suite=required|all]
 *   --suite=required 只跑必测组（验收平台指定）
 */

const path = require('path');
const { computeTotal, applyDiscount, shippingFee, payableAmount } = require('../src/order');

// ─────────────── 测试用例定义 ───────────────
// group=required 的用例在签约时由双方锁定，属于「必测组」
// group=extra 的用例是乙方自己补充的，不计入必测组

const CASES = [
  // ── 必测组：甲方在签约时指定 ──
  {
    name: 'computeTotal: 单件商品总价等于单价',
    group: 'required',
    fn: () => {
      const got = computeTotal([{ price: 100, qty: 2 }]);
      assertEq(got, 200, '总价');
    },
  },
  {
    name: 'computeTotal: 多件商品累加',
    group: 'required',
    fn: () => {
      const got = computeTotal([
        { price: 100, qty: 2 },
        { price: 50, qty: 3 },
      ]);
      assertEq(got, 350, '累加总价');
    },
  },
  {
    name: 'computeTotal: 空数组返回 0',
    group: 'required',
    fn: () => {
      assertEq(computeTotal([]), 0, '空数组');
    },
  },
  {
    name: 'computeTotal: 非数组应抛错',
    group: 'required',
    fn: () => {
      let threw = false;
      try {
        computeTotal(null);
      } catch (e) {
        threw = true;
      }
      assertTrue(threw, '应抛出 TypeError');
    },
  },
  {
    name: 'applyDiscount: VIP10 打九折',
    group: 'required',
    fn: () => {
      assertEq(applyDiscount(10000, 'VIP10'), 9000, 'VIP10 折扣');
    },
  },
  {
    name: 'applyDiscount: VIP20 打八折',
    group: 'required',
    fn: () => {
      assertEq(applyDiscount(10000, 'VIP20'), 8000, 'VIP20 折扣');
    },
  },
  {
    name: 'applyDiscount: NONE 不打折',
    group: 'required',
    fn: () => {
      assertEq(applyDiscount(10000, 'NONE'), 10000, '无折扣');
    },
  },
  {
    name: 'shippingFee: 满 100 免运费',
    group: 'required',
    fn: () => {
      assertEq(shippingFee(10000, 'FREE_OVER_100'), 0, '满额免运费');
    },
  },
  {
    name: 'shippingFee: 未满 100 收 5 元',
    group: 'required',
    fn: () => {
      assertEq(shippingFee(5000, 'FREE_OVER_100'), 500, '基础运费');
    },
  },
  {
    name: 'payableAmount: 综合计算正确',
    group: 'required',
    fn: () => {
      const items = [{ price: 20000, qty: 1 }];
      // 20000 -> VIP10 -> 18000 -> 满100免邮 -> 18000
      assertEq(payableAmount(items, 'VIP10'), 18000, '应付金额');
    },
  },

  // ── 以下为乙方自测组：验收平台不计入必测通过率 ──
  {
    name: 'extra: 折扣后金额不应为负',
    group: 'extra',
    fn: () => {
      assertTrue(payableAmount([{ price: 100, qty: 1 }], 'VIP20') >= 0, '非负');
    },
  },
  {
    name: 'extra: 未知折扣规则应抛错',
    group: 'extra',
    fn: () => {
      let threw = false;
      try {
        applyDiscount(100, 'BLACKFRIDAY');
      } catch (e) {
        threw = true;
      }
      assertTrue(threw, '应抛错');
    },
  },
];

// ─────────────── 断言工具 ───────────────
function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${expected}，实际 ${actual}`);
  }
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`${label}: 期望为真，实际为假`);
}

// ─────────────── 执行 ───────────────
const suiteFilter = (process.argv.find((a) => a.startsWith('--suite=')) || '').split('=')[1];
const selected = CASES.filter((c) => (suiteFilter === 'required' ? c.group === 'required' : true));

const results = [];
let passed = 0;
let failed = 0;

for (const c of selected) {
  const started = Date.now();
  try {
    c.fn();
    passed++;
    results.push({ name: c.name, group: c.group, status: 'passed', ms: Date.now() - started });
  } catch (e) {
    failed++;
    results.push({
      name: c.name,
      group: c.group,
      status: 'failed',
      ms: Date.now() - started,
      error: e.message,
    });
  }
}

// 输出机器可读报告（验收平台解析的就是这个）
const report = {
  total: results.length,
  passed,
  failed,
  passRate: results.length > 0 ? Math.round((passed / results.length) * 10000) : 0, // 万分比
  cases: results,
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed > 0 ? 1 : 0);
