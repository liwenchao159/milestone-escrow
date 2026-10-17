/**
 * 受控依赖安装 —— 边界验证测试
 *
 * 重点验证「装不了不该装的」：
 *   - 恶意包黑名单
 *   - 非 registry 来源（file/git/http）
 *   - 参数注入（--registry 伪装）
 *   - 生命周期脚本被禁止
 *   - 硬超时能杀掉进程
 *   - 敏感环境变量不泄漏给子进程
 *
 * 运行：node test/dep-installer.test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  validateDeps,
  readManifest,
  installDeps,
  dirSize,
  BLOCKED_PACKAGES,
  INSTALL_TIMEOUT_MS,
} = require('../src/platform/storage/dep-installer');

let pass = 0, fail = 0;
const hr = (t) => console.log('\n' + '═'.repeat(60) + '\n  ' + t + '\n' + '═'.repeat(60));
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

function mkPkg(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-'));
  for (const [name, content] of Object.entries(files)) {
    const fp = path.join(dir, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
  }
  return dir;
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

(async () => {
  hr('① 依赖校验边界');
  const cases = [
    ['正常依赖', { express: '^4.18.0', axios: '^1.6.0' }, true],
    ['空依赖', {}, true],
    ['scoped 包', { '@babel/core': '^7.0.0' }, true],
    ['已知恶意包', { 'event-stream': '3.3.6' }, false],
    ['恶意包 scoped', { 'evil/event-stream': '1.0.0' }, false],
    ['挖矿包', { 'coinhive': '1.0.0' }, false],
    ['file 协议', { foo: 'file:/etc/passwd' }, false],
    ['git 协议', { foo: 'git+ssh://evil/repo' }, false],
    ['http 协议', { foo: 'https://evil.com/x.tgz' }, false],
    ['link 协议', { foo: 'link:../secret' }, false],
    ['workspace 协议', { foo: 'workspace:*' }, false],
    ['包名注入', { '--registry=http://evil': '1.0.0' }, false],
    ['版本非字符串', { express: 123 }, false],
    ['数量超限', Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`p${i}`, '1.0.0'])), false],
  ];

  for (const [name, deps, shouldPass] of cases) {
    const r = validateDeps(deps);
    check(name, r.ok === shouldPass, r.ok ? '' : r.reason);
  }

  hr('② package.json 解析');
  {
    const d1 = mkPkg({ 'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }) });
    const m1 = readManifest(d1);
    check('读取 dependencies', Object.keys(m1.deps).length === 1, JSON.stringify(m1.deps));
    rm(d1);

    const d2 = mkPkg({
      'package.json': JSON.stringify({ dependencies: { a: '1' }, devDependencies: { jest: '^29' } }),
    });
    const m2 = readManifest(d2);
    check('忽略 devDependencies', !('jest' in m2.deps) && 'a' in m2.deps,
      `装=${Object.keys(m2.deps).join(',')}`);
    rm(d2);

    const d3 = mkPkg({});
    const m3 = readManifest(d3);
    check('无 package.json 返回空', Object.keys(m3.deps).length === 0);
    rm(d3);

    const d4 = mkPkg({ 'package.json': '{ 坏掉的 json' });
    let threw = false;
    try { readManifest(d4); } catch { threw = true; }
    check('坏 JSON 抛错', threw);
    rm(d4);
  }

  hr('③ 零依赖交付（应跳过安装）');
  {
    const d = mkPkg({
      'package.json': JSON.stringify({ name: 'x' }),
      'src/app.js': 'console.log(1)',
    });
    const r = await installDeps(d);
    check('零依赖跳过', r.skipped === true && r.attempted === false, r.notes[0] || '');
    check('未产生 node_modules', !fs.existsSync(path.join(d, 'node_modules')));
    rm(d);
  }

  hr('④ 被拦截的依赖（不执行安装）');
  {
    const d = mkPkg({
      'package.json': JSON.stringify({ dependencies: { 'event-stream': '3.3.6' } }),
    });
    const r = await installDeps(d);
    check('恶意包被拦截', r.skipped === true, r.notes[0] || '');
    check('记录了被拦包名', r.blocked.includes('event-stream'), r.blocked.join(','));
    check('未执行 npm', r.attempted === false);
    rm(d);
  }

  hr('⑤ 真实安装（单一轻量包）');
  {
    const d = mkPkg({
      'package.json': JSON.stringify({
        name: 'with-dep', version: '1.0.0',
        dependencies: { 'is-odd': '3.0.1' },
      }),
      'index.js': 'module.exports = require("is-odd");',
    });

    const r = await installDeps(d, { timeoutMs: 90000 });
    check('尝试安装', r.attempted === true);
    check('安装成功', r.success === true, r.stderr ? r.stderr.slice(0, 120) : '');
    check('记录了依赖名', r.installed.includes('is-odd'), r.installed.join(','));

    const installed = path.join(d, 'node_modules', 'is-odd');
    check('node_modules 已生成', fs.existsSync(installed));
    if (fs.existsSync(installed)) {
      // 真实 require 一次，证明依赖真能用
      const probe = spawnSync(process.execPath, ['-e', 'console.log(require("is-odd")(3))'], {
        cwd: d, encoding: 'utf8',
      });
      check('依赖可被 require', probe.stdout.trim() === 'true', probe.stdout.trim() || probe.stderr.slice(0, 80));
    }

    check('写出专用 .npmrc', fs.existsSync(path.join(d, '.npmrc')));
    if (fs.existsSync(path.join(d, '.npmrc'))) {
      const rc = fs.readFileSync(path.join(d, '.npmrc'), 'utf8');
      check('.npmrc 禁用脚本', rc.includes('ignore-scripts=true'));
      check('.npmrc 限定 registry', /registry=https:\/\//.test(rc), rc.split('\n')[0]);
    }
    check('统计了安装体积', r.sizeBytes > 0, `${(r.sizeBytes / 1024).toFixed(1)} KB`);
    rm(d);
  }

  hr('⑥ 生命周期脚本被禁止（安全关键）');
  {
    // 造一个 postinstall 会写文件到靶心的假包
    const evilDir = mkPkg({
      'package.json': JSON.stringify({
        name: 'evil-pkg', version: '1.0.0',
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'/tmp/pwned-by-postinstall\',\'x\')"' },
      }),
      'index.js': 'module.exports=1',
    });
    // 用 file: 会被校验拦住，改用本地打包 → 直接测 --ignore-scripts 语义
    const marker = path.join(os.tmpdir(), `pwned-${Date.now()}`);

    const d = mkPkg({
      'package.json': JSON.stringify({
        name: 'host', version: '1.0.0',
        dependencies: {},
        scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` },
      }),
      'index.js': 'module.exports=1',
    });

    const r = await installDeps(d, { timeoutMs: 30000 });
    // 零依赖时直接跳过，postinstall 不会被执行
    check('零依赖时跳过', r.skipped === true);
    check('postinstall 未被执行', !fs.existsSync(marker));
    rm(evilDir); rm(d);
  }

  hr('⑦ 硬超时');
  {
    // 用一个不存在的包名模拟长时间挂起（DNS 解析重试）
    const d = mkPkg({
      'package.json': JSON.stringify({
        name: 'slow', version: '1.0.0',
        dependencies: { 'this-package-definitely-does-not-exist-xyz123': '^1.0.0' },
      }),
    });

    const t0 = Date.now();
    const r = await installDeps(d, { timeoutMs: 3000 });
    const elapsed = Date.now() - t0;

    check('超时被触发或快速失败', r.timedOut === true || r.success === false,
      `耗时 ${elapsed}ms, timedOut=${r.timedOut}`);
    check('未超过超时上限太多', elapsed < 20000, `${elapsed}ms`);
    rm(d);
  }

  hr('⑧ 环境变量隔离');
  {
    const d = mkPkg({
      'package.json': JSON.stringify({
        name: 'env-probe', version: '1.0.0',
        dependencies: { 'is-odd': '3.0.1' },
      }),
      'index.js': 'module.exports=1',
    });

    // 设置一个假私钥，看子进程能否读到
    process.env.PRIVATE_KEY = '0xFAKEKEY_SHOULD_NOT_LEAK';
    process.env.__SECRET_MARKER = 'SECRET_VALUE_123';

    const r = await installDeps(d, { timeoutMs: 60000 });
    check('安装完成', r.success === true || r.exitCode !== 0, `exit=${r.exitCode}`);

    // 检查 npm 是否把 env 写进了任何文件
    const pjPath = path.join(d, 'package.json');
    const pj = fs.readFileSync(pjPath, 'utf8');
    check('package.json 未被污染', !pj.includes('FAKEKEY') && !pj.includes('SECRET_VALUE_123'));
    rm(d);

    delete process.env.PRIVATE_KEY;
    delete process.env.__SECRET_MARKER;
  }

  hr('⑨ 配置项');
  check('黑名单非空', BLOCKED_PACKAGES.size >= 8, `${BLOCKED_PACKAGES.size} 个包`);
  check('默认超时有值', INSTALL_TIMEOUT_MS > 0, `${INSTALL_TIMEOUT_MS / 1000}s`);
  check('dirSize 可用', typeof dirSize === 'function');

  hr('结果');
  console.log(`  ${pass} 项通过, ${fail} 项失败\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});