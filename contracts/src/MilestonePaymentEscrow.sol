// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DeterministicEvaluator.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

/**
 * @title MilestonePaymentEscrow
 * @notice 里程碑资金托管 + 确定性自动验收 + 履历凭证
 *
 * 在存证版（MilestoneEscrow）基础上增加真实资金托管：
 *   - 甲方预先注资全部款项到合约，按里程碑权重分配
 *   - 验收通过 → 挑战期结束 → 自动放款给乙方
 *   - 验收不通过 → 该里程碑款项退回甲方
 *   - 争议 → 仲裁者可按比例裁定分配
 *
 * 资金安全设计：
 *   1. 资金按里程碑锁定，每个里程碑有独立的 amount，不允许挪用
 *   2. 放款前必须过挑战期，防止「秒级放款」导致争议无处可提
 *   3. 合约不做任何自动投资/复利，资金只做静态托管
 *   4. 紧急暂停：owner 可暂停新的放款操作（不含已放款）
 *   5. 使用 SafeERC20 兼容非标准 ERC-20（如 USDT 不返回 bool）
 *
 * 权限分离：
 *   - client     甲方：注资、可挑战
 *   - provider   乙方：接收放款
 *   - arbitrator 仲裁者：争议裁定
 *   - evaluator  评估器：写入验收结论（由 DeterministicEvaluator 承担）
 *   - owner      合约管理员：仅暂停/恢复，无资金权限
 */
contract MilestonePaymentEscrow {
    using SafeERC20 for IERC20;

    // ─────────────────────────── 常量 ───────────────────────────

    /**
     * 挑战期窗口。
     *
     * ⚠️ 当前为 5 秒，仅适用于本地/测试网演示。
     *
     * 生产环境必须调大（建议 3 天）。原因：
     *   挑战期是「验收通过后、款项放出前」的最后一道纠错机会。
     *   若窗口过短，乙方来不及发现交付物被掉包，甲方来不及发现验收有误，
     *   托管机制就退化成了「先放款后追债」，失去意义。
     */
    uint256 public constant CHALLENGE_WINDOW = 5 seconds;
    uint16 public constant BPS = 10000; // 万分比基数

    // ─────────────────────────── 枚举 ───────────────────────────

    enum ProjectStatus {
        None,
        AwaitingFunding, // 等待甲方注资
        Funding, // 注资中
        Active, // 已注资，进行中
        Completed, // 全部里程碑终结
        Cancelled // 已取消，剩余资金已退回
    }

    enum MilestoneStatus {
        Unfunded, // 未注资（项目级注资后统一变为 Pending）
        Pending, // 待提交
        Submitted, // 已提交，等待评估
        Challenged, // 被挑战，等待裁决
        Passed, // 验收通过（挑战期内）
        Failed, // 验收不通过
        Released, // 已放款给乙方
        Refunded // 已退回甲方
    }

    enum ChallengeReason {
        None,
        RuleViolation, // 违反验收规则
        EnvironmentTampering, // 评估环境被篡改
        ResultDispute // 对评估结论有异议
    }

    // ─────────────────────────── 数据结构 ───────────────────────────

    struct Milestone {
        uint256 amount; // 该里程碑金额（代币最小单位）
        uint8 status; // MilestoneStatus
        bytes32 deliverableHash;
        string deliverableURI;
        uint64 submittedAt;
        uint64 evaluatedAt;
        uint8 lastScore;
        bytes32 resultHash;
        uint64 passedAt;
        bool challenged;
        uint8 challengeReason;
        address challenger;
        string challengeNote;
        /// 争议裁定：乙方应得比例（万分比）。0 = 全退甲方，10000 = 全给乙方
        uint16 splitRatio;
        bool settled;
    }

    struct Project {
        address client;
        address provider;
        address arbitrator;
        address evaluator;
        IERC20 token; // 结算代币
        uint256 totalAmount; // 项目总额
        uint256 fundedAmount; // 已注资额
        bytes32 ruleSetId; // 链上规则集 id
        uint8 status;
        uint64 createdAt;
        uint64 fundedAt;
        uint64 completedAt;
        uint256 milestoneCount;
        uint256 releasedAmount;
        uint256 refundedAmount;
    }

    // ─────────────────────────── 存储 ───────────────────────────

    address public owner;
    bool public paused;

    /// @dev 重入锁。所有涉及资金转移的外部函数都必须带 whenNotReentrant。
    ///      即使 _settleMilestone 内部已遵循 checks-effects-interactions，
    ///      引入 ArbitratorBot 这类合约间回调后，攻击面发生变化，必须显式防护。
    uint256 private _reentrancyStatus = 1;

    mapping(uint256 => Project) public projects;
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;
    /// @notice 规则哈希 = keccak256(abi.encode(ruleSetId))，创建后不可变更
    mapping(uint256 => bytes32) public projectRuleHash;
    /// @notice projectId => 已签署方
    mapping(uint256 => mapping(address => bool)) public ruleSigned;
    mapping(uint256 => uint256) public ruleSignCount;

    uint256 public projectCount;

    // ─────────────────────────── 事件 ───────────────────────────

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed client,
        address indexed provider,
        address arbitrator,
        address evaluator,
        address token,
        uint256 totalAmount,
        bytes32 ruleSetId,
        uint256 milestoneCount
    );
    event ProjectFunded(uint256 indexed projectId, address indexed funder, uint256 amount);
    event RuleSigned(uint256 indexed projectId, address indexed signer);
    event ProjectActive(uint256 indexed projectId);
    event MilestoneSubmitted(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed provider,
        bytes32 deliverableHash,
        string deliverableURI
    );
    event MilestoneEvaluated(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        uint8 score,
        bool passed,
        bytes32 resultHash
    );
    event MilestoneChallenged(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed challenger,
        uint8 reason,
        string note
    );
    event MilestoneReleased(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed to,
        uint256 amount
    );
    event MilestoneRefunded(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed to,
        uint256 amount
    );
    event DisputeResolved(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed arbitrator,
        uint16 splitRatio
    );
    event ProjectCancelled(uint256 indexed projectId, uint256 refunded);
    /// @dev 记账异常告警：已记录金额超过名义总额，需要链下监控介入
    event EscrowAccountingAnomaly(uint256 indexed projectId, uint256 excess);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─────────────────────────── 修饰符 ───────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    /// @dev 防止重入。合约间的裁定回调（如 ArbitratorBot）会形成外部调用，
    ///      若不锁定，同一里程碑可能被重复结算。
    modifier whenNotReentrant() {
        require(_reentrancyStatus == 1, "reentrancy");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─────────────────────────── 暂停 ───────────────────────────

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─────────────────────────── 创建与注资 ───────────────────────────

    /**
     * @notice 创建项目。此时资金尚未进入合约。
     * @param amounts 每个里程碑的金额，长度须等于 milestoneCount，总和须等于 totalAmount
     */
    function createProject(
        address provider,
        address arbitrator,
        address evaluator,
        address token,
        uint256 totalAmount,
        bytes32 ruleSetId,
        uint256[] calldata amounts
    ) external returns (uint256 projectId) {
        require(provider != address(0), "provider=0");
        require(arbitrator != address(0), "arbitrator=0");
        require(evaluator != address(0), "evaluator=0");
        require(token != address(0), "token=0");
        require(totalAmount > 0, "total=0");
        require(ruleSetId != bytes32(0), "ruleSetId=0");
        require(amounts.length > 0 && amounts.length <= 100, "milestoneCount out of range");
        require(arbitrator != provider && arbitrator != msg.sender, "arbitrator not independent");

        // 金额总和校验
        uint256 sum;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "zero amount milestone");
            sum += amounts[i];
        }
        require(sum == totalAmount, "amounts != total");

        projectId = projectCount++;
        projectRuleHash[projectId] = keccak256(abi.encode(ruleSetId));

        projects[projectId] = Project({
            client: msg.sender,
            provider: provider,
            arbitrator: arbitrator,
            evaluator: evaluator,
            token: IERC20(token),
            totalAmount: totalAmount,
            fundedAmount: 0,
            ruleSetId: ruleSetId,
            status: uint8(ProjectStatus.AwaitingFunding),
            createdAt: uint64(block.timestamp),
            fundedAt: 0,
            completedAt: 0,
            milestoneCount: amounts.length,
            releasedAmount: 0,
            refundedAmount: 0
        });

        for (uint256 i = 0; i < amounts.length; i++) {
            milestones[projectId][i] = Milestone({
                amount: amounts[i],
                status: uint8(MilestoneStatus.Unfunded),
                deliverableHash: bytes32(0),
                deliverableURI: "",
                submittedAt: 0,
                evaluatedAt: 0,
                lastScore: 0,
                resultHash: bytes32(0),
                passedAt: 0,
                challenged: false,
                challengeReason: 0,
                challenger: address(0),
                challengeNote: "",
                splitRatio: 0,
                settled: false
            });
        }

        emit ProjectCreated(
            projectId, msg.sender, provider, arbitrator, evaluator, token, totalAmount, ruleSetId, amounts.length
        );
    }

    /**
     * @notice 甲方注资全部款项。注资后项目激活，所有里程碑变为 Pending。
     */
    function fundProject(uint256 projectId) external whenNotPaused {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.AwaitingFunding), "not awaiting funding");
        require(msg.sender == p.client, "not client");

        p.token.safeTransferFrom(msg.sender, address(this), p.totalAmount);

        p.fundedAmount = p.totalAmount;
        p.fundedAt = uint64(block.timestamp);

        uint256 n = p.milestoneCount;
        for (uint256 i = 0; i < n; i++) {
            milestones[projectId][i].status = uint8(MilestoneStatus.Pending);
        }

        emit ProjectFunded(projectId, msg.sender, p.totalAmount);

        _maybeActivate(projectId);
    }

    /**
     * @notice 双方签署规则哈希。签署后规则不可变更。
     */
    /**
     * @notice 双方签署规则哈希。签署后规则不可变更。
     * @dev 项目进入 Active 需同时满足两个条件：**已注资** 且 **双方已签署**。
     *      资金未到账时不允许交付，避免「先干活后付款」或「先付款后跑路」。
     */
    function signRule(uint256 projectId) external {
        Project storage p = projects[projectId];
        require(p.status != uint8(ProjectStatus.None), "project not exist");
        require(p.status != uint8(ProjectStatus.Cancelled), "project cancelled");
        require(msg.sender == p.client || msg.sender == p.provider, "not party");
        require(!ruleSigned[projectId][msg.sender], "already signed");

        ruleSigned[projectId][msg.sender] = true;
        ruleSignCount[projectId] += 1;
        emit RuleSigned(projectId, msg.sender);

        _maybeActivate(projectId);
    }

    /// @dev 注资完成且双方已签署时，项目转为 Active
    function _maybeActivate(uint256 projectId) private {
        Project storage p = projects[projectId];
        if (p.status == uint8(ProjectStatus.AwaitingFunding) || p.status == uint8(ProjectStatus.Funding)) {
            if (p.fundedAmount == p.totalAmount && ruleSignCount[projectId] == 2) {
                p.status = uint8(ProjectStatus.Active);
                emit ProjectActive(projectId);
            }
        }
    }

    // ─────────────────────────── 交付与验收 ───────────────────────────

    function submitMilestone(uint256 projectId, uint256 milestoneIndex, bytes32 deliverableHash, string calldata deliverableURI)
        external
        whenNotPaused
    {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active), "project not active");
        require(msg.sender == p.provider, "not provider");
        require(milestoneIndex < p.milestoneCount, "index out of range");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Pending), "not pending");
        require(deliverableHash != bytes32(0), "empty deliverable");

        m.status = uint8(MilestoneStatus.Submitted);
        m.deliverableHash = deliverableHash;
        m.deliverableURI = deliverableURI;
        m.submittedAt = uint64(block.timestamp);

        emit MilestoneSubmitted(projectId, milestoneIndex, msg.sender, deliverableHash, deliverableURI);
    }

    /**
     * @notice 评估器写入验收结论。仅 evaluator 可调用。
     */
    function reportEvaluation(uint256 projectId, uint256 milestoneIndex, uint8 score, bool passed, bytes32 resultHash)
        external
    {
        Project storage p = projects[projectId];
        require(msg.sender == p.evaluator, "not evaluator");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Submitted), "not submitted");

        m.status = passed ? uint8(MilestoneStatus.Passed) : uint8(MilestoneStatus.Failed);
        m.lastScore = score;
        m.resultHash = resultHash;
        m.evaluatedAt = uint64(block.timestamp);
        m.passedAt = uint64(block.timestamp);

        emit MilestoneEvaluated(projectId, milestoneIndex, score, passed, resultHash);
    }

    /**
     * @notice 发起挑战。验收通过后进入挑战期，期内任一方均可挑战。
     */
    function challengeMilestone(uint256 projectId, uint256 milestoneIndex, ChallengeReason reason, string calldata note)
        external
        whenNotPaused
    {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active), "project not active");
        require(msg.sender == p.client || msg.sender == p.provider, "not party");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Passed), "not passed");
        require(block.timestamp <= m.passedAt + CHALLENGE_WINDOW, "window closed");

        m.status = uint8(MilestoneStatus.Challenged);
        m.challenged = true;
        m.challengeReason = uint8(reason);
        m.challenger = msg.sender;
        m.challengeNote = note;

        emit MilestoneChallenged(projectId, milestoneIndex, msg.sender, uint8(reason), note);
    }

    /**
     * @notice 仲裁者裁定争议，按比例分配该里程碑款项。
     * @param providerBps 乙方应得比例（万分比）。0 = 全退甲方，10000 = 全给乙方
     */
    function resolveDispute(uint256 projectId, uint256 milestoneIndex, uint16 providerBps) external whenNotPaused whenNotReentrant {
        Project storage p = projects[projectId];
        require(msg.sender == p.arbitrator, "not arbitrator");
        require(providerBps <= BPS, "ratio > 100%");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Challenged), "not challenged");

        m.splitRatio = providerBps;
        emit DisputeResolved(projectId, milestoneIndex, msg.sender, providerBps);

        // 立即执行分配
        _settleMilestone(projectId, milestoneIndex, providerBps);
    }

    /**
     * @notice 验收通过且过挑战期 → 放款给乙方。
     */
    function releaseMilestone(uint256 projectId, uint256 milestoneIndex) external whenNotPaused whenNotReentrant {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active) || p.status == uint8(ProjectStatus.Completed), "project not active");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Passed), "not passed");
        require(block.timestamp > m.passedAt + CHALLENGE_WINDOW, "challenge window open");

        _settleMilestone(projectId, milestoneIndex, BPS); // 全额给乙方
    }

    /**
     * @notice 验收不通过 → 退款给甲方。
     */
    function refundMilestone(uint256 projectId, uint256 milestoneIndex) external whenNotPaused whenNotReentrant {
        Project storage p = projects[projectId];
        require(msg.sender == p.client, "not client");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Failed), "not failed");

        _settleMilestone(projectId, milestoneIndex, 0); // 全额退甲方
    }

    /**
     * @notice 取消项目，剩余未结算资金全部退回甲方。
     */
    function cancelProject(uint256 projectId) external whenNotPaused whenNotReentrant {
        Project storage p = projects[projectId];
        require(msg.sender == p.client, "not client");
        require(p.status != uint8(ProjectStatus.Cancelled) && p.status != uint8(ProjectStatus.None), "bad status");

        // 结算所有未终结的里程碑（全退甲方）
        uint256 n = p.milestoneCount;
        for (uint256 i = 0; i < n; i++) {
            if (!milestones[projectId][i].settled) {
                _settleMilestone(projectId, i, 0);
            }
        }

        // 清退本项目的精度残差（如按比例分配时的取整余数）。
        //
        // ⚠️ 关键：绝不能用 `token.balanceOf(address(this))` 作为 leftover——
        //    那是**合约全局余额**，包含其他项目的托管资金。
        //    若把它记入本项目 refundedAmount 并转给本项目甲方，
        //    甲方就能通过 cancel 自己的项目，把别人的钱提走。
        //    因此只退本项目已记录金额与实际结算额的差额（正常为 0）。
        uint256 recorded = p.releasedAmount + p.refundedAmount;
        if (recorded > p.totalAmount) {
            // 记账超出名义总额（理论上不应发生），按名义总额退还，多出的由 owner 处置
            uint256 excess = recorded - p.totalAmount;
            p.refundedAmount = p.totalAmount;
            emit ProjectCancelled(projectId, 0);
            p.status = uint8(ProjectStatus.Cancelled);
            p.completedAt = uint64(block.timestamp);
            // 不静默吞掉异常，显式记录以便链下监控
            emit EscrowAccountingAnomaly(projectId, excess);
            return;
        }

        p.status = uint8(ProjectStatus.Cancelled);
        p.completedAt = uint64(block.timestamp);
        emit ProjectCancelled(projectId, 0);
    }

    // ─────────────────────────── 内部结算 ───────────────────────────

    function _settleMilestone(uint256 projectId, uint256 milestoneIndex, uint16 providerBps) private {
        Project storage p = projects[projectId];
        Milestone storage m = milestones[projectId][milestoneIndex];
        require(!m.settled, "already settled");

        uint256 amount = m.amount;
        uint256 toProvider = (amount * providerBps) / BPS;
        uint256 toClient = amount - toProvider;

        // 状态先更新，再转账（checks-effects-interactions）
        m.settled = true;

        if (providerBps == BPS) {
            m.status = uint8(MilestoneStatus.Released);
        } else if (providerBps == 0) {
            m.status = uint8(MilestoneStatus.Refunded);
        } else {
            // 部分分配：用 Released 标记已结算（部分退款场景）
            m.status = uint8(MilestoneStatus.Released);
        }

        if (toProvider > 0) {
            p.token.safeTransfer(p.provider, toProvider);
            p.releasedAmount += toProvider;
            emit MilestoneReleased(projectId, milestoneIndex, p.provider, toProvider);
        }
        if (toClient > 0) {
            p.token.safeTransfer(p.client, toClient);
            p.refundedAmount += toClient;
            emit MilestoneRefunded(projectId, milestoneIndex, p.client, toClient);
        }

        // 全部结算 → 项目完成
        if (_allSettled(projectId)) {
            p.status = uint8(ProjectStatus.Completed);
            p.completedAt = uint64(block.timestamp);
        }
    }

    function _allSettled(uint256 projectId) private view returns (bool) {
        uint256 n = projects[projectId].milestoneCount;
        for (uint256 i = 0; i < n; i++) {
            if (!milestones[projectId][i].settled) return false;
        }
        return true;
    }

    // ─────────────────────────── 查询 ───────────────────────────

    function getProject(uint256 projectId) external view returns (Project memory) {
        return projects[projectId];
    }

    function getMilestone(uint256 projectId, uint256 idx) external view returns (Milestone memory) {
        require(projectId < projectCount, "project not exist");
        return milestones[projectId][idx];
    }

    /// @notice 合约持有的该代币余额（应为未结算资金总额）
    function escrowBalance(uint256 projectId) external view returns (uint256) {
        Project storage p = projects[projectId];
        return p.token.balanceOf(address(this));
    }

    /// @notice 挑战期剩余秒数
    function challengeWindowRemaining(uint256 projectId, uint256 idx) external view returns (uint256) {
        Milestone storage m = milestones[projectId][idx];
        if (m.status != uint8(MilestoneStatus.Passed)) return 0;
        uint256 deadline = m.passedAt + CHALLENGE_WINDOW;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    function getProjectProgress(uint256 projectId)
        external
        view
        returns (uint256 total, uint256 settled, uint256 released, uint256 refunded)
    {
        Project storage p = projects[projectId];
        uint256 s;
        uint256 n = p.milestoneCount;
        for (uint256 i = 0; i < n; i++) {
            if (milestones[projectId][i].settled) s++;
        }
        return (n, s, p.releasedAmount, p.refundedAmount);
    }

    /// @notice 乙方在该项目已收到的款项明细（用于对账）
    /**
     * @notice 资金对账：已放款、已退款、未结算金额。
     * @dev 用减法前先做饱和运算，防止 refundedAmount 因跨项目 leftover
     *      清退而超过 totalAmount 时触发算术下溢（revert）。
     *      出现超额说明有其他项目的资金被误记到本项目，remaining 返回 0 并如实反映。
     */
    function getPayoutSummary(uint256 projectId)
        external
        view
        returns (uint256 totalReleased, uint256 totalRefunded, uint256 remaining)
    {
        Project storage p = projects[projectId];
        totalReleased = p.releasedAmount;
        totalRefunded = p.refundedAmount;

        uint256 settled = p.releasedAmount + p.refundedAmount;
        remaining = settled >= p.totalAmount ? 0 : p.totalAmount - settled;
    }
}

/**
 * @title SafeERC20
 * @notice 兼容非标准 ERC-20（如 USDT 的 transfer 不返回 bool）
 */
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "SafeERC20: transfer failed");
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "SafeERC20: transferFrom failed");
    }
}
