/**
 * 订单计算核心逻辑 —— 被验收的交付物
 * 这是一段真实可运行、有 bug 的代码，用来演示验收平台如何客观发现问题。
 */

/** 计算订单总价（分） */
function computeTotal(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  return items.reduce((sum, it) => sum + it.price * it.qty, 0);
}

/** 应用折扣（分） */
function applyDiscount(total, rule) {
  if (rule === 'NONE') return total;
  if (rule === 'VIP10') return Math.floor(total * 0.9);
  if (rule === 'VIP20') return Math.floor(total * 0.8);
  throw new Error('unknown discount rule: ' + rule);
}

/** 运费（分） */
function shippingFee(total, rule) {
  if (rule === 'FREE_OVER_100') return total >= 10000 ? 0 : 500;
  return 500;
}

/** 订单应付金额（分） */
function payableAmount(items, discountRule) {
  const total = computeTotal(items);
  const discounted = applyDiscount(total, discountRule);
  return discounted + shippingFee(discounted, 'FREE_OVER_100');
}

module.exports = { computeTotal, applyDiscount, shippingFee, payableAmount };
