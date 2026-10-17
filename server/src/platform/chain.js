/**
 * 链上客户端 —— 与 Monad 测试网上的合约交互
 *
 * 负责：
 *   - 创建项目（含里程碑金额）
 *   - 甲乙双签规则
 *   - 注资
 *   - 提交交付哈希
 *   - 提交验收事实（触发链上判定）
 *   - 挑战 / 仲裁 / 放款 / 退款
 *
 * 设计要点：所有判定逻辑都在链上，本模块只负责发交易和读状态。
 * 若未配置私钥或 RPC，自动降级为「模拟模式」——本地开发无需链。
 */

const fs = require('fs');
const path = require('path');

const ESCROW_ABI = [
  'function createProject(address provider,address arbitrator,address evaluator,address token,uint256 totalAmount,bytes32 ruleSetId,uint256[] amounts) returns (uint256)',
  'function fundProject(uint256 projectId)',
  'function signRule(uint256 projectId)',
  'function submitMilestone(uint256 projectId,uint256 milestoneIndex,bytes32 deliverableHash,string deliverableURI)',
  'function reportEvaluation(uint256 projectId,uint256 milestoneIndex,uint8 score,bool passed,bytes32 resultHash)',
  'function challengeMilestone(uint256 projectId,uint256 milestoneIndex,uint8 reason,string note)',
  'function resolveDispute(uint256 projectId,uint256 milestoneIndex,uint16 providerBps)',
  'function releaseMilestone(uint256 projectId,uint256 milestoneIndex)',
  'function refundMilestone(uint256 projectId,uint256 milestoneIndex)',
  'function cancelProject(uint256 projectId)',
  'function getProject(uint256) view returns (tuple(address client,address provider,address arbitrator,address evaluator,address token,uint256 totalAmount,uint256 fundedAmount,bytes32 ruleSetId,uint8 status,uint64 createdAt,uint64 fundedAt,uint64 completedAt,uint256 milestoneCount,uint256 releasedAmount,uint256 refundedAmount))',
  'function getMilestone(uint256,uint256) view returns (tuple(uint256 amount,uint8 status,bytes32 deliverableHash,string deliverableURI,uint64 submittedAt,uint64 evaluatedAt,uint8 lastScore,bytes32 resultHash,uint64 passedAt,bool challenged,uint8 challengeReason,address challenger,string challengeNote,uint16 splitRatio,bool settled))',
  'function getPayoutSummary(uint256) view returns (uint256,uint256,uint256)',
  'function challengeWindowRemaining(uint256,uint256) view returns (uint256)',
  'function projectCount() view returns (uint256)',
  'function projectRuleHash(uint256) view returns (bytes32)',
];

const EVALUATOR_ABI = [
  'function evaluate(uint256,uint256,bytes32,uint16,uint16,uint16,bytes32) returns (bool,uint16)',
  'function preview(bytes32,uint16,uint16,uint16) view returns (bool,uint16)',
  'function setCollector(address,bool)',
];

const TOKEN_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function decimals() view returns (uint8)',
];

/** 里程碑状态码 → 中文 */
const MS_STATUS = {
  0: '待注资', 1: '待提交', 2: '待验收', 3: '争议中',
  4: '验收通过', 5: '验收不通过', 6: '已放款', 7: '已退款',
  8: '已终结(通过)', 9: '已终结(不通过)',
};

const PROJECT_STATUS = {
  0: '不存在', 1: '待注资', 2: '注资中', 3: '进行中', 4: '已完成', 5: '已取消',
};

class ChainClient {
  constructor(options = {}) {
    this.mockMode = true;
    this.mockState = new Map();
    this.mockProjectSeq = 0;

    const deploymentsFile = options.deploymentsFile
      || path.join(__dirname, '..', '..', '..', 'contracts', 'deployments-monad.json');

    if (fs.existsSync(deploymentsFile)) {
      this.deployments = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'));
    }

    // 未提供私钥时走模拟模式：本地开发不需要链也能跑完整闭环
    if (options.rpcUrl && options.privateKey) {
      try {
        const { JsonRpcProvider, Wallet, Contract } = require('ethers');
        this.provider = new JsonRpcProvider(options.rpcUrl);
        this.signer = new Wallet(options.privateKey, this.provider);
        this.mockMode = false;

        /**
         * 角色 signer 池 —— 真链模式下必需。
         *
         * 合约里 `require(msg.sender == p.provider)` 意味着
         * 乙方动作必须用乙方的私钥签名。单个 signer 做不到：
         * 用甲方私钥调 submitMilestone 会被合约直接拒绝。
         *
         * 所以按地址缓存各自的 Wallet，谁发交易就用谁的私钥。
         */
        this.wallets = new Map();
        if (options.privateKey2) {
          const w2 = new Wallet(options.privateKey2, this.provider);
          this.wallets.set(w2.address.toLowerCase(), w2);
        }
        this.wallets.set(this.signer.address.toLowerCase(), this.signer);

        if (this.deployments) {
          this.escrow = new Contract(this.deployments.contracts.escrow, ESCROW_ABI, this.signer);
          this.evaluator = new Contract(this.deployments.contracts.evaluator, EVALUATOR_ABI, this.signer);
          this.token = new Contract(this.deployments.contracts.token, TOKEN_ABI, this.signer);
        }
      } catch (e) {
        console.warn('[chain] 初始化失败，降级为模拟模式:', e.message);
        this.mockMode = true;
      }
    }
  }

  static fromEnv() {
    const deploymentsFile = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments-monad.json');
    return new ChainClient({
      rpcUrl: process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz',
      privateKey: process.env.PRIVATE_KEY,
      privateKey2: process.env.PRIVATE_KEY_2,
      deploymentsFile,
    });
  }

  get mode() {
    return this.mockMode ? 'mock' : 'chain';
  }

  /**
   * 取出某个地址对应的 signer。
   *
   * 合约按 msg.sender 校验身份，所以「谁操作就用谁的私钥」是硬要求。
   * 找不到对应私钥时明确抛错，而不是悄悄用默认 signer ——
   * 后者会在链上被拒并浪费 gas。
   */
  signerFor(address) {
    if (!address) return this.signer;
    const w = this.wallets?.get(String(address).toLowerCase());
    if (!w) {
      throw new Error(
        `缺少 ${address} 对应的私钥，无法以该身份签名。` +
        '请检查 PRIVATE_KEY / PRIVATE_KEY_2 是否配置且与项目参与方地址匹配。'
      );
    }
    return w;
  }

  /** 已加载私钥的地址列表（启动日志用） */
  get signerAddresses() {
    return [...(this.wallets?.keys() || [])];
  }

  /** 授权本地测试账户为采集者 */
  async ensureCollector(addr) {
    if (this.mockMode) return true;
    try {
      const tx = await this.evaluator.setCollector(addr, true);
      await tx.wait();
      return true;
    } catch {
      return false;
    }
  }

  async createProject({ provider, arbitrator, ruleSetId, milestones }) {
    const amounts = milestones.map((m) => ethersBigInt(m.amount));
    const total = amounts.reduce((a, b) => a + b, 0n);

    if (this.mockMode) {
      const id = this.mockProjectSeq++;
      this.mockState.set(id, {
        client: 'client',
        provider,
        arbitrator,
        ruleSetId,
        totalAmount: total,
        fundedAmount: 0n,
        status: 1,
        milestones: milestones.map((m, i) => ({
          amount: amounts[i], title: m.title, status: 0, score: 0, settled: false,
        })),
        signed: new Set(),
      });
      return { projectId: id, txHash: 'mock-' + id };
    }

    const tx = await this.escrow.createProject(
      provider, arbitrator,
      this.deployments.contracts.evaluator,
      this.deployments.contracts.token,
      total, ruleSetId, amounts
    );
    const rc = await tx.wait();
    const count = await this.escrow.projectCount();
    return { projectId: count - 1n, txHash: rc.hash };
  }

  async fundProject(projectId, clientSigner) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      if (!p) throw new Error('项目不存在');
      p.fundedAmount = p.totalAmount;
      p.milestones.forEach((m) => (m.status = 1));
      return { txHash: 'mock-fund-' + projectId };
    }
    // 注资由甲方发起：用甲方的私钥 approve + fundProject
    const p = await this.getProject(projectId);
    const w = clientSigner || this.signerFor(p.client);
    const approveTx = await this.token.connect(w).approve(await this.escrow.getAddress(), p.totalAmount);
    await approveTx.wait();
    const rc = await (await this.escrow.connect(w).fundProject(projectId)).wait();
    return { txHash: rc.hash, approveTx: approveTx.hash, signer: w.address };
  }

  async signRule(projectId, role) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      p.signed.add(role);
      if (p.signed.size >= 2) {
        p.status = 3;
        p.milestones.forEach((m) => { if (m.status === 0) m.status = 1; });
      }
      return { txHash: 'mock-sign-' + role };
    }
    // 谁签署就用谁的私钥：合约校验 msg.sender == client || provider
    const p = await this.getProject(projectId);
    const w = this.signerFor(role === 'client' ? p.client : p.provider);
    const rc = await (await this.escrow.connect(w).signRule(projectId)).wait();
    return { txHash: rc.hash, signer: w.address };
  }

  async submitDeliverable(projectId, milestoneIndex, hash, uri) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const m = p.milestones[milestoneIndex];
      if (m.status !== 1) throw new Error('里程碑状态不允许提交');
      m.status = 2;
      m.deliverableHash = hash;
      return { txHash: 'mock-submit' };
    }
    // 合约要求 msg.sender == provider，必须用乙方私钥
    const p = await this.getProject(projectId);
    const w = this.signerFor(p.provider);
    const rc = await (
      await this.escrow.connect(w).submitMilestone(projectId, milestoneIndex, hash, uri)
    ).wait();
    return { txHash: rc.hash, signer: w.address };
  }

  /**
   * 提交验收结论。
   * @param result 本地判定结果 {passed, score, gates}。
   *   注意：**判定本身以链上为准**，这里只用于 mock 模式的状态推进，
   *   以及把结果回传给调用方展示。链上模式不依赖它。
   */
  async submitEvaluation(projectId, milestoneIndex, facts, resultHash, result = {}, collectorSigner) {
    const [t, a, f] = [facts.testPassRate, facts.apiAvailability, facts.fieldCoverage];
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const m = p.milestones[milestoneIndex];
      const passed = !!result.passed;
      m.status = passed ? 4 : 5;
      m.score = result.score ?? 0;
      m.settled = false;
      m.challenged = false;
      return { txHash: 'mock-eval', passed, score: m.score };
    }
    const signer = collectorSigner || this.signer;
    const rc = await (
      await this.evaluator.connect(signer).evaluate(projectId, milestoneIndex, facts.ruleSetId, t, a, f, resultHash)
    ).wait();
    return { txHash: rc.hash, passed: result.passed, score: result.score };
  }

  async challenge(projectId, milestoneIndex, reason, note) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      p.milestones[milestoneIndex].status = 3;
      p.milestones[milestoneIndex].challenged = true;
      return { txHash: 'mock-challenge' };
    }
    const rc = await (await this.escrow.challengeMilestone(projectId, milestoneIndex, reason, note)).wait();
    return { txHash: rc.hash };
  }

  async resolveDispute(projectId, milestoneIndex, providerBps, arbitratorSigner) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const m = p.milestones[milestoneIndex];
      m.settled = true;
      m.status = 6;
      m.payoutRatio = providerBps;
      return { txHash: 'mock-arbitrate', providerBps };
    }
    const signer = arbitratorSigner || this.signer;
    const rc = await (await this.escrow.connect(signer).resolveDispute(projectId, milestoneIndex, providerBps)).wait();
    return { txHash: rc.hash };
  }

  async release(projectId, milestoneIndex) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const m = p.milestones[milestoneIndex];
      if (m.status !== 4) throw new Error('当前状态不可放款');
      m.status = 6;
      m.settled = true;
      p.releasedAmount = (p.releasedAmount || 0n) + m.amount;
      const all = p.milestones.every((x) => x.settled);
      if (all) p.status = 4;
      return { txHash: 'mock-release', amount: m.amount };
    }
    const p = await this.getProject(projectId);
    const w = this.signerFor(p.client);
    const rc = await (await this.escrow.connect(w).releaseMilestone(projectId, milestoneIndex)).wait();
    return { txHash: rc.hash, signer: w.address };
  }

  async refund(projectId, milestoneIndex) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const m = p.milestones[milestoneIndex];
      if (m.status !== 5) throw new Error('当前状态不可退款');
      m.status = 7;
      m.settled = true;
      p.refundedAmount = (p.refundedAmount || 0n) + m.amount;
      const all = p.milestones.every((x) => x.settled);
      if (all) p.status = 4;
      return { txHash: 'mock-refund', amount: m.amount };
    }
    const p = await this.getProject(projectId);
    const w = this.signerFor(p.client);
    const rc = await (await this.escrow.connect(w).refundMilestone(projectId, milestoneIndex)).wait();
    return { txHash: rc.hash, signer: w.address };
  }

  async getProject(projectId) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      if (!p) throw new Error('项目不存在');
      return {
        client: p.client, provider: p.provider, arbitrator: p.arbitrator,
        totalAmount: p.totalAmount, fundedAmount: p.fundedAmount,
        status: p.status, milestoneCount: p.milestones.length,
        releasedAmount: p.releasedAmount || 0n,
        refundedAmount: p.refundedAmount || 0n,
        milestones: p.milestones,
      };
    }
    return await this.escrow.getProject(projectId);
  }

  async getMilestone(projectId, index) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      if (!p) throw new Error('项目不存在');
      return p.milestones[index];
    }
    return await this.escrow.getMilestone(projectId, index);
  }

  async getPayoutSummary(projectId) {
    if (this.mockMode) {
      const p = this.mockState.get(Number(projectId));
      const released = p.releasedAmount || 0n;
      const refunded = p.refundedAmount || 0n;
      const settled = released + refunded;
      return {
        released, refunded,
        remaining: settled >= p.totalAmount ? 0n : p.totalAmount - settled,
      };
    }
    const [released, refunded, remaining] = await this.escrow.getPayoutSummary(projectId);
    return { released, refunded, remaining };
  }
}

// ethers 在 mock 模式也可能没装，这里做安全包装
function ethersBigInt(v) {
  try {
    const { ethers } = require('ethers');
    return ethers.parseUnits(String(v), 18);
  } catch {
    return BigInt(Math.round(Number(v) * 1e18));
  }
}

module.exports = { ChainClient, MS_STATUS, PROJECT_STATUS, ESCROW_ABI, EVALUATOR_ABI, TOKEN_ABI };
