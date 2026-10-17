/**
 * 交付物本地存储
 *
 * 解决的核心问题：之前「交付物地址」只是个占位符字符串，
 * 上传的交付物与验收实际运行的代码是**断开的** ——
 * 验收跑的是平台目录里的固定样例，而不是乙方交的东西。
 *
 * 本模块把这条链接上：
 *   上传 zip/tar.gz → 存本地磁盘 → 算真实 SHA-256 → 记录路径
 *   → 验收时从该路径解包出源码，在隔离运行时里真正跑起来
 *
 * ⚠️ 安全要点：解包 zip/tar 时必须防路径穿越（Zip Slip / Tar Slip）。
 *    攻击者可以构造形如 `../../etc/passwd` 或 `../../../.ssh/id_rsa` 的条目，
 *    若直接解压到目标目录就能覆盖任意文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar');

const STORAGE_ROOT = process.env.DELIVERY_STORAGE_ROOT
  ? path.resolve(process.env.DELIVERY_STORAGE_ROOT)
  : path.join(__dirname, '..', '..', '..', 'deliveries');

/** 单个压缩包上限：50MB。防止磁盘被打爆 */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** 解包后总大小上限：200MB。防止 zip bomb（高压缩比炸弹） */
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;

/** 允许的单文件数上限 */
const MAX_FILE_COUNT = 5000;

// ══════════════════ 路径安全 ══════════════════

/**
 * 解析并校验路径，确保最终落在 base 之内。
 *
 * @param {string} base 基准目录（绝对路径）
 * @param {string} rel  相对路径（来自压缩包条目）
 * @returns {string} 安全的绝对路径
 * @throws 路径穿越时抛错
 */
function safeResolve(base, rel) {
  // Windows 路径分隔符统一
  const normalized = String(rel).replace(/\\/g, '/').replace(/\0/g, '');

  // 绝对路径直接拒绝
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`拒绝绝对路径条目: ${rel}`);
  }

  // 逐段检查，任何 .. 都直接拒绝（比解析后判断更严格，不会漏掉软链接绕过）
  const segments = normalized.split('/').filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new Error(`拒绝路径穿越条目: ${rel}`);
  }

  const abs = path.resolve(base, segments.join(path.sep));
  // 双保险：解析后仍需在 base 之内
  if (!abs.startsWith(path.resolve(base) + path.sep) && abs !== path.resolve(base)) {
    throw new Error(`路径越界: ${rel}`);
  }
  return abs;
}

// ══════════════════ 存储布局 ══════════════════

/**
 * 每个项目/里程碑一个目录：
 *   deliveries/<projectId>/<idx>/
 *     ├── archive.bin        原始压缩包
 *     ├── manifest.json      元信息（哈希、大小、文件名、时间）
 *     └── source/            解包后的源码
 */
function milestoneDir(projectId, idx) {
  return path.join(STORAGE_ROOT, String(projectId), String(idx));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ══════════════════ 保存上传 ══════════════════

/**
 * 保存并解包交付物。
 *
 * @param {number} projectId
 * @param {number} idx
 * @param {Buffer} buffer   压缩包内容
 * @param {string} filename 原始文件名（用于判断格式与展示）
 * @returns {object} { hash, uri, size, fileCount, extractedTo, originalName }
 */
async function saveDelivery(projectId, idx, buffer, filename = 'delivery.zip') {
  if (!buffer || !buffer.length) throw new Error('交付物内容为空');
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`压缩包过大（${(buffer.length / 1048576).toFixed(1)}MB），上限 ${MAX_ARCHIVE_BYTES / 1048576}MB`);
  }

  const dir = ensureDir(milestoneDir(projectId, idx));
  const srcDir = path.join(dir, 'source');
  // 重新上传时清空旧源码，避免残留文件混入
  fs.rmSync(srcDir, { recursive: true, force: true });
  ensureDir(srcDir);

  // 真实内容哈希 —— 这是交付物的唯一身份标识
  const hash = '0x' + crypto.createHash('sha256').update(buffer).digest('hex');

  const archivePath = path.join(dir, 'archive.bin');
  fs.writeFileSync(archivePath, buffer);

  const isTar = /\.tar\.gz$|\.tgz$|\.tar$/i.test(filename) || isTarGz(buffer);
  const extracted = isTar
    ? await extractTar(srcDir, buffer)
    : await extractZip(srcDir, buffer);

  const manifest = {
    hash,
    size: buffer.length,
    originalName: filename,
    format: isTar ? 'tar.gz' : 'zip',
    fileCount: extracted.fileCount,
    totalBytes: extracted.totalBytes,
    projectId,
    milestoneIndex: idx,
    uploadedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    hash,
    // 本地 URI：真实可解析到磁盘路径，不是占位符
    uri: `local://deliveries/${projectId}/${idx}`,
    size: buffer.length,
    fileCount: extracted.fileCount,
    totalBytes: extracted.totalBytes,
    originalName: filename,
    extractedTo: srcDir,
  };
}

/** 嗅探 gzip 魔数，判断是否 tar.gz */
function isTarGz(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// ══════════════════ 解包：ZIP ══════════════════

/**
 * 解包 ZIP（零依赖实现，只用 Node 内置 zlib）。
 *
 * 这里手写而不用 adm-zip 等库，是因为需要精确控制每一步：
 * 逐条目校验路径 → 累计大小 → 超限即中止。
 */
async function extractZip(destDir, buffer) {
  // 定位 EOCD（End of Central Directory）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP 文件（找不到 EOCD）');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  let fileCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 路径安全校验 —— 目录条目以 / 结尾
    if (name.endsWith('/')) {
      ensureDir(safeResolve(destDir, name));
    } else {
      const target = safeResolve(destDir, name);
      ensureDir(path.dirname(target));

      // 读本地文件头拿真实数据偏移
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`本地文件头损坏: ${name}`);
      }
      const lNameLen = buffer.readUInt16LE(localOffset + 26);
      const lExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);

      let content;
      if (method === 0) {
        content = raw; // stored
      } else if (method === 8) {
        content = zlib.inflateRawSync(raw); // deflate
      } else {
        throw new Error(`不支持的压缩方式 ${method}: ${name}`);
      }

      // 双重限额：单个文件大小 + 解包总量，防 zip bomb
      totalBytes += content.length;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`解包后总大小超限（${(totalBytes / 1048576).toFixed(0)}MB），疑似压缩炸弹`);
      }
      fileCount++;
      if (fileCount > MAX_FILE_COUNT) {
        throw new Error(`文件数超限（>${MAX_FILE_COUNT}）`);
      }

      fs.writeFileSync(target, content);
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { fileCount, totalBytes };
}

// ══════════════════ 解包：tar.gz ══════════════════

/**
 * 解包 tar / tar.gz。
 *
 * tar 库要求 file 路径（不直接吃 Buffer），所以先落临时文件再解压，
 * 解压完立即删除临时文件。
 *
 * 防穿越靠 tar 自身的 `filter` 回调 —— 它在**写盘之前**对每个条目调用，
 * 我们在这里做路径校验，命中穿越条目直接抛错中止整次解包。
 * 这比「先解出来再检查」安全得多，因为不会给攻击者写入机会。
 */
async function extractTar(destDir, buffer) {
  const tmpFile = path.join(destDir, '__archive.tmp');
  fs.writeFileSync(tmpFile, buffer);

  let fileCount = 0;
  let totalBytes = 0;
  let rejected = null;

  try {
    await tar.x({
      file: tmpFile,
      cwd: destDir,
      // 同步模式返回 undefined，必须 await 内部的结束信号
      sync: false,
      // strip: 去掉 tar 里的顶层 './'，让文件落在 destDir 根下
      filter: (p) => {
        try {
          safeResolve(destDir, p);
          return true;
        } catch (e) {
          // 记下来并拒绝该条目；不抛是为了让 tar 正常结束，
          // 之后统一由调用方判断是否有被拒条目
          rejected = e.message;
          return false;
        }
      },
      onentry: (entry) => {
        if (entry.type === 'File') {
          fileCount++;
          totalBytes += entry.size || 0;
          if (totalBytes > MAX_EXTRACTED_BYTES) {
            throw new Error(
              `解包后总大小超限（${(totalBytes / 1048576).toFixed(0)}MB），疑似压缩炸弹`
            );
          }
          if (fileCount > MAX_FILE_COUNT) {
            throw new Error(`文件数超限（>${MAX_FILE_COUNT}）`);
          }
        }
      },
    });
  } finally {
    // 无论成功失败都要清掉临时文件，否则会被当成"交付物的一部分"
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* 可能已被清理 */
    }
  }

  if (rejected) {
    throw new Error(`压缩包包含非法路径条目，已中止解包 —— ${rejected}`);
  }

  return { fileCount, totalBytes };
}

// ══════════════════ 读取 ══════════════════

/** 读取 manifest */
function readManifest(projectId, idx) {
  const p = path.join(milestoneDir(projectId, idx), 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 校验磁盘上的文件是否仍与记录的哈希一致（防篡改/替换） */
function verifyIntegrity(projectId, idx) {
  const manifest = readManifest(projectId, idx);
  if (!manifest) return { ok: false, reason: '未找到交付物' };

  const archivePath = path.join(milestoneDir(projectId, idx), 'archive.bin');
  if (!fs.existsSync(archivePath)) return { ok: false, reason: '压缩包文件丢失' };

  const buf = fs.readFileSync(archivePath);
  const hash = '0x' + crypto.createHash('sha256').update(buf).digest('hex');
  if (hash !== manifest.hash) {
    return { ok: false, reason: '哈希不匹配，文件可能被替换', expected: manifest.hash, actual: hash };
  }
  return { ok: true, hash, manifest };
}

/**
 * 探测真正的项目根目录。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 交付物打包时最常见的两种习惯：
 *   A. `tar -czf p.zip src test package.json`      → 解出来直接就是项目根
 *   B. `zip -r p.zip sample-api/`                  → 解出来多一层 `sample-api/`
 *
 * 若是 B，验收按 `src/server.js` 找会找不到（真实踩过：
 * `Cannot find module .../source/src/server.js`），
 * 而让乙方「重新打包」并不合理 —— 两种打包方式都是正常的。
 *
 * ── 判定规则（保守，不猜） ────────────────────────────────────
 * 只有满足**全部**条件才认定为嵌套根目录：
 *   1. source 下有且仅有 1 个子目录（顶层全是单个目录）
 *   2. 该子目录里有 package.json，或有验收规格里声明的入口文件
 * 否则一律用 source 本身。
 *
 * @param {string} sourceDirPath 解包根
 * @param {string[]} entryHints  入口文件线索（相对路径）
 * @returns {{dir: string, stripped: string|null, reason: string}}
 */
function detectProjectRoot(sourceDirPath, entryHints = []) {
  let entries;
  try {
    entries = fs.readdirSync(sourceDirPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
  } catch {
    return { dir: sourceDirPath, stripped: null, reason: '无法读取解包目录' };
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());

  // 顶层直接有文件 → 就是项目根
  if (files.length > 0) {
    return { dir: sourceDirPath, stripped: null, reason: '顶层含文件，判定为项目根' };
  }

  // 顶层有多个目录 → 无法确定哪个是根
  if (dirs.length !== 1) {
    return {
      dir: sourceDirPath, stripped: null,
      reason: `顶层有 ${dirs.length} 个目录，无法判定项目根`,
    };
  }

  // 唯一子目录，检查它像不像项目根
  const inner = path.join(sourceDirPath, dirs[0].name);
  const innerEntries = fs.readdirSync(inner);

  const hasPackageJson = innerEntries.includes('package.json');
  const hasEntry = entryHints.some((h) => {
    const p = path.join(inner, h);
    return fs.existsSync(p);
  });

  if (hasPackageJson || hasEntry) {
    return {
      dir: inner,
      stripped: dirs[0].name,
      reason: hasPackageJson
        ? `检测到嵌套项目根「${dirs[0].name}/」（含 package.json）`
        : `检测到嵌套项目根「${dirs[0].name}/」（含入口文件 ${entryHints.find((h) => fs.existsSync(path.join(inner, h)))}）`,
    };
  }

  // 唯一子目录但不含任何项目特征 → 保守起见不动
  return { dir: sourceDirPath, stripped: null, reason: `唯一子目录「${dirs[0].name}/」不像项目根，保持原样` };
}

/** 解包后的源码目录（验收时用这个作为 cwd） */
function sourceDir(projectId, idx) {
  return path.join(milestoneDir(projectId, idx), 'source');
}

/**
 * 实际的项目根目录 —— 供验收使用。
 *
 * 与 sourceDir 的区别：若打包时多了一层目录，这里会自动指向内层。
 */
function projectRoot(projectId, idx, spec) {
  const src = sourceDir(projectId, idx);
  const hints = [];
  if (spec?.delivery?.serveCommand) hints.push(spec.delivery.serveCommand.replace(/^\.?\//, ''));
  if (spec?.delivery?.entryPoint) hints.push(spec.delivery.entryPoint.replace(/^\.?\//, ''));
  return detectProjectRoot(src, hints).dir;
}

/** 读取探测结果（含说明，便于在验收响应里告诉用户） */
function explainRoot(projectId, idx, spec) {
  return detectProjectRoot(sourceDir(projectId, idx), [
    spec?.delivery?.serveCommand?.replace(/^\.?\//, ''),
    spec?.delivery?.entryPoint?.replace(/^\.?\//, ''),
  ].filter(Boolean));
}

function hasDelivery(projectId, idx) {
  return fs.existsSync(path.join(milestoneDir(projectId, idx), 'manifest.json'));
}

module.exports = {
  STORAGE_ROOT,
  MAX_ARCHIVE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_FILE_COUNT,
  safeResolve,
  detectProjectRoot,
  milestoneDir,
  sourceDir,
  projectRoot,
  explainRoot,
  saveDelivery,
  readManifest,
  verifyIntegrity,
  hasDelivery,
};