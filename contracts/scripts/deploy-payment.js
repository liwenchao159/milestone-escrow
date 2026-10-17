/**
 * 支付版部署脚本：代币 + 资金托管 + 确定性评估器
 *
 * 用法：
 *   npx hardhat run scripts/deploy-payment.js                      # 本地链
 *   npx hardhat run scripts/deploy-payment.js --network amoy        # Polygon Amoy 测试网
 */
require("dotenv").config();
const { ethers, network } = require("hardhat");

const toBytes32 = (v) => ethers.zeroPadValue(ethers.toUtf8Bytes(v), 32);

/** 与 server/src/ruleTemplates.ts / web/assets/engine.js 保持一致 */
const RULE_TEMPLATES = [
  { id: "standard-interface-v1", name: "标准接口开发", threshold: 80, required: [9000, 9500, 9000], weights: [5000, 3000, 2000] },
  { id: "data-pipeline-v1", name: "数据处理与管道", threshold: 78, required: [9200, 8500, 9500], weights: [3000, 2500, 4500] },
  { id: "strict-release-v1", name: "严格发布", threshold: 92, required: [9800, 9900, 9800], weights: [4500, 3500, 2000] },
  { id: "lightweight-doc-v1", name: "轻量技术文档", threshold: 75, required: [9000, 8000, 9000], weights: [2000, 1500, 6500] },
  // 门槛与分数线刻意拉开，使「硬门槛全过但总分不够」成为可达状态
  { id: "balanced-4d-v1", name: "均衡四维", threshold: 85, required: [7000, 7000, 7000], weights: [3000, 3000, 4000] },
];

/**
 * 部署时使用的参与方。
 *
 * 本地链：使用 Hardhat 内置的独立账户，各自持有独立私钥，可真实签名。
 * 远端链：内置账户不存在，改用从部署者私钥确定性派生出的地址。
 *   ⚠️ 派生地址仅用于部署脚本的演示流程——它们没有独立余额，
 *      且私钥可被任何人推导出来。生产环境必须替换为真实参与方地址，
 *      由参与方自己签名。
 */
async function resolveParticipants(deployer) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const isLocal = chainId === 31337n;

  if (isLocal) {
    const [, p, a, c] = await ethers.getSigners();
    return {
      provider: p.address,
      providerSigner: p,
      arbitrator: a.address,
      arbitratorSigner: a,
      collector: c.address,
      collectorSigner: c,
      mode: "hardhat 内置账户（可签名）",
    };
  }

  // 远端链：从 .env 的 PRIVATE_KEY_2 取第二个签名身份作为乙方。
  // 乙方必须有独立私钥才能签署 signRule / submitMilestone。
  const providerKey = process.env.PRIVATE_KEY_2;
  if (!providerKey) {
    throw new Error("缺少 PRIVATE_KEY_2（乙方私钥），请在 .env 中配置");
  }
  const providerW = new ethers.Wallet(providerKey);

  return {
    provider: providerW.address,
    providerSigner: providerW,
    providerKey: providerKey,
    arbitrator: null, // 由 ArbitratorBot 地址填充
    collector: deployer.address,
    collectorSigner: deployer,
    mode: "远端链：甲方=账户一，乙方=账户二，仲裁者=ArbitratorBot 合约",
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("══════════════════════════════════════════════");
  console.log("  里程碑资金托管系统 · 部署");
  console.log("══════════════════════════════════════════════");
  console.log("网络 chainId :", chainId.toString());
  console.log("网络名称     :", network.name);
  console.log("部署者       :", deployer.address);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("部署者余额   :", ethers.formatEther(bal), chainId === 10143n ? "MON" : "POL");

  if (bal === 0n && chainId !== 31337n) {
    console.error("\n✗ 部署者余额为 0，无法支付 gas。");
    if (chainId === 10143n) {
      console.error("  Monad 测试网水龙头：");
      console.error("  curl -s -X POST https://agents.devnads.com/v1/faucet \\");
      console.error('    -H "content-type: application/json" \\');
      console.error('    -d \'{"chainId":10143,"address":"<你的地址>"}\'');
    } else {
      console.error("  Polygon Amoy 水龙头：https://faucet.polygon.technology/");
    }
    process.exitCode = 1;
    return;
  }

  const parts = await resolveParticipants(deployer);
  const { provider, collector } = parts;
  console.log("参与方模式   :", parts.mode);

  // 1. 测试代币
  console.log("\n[1/4] 部署 MockToken...");
  const Token = await ethers.getContractFactory("MockToken");
  const token = await Token.deploy("Test USD", "TUSD", ethers.parseEther("1000000"));
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("      MockToken            ", tokenAddr);

  // 2. 资金托管合约
  console.log("[2/5] 部署 MilestonePaymentEscrow...");
  const Escrow = await ethers.getContractFactory("MilestonePaymentEscrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("      MilestonePaymentEscrow", escrowAddr);

  // 3. 确定性评估器（指向托管合约）
  console.log("[3/5] 部署 DeterministicEvaluator...");
  const Evaluator = await ethers.getContractFactory("DeterministicEvaluator");
  const evaluator = await Evaluator.deploy(escrowAddr);
  await evaluator.waitForDeployment();
  const evaluatorAddr = await evaluator.getAddress();
  console.log("      DeterministicEvaluator", evaluatorAddr);

  // 4. 部署独立仲裁者合约（远端链必需；本地链也一并部署以保持一致）
  console.log("[4/5] 部署 ArbitratorBot（独立仲裁者）...");
  const Bot = await ethers.getContractFactory("ArbitratorBot");
  const bot = await Bot.deploy(escrowAddr, 3000); // 默认裁定：乙方得 30%
  await bot.waitForDeployment();
  const botAddr = await bot.getAddress();
  console.log("      ArbitratorBot        ", botAddr);
  if (!parts.arbitrator) parts.arbitrator = botAddr;

  // 5. 注册规则模板 + 授权采集者
  console.log("[5/5] 注册规则模板并授权采集者...");
  const rules = [];
  for (const t of RULE_TEMPLATES) {
    const id = toBytes32(t.id);
    await (
      await evaluator.registerRuleSet(id, t.threshold, t.required[0], t.required[1], t.required[2], t.weights[0], t.weights[1], t.weights[2])
    ).wait();
    rules.push({ id: t.id, bytes32Id: id, name: t.name, passThreshold: t.threshold, required: t.required, weights: t.weights });
    console.log(`      ✓ ${t.id}`);
  }
  await (await evaluator.setCollector(collector, true)).wait();
  console.log("      采集者已授权:", collector);

  // 演示资金：给三个参与方各铸 1000 测试币
  const demo = ethers.parseEther("1000");
  for (const addr of [provider, collector]) {
    await (await token.mint(addr, demo)).wait();
  }
  console.log("\n      已为参与方各铸造 1000 TUSD（测试币，无价值）");

  const out = {
    network: network.name,
    chainId: chainId.toString(),
    deployedAt: new Date().toISOString(),
    contracts: {
      token: tokenAddr,
      escrow: escrowAddr,
      evaluator: evaluatorAddr,
      arbitratorBot: botAddr,
    },
    participants: {
      deployer: deployer.address,
      client: deployer.address,   // 甲方 = 部署者
      provider,                    // 乙方
      arbitrator: parts.arbitrator, // ArbitratorBot 合约地址
      collector,
    },
    // 仅供本地演示脚本使用。生产环境绝不可把私钥写入文件。
    demoProviderKey: parts.providerKey || null,
    participantMode: parts.mode,
    rules,
    notice: "MockToken 为本地部署的测试代币，无任何真实价值或流通性",
  };

  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", `deployments-${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  console.log("\n══════════════════════════════════════════════");
  console.log("  部署完成");
  console.log("══════════════════════════════════════════════");
  console.log(JSON.stringify(out, null, 2));
  console.log("\n已写入", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
