/**
 * 汇率换算核心逻辑
 *
 * 这是交付物中「纯计算」部分 —— 不依赖 IO，因此最容易写必测用例。
 *
 * 约定：
 *   - 所有金额单位为「分」（整数），避免浮点误差
 *   - 所有比率单位为「万分比」（basis points，1 bps = 0.01%）
 */

/** 支持的币种 */
const CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY'];

/** 零位小数币种（JPY 无小数位） */
const ZERO_DECIMAL = new Set(['JPY']);

/**
 * 校验并规范化金额。
 * @param {number} amount 金额（分）
 * @returns {number} 规范化后的整数分
 */
function normalizeAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError('amount 必须是有限数字');
  }
  if (!Number.isInteger(amount)) {
    throw new TypeError('amount 必须是整数分，避免浮点误差');
  }
  if (amount < 0) {
    throw new RangeError('amount 不能为负数');
  }
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('amount 超出安全范围');
  }
  return amount;
}

/**
 * 校验币种代码。
 * @param {string} code 币种代码
 * @returns {string} 大写后的币种代码
 */
function normalizeCurrency(code) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('currency 必须是非空字符串');
  }
  const up = code.toUpperCase();
  if (!CURRENCIES.includes(up)) {
    throw new RangeError(`不支持的币种: ${code}，可选 ${CURRENCIES.join('/')}`);
  }
  return up;
}

/**
 * 按万分比计算汇率（含加点）。
 *
 * 例：baseRate = 720000 bps（= 72.0000，即 1 单位 base 换 720000 分 target），
 *     spread = 30 bps（0.3%），则用户实际拿到 base * (720000 + 30) / 1000000
 *
 * @param {number} baseRate 基础汇率（万分比）
 * @param {number} spreadBps 点差（万分比，向下取整表示对用户不利）
 * @returns {number} 含点差的汇率（万分比）
 */
function applySpread(baseRate, spreadBps) {
  if (!Number.isInteger(baseRate) || baseRate < 0) {
    throw new RangeError('baseRate 必须是非负整数');
  }
  if (!Number.isInteger(spreadBps) || spreadBps < 0) {
    throw new RangeError('spreadBps 必须是非负整数');
  }
  return baseRate + spreadBps;
}

/**
 * 换算金额，四舍五入到目标币种的最小单位。
 *
 * 舍入策略：ROUND_HALF_UP（0.5 向上），符合财务场景惯例。
 * JPY 为零位小数，直接取整。
 *
 * @param {number} amount 源金额（分）
 * @param {number} rate 含点差汇率（万分比）
 * @param {string} targetCurrency 目标币种
 * @returns {number} 目标金额（最小单位）
 */
function convert(amount, rate, targetCurrency) {
  normalizeAmount(amount);

  // amount * rate / 1_000_000
  const raw = (amount * rate) / 1000000;

  if (ZERO_DECIMAL.has(normalizeCurrency(targetCurrency))) {
    return Math.round(raw);
  }

  // 四舍五入到「分」：先乘 100 再四舍五入
  return Math.round(raw * 100);
}

/**
 * 解析报价请求。
 * @param {object} body 请求体
 * @returns {{amount:number, from:string, to:string}} 规范化后的请求
 */
function parseQuoteRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new TypeError('请求体必须是对象');
  }
  return {
    amount: normalizeAmount(body.amount),
    from: normalizeCurrency(body.from),
    to: normalizeCurrency(body.to),
  };
}

/**
 * 生成报价单。
 *
 * @param {object} body 请求体 { amount, from, to }
 * @param {number} baseRate 基础汇率（万分比），来自数据库
 * @param {number} spreadBps 点差（万分比）
 * @returns {object} 报价结果
 */
function quote(body, baseRate, spreadBps = 0) {
  const req = parseQuoteRequest(body);
  const rate = applySpread(baseRate, spreadBps);
  const target = convert(req.amount, rate, req.to);

  return {
    from: req.from,
    to: req.to,
    amount: req.amount,
    rate,
    baseRate,
    spreadBps,
    target,
    currency: req.to,
  };
}

module.exports = {
  CURRENCIES,
  ZERO_DECIMAL,
  normalizeAmount,
  normalizeCurrency,
  applySpread,
  convert,
  parseQuoteRequest,
  quote,
};