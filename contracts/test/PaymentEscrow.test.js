const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 里程碑资金托管测试
 *
 * 重点：资金安全不变量。
 * 这是本合约最需要保证的性质 —— 一旦钱能被挪走或凭空消失，
 * 整个方案就失去意义（比验收是否客观更严重）。
 */
describe("MilestonePaymentEscrow", function () {
  const RULE_ID = ethers.zeroPadValue(ethers.toUtf8Bytes("standard-interface-v1"), 32);
  const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;
  const ONE = ethers.parseEther("1");

  let token, escrow, evaluator;
  let client, provider, arbitrator, collector, outsider;

  // 项目金额：3 个里程碑，各 100
  const amounts = [ONE * 100n, ONE * 100n, ONE * 100n];
  const total = ONE * 300n;

  async function setup() {
    const signers = await ethers.getSigners();
    client = signers[0];
    provider = signers[1];
    arbitrator = signers[2];
    collector = signers[3];
    outsider = signers[4];

    token = await (await ethers.getContractFactory("MockToken")).deploy("USD", "USD", ONE * 100000n);
    await token.waitForDeployment();

    escrow = await (await ethers.getContractFactory("MilestonePaymentEscrow")).deploy();
    await escrow.waitForDeployment();

    // 支付版托管合约与评估器通过 address 关联；
    // 测试中把评估器指向支付合约，以便 reportEvaluation 通过鉴权。
    evaluator = await (await ethers.getContractFactory("DeterministicEvaluator")).deploy(
      await escrow.getAddress()
    );
    await evaluator.waitForDeployment();

    await (await evaluator.registerRuleSet(RULE_ID, 80, 9000, 9500, 9000, 5000, 3000, 2000)).wait();
    await (await evaluator.setCollector(collector.address, true)).wait();
  }

  /** 注资前的余额快照，用于验证资金守恒 */
  let balancesBeforeFunding;

  async function createFunded(amt) {
    balancesBeforeFunding = {
      client: await token.balanceOf(client.address),
      provider: await token.balanceOf(provider.address),
    };
    await (
      await escrow.createProject(
        provider.address,
        arbitrator.address,
        await evaluator.getAddress(),
        await token.getAddress(),
        amt ? amt.reduce((a, b) => a + b, 0n) : total,
        RULE_ID,
        amt || amounts
      )
    ).wait();
    const pid = (await escrow.projectCount()) - 1n;

    // 甲方授权 + 注资
    await (await token.connect(client).approve(await escrow.getAddress(), total)).wait();
    await (await escrow.connect(client).fundProject(pid)).wait();

    // 双签规则
    await (await escrow.connect(client).signRule(pid)).wait();
    await (await escrow.connect(provider).signRule(pid)).wait();
    return pid;
  }

  async function submit(pid, i) {
    await (
      await escrow.connect(provider).submitMilestone(pid, i, ethers.id(`d${i}`), `ipfs://d${i}`)
    ).wait();
  }

  async function evaluate(pid, i, test, api, field) {
    await (await evaluator.connect(collector).evaluate(pid, i, RULE_ID, test, api, field, ethers.id("r"))).wait();
  }

  beforeEach(setup);

  // ─────────────── 创建与注资 ───────────────

  describe("创建与注资", function () {
    it("创建后未注资，里程碑为 Unfunded", async function () {
      await (
        await escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, amounts
        )
      ).wait();
      const p = await escrow.getProject(0n);
      expect(p.status).to.equal(1n); // AwaitingFunding
      expect((await escrow.getMilestone(0n, 0)).status).to.equal(0n); // Unfunded
    });

    it("注资后资金进入合约，里程碑变为 Pending", async function () {
      const pid = await createFunded();
      expect(await escrow.escrowBalance(pid)).to.equal(total);
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(1n); // Pending
      // 甲方余额减少
      expect(await token.balanceOf(client.address)).to.equal((ONE * 100000n) - total);
    });

    it("金额总和必须等于总额", async function () {
      await expect(
        escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, [ONE, ONE]
        )
      ).to.be.revertedWith("amounts != total");
    });

    it("不接受零金额里程碑", async function () {
      await expect(
        escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), ONE * 3n, RULE_ID, [ONE, 0, ONE]
        )
      ).to.be.revertedWith("zero amount milestone");
    });

    it("仲裁者必须独立于甲乙双方", async function () {
      await expect(
        escrow.createProject(
          provider.address, provider.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, amounts
        )
      ).to.be.revertedWith("arbitrator not independent");
    });

    it("非甲方不能注资", async function () {
      await (
        await escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, amounts
        )
      ).wait();
      await expect(escrow.connect(provider).fundProject(0n)).to.be.revertedWith("not client");
    });

    it("未授权额度时注资失败（SafeERC20 生效）", async function () {
      await (
        await escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, amounts
        )
      ).wait();
      await expect(escrow.connect(client).fundProject(0n)).to.be.revertedWith(
        "SafeERC20: transferFrom failed"
      );
    });
  });

  // ─────────────── 正常放款 ───────────────

  describe("验收通过放款", function () {
    it("过挑战期后放款，钱到乙方", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);

      const before = await token.balanceOf(provider.address);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait();

      const after = await token.balanceOf(provider.address);
      expect(after - before).to.equal(amounts[0]);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(total - amounts[0]);
    });

    it("挑战期内不能放款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("challenge window open");
    });

    it("放款后里程碑标记 Released", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait();
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(6n); // Released
    });

    it("放款后不能重复放款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait();
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("not passed");
    });

    it("全部放款后项目完成，合约余额归零", async function () {
      const pid = await createFunded();
      for (let i = 0; i < 3; i++) {
        await submit(pid, i);
        await evaluate(pid, i, 9600, 9900, 9500);
      }
      await time.increase(CHALLENGE_WINDOW + 100);
      for (let i = 0; i < 3; i++) {
        await (await escrow.releaseMilestone(pid, i)).wait();
      }
      expect((await escrow.getProject(pid)).status).to.equal(4n); // Completed
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
      // 乙方共收到 300
      expect(await token.balanceOf(provider.address)).to.equal(total);
    });
  });

  // ─────────────── 验收不通过退款 ───────────────

  describe("验收不通过退款", function () {
    it("不通过时退款给甲方（不需等挑战期）", async function () {
      const pid = await createFunded();
      const before = await token.balanceOf(client.address);
      await submit(pid, 0);
      await evaluate(pid, 0, 7000, 7000, 7000);

      await (await escrow.connect(client).refundMilestone(pid, 0)).wait();
      expect((await token.balanceOf(client.address)) - before).to.equal(amounts[0]);
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(7n); // Refunded
    });

    it("乙方一分钱拿不到", async function () {
      const pid = await createFunded();
      const before = await token.balanceOf(provider.address);
      await submit(pid, 0);
      await evaluate(pid, 0, 7000, 7000, 7000);
      await (await escrow.connect(client).refundMilestone(pid, 0)).wait();
      expect(await token.balanceOf(provider.address)).to.equal(before);
    });

    it("非甲方不能退款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 7000, 7000, 7000);
      await expect(escrow.connect(provider).refundMilestone(pid, 0)).to.be.revertedWith("not client");
    });

    it("通过的里程碑不能走退款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await expect(escrow.connect(client).refundMilestone(pid, 0)).to.be.revertedWith("not failed");
    });
  });

  // ─────────────── 争议与部分分配 ───────────────

  describe("争议裁定与部分分配", function () {
    it("挑战后仲裁者可按比例分配（30% 给乙方）", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "评分偏低")).wait();

      const pBefore = await token.balanceOf(provider.address);
      const cBefore = await token.balanceOf(client.address);

      await (await escrow.connect(arbitrator).resolveDispute(pid, 0, 3000)).wait(); // 30%

      const pGot = (await token.balanceOf(provider.address)) - pBefore;
      const cGot = (await token.balanceOf(client.address)) - cBefore;

      expect(pGot).to.equal((amounts[0] * 3000n) / 10000n);
      expect(cGot).to.equal((amounts[0] * 7000n) / 10000n);
      // 两者之和恰好等于该里程碑金额（无泄漏）
      expect(pGot + cGot).to.equal(amounts[0]);
    });

    it("挑战后仲裁者全退甲方", async function () {
      const pid = await createFunded();
      const before = await token.balanceOf(client.address);
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 0, "环境可疑")).wait();
      await (await escrow.connect(arbitrator).resolveDispute(pid, 0, 0)).wait();
      expect((await token.balanceOf(client.address)) - before).to.equal(amounts[0]);
    });

    it("挑战后仲裁者全给乙方", async function () {
      const pid = await createFunded();
      const before = await token.balanceOf(provider.address);
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "我有信心")).wait();
      await (await escrow.connect(arbitrator).resolveDispute(pid, 0, 10000)).wait();
      expect((await token.balanceOf(provider.address)) - before).to.equal(amounts[0]);
    });

    it("比例超过 100% 被拒绝", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "x")).wait();
      await expect(escrow.connect(arbitrator).resolveDispute(pid, 0, 10001)).to.be.revertedWith(
        "ratio > 100%"
      );
    });

    it("非仲裁者不能裁定", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "x")).wait();
      await expect(escrow.connect(outsider).resolveDispute(pid, 0, 5000)).to.be.revertedWith(
        "not arbitrator"
      );
    });

    it("争议未解决时不能放款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "x")).wait();
      await time.increase(CHALLENGE_WINDOW + 100);
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("not passed");
    });

    it("挑战期过后不能再挑战", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await expect(
        escrow.connect(provider).challengeMilestone(pid, 0, 3, "late")
      ).to.be.revertedWith("window closed");
    });
  });

  // ─────────────── 资金安全不变量 ───────────────

  describe("资金安全不变量", function () {
    it("合约余额始终等于未结算金额（回归测试）", async function () {
      const pid = await createFunded();

      // 混合场景：0 通过、1 部分分配、2 退款
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await (await escrow.connect(provider).challengeMilestone(pid, 0, 3, "争议")).wait();
      await (await escrow.connect(arbitrator).resolveDispute(pid, 0, 5000)).wait();

      await submit(pid, 1);
      await evaluate(pid, 1, 7000, 7000, 7000);
      await (await escrow.connect(client).refundMilestone(pid, 1)).wait();

      await submit(pid, 2);
      await evaluate(pid, 2, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 2)).wait();

      // 校验：已放 150 + 50 = 200，已退 50 + 100 = 150，合约剩 100 ✓
      const [released, refunded, remaining] = await escrow.getPayoutSummary(pid);
      expect(released).to.equal((amounts[0] * 5000n) / 10000n + amounts[2]);
      expect(refunded).to.equal((amounts[0] * 5000n) / 10000n + amounts[1]);
      expect(remaining).to.equal(0);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
    });

    it("任何路径下合约余额都不为负、总量守恒", async function () {
      const pid = await createFunded();
      // 起点必须是「注资前」，才能验证全程资金守恒
      const clientStart = balancesBeforeFunding.client;
      const providerStart = balancesBeforeFunding.provider;

      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait();

      await submit(pid, 1);
      await evaluate(pid, 1, 5000, 5000, 5000);
      await (await escrow.connect(client).refundMilestone(pid, 1)).wait();

      // 甲方：净支出 300 - 退回 100 = 200；乙方：+100；合约：0。总量守恒
      const clientDelta = clientStart - (await token.balanceOf(client.address));
      const providerDelta = (await token.balanceOf(provider.address)) - providerStart;
      expect(clientDelta).to.equal(amounts[1] + amounts[0]); // 净支出 200
      expect(providerDelta).to.equal(amounts[0]); // 收到 100
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(amounts[2]); // 合约留 100
      expect(clientDelta).to.equal(providerDelta + amounts[2]); // 守恒
    });

    it("未注资不能提交交付", async function () {
      await (
        await escrow.createProject(
          provider.address, arbitrator.address, await evaluator.getAddress(),
          await token.getAddress(), total, RULE_ID, amounts
        )
      ).wait();
      await expect(
        escrow.connect(provider).submitMilestone(0n, 0, ethers.id("x"), "u")
      ).to.be.revertedWith("project not active");
    });

    it("重复提交被拒绝", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await expect(
        escrow.connect(provider).submitMilestone(pid, 0, ethers.id("y"), "u")
      ).to.be.revertedWith("not pending");
    });

    it("规则哈希创建后不可变（合约无修改入口）", async function () {
      const pid = await createFunded();
      const h = await escrow.projectRuleHash(pid);
      expect(h).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [RULE_ID])));
      const abi = escrow.interface.fragments.map((f) => f.name);
      expect(abi.filter((n) => /updateRule|setRule|changeRule|setRuleSet/i.test(n))).to.have.length(0);
    });
  });

  // ─────────────── 取消项目 ───────────────

  describe("取消项目", function () {
    it("甲方取消后剩余资金全退", async function () {
      const pid = await createFunded();
      const before = await token.balanceOf(client.address);

      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait(); // 已放 100

      await (await escrow.connect(client).cancelProject(pid)).wait();

      // 甲方拿回剩余 200
      const got = (await token.balanceOf(client.address)) - before;
      expect(got).to.equal(amounts[1] + amounts[2]);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
    });

    it("【资金归属】取消项目不会带走其他项目的资金（回归测试）", async function () {
      // 两个项目，甲乙各有独立资金
      const pidA = await createFunded(); // 3 x 100 = 300
      const pidB = await createFunded(); // 3 x 100 = 300
      const escrowAddr = await escrow.getAddress();

      const totalIn = await token.balanceOf(escrowAddr);
      expect(totalIn).to.equal(total * 2n); // 600 全部在托管中

      // 甲方取消项目 A
      const clientBefore = await token.balanceOf(client.address);
      await (await escrow.connect(client).cancelProject(pidA)).wait();
      const clientGot = (await token.balanceOf(client.address)) - clientBefore;

      // 甲方只能拿回自己项目的 300，不能多拿一分子
      expect(clientGot).to.equal(total, "甲方应恰好拿回项目 A 的 300");

      // 项目 B 的资金必须原封不动留在合约
      const projB = await escrow.getProject(pidB);
      expect(projB.fundedAmount).to.equal(total);
      const bSettled = [];
      for (let i = 0; i < 3; i++) {
        bSettled.push((await escrow.getMilestone(pidB, i)).settled);
      }
      expect(bSettled.some(Boolean)).to.equal(false, "项目 B 的里程碑不应被结算");

      // 合约剩余应正好等于项目 B 的托管额
      expect(await token.balanceOf(escrowAddr)).to.equal(total);

      // 对账不应触发算术下溢
      const [, , remainingA] = await escrow.getPayoutSummary(pidA);
      const [, , remainingB] = await escrow.getPayoutSummary(pidB);
      expect(remainingA).to.equal(0n, "项目 A 应已结清");
      expect(remainingB).to.equal(total, "项目 B 应仍全额未结算");
    });

    it("取消后不能再放款", async function () {
      const pid = await createFunded();
      await (await escrow.connect(client).cancelProject(pid)).wait();
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("project not active");
    });

    it("只有甲方能取消", async function () {
      const pid = await createFunded();
      await expect(escrow.connect(provider).cancelProject(pid)).to.be.revertedWith("not client");
    });
  });

  // ─────────────── 权限与暂停 ───────────────

  describe("权限与紧急暂停", function () {
    it("非评估器不能写入结论", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await expect(
        escrow.connect(outsider).reportEvaluation(pid, 0, 100, true, ethers.id("f"))
      ).to.be.revertedWith("not evaluator");
    });

    it("只有 owner 能暂停", async function () {
      await expect(escrow.connect(outsider).pause()).to.be.revertedWith("not owner");
    });

    it("暂停后不能提交/放款，但 owner 不能动钱", async function () {
      const pid = await createFunded();
      await (await escrow.pause()).wait();

      // 暂停期间：提交被拒绝
      await expect(escrow.connect(provider).submitMilestone(pid, 0, ethers.id("x"), "u")).to.be.revertedWith(
        "paused"
      );

      // 恢复后再提交、评估，然后重新暂停测放款被拒
      await (await escrow.unpause()).wait();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);

      await (await escrow.pause()).wait();
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("paused");
      // 暂停期间甲方也无法发起退款 / 挑战等资金操作
      await expect(escrow.connect(client).refundMilestone(pid, 0)).to.be.revertedWith("paused");
      await expect(escrow.connect(client).cancelProject(pid)).to.be.revertedWith("paused");

      // owner 无法提取资金（合约无任何此类函数）
      const abi = escrow.interface.fragments.map((f) => f.name);
      expect(abi.filter((n) => /withdraw|sweep|steal|rescue/i.test(n))).to.have.length(0);
    });

    it("重复结算被重入锁拦截", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.releaseMilestone(pid, 0)).wait();
      const bal = await token.balanceOf(provider.address);
      // 同一里程碑无法二次结算（无论走放款还是退款路径）
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("not passed");
      await expect(escrow.connect(client).refundMilestone(pid, 0)).to.be.revertedWith("not failed");
      expect(await token.balanceOf(provider.address)).to.equal(bal);
    });

    it("合约型仲裁者可裁定争议（ArbitratorBot）", async function () {
      const bot = await (
        await ethers.getContractFactory("ArbitratorBot")
      ).deploy(await escrow.getAddress(), 4000);
      await bot.waitForDeployment();

      const pid2 = await (await escrow.projectCount());
      // 用 bot 作为仲裁者建新项目
      await (
        await escrow.createProject(
          provider.address,
          await bot.getAddress(),
          await evaluator.getAddress(),
          await token.getAddress(),
          total,
          RULE_ID,
          amounts
        )
      ).wait();
      await (await token.connect(client).approve(await escrow.getAddress(), total)).wait();
      await (await escrow.connect(client).fundProject(pid2)).wait();
      await (await escrow.connect(client).signRule(pid2)).wait();
      await (await escrow.connect(provider).signRule(pid2)).wait();

      await (
        await escrow.connect(provider).submitMilestone(pid2, 0, ethers.id("d"), "ipfs://d")
      ).wait();
      await (await evaluator.connect(collector).evaluate(pid2, 0, RULE_ID, 9600, 9900, 9500, ethers.id("r"))).wait();
      await (await escrow.connect(provider).challengeMilestone(pid2, 0, 3, "争议")).wait();

      const before = await token.balanceOf(provider.address);
      // bot.arbitrate 内部回调 escrow.resolveDispute
      await (await bot.arbitrate(pid2, 0)).wait();
      const got = (await token.balanceOf(provider.address)) - before;

      // 默认比例 4000 → 40% 给乙方
      expect(got).to.equal((amounts[0] * 4000n) / 10000n);
      expect((await escrow.getMilestone(pid2, 0)).status).to.equal(6n); // Released
    });

    it("恢复后可正常放款", async function () {
      const pid = await createFunded();
      await submit(pid, 0);
      await evaluate(pid, 0, 9600, 9900, 9500);
      await time.increase(CHALLENGE_WINDOW + 100);
      await (await escrow.pause()).wait();
      await expect(escrow.releaseMilestone(pid, 0)).to.be.revertedWith("paused");
      await (await escrow.unpause()).wait();
      await (await escrow.releaseMilestone(pid, 0)).wait();
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(6n);
    });
  });
});
