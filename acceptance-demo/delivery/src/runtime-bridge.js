/**
 * 运行时桥接 —— 交付物通过它访问平台提供的中间件
 *
 * 交付物**不关心**背后是真 PG 还是内存实现，只调标准接口。
 * 这样平台可以自由替换底层实现，而交付物代码零改动。
 *
 * 生产环境把这里换成真实 pg / ioredis 即可。
 */

function getRuntime() {
  const rt = global.__ACCEPTANCE_RUNTIME__;
  if (!rt) {
    throw new Error('运行时未注入 —— 该服务必须在验收平台的隔离环境中运行');
  }
  return rt;
}

/** 数据库访问 */
const db = {
  async query(sql, params) {
    const { database } = getRuntime();
    return database.query(sql, params);
  },
  async one(sql, params) {
    const { database } = getRuntime();
    return database.one(sql, params);
  },
  async many(sql, params) {
    const { database } = getRuntime();
    return database.many(sql, params);
  },
};

/** 缓存访问 */
const cache = {
  async get(k) { return getRuntime().kv.get(k); },
  async set(k, v) { return getRuntime().kv.set(k, v); },
  async incr(k) { return getRuntime().kv.incr(k); },
  async del(...k) { return getRuntime().kv.del(...k); },
  async hset(k, f, v) { return getRuntime().kv.hset(k, f, v); },
  async hgetall(k) { return getRuntime().kv.hgetall(k); },
  async lpush(k, ...v) { return getRuntime().kv.lpush(k, ...v); },
  async lrange(k, s, e) { return getRuntime().kv.lrange(k, s, e); },
  async expire(k, s) { return getRuntime().kv.expire(k, s); },
};

module.exports = { db, cache, getRuntime };
