/**
 * 订单服务 —— 依赖数据库 + 缓存的完整实现
 *
 * 这个服务演示真实交付物中常见的中间件依赖：
 *   - 订单存储在数据库
 *   - 热点查询走缓存
 *   - 访问计数走 KV
 *
 * 平台验收时，它被注入到一个隔离的运行时里（独立 DB + 独立 KV）。
 */

const http = require('http');
const { payableAmount, computeTotal } = require('./order');
const { db, cache } = require('./runtime-bridge');

let ready = false;

// ─────────────── 初始化：建表 + 幂等 ───────────────
async function init() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id             VARCHAR(32) PRIMARY KEY,
        items_json     TEXT NOT NULL,
        discount_rule  VARCHAR(32) NOT NULL,
        status         VARCHAR(16) NOT NULL DEFAULT 'created',
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS order_events (
        id          SERIAL PRIMARY KEY,
        order_id    VARCHAR(32) NOT NULL,
        event_type  VARCHAR(32) NOT NULL,
        payload     TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // 等待平台的种子数据导入完成（若在验收环境中）
    const rt = require('./runtime-bridge').getRuntime();
    if (rt.seedReady) {
      const n = await rt.seedReady;
      console.log('[db] seed rows available:', n);
    }

    // 种子数据由平台灌入（来自锁定的验收规格）。这里只在表空时补一条，
    // 用于验证「无种子数据时服务仍能正常响应」。
    const count = await db.one('SELECT COUNT(*)::int AS n FROM orders');
    if (count && count.n === 0) {
      await db.query(
        'INSERT INTO orders (id, items_json, discount_rule) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        ['DEFAULT', JSON.stringify([{ sku: 'X', name: '占位', price: 1, qty: 1 }]), 'NONE']
      );
    }
    ready = true;
    console.log('[db] tables ready');
  } catch (e) {
    console.error('[db] init failed:', e.message);
  }
}

// ─────────────── 数据访问 ───────────────
async function loadOrder(id) {
  // 先查缓存
  const cached = await cache.get(`order:${id}`);
  if (cached) {
    try {
      return { ...JSON.parse(cached), fromCache: true };
    } catch {
      /* 缓存脏数据，回源 */
    }
  }

  const row = await db.one('SELECT * FROM orders WHERE id = $1', [id]);
  if (!row) return null;

  const order = {
    id: row.id,
    items: JSON.parse(row.items_json),
    discountRule: row.discount_rule,
    status: row.status,
    createdAt: row.created_at,
    fromCache: false,
  };

  // 写缓存，TTL 300 秒
  await cache.set(`order:${id}`, JSON.stringify(order));
  await cache.expire(`order:${id}`, 300);
  return order;
}

async function saveOrder(o) {
  await db.query(
    `INSERT INTO orders (id, items_json, discount_rule, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET items_json = $2, discount_rule = $3, status = $4`,
    [o.id, JSON.stringify(o.items), o.discountRule || 'NONE', o.status || 'created']
  );
  await db.query('INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, $2, $3)', [
    o.id, o.status || 'created', JSON.stringify(o.items || []),
  ]);
  // 失效缓存
  await cache.del(`order:${o.id}`);
}

async function recordAccess(id) {
  return cache.incr(`hits:${id}`);
}

// ─────────────── HTTP ───────────────
function json(res, code, body) {
  const p = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) });
  res.end(p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/health') {
      return json(res, 200, {
        status: ready ? 'ok' : 'degraded',
        db: ready,
        ts: Date.now(),
      });
    }

    // 列出订单
    if (path === '/orders' && req.method === 'GET') {
      const rows = await db.many('SELECT id, status FROM orders ORDER BY id');
      const items = [];
      for (const r of rows) {
        const o = await loadOrder(r.id);
        items.push({
          id: o.id,
          total: computeTotal(o.items),
          payable: payableAmount(o.items, o.discountRule),
          currency: 'CNY',
        });
      }
      return json(res, 200, { items, count: items.length });
    }

    // 创建订单
    if (path === '/orders' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { id, items = [], discountRule = 'NONE' } = JSON.parse(body || '{}');
          if (!id) return json(res, 400, { error: 'id required' });
          await saveOrder({ id, items, discountRule, status: 'created' });
          return json(res, 201, {
            id,
            total: computeTotal(items),
            payable: payableAmount(items, discountRule),
            currency: 'CNY',
          });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      });
      return;
    }

    // 单个订单
    const m = path.match(/^\/orders\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      const id = m[1];
      const o = await loadOrder(id);
      if (!o) return json(res, 404, { error: 'order not found' });
      await recordAccess(id);
      return json(res, 200, {
        id: o.id,
        total: computeTotal(o.items),
        payable: payableAmount(o.items, o.discountRule),
        currency: 'CNY',
        items: o.items,
        status: o.status,
      });
    }

    // 统计
    const h = path.match(/^\/stats\/([A-Za-z0-9_-]+)$/);
    if (h) {
      const hits = await cache.get(`hits:${h[1]}`);
      return json(res, 200, { orderId: h[1], hits: Number(hits || 0), currency: 'CNY' });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (process.env.ACCEPTANCE_DEBUG) console.error('[handler]', e.stack);
    json(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
init().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`order-service listening on http://127.0.0.1:${PORT} (db=${!!global.__ACCEPTANCE_RUNTIME__})`);
  });
});

module.exports = server;
