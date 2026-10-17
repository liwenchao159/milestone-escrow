/**
 * 汇率服务 HTTP 接口
 *
 * 这是交付物中「IO」部分 —— 依赖数据库与缓存。
 *
 * 关键设计：所有对数据库/缓存的访问都走 runtime-bridge，
 * 交付物不关心背后是内存实现还是真实 PG/Redis。
 *
 * ⚠️ 本文件故意留了两个缺陷，用于演示验收平台如何发现问题：
 *    1. GET /rates/:code 在币种不存在时返回 200 而非 404
 *    2. 报价接口未校验 amount 是否为正
 */
const http = require('http');
const { quote, normalizeCurrency, CURRENCIES } = require('./fx');
const { db, cache } = require('./runtime-bridge');

let ready = false;
let seededCount = 0;

/** 点差（万分比）—— 真实场景应按币种对配置，这里简化为固定值 */
const SPREAD_BPS = 30;

// ─────────────── 启动初始化 ───────────────
async function init() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        base   VARCHAR(8) NOT NULL,
        quote  VARCHAR(8) NOT NULL,
        rate   BIGINT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (base, quote)
      )
    `);

    // 等平台的种子数据导入完成（验收环境下才有）
    let rt = null;
    try {
      rt = require('./runtime-bridge').getRuntime();
    } catch {
      /* 本地独立运行时，无平台注入 */
    }
    if (rt?.seedReady) {
      const n = await rt.seedReady;
      seededCount = n;
      console.log('[fx] seed rows available:', n);
    }

    // 表为空时写入默认汇率，保证服务可独立响应
    const cnt = await db.one('SELECT COUNT(*)::int AS n FROM fx_rates');
    if (cnt && cnt.n === 0) {
      const defaults = [
        ['CNY', 'USD', 13850],   // 1 CNY = 0.13850 USD
        ['USD', 'CNY', 72200],
        ['CNY', 'HKD', 10850],
        ['HKD', 'CNY', 92200],
        ['USD', 'HKD', 7800],
        ['HKD', 'USD', 12820],
      ];
      for (const [b, q, r] of defaults) {
        await db.query(
          'INSERT INTO fx_rates (base, quote, rate) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [b, q, r]
        );
      }
      console.log('[fx] default rates inserted:', defaults.length);
    }

    ready = true;
  } catch (e) {
    console.error('[fx] init failed:', e.message);
  }
}

// ─────────────── 数据访问 ───────────────
async function getRate(base, quote) {
  // 热门币种走缓存
  const key = `fx:${base}:${quote}`;
  const cached = await cache.get(key);
  if (cached) {
    try {
      return { rate: Number(cached), fromCache: true };
    } catch {
      /* 脏数据，回源 */
    }
  }

  const row = await db.one(
    'SELECT rate FROM fx_rates WHERE base = $1 AND quote = $2',
    [base, quote]
  );
  if (!row) return null;

  await cache.set(key, String(row.rate));
  await cache.expire(key, 300);
  return { rate: Number(row.rate), fromCache: false };
}

async function listRates() {
  return db.many('SELECT base, quote, rate FROM fx_rates ORDER BY base, quote');
}

// ─────────────── HTTP ───────────────
function json(res, code, body) {
  const p = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(p),
  });
  res.end(p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    // 健康检查 —— 验收平台用它判断服务是否就绪
    if (path === '/health') {
      return json(res, 200, {
        status: ready ? 'ok' : 'degraded',
        db: ready,
        currencies: CURRENCIES.length,
        ts: Date.now(),
      });
    }

    // 汇率列表
    if (path === '/rates' && req.method === 'GET') {
      const rows = await listRates();
      const items = rows.map((r) => ({
        base: r.base,
        quote: r.quote,
        rate: Number(r.rate),
        spreadBps: SPREAD_BPS,
      }));
      return json(res, 200, { items, count: items.length });
    }

    // 单个汇率
    const m = path.match(/^\/rates\/([A-Za-z]{3})$/);
    if (m && req.method === 'GET') {
      let base, quoteCode;
      try {
        base = normalizeCurrency(m[1]);
        // 约定路径 /rates/:base 只查 CNY 基准，简化演示
        quoteCode = 'CNY';
        if (base === 'CNY') quoteCode = 'USD';
      } catch {
        return json(res, 400, { error: '不支持的币种代码' });
      }

      const r = await getRate(base, quoteCode);
      if (!r) {
        // ⚠️ 缺陷 1：应为 404，实际返回 200 且字段不全
        // 契约字段覆盖率检测会因此失败
        return json(res, 200, { base });
      }
      return json(res, 200, {
        base,
        quote: quoteCode,
        rate: r.rate,
        spreadBps: SPREAD_BPS,
        effectiveRate: r.rate + SPREAD_BPS,
      });
    }

    // 报价
    if (path === '/quote' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          return json(res, 400, { error: '请求体不是合法 JSON' });
        }

        // ⚠️ 缺陷 2：未校验 amount 是否为正，负数会走到业务逻辑
        let from, to;
        try {
          from = normalizeCurrency(payload.from);
          to = normalizeCurrency(payload.to);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }

        const r = await getRate(from, to);
        if (!r) {
          return json(res, 404, { error: `无 ${from}/${to} 汇率` });
        }

        try {
          const q = quote(payload, r.rate, SPREAD_BPS);
          return json(res, 200, {
            from: q.from,
            to: q.to,
            amount: q.amount,
            rate: q.rate,
            target: q.target,
            currency: q.currency,
            spreadBps: q.spreadBps,
          });
        } catch (e) {
          // 缺陷 2 的后果：负数金额会走到这里才报错，且返回 400 而非业务语义
          return json(res, 400, { error: e.message });
        }
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (process.env.FX_DEBUG) console.error('[handler]', e.stack);
    json(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
init().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`fx-service listening on http://127.0.0.1:${PORT} (ready=${ready})`);
  });
});

module.exports = server;