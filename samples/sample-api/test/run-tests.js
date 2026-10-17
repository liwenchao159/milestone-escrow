/**
 * 零依赖测试运行器 —— 输出机器可读 JSON 报告
 *
 * 交付物写法说明：
 *   1. group='required' 的用例是「必测组」，验收平台只统计这些
 *   2. group='extra' 的是自测组，不计入验收
 *   3. 报告格式必须机器可读 —— 验收平台靠它提取通过率
 *
 * 运行：
 *   node test/run-tests.js                 # 全部
 *   node test/run-tests.js --suite=required  # 仅必测组（验收平台用这个）
 */
const { applySpread, convert, quote, normalizeAmount, normalizeCurrency } = require('../src/fx');

const CASES = [
  // ══════ 必测组：签约时由双方锁定，数量固定 ══════
  {
    name: 'normalizeAmount: 整数分原样返回',
    group: 'required',
    fn: () => assertEq(normalizeAmount(1000), 1000),
  },
  {
    name: 'normalizeAmount: 拒绝小数',
    group: 'required',
    fn: () => assertThrows(() => normalizeAmount(10.5), TypeError),
  },
  {
    name: 'normalizeAmount: 拒绝负数',
    group: 'required',
    fn: () => assertThrows(() => normalizeAmount(-1), RangeError),
  },
  {
    name: 'normalizeAmount: 拒绝非数字',
    group: 'required',
    fn: () => assertThrows(() => normalizeAmount('100'), TypeError),
  },
  {
    name: 'normalizeCurrency: 转大写',
    group: 'required',
    fn: () => assertEq(normalizeCurrency('usd'), 'USD'),
  },
  {
    name: 'normalizeCurrency: 拒绝不支持的币种',
    group: 'required',
    fn: () => assertThrows(() => normalizeCurrency('BTC'), RangeError),
  },
  {
    name: 'applySpread: 点差按万分比加到汇率上',
    group: 'required',
    fn: () => assertEq(applySpread(72000, 30), 72030),
  },
  {
    name: 'applySpread: 点差为 0 时汇率不变',
    group: 'required',
    fn: () => assertEq(applySpread(72000, 0), 72000),
  },
  {
    name: 'convert: 72000 万分比 × 100 分 = 720 分',
    group: 'required',
    fn: () => {
      // 汇率 72000 bps = 7.2000；100 分 × 7.2 = 720 分
      assertEq(convert(100, 72000, 'CNY'), 720);
    },
  },
  {
    name: 'convert: JPY 为零位小数直接取整',
    group: 'required',
    fn: () => assertEq(convert(10000, 20000, 'JPY'), 200),
  },
  {
    name: 'convert: 结果做四舍五入而非截断',
    group: 'required',
    fn: () => assertEq(convert(3, 50000, 'CNY'), 15),
  },
  {
    name: 'quote: 返回完整报价字段',
    group: 'required',
    fn: () => {
      const q = quote({ amount: 10000, from: 'USD', to: 'CNY' }, 72000, 30);
      assertEq(q.from, 'USD', 'from');
      assertEq(q.to, 'CNY', 'to');
      assertEq(q.rate, 72030, '含点差汇率');
      assertEq(q.target, 72030, '目标金额');
      assertEq(q.currency, 'CNY', '币种');
    },
  },

  // ══════ 自测组：乙方自己加的，不计入验收 ══════
  {
    name: 'extra: 报价金额不应为负',
    group: 'extra',
    fn: () => {
      let threw = false;
      try {
        quote({ amount: -100, from: 'USD', to: 'CNY' }, 72000, 30);
      } catch {
        threw = true;
      }
      assertTrue(threw, '应拒绝负数金额');
    },
  },
  {
    name: 'extra: 零金额报价合法',
    group: 'extra',
    fn: () => assertEq(quote({ amount: 0, from: 'USD', to: 'CNY' }, 72000, 0).target, 0),
  },
  {
    name: 'extra: 大额换算不溢出',
    group: 'extra',
    fn: () => {
      const q = quote({ amount: 999999999, from: 'CNY', to: 'USD' }, 13850, 30);
      assertTrue(Number.isSafeInteger(q.target), '结果应为安全整数');
    },
  },
];

// ─────────────── 断言 ───────────────
function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || '值'}: 期望 ${expected}，实际 ${actual}`);
  }
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`${label}: 期望为真，实际为假`);
}
function assertThrows(fn, errType) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`应抛出 ${errType?.name || '错误'}，但没有抛`);
  if (errType && !(threw instanceof errType)) {
    throw new Error(`应抛出 ${errType.name}，实际是 ${threw.constructor.name}`);
  }
}

// ─────────────── 执行 ───────────────
const suiteArg = (process.argv.find((a) => a.startsWith('--suite=')) || '').split('=')[1];
const selected = CASES.filter((c) => (suiteArg === 'required' ? c.group === 'required' : true));

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

const report = {
  total: results.length,
  passed,
  failed,
  passRate: results.length > 0 ? Math.round((passed / results.length) * 10000) : 0, // 万分比
  cases: results,
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed > 0 ? 1 : 0);