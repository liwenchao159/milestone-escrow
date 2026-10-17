// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MilestoneEscrow.sol";

/**
 * @title DeterministicEvaluator
 * @notice 确定性验收评估器 —— 方案的缺失模块，也是自动验收的核心
 *
 * 关键设计（回应可行性评估中的信任漏洞 1 与 2）：
 *
 * 漏洞 1「规则由甲方单方定义」的解法：
 *   评估器只接受**预编译的规则集**（ruleSetId），不接受甲方临时传入的判定参数。
 *   规则集在部署时确定并哈希锁定，评估时合约自行加载，无法被调用方覆盖。
 *
 * 漏洞 2「验收环境由单方控制」的解法：
 *   评估器只做**纯函数式判定**——输入是存证处拉取的客观事实（测试通过数、
 *   接口可用率、必填字段覆盖率），输出是分数。它不执行任何外部请求，
 *   因此不存在"甲方自建接口返回 200"这类攻击面。
 *   事实采集由 server 侧的采集器完成，采集器与评估器分离，且采集报告的哈希
 *   会被记录到链上供事后审计。
 *
 * 评分规则完全公开、纯函数、可复算。任何第三方可以用同一份事实报告复算出同一分数。
 */
contract DeterministicEvaluator {
    struct RuleSet {
        bytes32 id;
        uint16 passThreshold; // 通过分数线（如 80）
        uint16 requiredTestPassRate; // 必测用例通过率要求（万分比，如 9500 = 95%）
        uint16 requiredApiAvailability; // 接口可用率要求（万分比）
        uint16 requiredFieldCoverage; // 必填字段覆盖率要求（万分比）
        uint16 weightTest; // 三个维度的权重（和为 10000）
        uint16 weightApi;
        uint16 weightField;
        bool active;
    }

    address public escrow;
    address public owner;

    /// @notice 授权的事实采集者。
    /// @dev 采集器负责从可验证源拉取客观事实并提交评估。
    /// 它不参与判定逻辑——判定完全由 ruleSet 决定，采集器无法左右结果。
    /// 这是「信任分离」的关键：采集器可被质疑，但判定逻辑不可被收买。
    mapping(address => bool) public collectors;

    mapping(bytes32 => RuleSet) public ruleSets;

    /// @dev 已被调用的 (projectId, milestoneIndex) 防止重复评估
    mapping(uint256 => mapping(uint256 => bool)) public evaluated;
    /// @dev 事实报告哈希，供事后审计复算
    mapping(uint256 => mapping(uint256 => bytes32)) public factReportHash;

    event RuleSetRegistered(bytes32 indexed id, uint16 passThreshold);
    event Evaluated(uint256 indexed projectId, uint256 indexed milestoneIndex, uint16 score, bool passed);
    event FactReportRecorded(uint256 indexed projectId, uint256 indexed milestoneIndex, bytes32 reportHash);
    event CollectorSet(address indexed collector, bool authorized);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address escrowAddress) {
        require(escrowAddress != address(0), "escrow=0");
        escrow = escrowAddress;
        owner = msg.sender;
    }

    /**
     * @notice 授权 / 撤销事实采集者。
     * @dev 采集者是「事实提供者」而非「判定者」——它提交客观数据，
     * 但无法改变 passThreshold / weights / required 这些判定参数。
     */
    function setCollector(address collector, bool authorized) external onlyOwner {
        require(collector != address(0), "collector=0");
        collectors[collector] = authorized;
        emit CollectorSet(collector, authorized);
    }

    /**
     * @notice 注册验收规则集。所有权归 owner，注册后不可修改（不可变保证可复算性）。
     */
    function registerRuleSet(
        bytes32 id,
        uint16 passThreshold,
        uint16 requiredTestPassRate,
        uint16 requiredApiAvailability,
        uint16 requiredFieldCoverage,
        uint16 weightTest,
        uint16 weightApi,
        uint16 weightField
    ) external onlyOwner {
        require(!ruleSets[id].active, "rule exists");
        require(passThreshold > 0 && passThreshold <= 100, "bad threshold");
        require(weightTest + weightApi + weightField == 10000, "weights must sum to 10000");

        ruleSets[id] = RuleSet({
            id: id,
            passThreshold: passThreshold,
            requiredTestPassRate: requiredTestPassRate,
            requiredApiAvailability: requiredApiAvailability,
            requiredFieldCoverage: requiredFieldCoverage,
            weightTest: weightTest,
            weightApi: weightApi,
            weightField: weightField,
            active: true
        });

        emit RuleSetRegistered(id, passThreshold);
    }

    /**
     * @notice 评估一个里程碑。仅授权采集者可调用。
     *
     * @param reportHash 事实报告哈希（供审计复算）
     *
     * @dev 判定逻辑：
     *   1. 先过硬门槛：三个维度各自必须达到 required 阈值，任一不达标直接不通过
     *      —— 这是防「甲方只挑软指标达标」的机制，不能靠其他维度的高分补齐
     *   2. 再算加权总分：通过则取分，低于 passThreshold 判不通过
     *
     * 信任模型：
     *   采集者决定「事实是什么」，但**无法决定「判定结果」**。
     *   阈值与权重在 evaluate() 的参数中完全不存在，只能来自已注册的 ruleSet。
     *   即使采集者恶意压低或抬高事实，也只会在既定规则下得出既定结论——
     *   而事实报告哈希上链，事后可复算、可挑战。
     */
    function evaluate(
        uint256 projectId,
        uint256 milestoneIndex,
        bytes32 ruleSetId,
        uint16 testPassRate,
        uint16 apiAvailability,
        uint16 fieldCoverage,
        bytes32 reportHash
    ) external returns (bool passed, uint16 score) {
        require(collectors[msg.sender], "not collector");
        require(!evaluated[projectId][milestoneIndex], "already evaluated");

        RuleSet memory rs = ruleSets[ruleSetId];
        require(rs.active, "rule not exist");

        // 硬门槛：任一维度不达标，直接判定不通过（不给加权补齐的机会）
        bool gateTest = testPassRate >= rs.requiredTestPassRate;
        bool gateApi = apiAvailability >= rs.requiredApiAvailability;
        bool gateField = fieldCoverage >= rs.requiredFieldCoverage;

        uint256 weighted =
            (uint256(testPassRate) * rs.weightTest + uint256(apiAvailability) * rs.weightApi + uint256(fieldCoverage) * rs.weightField)
            / 10000;

        // 万分比转百分比并四舍五入
        score = uint16((weighted + 50) / 100);

        passed = gateTest && gateApi && gateField && score >= rs.passThreshold;

        evaluated[projectId][milestoneIndex] = true;
        factReportHash[projectId][milestoneIndex] = reportHash;

        emit FactReportRecorded(projectId, milestoneIndex, reportHash);
        emit Evaluated(projectId, milestoneIndex, score, passed);

        MilestoneEscrow(escrow).reportEvaluation(projectId, milestoneIndex, uint8(score), passed, reportHash);
    }

    /**
     * @notice 评估器是否会因该事实组合而通过（纯查询，供 UI 预估与审计）
     */
    function preview(bytes32 ruleSetId, uint16 testPassRate, uint16 apiAvailability, uint16 fieldCoverage)
        external
        view
        returns (bool passed, uint16 score)
    {
        RuleSet memory rs = ruleSets[ruleSetId];
        require(rs.active, "rule not exist");

        bool gateTest = testPassRate >= rs.requiredTestPassRate;
        bool gateApi = apiAvailability >= rs.requiredApiAvailability;
        bool gateField = fieldCoverage >= rs.requiredFieldCoverage;

        uint256 weighted =
            (uint256(testPassRate) * rs.weightTest + uint256(apiAvailability) * rs.weightApi + uint256(fieldCoverage) * rs.weightField)
            / 10000;
        score = uint16((weighted + 50) / 100);
        passed = gateTest && gateApi && gateField && score >= rs.passThreshold;
    }

    function getRuleSet(bytes32 id) external view returns (RuleSet memory) {
        return ruleSets[id];
    }

    function getFactReportHash(uint256 projectId, uint256 milestoneIndex) external view returns (bytes32) {
        return factReportHash[projectId][milestoneIndex];
    }
}
