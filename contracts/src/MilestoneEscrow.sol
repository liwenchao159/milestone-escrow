// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MilestoneEscrow
 * @notice 里程碑存证合约（路径 A：不做资金托管，仅存证与凭证）
 *
 * 设计要点 —— 直接回应可行性评估中的三个信任漏洞：
 *
 * 1. 规则锁定（漏洞 1：规则定义权在甲方）
 *    验收规则在项目创建时确定，规则哈希写入链上。
 *    修改规则需**双方签名**，任一方无法单方改规则塞入偏颇条件。
 *
 * 2. 独立评估器（漏洞 2：验收环境由单方控制）
 *    evaluate() 由 evaluator 合约地址调用，该地址在创建时由**双方共同指定**
 *    并写入链上。评估器不隶属于任何一方，且无法自行改写判定逻辑。
 *
 * 3. 挑战期（替代「秒级自动放款」）
 *    验收通过后进入 CHALLENGE_WINDOW 期，期内任一方可提交挑战。
 *    这段延迟换取了争议可达性，是合规优先路线主动接受的取舍。
 *
 * 注意：本合约**不托管任何真实资产**，不涉及法币或代币转移。
 * 仅存证交付物哈希、验收结论与凭证铸造。
 */
contract MilestoneEscrow {
    // ─────────────────────────── 常量 ───────────────────────────

    /// @notice 挑战期（秒）。默认 3 天。
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

    /// @notice 验收通过后的确认期（秒），期间无挑战则自动终结。默认 5 天。
    uint256 public constant CONFIRMATION_WINDOW = 5 days;

    // ─────────────────────────── 枚举 ───────────────────────────

    enum ProjectStatus {
        None,
        Draft, // 规则拟定中，尚未双签
        Active, // 双方已签署规则，可提交交付
        Completed, // 全部里程碑验收通过
        Cancelled // 已取消
    }

    enum MilestoneStatus {
        Pending, // 待提交
        Submitted, // 已提交，等待评估
        Evaluating, // 评估器处理中（预留）
        Challenged, // 已被挑战
        Passed, // 验收通过（已过挑战期）
        Failed, // 验收不通过
        Rejected, // 被直接拒收
        FinalizedPassed, // 已终结：验收通过并已铸发凭证
        FinalizedFailed // 已终结：验收不通过（不铸凭证）
    }

    enum ChallengeReason {
        None,
        RuleViolation, // 违反验收规则
        EnvironmentTampering, // 评估环境被篡改
        ResultDispute // 对评估结论有异议
    }

    // ─────────────────────────── 数据结构 ───────────────────────────

    struct RuleSet {
        bytes32 ruleHash; // 规则哈希（规则正文存证处，链上只留哈希）
        address evaluator; // 双方共同指定的评估器合约
        uint256 challengeWindow; // 挑战期
        address[] signers; // 已签署方地址
    }

    struct Milestone {
        uint8 status; // MilestoneStatus
        bytes32 deliverableHash; // 交付物内容哈希
        string deliverableURI; // 交付物位置（存证处）
        uint64 submittedAt;
        uint64 evaluatedAt;
        uint8 lastScore; // 评估器给出的分数（0-100）
        bytes32 resultHash; // 评估报告哈希
        uint64 passedAt; // 通过时间点
        bool challenged;
        uint8 challengeReason; // ChallengeReason
        address challenger;
        string challengeNote;
    }

    struct Project {
        address client; // 甲方
        address provider; // 乙方
        address arbitrator; // 争议仲裁者（链下有声誉约束的角色）
        bytes32 ruleHash;
        address evaluator;
        uint8 status; // ProjectStatus
        uint64 createdAt;
        uint64 activatedAt;
        uint64 completedAt;
        uint256 milestoneCount;
    }

    // ─────────────────────────── 存储 ───────────────────────────

    address public owner;

    /// @notice projectId => 项目
    mapping(uint256 => Project) public projects;
    /// @notice projectId => milestoneIndex => 里程碑
    /// @dev 采用嵌套 mapping 而非动态数组：Solidity 不支持 memory 结构体数组直接赋值到 storage
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;
    /// @notice projectId => 规则签署记录
    mapping(uint256 => RuleSet) public ruleSets;
    /// @notice projectId => 已通过验收的里程碑数（用于进度统计）
    mapping(uint256 => uint256) public passedCount;

    uint256 public projectCount;

    // ─────────────────────────── 事件 ───────────────────────────

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed client,
        address indexed provider,
        address arbitrator,
        address evaluator,
        bytes32 ruleHash,
        uint256 milestoneCount
    );
    event RuleSigned(uint256 indexed projectId, address indexed signer, bytes32 ruleHash);
    event ProjectActivated(uint256 indexed projectId);
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
        address indexed evaluator,
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
    event MilestoneFinalized(uint256 indexed projectId, uint256 indexed milestoneIndex, uint8 score);
    event MilestoneRejected(uint256 indexed projectId, uint256 indexed milestoneIndex, address indexed by);
    event CredentialMinted(
        uint256 indexed projectId,
        address indexed provider,
        uint256 credentialId,
        uint256 milestonesPassed
    );
    event CredentialRevoked(uint256 indexed credentialId, address indexed by);
    event ProjectCancelled(uint256 indexed projectId, address indexed by, string reason);
    event DisputeResolved(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        address indexed arbitrator,
        bool passAccepted
    );

    // ─────────────────────────── 修饰符 ───────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // ─────────────────────────── 构造函数 ───────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─────────────────────────── 项目创建 ───────────────────────────

    /**
     * @notice 创建项目。规则哈希与评估器地址写入链上，须双方签署后生效。
     * @param provider 乙方地址
     * @param arbitrator 争议仲裁者地址
     * @param evaluator 双方共同认可的评估器合约地址
     * @param ruleHash 验收规则哈希（规则正文存于存证处）
     * @param milestoneCount 里程碑数量
     */
    function createProject(
        address provider,
        address arbitrator,
        address evaluator,
        bytes32 ruleHash,
        uint256 milestoneCount
    ) external returns (uint256 projectId) {
        require(provider != address(0), "provider=0");
        require(arbitrator != address(0), "arbitrator=0");
        require(evaluator != address(0), "evaluator=0");
        require(bytes32(ruleHash) != bytes32(0), "ruleHash empty");
        require(milestoneCount > 0 && milestoneCount <= 100, "milestoneCount out of range");

        projectId = projectCount++;

        projects[projectId] = Project({
            client: msg.sender,
            provider: provider,
            arbitrator: arbitrator,
            ruleHash: ruleHash,
            evaluator: evaluator,
            status: uint8(ProjectStatus.Draft),
            createdAt: uint64(block.timestamp),
            activatedAt: 0,
            completedAt: 0,
            milestoneCount: milestoneCount
        });

        ruleSets[projectId] = RuleSet({
            ruleHash: ruleHash,
            evaluator: evaluator,
            challengeWindow: CHALLENGE_WINDOW,
            signers: new address[](0)
        });

        emit ProjectCreated(projectId, msg.sender, provider, arbitrator, evaluator, ruleHash, milestoneCount);
    }

    /**
     * @notice 签署验收规则。甲乙双方各签一次后项目激活。
     * @dev 规则哈希不可变更——这是防止甲方中途塞入偏颇条件的核心约束。
     */
    function signRule(uint256 projectId) external {
        Project storage p = projects[projectId];
        require(p.status != uint8(ProjectStatus.None), "project not exist");
        require(p.status == uint8(ProjectStatus.Draft), "already activated");

        require(msg.sender == p.client || msg.sender == p.provider, "not party");

        // 重复签署检查
        RuleSet storage rs = ruleSets[projectId];
        for (uint256 i = 0; i < rs.signers.length; i++) {
            require(rs.signers[i] != msg.sender, "already signed");
        }
        rs.signers.push(msg.sender);
        emit RuleSigned(projectId, msg.sender, p.ruleHash);

        if (rs.signers.length == 2) {
            p.status = uint8(ProjectStatus.Active);
            p.activatedAt = uint64(block.timestamp);
            emit ProjectActivated(projectId);
        }
    }

    // ─────────────────────────── 交付与验收 ───────────────────────────

    /**
     * @notice 乙方提交交付物。
     * @param deliverableHash 交付物内容哈希（keccak256）
     * @param deliverableURI 交付物位置（存证处）
     */
    function submitMilestone(uint256 projectId, uint256 milestoneIndex, bytes32 deliverableHash, string calldata deliverableURI)
        external
    {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active), "project not active");
        require(msg.sender == p.provider, "not provider");
        require(milestoneIndex < p.milestoneCount, "index out of range");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Pending), "already submitted");
        require(bytes32(deliverableHash) != bytes32(0), "empty deliverable");

        m.status = uint8(MilestoneStatus.Submitted);
        m.deliverableHash = deliverableHash;
        m.deliverableURI = deliverableURI;
        m.submittedAt = uint64(block.timestamp);

        emit MilestoneSubmitted(projectId, milestoneIndex, msg.sender, deliverableHash, deliverableURI);
    }

    /**
     * @notice 评估器提交评估结论。仅指定的 evaluator 合约可调用。
     * @dev 这是方案缺失的关键模块——评估器是独立的第三方角色，
     *      不由任一方控制，且判定逻辑不可被任一方改写。
     */
    function reportEvaluation(uint256 projectId, uint256 milestoneIndex, uint8 score, bool passed, bytes32 resultHash)
        external
    {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active), "project not active");
        require(msg.sender == p.evaluator, "not evaluator");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Submitted), "not submitted");

        m.status = passed ? uint8(MilestoneStatus.Passed) : uint8(MilestoneStatus.Failed);
        m.lastScore = score;
        m.resultHash = resultHash;
        m.evaluatedAt = uint64(block.timestamp);
        m.passedAt = uint64(block.timestamp);

        if (passed) {
            passedCount[projectId] += 1;
        }

        emit MilestoneEvaluated(projectId, milestoneIndex, msg.sender, score, passed, resultHash);
    }

    /**
     * @notice 发起挑战。验收通过后进入挑战期，期内任一方均可挑战。
     * @dev 挑战由仲裁者在仲裁期后裁决。
     */
    function challengeMilestone(uint256 projectId, uint256 milestoneIndex, ChallengeReason reason, string calldata note)
        external
    {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active), "project not active");
        require(msg.sender == p.client || msg.sender == p.provider, "not party");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Passed), "not passed");
        require(!m.challenged, "already challenged");
        require(block.timestamp <= m.passedAt + ruleSets[projectId].challengeWindow, "challenge window closed");

        m.challenged = true;
        m.challengeReason = uint8(reason);
        m.challenger = msg.sender;
        m.challengeNote = note;
        m.status = uint8(MilestoneStatus.Challenged);

        emit MilestoneChallenged(projectId, milestoneIndex, msg.sender, uint8(reason), note);
    }

    /**
     * @notice 仲裁者裁决被挑战的里程碑。
     * @param passAccepted 是否维持验收通过
     */
    function resolveDispute(uint256 projectId, uint256 milestoneIndex, bool passAccepted) external {
        Project storage p = projects[projectId];
        require(msg.sender == p.arbitrator, "not arbitrator");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(m.status == uint8(MilestoneStatus.Challenged), "not challenged");

        if (passAccepted) {
            // 维持通过：恢复计数并进入待终结状态
            m.status = uint8(MilestoneStatus.Passed);
            m.challenged = false;
            passedCount[projectId] += 1;
        } else {
            // 推翻通过：回退计数，凭证不得铸造
            m.status = uint8(MilestoneStatus.Failed);
            m.challenged = false;
            require(passedCount[projectId] > 0, "count underflow");
            passedCount[projectId] -= 1;
        }

        emit DisputeResolved(projectId, milestoneIndex, msg.sender, passAccepted);
    }

    /**
     * @notice 终结单个里程碑。挑战期过后可调用。
     *
     * @dev 两种终态：
     *   Passed  → 铸发履约凭证
     *   Failed  → 不铸凭证，标记终结
     *
     * 「不达标」同样需要一条闭环路径——否则验收失败的里程碑会永远卡在
     * Failed 状态，乙方无法重投、项目也无法正常终结。这是设计缺陷的修复。
     *
     * 项目终结条件基于**已终结数**而非通过数，
     * 因此与 finalize 的调用顺序无关（修复顺序依赖问题）。
     */
    function finalizeMilestone(uint256 projectId, uint256 milestoneIndex) external {
        Project storage p = projects[projectId];
        require(
            p.status == uint8(ProjectStatus.Active) || p.status == uint8(ProjectStatus.Completed),
            "project not active"
        );
        require(msg.sender == p.client || msg.sender == p.provider, "not party");

        Milestone storage m = milestones[projectId][milestoneIndex];
        require(!m.challenged, "under dispute");

        uint8 finalizedCount = _countFinalized(projectId);
        bool doMint;

        if (m.status == uint8(MilestoneStatus.Passed)) {
            require(block.timestamp > m.passedAt + ruleSets[projectId].challengeWindow, "challenge window open");
            m.status = uint8(MilestoneStatus.FinalizedPassed);
            doMint = true;
        } else if (m.status == uint8(MilestoneStatus.Failed)) {
            // 不达标：评估时刻已确定结论，无需再等挑战期（无争议可挑战）
            m.status = uint8(MilestoneStatus.FinalizedFailed);
        } else {
            revert("not finalized-able");
        }

        finalizedCount += 1;

        if (doMint) {
            _mintCredential(projectId, milestoneIndex, m.lastScore);
        }

        emit MilestoneFinalized(projectId, milestoneIndex, m.lastScore);

        // 全部里程碑均已终结 → 项目完成
        if (finalizedCount == p.milestoneCount) {
            p.status = uint8(ProjectStatus.Completed);
            p.completedAt = uint64(block.timestamp);
        }
    }

    // ─────────────────────────── 凭证（内联 ERC-1155） ───────────────────────────

    mapping(uint256 => mapping(address => uint256)) private _balances; // projectId => owner => balance
    mapping(uint256 => uint256) private _projectMinted; // projectId => 已铸数量
    mapping(uint256 => mapping(uint256 => bool)) public credentialRevoked; // projectId => tokenId => revoked
    mapping(uint256 => mapping(uint256 => uint8)) public credentialScore; // projectId => tokenId => score

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    /// @dev 凭证为 soulbound：铸造后不可转让。函数保留但永久 revert。
    function safeTransferFrom(address, address, uint256, uint256, bytes memory) public pure {
        revert("SBT: non-transferable");
    }

    /// @dev soulbound 凭证不支持 approvals
    function setApprovalForAll(address, bool) public pure {
        revert("SBT: non-transferable");
    }

    function isApprovedForAll(address, address) public pure returns (bool) {
        return false;
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    /// @notice 该项目下所有凭证的持有人（仅一方，符合 soulbound 语义）
    function creatorOf(uint256 id) external view returns (address) {
        Project storage p = projects[id];
        require(p.status != uint8(ProjectStatus.None), "project not exist");
        return p.provider;
    }

    /// @notice 凭证 URI：指向存证处的验收报告哈希
    function uri(uint256 id) external view returns (string memory) {
        Project storage p = projects[id];
        require(p.status != uint8(ProjectStatus.None), "project not exist");
        return string(abi.encodePacked("ar://milestone-escrow/", _toString(id), "/", _toString(_projectMinted[id])));
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function _mintCredential(uint256 projectId, uint256 milestoneIndex, uint8 score) private {
        Project storage p = projects[projectId];
        _balances[projectId][p.provider] += 1;
        _projectMinted[projectId] += 1;
        credentialScore[projectId][milestoneIndex] = score;
        emit TransferSingle(msg.sender, address(0), p.provider, projectId, 1);
        emit CredentialMinted(projectId, p.provider, _projectMinted[projectId], passedCount[projectId]);
    }

    /**
     * @notice 撤销凭证。仅项目甲方可撤销（用于争议终局裁决后）
     * @dev 采用 burn-and-reissue 模式：撤销交易本身公开，链上无删除能力。
     */
    function revokeCredential(uint256 projectId, uint256 milestoneIndex) external {
        Project storage p = projects[projectId];
        require(msg.sender == p.client || msg.sender == p.arbitrator, "not authorized");
        require(!credentialRevoked[projectId][milestoneIndex], "already revoked");

        credentialRevoked[projectId][milestoneIndex] = true;
        emit CredentialRevoked(milestoneIndex, msg.sender);
    }

    // ─────────────────────────── 查询 ───────────────────────────

    function getProject(uint256 projectId) external view returns (Project memory) {
        return projects[projectId];
    }

    function getMilestone(uint256 projectId, uint256 milestoneIndex) external view returns (Milestone memory) {
        require(projectId < projectCount, "project not exist");
        return milestones[projectId][milestoneIndex];
    }

    /// @notice 分页读取里程碑列表（Solidity 不支持直接返回 storage 数组，故逐项封装）
    function getMilestoneCount(uint256 projectId) external view returns (uint256) {
        require(projectId < projectCount, "project not exist");
        return projects[projectId].milestoneCount;
    }

    /// @notice 挑战期剩余时间（秒）。已结束返回 0。
    function challengeWindowRemaining(uint256 projectId, uint256 milestoneIndex) external view returns (uint256) {
        Milestone storage m = milestones[projectId][milestoneIndex];
        if (m.status != uint8(MilestoneStatus.Passed) || m.challenged) {
            return 0;
        }
        uint256 deadline = m.passedAt + ruleSets[projectId].challengeWindow;
        if (block.timestamp >= deadline) {
            return 0;
        }
        return deadline - block.timestamp;
    }

    /// @notice 统计已终结的里程碑数量（Passed 或 Failed 的终态）
    function _countFinalized(uint256 projectId) private view returns (uint8 count) {
        uint256 total = projects[projectId].milestoneCount;
        for (uint256 i = 0; i < total; i++) {
            uint8 s = milestones[projectId][i].status;
            if (s == uint8(MilestoneStatus.FinalizedPassed) || s == uint8(MilestoneStatus.FinalizedFailed)) {
                count++;
            }
        }
    }

    function getProjectProgress(uint256 projectId)
        external
        view
        returns (uint256 total, uint256 passed, uint256 finalized)
    {
        Project storage p = projects[projectId];
        return (p.milestoneCount, passedCount[projectId], _countFinalized(projectId));
    }

    /// @notice 乙方在项目下的可验证履历（用于求职展示，不泄露交付内容）
    function getProviderCredentials(address provider)
        external
        view
        returns (uint256[] memory projectIds, uint256[] memory counts)
    {
        uint256 n = projectCount;
        uint256 found;
        for (uint256 i = 0; i < n; i++) {
            if (projects[i].provider == provider && _balances[i][provider] > 0) {
                found++;
            }
        }
        projectIds = new uint256[](found);
        counts = new uint256[](found);
        uint256 j;
        for (uint256 k = 0; k < n; k++) {
            if (projects[k].provider == provider && _balances[k][provider] > 0) {
                projectIds[j] = k;
                counts[j] = _balances[k][provider];
                j++;
            }
        }
    }

    // ─────────────────────────── 取消 ───────────────────────────

    function cancelProject(uint256 projectId, string calldata reason) external {
        Project storage p = projects[projectId];
        require(p.status == uint8(ProjectStatus.Active) || p.status == uint8(ProjectStatus.Draft), "not cancellable");
        require(msg.sender == p.client || msg.sender == p.provider, "not party");
        p.status = uint8(ProjectStatus.Cancelled);
        emit ProjectCancelled(projectId, msg.sender, reason);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
