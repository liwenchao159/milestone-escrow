const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 测试重点：验证方案对三个信任漏洞的实际防护效果，
 * 而非只测 happy path。
 */
describe("MilestoneEscrow + DeterministicEvaluator", function () {
  let escrow;
  let evaluator;

  const RULE_ID = ethers.id("standard-interface-v1");
  const CHALLENGE_WINDOW = 3 * 24 * 60 * 60; // 3 days

  let client, provider, arbitrator, outsider;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    client = signers[0];
    provider = signers[1];
    arbitrator = signers[2];
    outsider = signers[3];

    const Escrow = await ethers.getContractFactory("MilestoneEscrow");
    escrow = await Escrow.deploy();
    await escrow.waitForDeployment();

    const Evaluator = await ethers.getContractFactory("DeterministicEvaluator");
    evaluator = await Evaluator.deploy(await escrow.getAddress());
    await evaluator.waitForDeployment();

    // 注册标准规则集：门槛 80 分，三维度必达 9000/9500/9000
    await evaluator.registerRuleSet(
      RULE_ID,
      80, // passThreshold
      9000, // requiredTestPassRate (90%)
      9500, // requiredApiAvailability (95%)
      9000, // requiredFieldCoverage (90%)
      5000, // weightTest 50%
      3000, // weightApi 30%
      2000 // weightField 20%
    );

    // 授权事实采集者。client 兼作 demo 采集器；outsider 在负例中临时撤销。
    await evaluator.setCollector(client.address, true);
  });

  async function createActiveProject(milestoneCount = 2) {
    const tx = await escrow.createProject(
      provider.address,
      arbitrator.address,
      await evaluator.getAddress(),
      ethers.id("acceptance-rules-v1-hash"),
      milestoneCount
    );
    const rc = await tx.wait();
    const projectId = await escrow.projectCount() - 1n;

    await escrow.connect(client).signRule(projectId);
    await escrow.connect(provider).signRule(projectId);
    return projectId;
  }

  async function submit(projectId, index) {
    await escrow.connect(provider).submitMilestone(
      projectId,
      index,
      ethers.id(`deliverable-${index}`),
      `ipfs://demo-milestone-${index}`
    );
  }

  // ─────────────────── 项目与规则锁定 ───────────────────

  describe("项目创建与规则双签", function () {
    it("创建后状态为 Draft，双方签署后激活", async function () {
      const tx = await escrow.createProject(
        provider.address,
        arbitrator.address,
        await evaluator.getAddress(),
        ethers.id("rules-hash"),
        3
      );
      await tx.wait();
      const pid = 0n;

      let p = await escrow.getProject(pid);
      expect(p.status).to.equal(1n); // Draft

      await escrow.connect(client).signRule(pid);
      p = await escrow.getProject(pid);
      expect(p.status).to.equal(1n); // 仍为 Draft

      await escrow.connect(provider).signRule(pid);
      p = await escrow.getProject(pid);
      expect(p.status).to.equal(2n); // Active
    });

    it("规则哈希在创建后不可变更（防甲方中途塞入偏颇条件）", async function () {
      const pid = await createActiveProject();
      const p = await escrow.getProject(pid);
      // 合约中不存在任何修改 ruleHash 的函数入口——结构性保证
      const abi = escrow.interface.fragments.map((f) => f.name);
      expect(abi.filter((n) => /updateRule|setRule|changeRule/i.test(n))).to.have.length(0);
      expect(p.ruleHash).to.equal(ethers.id("acceptance-rules-v1-hash"));
    });

    it("非项目方不能签署规则", async function () {
      await escrow.createProject(
        provider.address,
        arbitrator.address,
        await evaluator.getAddress(),
        ethers.id("r"),
        1
      );
      await expect(escrow.connect(outsider).signRule(0n)).to.be.revertedWith("not party");
    });

    it("重复签署被拒绝", async function () {
      await escrow.createProject(
        provider.address,
        arbitrator.address,
        await evaluator.getAddress(),
        ethers.id("r"),
        1
      );
      await escrow.connect(client).signRule(0n);
      await expect(escrow.connect(client).signRule(0n)).to.be.revertedWith("already signed");
    });
  });

  // ─────────────────── 评估器：硬门槛机制 ───────────────────

  describe("确定性评估器", function () {
    it("三维度全部达标且分数过线 → 通过", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);

      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("report"));
      const m = await escrow.getMilestone(pid, 0);
      expect(m.status).to.equal(4n); // Passed
      expect(m.lastScore).to.be.gte(80);
    });

    it("测试通过率不达标 → 即使其他维度满分也直接不通过（防补齐）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);

      // 测试维度 8000 < 门槛 9000，但 api/field 满分
      await evaluator.evaluate(pid, 0, RULE_ID, 8000, 10000, 10000, ethers.id("r"));
      const m = await escrow.getMilestone(pid, 0);
      expect(m.status).to.equal(5n); // Failed —— 硬门槛生效
      expect(m.lastScore).to.be.gte(80); // 分数很高但仍不通过
    });

    it("接口可用率不达标 → 直接不通过", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 10000, 8000, 10000, ethers.id("r"));
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(5n);
    });

    it("字段覆盖率不达标 → 直接不通过", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 10000, 10000, 5000, ethers.id("r"));
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(5n);
    });

    it("门槛全过但加权分低于阈值 → 不通过", async function () {
      // 用一个宽松规则集：门槛 80，但 required 都压到 5000
      const loose = ethers.id("loose-v1");
      await evaluator.registerRuleSet(loose, 80, 5000, 5000, 5000, 5000, 3000, 2000);

      const pid = await createActiveProject();
      await submit(pid, 0);
      // 各项都刚过门槛(5000)，加权分 = 50 分 < 80
      await evaluator.evaluate(pid, 0, loose, 5000, 5000, 5000, ethers.id("r"));
      const m = await escrow.getMilestone(pid, 0);
      expect(m.status).to.equal(5n); // Failed
      expect(m.lastScore).to.equal(50);
    });

    it("评估结果可被任何人复算（preview 与 evaluate 结论一致）", async function () {
      const pv = await evaluator.preview(RULE_ID, 9500, 9900, 9200);
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      const m = await escrow.getMilestone(pid, 0);
      expect(m.lastScore).to.equal(pv.score);
      expect((m.status === 4n)).to.equal(pv.passed);
    });

    it("任何人都无法绕过评估器直接写入结论", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await expect(
        escrow.connect(client).reportEvaluation(pid, 0, 100, true, ethers.id("fake"))
      ).to.be.revertedWith("not evaluator");
    });

    it("未授权采集者不能触发评估", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await expect(
        evaluator.connect(outsider).evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"))
      ).to.be.revertedWith("not collector");
    });

    it("采集者被撤销授权后无法评估（可问责）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.setCollector(client.address, false);
      await expect(
        evaluator.connect(client).evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"))
      ).to.be.revertedWith("not collector");
    });

    it("评估器判定逻辑不依赖采集者身份——恶意采集者也无法篡改阈值", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      // 即便采集者压低事实，判定仍按已注册规则集执行（低分→不通过）
      await evaluator.connect(client).evaluate(pid, 0, RULE_ID, 5000, 5000, 5000, ethers.id("r"));
      const m = await escrow.getMilestone(pid, 0);
      expect(m.status).to.equal(5n); // Failed，规则集门槛未被绕过
    });

    it("同一里程碑不可重复评估", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await expect(
        evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"))
      ).to.be.revertedWith("already evaluated");
    });

    it("事实报告哈希被记录供审计", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      const rh = ethers.id("audit-report-hash");
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, rh);
      expect(await evaluator.getFactReportHash(pid, 0)).to.equal(rh);
    });

    it("评估器不接受调用方传入的判定阈值（阈值来自注册表）", async function () {
      // evaluate 签名中没有任何 threshold 参数——结构性保证
      const frag = evaluator.interface.getFunction("evaluate");
      const inputs = frag.inputs.map((i) => i.name);
      expect(inputs.some((n) => /threshold|weight|required/i.test(n))).to.equal(false);
    });

    it("规则集权重必须和为 10000", async function () {
      await expect(
        evaluator.registerRuleSet(ethers.id("bad"), 80, 9000, 9000, 9000, 5000, 3000, 3000)
      ).to.be.revertedWith("weights must sum to 10000");
    });
  });

  // ─────────────────── 挑战期与争议 ───────────────────

  describe("挑战期机制", function () {
    it("挑战期内可挑战，超期不可挑战", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));

      let remain = await escrow.challengeWindowRemaining(pid, 0);
      expect(remain).to.be.gt(0n);

      await escrow.connect(client).challengeMilestone(pid, 0, 1, "只跑了指定的3个测试");
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(3n); // Challenged

      // 超期挑战
      const pid2 = await createActiveProject();
      await submit(pid2, 1);
      await evaluator.evaluate(pid2, 1, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);
      await expect(
        escrow.connect(client).challengeMilestone(pid2, 1, 1, "late")
      ).to.be.revertedWith("challenge window closed");
    });

    it("挑战期内不能 finalize（防快速放款）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await expect(escrow.connect(client).finalizeMilestone(pid, 0)).to.be.revertedWith(
        "challenge window open"
      );
    });

    it("仲裁者可推翻验收结论", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await escrow.connect(client).challengeMilestone(pid, 0, 0, "环境被篡改");

      await escrow.connect(arbitrator).resolveDispute(pid, 0, false);
      const m = await escrow.getMilestone(pid, 0);
      expect(m.status).to.equal(5n); // Failed
      expect(await escrow.passedCount(pid)).to.equal(0n);
    });

    it("仲裁者可维持通过结论", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await escrow.connect(provider).challengeMilestone(pid, 0, 3, "我认为达标了");
      await escrow.connect(arbitrator).resolveDispute(pid, 0, true);
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(4n);
    });

    it("非仲裁者不能裁决", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await escrow.connect(client).challengeMilestone(pid, 0, 0, "x");
      await expect(escrow.connect(outsider).resolveDispute(pid, 0, true)).to.be.revertedWith(
        "not arbitrator"
      );
    });
  });

  // ─────────────────── 凭证 ───────────────────

  describe("履历凭证", function () {
    it("通过且过挑战期后铸发凭证，绑定真实回款事件", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);

      await escrow.connect(client).finalizeMilestone(pid, 0);
      expect(await escrow.balanceOf(provider.address, pid)).to.equal(1n);
      expect(await escrow.creatorOf(pid)).to.equal(provider.address);
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(7n); // FinalizedPassed
    });

    it("验收不通过不产生凭证，但可正常终结（不达标也有闭环）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 7000, 7000, 7000, ethers.id("r"));
      await escrow.connect(client).finalizeMilestone(pid, 0);
      expect(await escrow.balanceOf(provider.address, pid)).to.equal(0n);
      expect((await escrow.getMilestone(pid, 0)).status).to.equal(8n); // FinalizedFailed
    });

    it("不达标里程碑终结后项目可完成（回归测试）", async function () {
      const pid = await createActiveProject(2);
      await submit(pid, 0);
      await submit(pid, 1);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await evaluator.evaluate(pid, 1, RULE_ID, 6000, 6000, 6000, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);

      await escrow.connect(client).finalizeMilestone(pid, 0); // passed
      await escrow.connect(client).finalizeMilestone(pid, 1); // failed
      expect((await escrow.getProject(pid)).status).to.equal(3n); // Completed
      expect(await escrow.balanceOf(provider.address, pid)).to.equal(1n);
    });

    it("finalize 顺序无关：先终结失败项也能完成（回归测试）", async function () {
      const pid = await createActiveProject(2);
      await submit(pid, 0);
      await submit(pid, 1);
      await evaluator.evaluate(pid, 0, RULE_ID, 6000, 6000, 6000, ethers.id("r"));
      await evaluator.evaluate(pid, 1, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);

      // 反序：先 finalize index 1（passed），后 finalize index 0（failed）
      await escrow.connect(client).finalizeMilestone(pid, 1);
      await escrow.connect(client).finalizeMilestone(pid, 0);
      expect((await escrow.getProject(pid)).status).to.equal(3n);
      expect(await escrow.balanceOf(provider.address, pid)).to.equal(1n);
    });

    it("Pending 状态不能直接 finalize", async function () {
      const pid = await createActiveProject();
      await expect(escrow.connect(client).finalizeMilestone(pid, 0)).to.be.revertedWith(
        "not finalized-able"
      );
    });

    it("已终结的里程碑不能重复 finalize", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);
      await escrow.connect(client).finalizeMilestone(pid, 0);
      await expect(escrow.connect(client).finalizeMilestone(pid, 0)).to.be.revertedWith(
        "not finalized-able"
      );
    });

    it("凭证为 soulbound：不可转让", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);
      await escrow.connect(client).finalizeMilestone(pid, 0);

      await expect(
        escrow.safeTransferFrom(provider.address, outsider.address, pid, 1, "0x")
      ).to.be.revertedWith("SBT: non-transferable");
      await expect(
        escrow.setApprovalForAll(outsider.address, true)
      ).to.be.revertedWith("SBT: non-transferable");
    });

    it("全部里程碑通过 → 项目完成", async function () {
      const pid = await createActiveProject(2);
      await submit(pid, 0);
      await submit(pid, 1);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await evaluator.evaluate(pid, 1, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);

      await escrow.connect(client).finalizeMilestone(pid, 0);
      await escrow.connect(client).finalizeMilestone(pid, 1);

      const p = await escrow.getProject(pid);
      expect(p.status).to.equal(3n); // Completed
      expect(await escrow.balanceOf(provider.address, pid)).to.equal(2n);
    });

    it("可查询乙方跨项目的可验证履历（不泄露交付内容）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);
      await escrow.connect(client).finalizeMilestone(pid, 0);

      const [pids, counts] = await escrow.getProviderCredentials(provider.address);
      expect(pids.length).to.equal(1);
      expect(counts[0]).to.equal(1n);
    });

    it("凭证可被撤销（burn-and-reissue 模式）", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await evaluator.evaluate(pid, 0, RULE_ID, 9500, 9900, 9200, ethers.id("r"));
      await time.increase(CHALLENGE_WINDOW + 100);
      await escrow.connect(client).finalizeMilestone(pid, 0);

      await escrow.connect(client).revokeCredential(pid, 0);
      expect(await escrow.credentialRevoked(pid, 0)).to.equal(true);
      await expect(escrow.connect(client).revokeCredential(pid, 0)).to.be.revertedWith(
        "already revoked"
      );
    });
  });

  // ─────────────────── 访问控制 ───────────────────

  describe("访问控制", function () {
    it("非乙方不能提交交付", async function () {
      const pid = await createActiveProject();
      await expect(
        escrow.connect(outsider).submitMilestone(pid, 0, ethers.id("x"), "u")
      ).to.be.revertedWith("not provider");
    });

    it("未激活项目不能提交", async function () {
      await escrow.createProject(provider.address, arbitrator.address, await evaluator.getAddress(), ethers.id("r"), 1);
      await expect(
        escrow.connect(provider).submitMilestone(0n, 0, ethers.id("x"), "u")
      ).to.be.revertedWith("project not active");
    });

    it("已提交的里程碑不能重复提交", async function () {
      const pid = await createActiveProject();
      await submit(pid, 0);
      await expect(
        escrow.connect(provider).submitMilestone(pid, 0, ethers.id("y"), "u")
      ).to.be.revertedWith("already submitted");
    });

    it("索引越界被拒绝", async function () {
      const pid = await createActiveProject(1);
      await expect(
        escrow.connect(provider).submitMilestone(pid, 5, ethers.id("x"), "u")
      ).to.be.revertedWith("index out of range");
    });

    it("里程碑数量必须在 1-100 之间", async function () {
      await expect(
        escrow.createProject(provider.address, arbitrator.address, await evaluator.getAddress(), ethers.id("r"), 0)
      ).to.be.revertedWith("milestoneCount out of range");
      await expect(
        escrow.createProject(provider.address, arbitrator.address, await evaluator.getAddress(), ethers.id("r"), 101)
      ).to.be.revertedWith("milestoneCount out of range");
    });

    it("空地址参数被拒绝", async function () {
      await expect(
        escrow.createProject(ethers.ZeroAddress, arbitrator.address, await evaluator.getAddress(), ethers.id("r"), 1)
      ).to.be.revertedWith("provider=0");
    });
  });
});
