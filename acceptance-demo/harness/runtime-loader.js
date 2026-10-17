/**
 * 运行时加载器 —— 在交付物进程启动前注入平台运行时
 *
 * 用 `node --require runtime-loader.js server.js` 方式加载。
 * 它在交付物的主逻辑之前执行，因此交付物的 src/runtime-bridge.js
 * 第一次被 require 时，global.__ACCEPTANCE_RUNTIME__ 已经就绪。
 *
 * 为什么需要它：global 变量无法跨进程传递（父进程设置，子进程读不到，
 * 已实测确认）。所以必须在子进程内部完成注入。
 */

const path = require('path');
const fs = require('fs');

const runtimeModule = process.env.ACCEPTANCE_RUNTIME_MODULE;
const projectId = process.env.ACCEPTANCE_PROJECT_ID || 'acceptance';
/** 父进程写出的数据库快照路径（子进程启动时读入） */
const snapshotPath = process.env.ACCEPTANCE_DB_SNAPSHOT;
let seedReadyPromise = Promise.resolve(0);

if (runtimeModule) {
  try {
    const { createProjectRuntime } = require(runtimeModule);
    const runtime = createProjectRuntime(projectId);

    /**
     * 关键：父进程和子进程是两个独立进程，各建一份数据库实例，
     * 内存不共享。所以父进程必须把灌好的种子数据**导出成快照**，
     * 由本加载器在子进程里**导入**。
     *
     * 导入必须是**同步阻塞**的：交付物的主逻辑（require server.js）
     * 在本加载器之后才执行，若导入是异步的，服务会在数据就绪前
     * 开始处理请求，导致「订单查不到」。
     */
    seedReadyPromise = importSeed(runtime.database, snapshotPath);

    global.__ACCEPTANCE_RUNTIME__ = {
      database: runtime.database,
      kv: runtime.kv,
      /** 等待种子数据导入完成。交付物的 init() 应 await 这个。 */
      seedReady: seedReadyPromise,
    };
    process.env.ACCEPTANCE_RUNTIME_READY = '1';
  } catch (e) {
    process.env.ACCEPTANCE_RUNTIME_ERROR = e.message;
    console.error('[runtime-loader] 运行时注入失败:', e.message);
  }
}

/**
 * 导入种子数据快照。
 * 返回 Promise，交付物 init() 必须 await 它，否则会在数据就绪前处理请求。
 */
async function importSeed(database, snapshotPath) {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return 0;
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const rows = snapshot.rows || [];
  let imported = 0;

  // 先确保 schema 存在（平台表 + 规格里的建表语句由父进程负责，这里只建平台表）
  await database.ensureSchema().catch(() => {});

  for (const row of rows) {
    const cols = Object.keys(row.values);
    const marks = cols.map((_, i) => '$' + (i + 1));
    try {
      await database.raw(
        `INSERT INTO ${row.table} (${cols.join(',')}) VALUES (${marks.join(',')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row.values[c])
      );
      imported++;
    } catch {
      /* 表可能尚未创建 —— 交付物 init() 会建表，之后种子数据由平台二次注入 */
    }
  }
  return imported;
}
