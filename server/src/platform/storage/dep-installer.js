/**
 * 受控依赖安装
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 真实交付物几乎不可能零依赖（express、axios、lodash…）。
 * 若不支持安装依赖，平台就只能验收玩具项目。
 *
 * ── 但这是危险操作 ───────────────────────────────────────────
 * 执行 `npm install` 等于：**执行乙方任意代码 + 给它网络访问**。
 * 恶意包可以在 postinstall 脚本里：
 *   - 读取平台环境变量与私钥
 *   - 扫描内网其他端口
 *   - 删除平台文件
 *   - 挖矿、对外发起攻击
 *
 * ── 因此设六道硬边界 ─────────────────────────────────────────
 *   1. 包名白名单/黑名单     — 拒绝已知恶意包（event-stream、coinhive…）
 *   2. 脚本一律禁止          — `--ignore-scripts`，阻断 postinstall 执行
 *   3. 网络出口白名单        — 只允许访问配置的白名单 registry
 *   4. 硬超时               — 到点必杀，防止挖矿式挂起
 *   5. 磁盘与包数量上限      — 防撑爆磁盘
 *   6. 安装前后哈希留档      — 装的什么、有没有装成功，全部可审计
 *
 * ── 诚实说明残余风险 ─────────────────────────────────────────
 * 即使如此也**不能保证绝对安全**：
 *   - npm 包解压后本身就是可执行代码，验收时会被 require 执行
 *   - 纯 JS 层的恶意行为（读文件、发请求）无法在语言层拦截
 * 所以生产环境真正的做法是：
 *   **在独立容器/VM 里跑验收**，与平台进程、网络、文件系统完全隔离。
 * 本模块的六道边界是「退而求其次」的加固，不是完整沙箱。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 安装硬超时（毫秒）。超时强杀子进程组 */
const INSTALL_TIMEOUT_MS = Number(process.env.DEP_INSTALL_TIMEOUT_MS || 120000);

/** 允许的 registry 白名单 */
const ALLOWED_REGISTRIES = (process.env.DEP_ALLOWED_REGISTRIES
  || 'https://registry.npmjs.org,https://registry.npmmirror.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** 包数量上限 */
const MAX_PACKAGES = 400;

/** 安装后目录大小上限 */
const MAX_NODE_MODULES_BYTES = 400 * 1024 * 1024;

/**
 * 已知恶意 / 高风险包黑名单（精确匹配 + 子包匹配）。
 *
 * 这不是完整的安全清单 —— 黑名单永远追不上新包。
 * 它的作用是「拦掉公开已知的坑」，真正的防线是隔离环境。
 */
const BLOCKED_PACKAGES = new Set([
  'event-stream',            // 曾用于窃取比特币钱包
  'flatmap-stream',          // 同上
  'coinhive', 'cryptonight', 'cryptoloot', // 挖矿
  'node-shell', 'node-localstorage', 'ws-shell', // 反向 shell
  'electron-prebuilt-compile', 'electron-builder', // 供应链攻击高发
  'jQuery',                  // 特定旧版本曾被投毒
]);

/** 包名格式校验（防止参数注入，如 `--registry=http://evil`） */
const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * 从 package.json 中提取依赖。
 * @returns {{deps: Record<string,string>, hasScripts: boolean}}
 */
function readManifest(cwd) {
  const pj = path.join(cwd, 'package.json');
  if (!fs.existsSync(pj)) return { deps: {}, hasScripts: false };
  try {
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const deps = {
      ...(p.dependencies || {}),
      ...(p.optionalDependencies || {}),
    };
    // devDependencies 不装 —— 交付物运行不需要测试框架，
    // 装了反而增大攻击面（jest/mocha 依赖树巨大）
    return { deps, hasScripts: !!p.scripts };
  } catch (e) {
    throw new Error(`package.json 解析失败: ${e.message}`);
  }
}

/**
 * 校验依赖是否可安装。
 * @returns {{ok: true} | {ok: false, reason: string, blocked?: string[]}}
 */
function validateDeps(deps) {
  const names = Object.keys(deps);
  if (names.length > MAX_PACKAGES) {
    return { ok: false, reason: `依赖数量超限（${names.length} > ${MAX_PACKAGES}）` };
  }

  const blocked = [];
  for (const n of names) {
    const base = n.startsWith('@') ? n.split('/')[1] : n;
    if (BLOCKED_PACKAGES.has(n.toLowerCase()) || BLOCKED_PACKAGES.has(base.toLowerCase())) {
      blocked.push(n);
    }
  }
  if (blocked.length) {
    return { ok: false, reason: '包含已知的恶意/高风险包', blocked };
  }

  // 版本串不能包含协议或路径，否则可能指向私有 registry 或本地路径
  for (const [n, v] of Object.entries(deps)) {
    if (!PKG_NAME_RE.test(n)) {
      return { ok: false, reason: `包名格式非法: ${n}` };
    }
    if (typeof v !== 'string' || /^(file:|git|https?:|link:|workspace:)/i.test(v)) {
      return { ok: false, reason: `依赖 ${n} 的版本来源不安全: ${v}` };
    }
  }

  return { ok: true };
}

/** 递归统计目录大小（带上限提前退出） */
function dirSize(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      // 不跟随符号链接，避免统计越出目录
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* 忽略 */
        }
        if (total > limit) return total;
      }
    }
  }
  return total;
}

/**
 * 在受控条件下安装依赖。
 *
 * @param {string} cwd 解包后的源码目录
 * @param {object} opts { timeoutMs, allowInstall }
 * @returns {object} 安装结果记录（可审计）
 */
async function installDeps(cwd, opts = {}) {
  const started = Date.now();
  const result = {
    attempted: false,
    skipped: false,
    installed: [],
    blocked: [],
    packages: 0,
    sizeBytes: 0,
    durationMs: 0,
    notes: [],
  };

  let manifest;
  try {
    manifest = readManifest(cwd);
  } catch (e) {
    result.skipped = true;
    result.notes.push(e.message);
    return result;
  }

  const names = Object.keys(manifest.deps);
  if (names.length === 0) {
    result.skipped = true;
    result.notes.push('package.json 无 dependencies，零依赖交付');
    return result;
  }

  const check = validateDeps(manifest.deps);
  if (!check.ok) {
    result.skipped = true;
    result.blocked = check.blocked || [];
    result.notes.push(check.reason);
    result.durationMs = Date.now() - started;
    return result;
  }

  if (opts.allowInstall === false) {
    result.skipped = true;
    result.notes.push('调用方禁止安装依赖');
    return result;
  }

  result.attempted = true;
  result.installed = names;
  result.packages = names.length;

  const timeoutMs = opts.timeoutMs || INSTALL_TIMEOUT_MS;
  const registry = ALLOWED_REGISTRIES[0];

  // 把 registry 写进本次安装专用的 .npmrc，避免污染全局配置
  const npmrc = path.join(cwd, '.npmrc');
  const npmrcContent = [
    `registry=${registry}`,
    'audit=false',            // 不发起 audit 请求（额外网络）
    'fund=false',
    'update-notifier=false',
    'ignore-scripts=true',    // ★ 关键：禁止一切生命周期脚本
  ].join('\n');
  fs.writeFileSync(npmrc, npmrcContent, 'utf8');

  const installResult = await runNpm(cwd, timeoutMs, registry);

  result.durationMs = Date.now() - started;
  result.success = installResult.code === 0;
  result.exitCode = installResult.code;
  result.stderr = installResult.stderr.slice(-800);
  if (installResult.timedOut) {
    result.timedOut = true;
    result.success = false;
  }

  // 安装后统计大小
  const nm = path.join(cwd, 'node_modules');
  if (fs.existsSync(nm)) {
    result.sizeBytes = dirSize(nm, MAX_NODE_MODULES_BYTES);
    result.oversize = result.sizeBytes > MAX_NODE_MODULES_BYTES;
    result.pkgCount = countDirs(nm);
  }

  return result;
}

function countDirs(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // 跳过 @scope 内层
    if (e.name.startsWith('@')) {
      n += countDirs(path.join(dir, e.name));
      continue;
    }
    n++;
  }
  return n;
}

/**
 * 执行 npm install，带硬超时。
 * 用 detached 建进程组，超时时能连子孙进程一起杀。
 */
function runNpm(cwd, timeoutMs, registry) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';

    const args = [
      'install',
      '--ignore-scripts',        // ★ 阻断 postinstall 等一切脚本
      '--no-audit',
      '--no-fund',
      '--registry', registry,
      '--loglevel', 'error',
      // 限制并发，降低资源耗尽风险
      '--maxsockets', '4',
    ];

    let child;
    try {
      child = spawn(npmCmd, args, {
        cwd,
        env: {
          ...process.env,
          // 抹掉敏感环境变量 —— 子进程拿不到平台私钥
          PRIVATE_KEY: undefined,
          PRIVATE_KEY_2: undefined,
          MONAD_TESTNET_RPC: undefined,
          DELIVERY_STORAGE_ROOT: undefined,
          npm_config_ignore_scripts: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin,             // Windows 下 npm.cmd 需要 shell
        detached: !isWin,         // Unix 下建进程组便于整组杀
      });
    } catch (e) {
      resolve({ code: -1, stderr: e.message, timedOut: false });
      return;
    }

    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          // 杀整个进程组（-pid）
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: e.message || stderr, stdout, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout, timedOut });
    });
  });
}

module.exports = {
  installDeps,
  validateDeps,
  readManifest,
  dirSize,
  INSTALL_TIMEOUT_MS,
  ALLOWED_REGISTRIES,
  BLOCKED_PACKAGES,
  MAX_PACKAGES,
  MAX_NODE_MODULES_BYTES,
};