/**
 * 部署脚本：部署合约 + 注册规则模板 + 授权采集者
 *
 * 合规说明：本项目不部署任何资金托管合约，不涉及法币或代币转移。
 * 仅部署存证与验收结论的记录层。
 */
const { ethers } = require("hardhat");

/**
 * 规则模板 —— 与 server/src/ruleTemplates.ts 保持一致
 * 部署时写入链上，注册后不可变（保证任何人都能复算同一结论）。
 * 字段单位均为「万分比」：9000 = 90%
 */
const RULE_TEMPLATES = [
  {
    id: "standard-interface-v1",
    name: "标准接口开发（推荐默认）",
    threshold: 80,
    required: { test: 9000, api: 9500, field: 9000 },
    weights: { test: 5000, api: 3000, field: 2000 },
  },
  {
    id: "data-pipeline-v1",
    name: "数据处理与管道",
    threshold: 78,
    required: { test: 9200, api: 8500, field: 9500 },
    weights: { test: 3000, api: 2500, field: 4500 },
  },
  {
    id: "strict-release-v1",
    name: "严格发布（高风险交付）",
    threshold: 92,
    required: { test: 9800, api: 9900, field: 9800 },
    weights: { test: 4500, api: 3500, field: 2000 },
  },
  {
    id: "lightweight-doc-v1",
    name: "轻量文档交付",
    threshold: 75,
    required: { test: 9000, api: 8000, field: 9000 },
    weights: { test: 2000, api: 1500, field: 6500 },
  },
  {
    id: "balanced-4d-v1",
    name: "均衡四维",
    threshold: 85,
    required: { test: 7000, api: 7000, field: 7000 },
    weights: { test: 3000, api: 3000, field: 4000 },
  },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("部署者地址:", deployer.address);

  // 1. 部署存证合约
  const Escrow = await ethers.getContractFactory("MilestoneEscrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("MilestoneEscrow      ->", escrowAddr);

  // 2. 部署确定性评估器
  const Evaluator = await ethers.getContractFactory("DeterministicEvaluator");
  const evaluator = await Evaluator.deploy(escrowAddr);
  await evaluator.waitForDeployment();
  const evaluatorAddr = await evaluator.getAddress();
  console.log("DeterministicEvaluator ->", evaluatorAddr);

  // 3. 注册规则模板（链上不可变，保证可复算）
  const toBytes32 = (v) => ethers.zeroPadValue(ethers.toUtf8Bytes(v), 32);
  for (const tpl of RULE_TEMPLATES) {
    const id = toBytes32(tpl.id);
    await (
      await evaluator.registerRuleSet(
        id,
        tpl.threshold,
        tpl.required.test,
        tpl.required.api,
        tpl.required.field,
        tpl.weights.test,
        tpl.weights.api,
        tpl.weights.field
      )
    ).wait();
    console.log(`  规则已注册: ${tpl.id} (${tpl.name}) → id=${id}`);
  }

  // 4. 授权事实采集者（demo 中为部署者；生产环境应为独立采集服务）
  await (await evaluator.setCollector(deployer.address, true)).wait();
  console.log("  采集者已授权:", deployer.address);

  // 5. 输出前端所需的地址清单
  const out = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    escrow: escrowAddr,
    evaluator: evaluatorAddr,
    collector: deployer.address,
    rules: RULE_TEMPLATES.map((t) => ({
      id: t.id,
      bytes32Id: toBytes32(t.id),
      name: t.name,
      passThreshold: t.threshold,
      required: t.required,
      weights: t.weights,
    })),
    deployedAt: new Date().toISOString(),
  };

  console.log("\n=== 部署清单 ===");
  console.log(JSON.stringify(out, null, 2));

  const fs = require("fs");
  const p = require("path");
  fs.writeFileSync(
    p.join(__dirname, "..", "deployments.json"),
    JSON.stringify(out, null, 2),
    "utf8"
  );
  console.log("\n已写入 deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
