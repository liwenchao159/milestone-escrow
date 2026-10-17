/**
 * 对照实验：验证验收平台能否客观发现交付物的问题
 *
 * 三个场景：
 *   A. 交付物有真实 bug        → 平台应该测出来
 *   B. 乙方删减必测用例        → 平台应该检测到数量不符
 *   C. 甲方伪造验收环境        → 理论上不可能（平台自建环境）
 *
 * 运行：node harness/experiments.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runAcceptance } = require('./acceptance-harness');

// 注意：跨平台安全起见用 process.cwd() 而非 __dirname（打包/单文件运行时可能失效）
const DEMO = process.cwd();
const DELIVERY = path.join(DEMO, 'delivery');
const SPEC = path.join(DEMO, 'acceptance-spec.json');

const hr = (t) => console.log('\n' + '═'.repeat(70) + '\n  ' + t + '\n' + '═'.repeat(70));

/**
 * 把交付物复制到临时目录做篡改实验。
 *
 * 不用 fs.cpSync —— 它在部分 Node 版本上会直接崩溃（0xC0000409），
 * 改为手写递归复制，跨版本稳定。
 */
function cloneDelivery() {
  const tmp = path.join(DEMO, '.sandbox-' + Date.now());
  copyDir(DELIVERY, tmp);
  return tmp;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // 跳过 node_modules 等重内容，加速实验
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function experimentA() {
  hr('实验 A · 交付物存在真实 bug —— 平台能否测出来？');

  // 注入 bug：VIP20 折扣算错（打九折而不是八折）
  const dir = cloneDelivery();
  const orderFile = path.join(dir, 'src', 'order.js');
  let code = fs.readFileSync(orderFile, 'utf8');
  code = code.replace("if (rule === 'VIP20') return Math.floor(total * 0.8);",
                      "if (rule === 'VIP20') return Math.floor(total * 0.9);");
  fs.writeFileSync(orderFile, code);
  console.log('已注入缺陷：VIP20 折扣从八折改为九折');
  console.log('');

  const r = await runAcceptance(dir, SPEC);
  console.log('');
  console.log('  ▶ 结论：');
  console.log(`    验收结果    : ${r.result.passed ? '通过' : '不通过'}`);
  console.log(`    必测通过率  : ${r.facts.testPassRate / 100}%`);
  console.log(`    失败用例    : ${r.testResult.detail.failedCases.map((c) => c.name).join('; ') || '无'}`);
  console.log(`    平台是否发现 : ${r.testResult.detail.failedRequired > 0 ? '✓ 发现并精确定位到用例' : '✗ 未发现'}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function experimentB() {
  hr('实验 B · 乙方删减必测用例 —— 平台能否检测到？');

  // 乙方作弊：删掉 3 个必测用例，只留最容易过的 7 个
  const dir = cloneDelivery();
  const testFile = path.join(dir, 'test', 'run-tests.js');
  let code = fs.readFileSync(testFile, 'utf8');

  // 把三个必测用例改成 skip（即不参与统计）
  code = code.replace(
    "  {\n    name: 'computeTotal: 空数组返回 0',\n    group: 'required',",
    "  {\n    name: 'computeTotal: 空数组返回 0',\n    group: 'extra',"
  ).replace(
    "  {\n    name: 'computeTotal: 非数组应抛错',\n    group: 'required',",
    "  {\n    name: 'computeTotal: 非数组应抛错',\n    group: 'extra',"
  ).replace(
    "  {\n    name: 'shippingFee: 未满 100 收 5 元',\n    group: 'required',",
    "  {\n    name: 'shippingFee: 未满 100 收 5 元',\n    group: 'extra',"
  );
  fs.writeFileSync(testFile, code);

  console.log('已模拟作弊：乙方把 3 个失败的必测用例标记为 extra（逃出统计）');
  console.log('');

  const r = await runAcceptance(dir, SPEC);
  console.log('');
  console.log('  ▶ 结论：');
  console.log(`    必测用例数  : 实测 ${r.testResult.detail.requiredCount} / 约定 ${r.testResult.detail.expectedCount}`);
  console.log(`    数量校验    : ${r.testResult.detail.countMismatch ? '✗ 检测到不符！' : '未发现'}`);
  console.log(`    通过率      : ${r.facts.testPassRate / 100}%`);
  console.log('');
  if (r.testResult.detail.countMismatch) {
    console.log('    ★ 平台发现数量不符，判定为无效交付');
    console.log('      这就是「必测组数量在签约时锁定」的价值 ——');
    console.log('      乙方无法通过删减用例来提高通过率。');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function experimentC() {
  hr('实验 C · 甲方伪造验收环境 —— 平台能否防御？');

  console.log('这个实验不需要真跑，因为从架构上就不成立：');
  console.log('');
  console.log('  平台的探测流程：');
  console.log('    1. 平台用自己的 Node 进程，在随机端口启动交付物');
  console.log('    2. 平台向 127.0.0.1:<随机端口> 发请求');
  console.log('    3. 甲方无法在任何环节介入 —— 没有「甲方提供接口地址」这个配置项');
  console.log('');
  console.log('  对比原 Web3 方案的漏洞：');
  console.log('    原方案：验收接口地址由甲方填 → 甲方自建一个返回 200 的假接口');
  console.log('    本方案：接口地址由平台生成 → 不存在可伪造的第三方');
  console.log('');
  console.log('  契约字段覆盖率的分母同样来自锁定的契约，');
  console.log('  乙方多返回字段也无法提高覆盖率。');
}

async function experimentD() {
  hr('实验 D · 接口契约不满足 —— 平台能否定位到具体缺失字段？');

  const dir = cloneDelivery();
  const serverFile = path.join(dir, 'src', 'server.js');
  let code = fs.readFileSync(serverFile, 'utf8');
  // 删除 currency 字段（契约里声明为必填）
  code = code.replace("      payable: amount,\n      currency: 'CNY',\n      items: o.items,", "      payable: amount,\n      items: o.items,");
  fs.writeFileSync(serverFile, code);

  console.log('已移除接口响应中的 currency 字段（契约声明为必填）');
  console.log('');

  const r = await runAcceptance(dir, SPEC);
  console.log('');
  console.log('  ▶ 结论：');
  console.log(`    字段覆盖率  : ${r.facts.fieldCoverage / 100}%`);
  r.apiResult.fieldCoverage.detail.perPath.forEach((p) => {
    if (p.status === 'incomplete') {
      console.log(`    缺失字段    : ${p.path} → ${p.missing.join(', ')}`);
    }
  });
  console.log(`    验收结果    : ${r.result.passed ? '通过' : '不通过'}`);
  console.log('');
  console.log('    ★ 平台不只说「字段不达标」，而是精确指出哪个接口少了哪个字段。');
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await experimentA();
  await experimentB();
  await experimentC();
  await experimentD();

  hr('汇总');
  console.log('  平台能客观发现的：');
  console.log('    ✓ 计算逻辑错误（通过必测用例失败发现）');
  console.log('    ✓ 必测用例被删减（通过数量校验发现）');
  console.log('    ✓ 接口不可达 / 状态码不符（通过多轮探测发现）');
  console.log('    ✓ 响应字段缺失（通过契约比对发现，并定位到具体字段）');
  console.log('');
  console.log('  平台测不到、必须人来看的：');
  console.log('    ✗ 规格清单里没列的接口 / 场景 —— 平台只测清单内的');
  console.log('    ✗ 代码是否优雅、命名是否清晰、可维护性');
  console.log('    ✗ 架构是否合理、有无隐藏后门（可辅以静态扫描 + 人工评审）');
  console.log('');
  console.log('  这正是「范围克制」的意义：只对能被客观验证的部分做自动验收，');
  console.log('  其余部分明确交给人工判断，而不是伪装成自动化。');
})();
