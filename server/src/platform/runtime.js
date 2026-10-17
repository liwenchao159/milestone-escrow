/**
 * 进程内数据库 —— 回答「服务依赖数据库时验收平台怎么跑」
 *
 * 核心思路：
 *   平台不能假设对方用 MySQL 还是 PG、Redis 还是 Memcached。
 *   所以约定一套**平台提供的运行时契约**：
 *   - 交付物只依赖标准 Postgres 协议与 Redis 协议
 *   - 平台负责在沙箱里提供这两个「服务」
 *   - 平台用 pg-mem 起一个真能执行 SQL 的内存 PG，用内存 Map 实现 Redis 常用命令
 *
 * 这样做的三个好处：
 *   1. 不需要 Docker —— 验收环境随开随用，每单独立隔离
 *   2. 环境完全由平台掌控，乙方无法在「数据库里塞假数据」骗过验收
 *   3. 每个项目的数据库是独立的，天然隔离，互不污染
 *
 * 局限（必须诚实说明）：
 *   - pg-mem 不是完整 PostgreSQL，复杂 SQL / 扩展（PostGIS 等）不支持
 *   - 内存 Redis 只实现了常用命令，不覆盖 Lua 脚本、持久化、集群
 *   - 不测真实数据库的性能特征（慢查询、连接数上限、锁竞争）
 *   → 因此**性能与容量相关的验收不能用这套环境**，必须另配压测环境
 */

const { newDb } = require('pg-mem');

/**
 * 创建隔离的数据库实例。
 * 每次调用得到一个全新的库，天然实现项目级数据隔离。
 */
function createDatabase(name = 'escrow_platform') {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem 的 createPg() 返回 { Pool, Client } 工厂，必须先 new Pool 才有 query 方法
  const pgFactory = db.adapters.createPg();
  const pool = new pgFactory.Pool();

  // 建表语句在首次调用时执行（async），因此用 lazy 初始化
  let schemaPromise = null;

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        // 平台自身的数据表
        await pool.query(`
          CREATE TABLE users (
            id            SERIAL PRIMARY KEY,
            address       VARCHAR(64) UNIQUE NOT NULL,
            nickname      VARCHAR(64) NOT NULL,
            role          VARCHAR(32) NOT NULL DEFAULT 'user',
            created_at    TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(`
          CREATE TABLE projects (
            id              SERIAL PRIMARY KEY,
            title           VARCHAR(256) NOT NULL,
            client_addr     VARCHAR(64) NOT NULL,
            provider_addr   VARCHAR(64) NOT NULL,
            arbitrator_addr VARCHAR(64) NOT NULL,
            rule_set_id     VARCHAR(64) NOT NULL,
            spec_json       TEXT NOT NULL,
            total_amount    VARCHAR(128) NOT NULL,
            chain_project_id VARCHAR(32),
            status          VARCHAR(32) NOT NULL DEFAULT 'draft',
            created_at      TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(`
          CREATE TABLE milestones (
            id                SERIAL PRIMARY KEY,
            project_id        INT NOT NULL,
            idx               INT NOT NULL,
            title             VARCHAR(256) NOT NULL,
            amount            VARCHAR(128) NOT NULL,
            status            VARCHAR(32) NOT NULL DEFAULT 'pending',
            deliverable_hash  VARCHAR(128),
            deliverable_uri   TEXT,
            submitter_addr    VARCHAR(64),
            submitted_at      TIMESTAMP,
            score             SMALLINT,
            facts_json        TEXT,
            facts_hash        VARCHAR(128),
            evaluated_at      TIMESTAMP,
            passed_at         TIMESTAMP,
            settled_at        TIMESTAMP,
            challenge_reason  VARCHAR(32),
            challenge_note    TEXT,
            challenger_addr   VARCHAR(64),
            payout_ratio      SMALLINT,
            dispute_hash      VARCHAR(128)
          )
        `);

        await pool.query(`
          CREATE TABLE settlement_orders (
            id                SERIAL PRIMARY KEY,
            project_id        INT NOT NULL,
            milestone_id      INT NOT NULL,
            order_type        VARCHAR(32) NOT NULL,
            amount            VARCHAR(128) NOT NULL,
            to_addr           VARCHAR(64) NOT NULL,
            tx_hash           VARCHAR(128),
            block_number      VARCHAR(32),
            status            VARCHAR(32) NOT NULL DEFAULT 'pending',
            created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
            confirmed_at      TIMESTAMP
          )
        `);

        await pool.query(`
          CREATE TABLE audit_log (
            id          SERIAL PRIMARY KEY,
            project_id  INT,
            actor_addr  VARCHAR(64),
            action      VARCHAR(64) NOT NULL,
            detail_json TEXT,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
      })();
    }
    return schemaPromise;
  }

  return {
    db,
    pg: pool,
    name,
    ensureSchema,
    async query(sql, params) {
      await ensureSchema();
      return pool.query(sql, params);
    },
    async one(sql, params) {
      await ensureSchema();
      const r = await pool.query(sql, params);
      return r.rows[0] || null;
    },
    async many(sql, params) {
      await ensureSchema();
      const r = await pool.query(sql, params);
      return r.rows;
    },
    /** 允许交付物建自己的表（模拟真实的多 schema 场景） */
    async raw(sql, params) {
      return pool.query(sql, params);
    },
  };
}

/**
 * 内存 Key-Value 存储 —— Redis 常用命令的兼容实现。
 *
 * 覆盖交付物常用的：GET/SET/DEL/EXISTS/INCR/HSET/HGETALL/SADD/SMEMBERS/LPUSH/LRANGE/EXPIRE/TTL
 * 不支持：Lua 脚本、持久化、集群、发布订阅、事务
 */
function createKVStore() {
  /** @type {Map<string, {value: any, type: 'string'|'hash'|'set'|'list', expireAt?: number}>} */
  const store = new Map();

  /**
   * 判断是否过期。
   * 注意：entry 可能是 undefined（key 不存在），此时返回 false 表示「未过期但不存在」，
   * 调用方各自处理不存在的情况。早期版本写成 `entry && entry.expireAt && ...`
   * 在 `entry` 为 undefined 时返回 undefined（falsy），但后续有代码直接读
   * `e.type` 导致崩溃 —— 这里显式返回布尔值并注释语义。
   */
  function isExpired(entry) {
    if (!entry) return false; // 不存在 ≠ 过期
    return Boolean(entry.expireAt) && Date.now() > entry.expireAt;
  }

  function ensure(key, type, factory) {
    let e = store.get(key);
    if (isExpired(e)) {
      e = factory();
      store.set(key, e);
    } else if (!e) {
      e = factory();
      store.set(key, e);
    }
    return e;
  }

  const api = {
    // ── 字符串 ──
    async set(key, value, mode) {
      if (mode === 'EX') {
        // set(key, val, 'EX', seconds)
      }
      store.set(key, { value: String(value), type: 'string' });
      return 'OK';
    },
    async get(key) {
      const e = store.get(key);
      if (!e || isExpired(e)) return null;
      return e.type === 'string' ? e.value : null;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys.flat()) if (store.delete(k)) n++;
      return n;
    },
    async exists(key) {
      const e = store.get(key);
      return isExpired(e) ? 0 : 1;
    },
    async incr(key) {
      const e = ensure(key, 'string', () => ({ value: '0', type: 'string' }));
      e.value = String(Number(e.value) + 1);
      return Number(e.value);
    },
    async incrby(key, n) {
      const e = ensure(key, 'string', () => ({ value: '0', type: 'string' }));
      e.value = String(Number(e.value) + Number(n));
      return Number(e.value);
    },
    async expire(key, seconds) {
      const e = store.get(key);
      if (!e || isExpired(e)) return 0;
      e.expireAt = Date.now() + Number(seconds) * 1000;
      return 1;
    },
    async ttl(key) {
      const e = store.get(key);
      if (!e) return -2;
      if (isExpired(e)) return -2;
      if (!e.expireAt) return -1;
      const left = Math.ceil((e.expireAt - Date.now()) / 1000);
      return left > 0 ? left : -2;
    },

    // ── 哈希 ──
    async hset(key, field, value) {
      const e = ensure(key, 'hash', () => ({ value: {}, type: 'hash' }));
      e.value[field] = String(value);
      return 1;
    },
    async hget(key, field) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'hash') return null;
      return e.value[field] ?? null;
    },
    async hgetall(key) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'hash') return {};
      return { ...e.value };
    },
    async hincrby(key, field, n) {
      const e = ensure(key, 'hash', () => ({ value: {}, type: 'hash' }));
      e.value[field] = String((Number(e.value[field]) || 0) + Number(n));
      return Number(e.value[field]);
    },

    // ── 集合 ──
    async sadd(key, ...members) {
      const e = ensure(key, 'set', () => ({ value: new Set(), type: 'set' }));
      let n = 0;
      for (const m of members.flat()) {
        if (!e.value.has(String(m))) {
          e.value.add(String(m));
          n++;
        }
      }
      return n;
    },
    async srem(key, ...members) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'set') return 0;
      let n = 0;
      for (const m of members.flat()) if (e.value.delete(String(m))) n++;
      return n;
    },
    async smembers(key) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'set') return [];
      return [...e.value];
    },
    async sismember(key, member) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'set') return 0;
      return e.value.has(String(member)) ? 1 : 0;
    },

    // ── 列表 ──
    async lpush(key, ...values) {
      const e = ensure(key, 'list', () => ({ value: [], type: 'list' }));
      for (const v of values.flat()) e.value.unshift(String(v));
      return e.value.length;
    },
    async rpush(key, ...values) {
      const e = ensure(key, 'list', () => ({ value: [], type: 'list' }));
      for (const v of values.flat()) e.value.push(String(v));
      return e.value.length;
    },
    async lrange(key, start, stop) {
      const e = store.get(key);
      if (!e || isExpired(e) || e.type !== 'list') return [];
      const len = e.value.length;
      const s = start < 0 ? Math.max(0, len + start) : start;
      const t = stop < 0 ? len + stop : Math.min(stop, len - 1);
      return t < s ? [] : e.value.slice(s, t + 1);
    },
    async llen(key) {
      const e = store.get(key);
      return !e || isExpired(e) || e.type !== 'list' ? 0 : e.value.length;
    },

    // ── 运维 ──
    async flushall() {
      store.clear();
      return 'OK';
    },
    async ping() {
      return 'PONG';
    },
    /** 平台自用：导出现状用于调试 */
    _dump() {
      return Object.fromEntries(
        [...store.entries()].map(([k, v]) => [k, { type: v.type, value: v.value }])
      );
    },
    _stats() {
      return { keys: store.size };
    },
  };

  return api;
}

/**
 * 为一个项目创建完整的隔离运行环境。
 * 数据库 + KV 都是全新的，不与任何其他项目共享。
 */
function createProjectRuntime(projectId) {
  const database = createDatabase(`project_${projectId}`);
  const kv = createKVStore();
  return {
    projectId,
    database,
    kv,
    async destroy() {
      await kv.flushall();
      // pg-mem 无需显式销毁，实例被 GC 即可；这里只清 KV
    },
  };
}

module.exports = { createDatabase, createKVStore, createProjectRuntime };
