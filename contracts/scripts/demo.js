/**
 * 端到端演示：完整走一遍「创建 → 双签 → 提交 → 采集 → 评估 → 挑战 → 终结 → 凭证」全流程
 *
 * 运行：npx hardhat run scripts/demo.js
 */
const { ethers } = require("hardhat");

const toBytes32 = (v) => ethers.zeroPadValue(ethers.toUtf8Bytes(v), 32);
const R = "standard-interface-v1";
const RID = toBytes32(R);
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;

const log = (...a) => console.log(...a);
const hr = (t) => log("\n" + "═".repeat(62) + "\n  " + t + "\n" + "═".repeat(62));

async function main() {
  const [client, provider, arbitrator] = await ethers.getSigners();

  hr("步骤 0 · 部署");
  const escrow = await (await ethers.getContractFactory("MilestoneEscrow")).deploy();
  await escrow.waitForDeployment();
  const evaluator = await (
    await ethers.getContractFactory("DeterministicEvaluator")
  ).deploy(await escrow.getAddress());
  await evaluator.waitForDeployment();

  await (
    await evaluator.registerRuleSet(RID, 80, 9000, 9500, 9000, 5000, 3000, 2000)
  ).wait();
  await (await evaluator.setCollector(client.address, true)).wait();

  log("  Escrow   ", await escrow.getAddress());
  log("  Evaluator", await evaluator.getAddress());
  log("  甲(client)   ", client.address);
  log("  乙(provider) ", provider.address);
  log("  仲裁者      ", arbitrator.address);

  // ── 1. 创建项目 ──
  hr("步骤 1 · 创建项目（规则哈希上链，锁定不可单方变更）");
  await (
    await escrow.createProject(provider.address, arbitrator.address, await evaluator.getAddress(), toBytes32("template:" + R), 2)
  ).wait();
  const pid = 0n;
  log("  项目已创建，状态 =", (await escrow.getProject(pid)).status === 1n ? "Draft（等待双签）" : "?");
  log("  规则哈希已写入链上，此后不可变更");

  // ── 2. 双签 ──
  hr("步骤 2 · 甲乙双签规则");
  await (await escrow.connect(client).signRule(pid)).wait();
  log("  ✓ 甲方已签署");
  await (await escrow.connect(provider).signRule(pid)).wait();
  log("  ✓ 乙方已签署 → 项目激活，规则正式锁定");
  log("  当前状态 =", (await escrow.getProject(pid)).status === 2n ? "Active" : "?");

  // ── 3. 提交交付 ──
  hr("步骤 3 · 乙方提交交付物（存哈希，不存源码）");
  const codeHash = ethers.id("sha256:deliverable-m1-source-code");
  await (
    await escrow.connect(provider).submitMilestone(pid, 0, codeHash, "ipfs://Qm-demo-milestone-1")
  ).wait();
  log("  里程碑 0 已提交");
  log("  交付物哈希 =", codeHash);
  log("  注意：链上只有哈希，源码内容不落链，乙方可安心用于作品集");

  // ── 4. 事实采集 ──
  hr("步骤 4 · 采集客观事实（模拟采集结果）");
  const facts = { test: 9600, api: 9900, field: 9500 };
  log("  采集器拉取到三维度事实（万分比）:");
  log("    必测用例通过率  ", facts.test / 100 + "%");
  log("    接口可用率      ", facts.api / 100 + "%");
  log("    契约字段覆盖率  ", facts.field / 100 + "%");
  const reportHash = ethers.id("sha256:fact-report-" + JSON.stringify(facts));
  log("  事实报告哈希 =", reportHash, "（上链后可审计复算）");

  // ── 5. 链上评估 ──
  hr("步骤 5 · 链上确定性评估");
  await (await evaluator.connect(client).evaluate(pid, 0, RID, facts.test, facts.api, facts.field, reportHash)).wait();
  let m = await escrow.getMilestone(pid, 0);
  log(`  评估结论：得分 ${m.lastScore} / 通过线 80 → ${m.status === 4n ? "✓ 通过" : "✗ 不通过"}`);
  log("  判定完全由链上不可变规则集决定，采集器无法左右结果");

  // ── 6. 对比：低分维度被硬门槛拦下 ──
  hr("步骤 6 · 对照实验 · 高分但某维度不达标 → 硬门槛拦下");
  await (await escrow.connect(provider).submitMilestone(pid, 1, ethers.id("sha256:deliverable-m2"), "ipfs://Qm-demo-m2")).wait();
  const sneaky = { test: 8000, api: 10000, field: 10000 };
  await (await evaluator.connect(client).evaluate(pid, 1, RID, sneaky.test, sneaky.api, sneaky.field, ethers.id("sneaky"))).wait();
  m = await escrow.getMilestone(pid, 1);
  log("  事实：测试 80%（未达 90% 门槛）· 接口 100% · 字段 100%");
  log(`  结果：得分 ${m.lastScore} 分（很高）→ ${m.status === 5n ? "✗ 仍判定不通过" : "?"}`);
  log("  这就是硬门槛的价值：不能靠其他维度的高分补齐，防止「只挑软指标达标」");

  // ── 7. 挑战 ──
  hr("步骤 7 · 挑战期（3 天）内发起挑战");
  await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "我认为已达标，评分偏低")).wait();
  m = await escrow.getMilestone(pid, 0);
  log("  乙方发起挑战，状态 =", m.status === 3n ? "Challenged" : "?");

  hr("步骤 8 · 仲裁者裁决（维持通过）");
  await (await escrow.connect(arbitrator).resolveDispute(pid, 0, true)).wait();
  m = await escrow.getMilestone(pid, 0);
  log("  仲裁者维持通过结论，状态 =", m.status === 4n ? "Passed" : "?");

  // ── 9. 终结并铸发凭证 ──
  hr("步骤 9 · 过挑战期，终结并铸发履历凭证");
  await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 100]);
  await ethers.provider.send("evm_mine", []);

  await (await escrow.connect(client).finalizeMilestone(pid, 0)).wait();
  const bal = await escrow.balanceOf(provider.address, pid);
  log(`  里程碑 0 已终结，乙方凭证数 = ${bal}`);
  log("  凭证为 soulbound，不可转让（防止买卖履历）");

  // 失败里程碑也能终结
  await (await escrow.connect(client).finalizeMilestone(pid, 1)).wait();
  log(`  里程碑 1（未达标）也已终结，乙方凭证数仍为 ${await escrow.balanceOf(provider.address, pid)}`);
  log("  不达标不铸凭证，但同样有闭环路径 —— 这是 v1 设计缺陷的修复");

  // ── 10. 项目完成与履历 ──
  hr("步骤 10 · 项目完成与可验证履历");
  const p = await escrow.getProject(pid);
  log("  项目状态 =", p.status === 3n ? "Completed" : "?", "（基于终结数计算，与调用顺序无关）");

  const [pids, counts] = await escrow.getProviderCredentials(provider.address);
  log(`  乙方可验证履历：项目 ${pids.length} 个，凭证 ${counts.reduce((a, b) => a + b, 0n)} 张`);
  log("  履历与真实验收事件绑定，可对外展示但不泄露交付内容");

  hr("演示完成");
  log("  核心结论：");
  log("  1. 规则锁定 + 双签 → 甲方无法单方塞入偏颇条件");
  log("  2. 硬门槛机制 → 高分无法补齐不达标维度");
  log("  3. 判定在链上 → 采集器可被质疑但无法操纵结论");
  log("  4. 挑战期 + 仲裁 → 信任被转移，但没被消除，且可问责");
  log("  5. 不达标也有闭环 → 状态机无死锁");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
