/**
 * Monad 测试网端到端演示（真实资金流转）
 *
 * 与 demo-payment.js 的区别：这里每一笔都是链上真实交易，
 * 涉及注资、验收、放款、退款、争议分配的全流程。
 *
 * 前置：deploy-payment.js 已执行
 * 运行：npx hardhat run scripts/demo-onchain.js --network monad
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const CW = 3 * 24 * 60 * 60;
const U = ethers.parseEther("1");
const fmt = (v) => Number(ethers.formatEther(v)).toFixed(2);
const hr = (t) => console.log("\n" + "═".repeat(64) + "\n  " + t + "\n" + "═".repeat(64));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Monad 注意：共识与执行解耦，新充值账户需等待约 1.2 秒状态延迟。
 * 发送交易前短暂等待，避免状态未同步导致的失败。
 */
async function waitForStateSync() {
  await sleep(1500);
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const file = path.join(__dirname, "..", `deployments-${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`未找到部署清单 ${file}，请先运行 deploy-payment.js`);
  }
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const RULE_ID = ethers.zeroPadValue(
    ethers.toUtf8Bytes(dep.rules.find((r) => r.id === "standard-interface-v1").id),
    32
  );

  const [deployer] = await ethers.getSigners();

  hr("连接 Monad 测试网");
  console.log("  chainId :", chainId.toString());
  console.log("  部署者  :", deployer.address);
  console.log("  余额    :", fmt(await ethers.provider.getBalance(deployer.address)), "MON");

  // 绑定已部署合约
  const token = new ethers.Contract(dep.contracts.token, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function mint(address,uint256)",
  ], deployer);

  const escrow = new ethers.Contract(dep.contracts.escrow, [
    "function createProject(address,address,address,address,uint256,bytes32,uint256[]) returns (uint256)",
    "function fundProject(uint256)",
    "function signRule(uint256)",
    "function submitMilestone(uint256,uint256,bytes32,string)",
    "function challengeMilestone(uint256,uint256,uint8,string)",
    "function resolveDispute(uint256,uint256,uint16)",
    "function releaseMilestone(uint256,uint256)",
    "function refundMilestone(uint256,uint256)",
    "function cancelProject(uint256)",
    "function projectCount() view returns (uint256)",
    "function getProject(uint256) view returns (tuple(address client,address provider,address arbitrator,address evaluator,address token,uint256 totalAmount,uint256 fundedAmount,bytes32 ruleSetId,uint8 status,uint64 createdAt,uint64 fundedAt,uint64 completedAt,uint256 milestoneCount,uint256 releasedAmount,uint256 refundedAmount))",
    "function getMilestone(uint256,uint256) view returns (tuple(uint256 amount,uint8 status,bytes32 deliverableHash,string deliverableURI,uint64 submittedAt,uint64 evaluatedAt,uint8 lastScore,bytes32 resultHash,uint64 passedAt,bool challenged,uint8 challengeReason,address challenger,string challengeNote,uint16 splitRatio,bool settled))",
    "function getPayoutSummary(uint256) view returns (uint256,uint256,uint256)",
    "function challengeWindowRemaining(uint256,uint256) view returns (uint256)",
  ], deployer);

  const evaluator = new ethers.Contract(dep.contracts.evaluator, [
    "function evaluate(uint256,uint256,bytes32,uint16,uint16,uint16,bytes32) returns (bool,uint16)",
  ], deployer);

  // 仲裁者是独立的 ArbitratorBot 合约（部署时生成）。
  // 其裁定比例写在链上，任一方都无法临时干预——这才是「无主观裁量」的含义。
  const arbitratorAddr = dep.contracts.arbitratorBot;
  const bot = new ethers.Contract(arbitratorAddr, [
    "function arbitrate(uint256,uint256)",
    "function defaultRatio() view returns (uint16)",
  ], deployer);

  // 乙方：部署时新建的钱包，必须有私钥才能签署 signRule / submitMilestone。
  // ⚠️ 该私钥仅存在于本地部署清单中，仅供演示。生产环境由乙方本人持有。
  const providerAddr = dep.participants.provider;
  const providerKey = dep.demoProviderKey;
  if (!providerKey) throw new Error("部署清单中缺少 demoProviderKey，请重新部署");
  const providerSigner = new ethers.Wallet(providerKey, ethers.provider);

  const amounts = [U * 20n, U * 30n, U * 50n]; // 三个里程碑，总计 100 TUSD
  const total = U * 100n;

  const show = async (title) => {
    const [c, e] = await Promise.all([
      token.balanceOf(deployer.address),
      token.balanceOf(dep.contracts.escrow),
    ]);
    console.log(`\n  ${title}`);
    console.log(`    甲方/乙方 ${fmt(c)} TUSD    合约托管 ${fmt(e)} TUSD`);
    return { c, e };
  };

  // ─────────────── 创建项目 ───────────────
  hr("步骤 1 · 创建项目（3 个里程碑，共 100 TUSD）");
  await waitForStateSync();

  const tx1 = await escrow.createProject(
    providerAddr, arbitratorAddr, dep.contracts.evaluator,
    dep.contracts.token, total, RULE_ID, amounts
  );
  const r1 = await tx1.wait();
  const pid = (await escrow.projectCount()) - 1n; // 最新创建的项目
  console.log("  交易哈希:", r1.hash);
  console.log("  项目 ID :", pid.toString());
  console.log("  里程碑分配:", amounts.map((a, i) => `M${i}=${fmt(a)}`).join("  "));
  await show("注资前");

  // ─────────────── 注资 ───────────────
  hr("步骤 2 · 注资 100 TUSD 到托管合约");
  await waitForStateSync();
  // approve 与 fundProject 由同一地址发出，显式分配 nonce 避免冲突
  const n1 = await ethers.provider.getTransactionCount(deployer.address, "pending");
  await (await token.approve(dep.contracts.escrow, total, { nonce: n1 })).wait();
  await sleep(2000);
  const n2 = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const r2 = await (await escrow.fundProject(pid, { nonce: n2 })).wait();
  console.log("  交易哈希:", r2.hash);
  await show("注资后");

  // ─────────────── 双签 ───────────────
  hr("步骤 3 · 双方签署验收规则");
  await waitForStateSync();

  // Monad 是乐观并行执行：同一地址连续发交易必须显式管理 nonce，
  // 否则第二笔会因 nonce 已被占用而失败（表现为状态未推进的假象）。
  const clientNonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const clientTx = await escrow.connect(deployer).signRule(pid, { nonce: clientNonce });
  await clientTx.wait();
  console.log("  ✓ 甲方已签署:", dep.participants.client);
  console.log("    tx:", clientTx.hash);

  await sleep(2000);
  const providerNonce = await ethers.provider.getTransactionCount(providerAddr, "pending");
  const providerTx = await escrow.connect(providerSigner).signRule(pid, { nonce: providerNonce });
  await providerTx.wait();
  console.log("  ✓ 乙方已签署:", providerAddr, "（独立签名身份）");
  console.log("    tx:", providerTx.hash);

  await sleep(2000);

  const proj = await escrow.getProject(pid);
  console.log("  项目状态:", proj.status === 3n ? "Active ✓（注资 + 双签均完成）" : proj.status);
  console.log("  注资额  :", fmt(proj.fundedAmount), "TUSD");

  // ─────────────── 交付 + 验收 ───────────────
  hr("步骤 4 · 提交交付并触发链上确定性验收");
  await waitForStateSync();
  await (await escrow.connect(providerSigner).submitMilestone(pid, 0, ethers.id("deliverable-M0"), "ipfs://monad-demo-M0")).wait();
  await sleep(1500);
  console.log("  M0 已提交（链上只存哈希，源码不落链）");

  await (await evaluator.evaluate(pid, 0, RULE_ID, 9600, 9900, 9500, ethers.id("report-M0"))).wait();
  await sleep(1500);
  const m0 = await escrow.getMilestone(pid, 0);
  console.log(`  评估结论: 得分 ${m0.lastScore}/100 → ${m0.status === 4n ? "✓ 通过" : "✗ 不通过"}`);
  const remain = await escrow.challengeWindowRemaining(pid, 0);
  console.log(`  挑战期剩余: ${Number(remain) / 3600 / 24} 天（真实时间，无法快进）`);

  // ─────────────── 争议分配 ───────────────
  hr("步骤 5 · 发起挑战 → 仲裁者按 30% 裁定（真实争议路径）");
  await waitForStateSync();
  await (await escrow.connect(providerSigner).challengeMilestone(pid, 0, 3, "远程演示：乙方发起争议")).wait();
  await sleep(1500);
  const beforeP = await token.balanceOf(deployer.address);

  // 由 ArbitratorBot 合约裁定，比例不可由调用方指定
  const botRatio = await bot.defaultRatio();
  await (await bot.arbitrate(pid, 0)).wait();
  await sleep(2000);

  const afterP = await token.balanceOf(deployer.address);
  const got = afterP - beforeP;
  console.log(`  仲裁者  : ArbitratorBot (${arbitratorAddr.slice(0,10)}...)`);
  console.log(`  链上预设比例: ${Number(botRatio) / 100}% —— 调用方无法指定`);
  console.log(`  实际到账: +${fmt(got)} TUSD（里程碑 M0 = 20，应得 ${fmt((U * 20n * BigInt(botRatio)) / 10000n)}）`);

  const m0b = await escrow.getMilestone(pid, 0);
  console.log(`  M0 状态: ${m0b.status === 6n ? "Released ✓" : m0b.status}  settled=${m0b.settled}`);

  // ─────────────── 验收不通过 → 退款 ───────────────
  hr("步骤 6 · M1 验收不通过 → 退款路径");
  await waitForStateSync();
  await (await escrow.connect(providerSigner).submitMilestone(pid, 1, ethers.id("deliverable-M1"), "ipfs://monad-demo-M1")).wait();
  await sleep(1500);
  await (await evaluator.evaluate(pid, 1, RULE_ID, 8000, 10000, 10000, ethers.id("report-M1"))).wait();
  await sleep(1500);
  const m1 = await escrow.getMilestone(pid, 1);
  console.log(`  M1 评估: 得分 ${m1.lastScore} → ${m1.status === 5n ? "✗ 不通过（硬门槛拦截）" : m1.status}`);
  console.log("  ↑ 得分很高但测试维度未达 90% 门槛 → 硬门槛不可被高分补齐");

  const beforeRefund = await token.balanceOf(deployer.address);
  await (await escrow.refundMilestone(pid, 1)).wait();
  await sleep(1500);
  const afterRefund = await token.balanceOf(deployer.address);
  console.log(`  退款到账: +${fmt(afterRefund - beforeRefund)} TUSD（M1 = 30）`);
  const m1b = await escrow.getMilestone(pid, 1);
  console.log(`  M1 状态: ${m1b.status === 7n ? "Refunded ✓" : m1b.status}`);

  // ─────────────── 取消项目 ───────────────
  hr("步骤 7 · 取消项目 → 剩余资金全退");
  await waitForStateSync();
  await (await escrow.cancelProject(pid)).wait();
  await sleep(1500);
  const projFinal = await escrow.getProject(pid);
  console.log(`  项目状态: ${projFinal.status === 5n ? "Cancelled ✓" : projFinal.status}`);

  // ─────────────── 对账 ───────────────
  hr("链上对账 · 资金守恒验证");
  const [released, refunded, remaining] = await escrow.getPayoutSummary(pid);
  const escrowBal = await token.balanceOf(dep.contracts.escrow);

  console.log(`  合约记录 · 已放款 : ${fmt(released)} TUSD`);
  console.log(`  合约记录 · 已退款 : ${fmt(refunded)} TUSD`);
  console.log(`  合约记录 · 未结算 : ${fmt(remaining)} TUSD`);
  console.log(`  链上实际 · 合约余额: ${fmt(escrowBal)} TUSD`);

  const checks = [
    ["记录之和 = 项目总额", released + refunded + remaining === total],
    ["合约余额 = 未结算金额", escrowBal === remaining],
    ["合约已清空（无残留）", escrowBal === 0n],
  ];
  console.log("");
  checks.forEach(([n, ok]) => console.log(`  ${ok ? "✓" : "✗"} ${n}`));

  hr("部署与验证信息");
  console.log("  网络   : Monad 测试网 (chainId 10143)");
  console.log("  浏览器 : https://testnet.monadscan.com");
  console.log("  Escrow :", dep.contracts.escrow);
  console.log("  Token  :", dep.contracts.token);
  console.log("  Evaluator:", dep.contracts.evaluator);
  console.log("  部署者 :", deployer.address);

  const allOk = checks.every(([, ok]) => ok);
  console.log("\n" + (allOk ? "  ✓ 全部校验通过" : "  ✗ 存在校验失败"));

  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n✗ 执行失败:", e.message);
  if (e.receipt) console.error("  交易哈希:", e.receipt.hash);
  process.exitCode = 1;
});
