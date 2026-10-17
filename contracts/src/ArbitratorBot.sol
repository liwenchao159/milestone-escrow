// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArbitratorBot
 * @notice 独立仲裁者合约 —— 演示「去信任裁定」的实现方式
 *
 * 为什么用合约而不是 EOA 当仲裁者？
 *   EOA 仲裁者本质上是「换一个中心化主体」，其判断仍不可验证。
 *   合约仲裁者的裁定规则**写在链上、公开可查、无法被任何一方临时修改**，
 *   且规则本身简单到可以人工验算——这才是真正的「无主观裁量」。
 *
 * 裁定规则（本 demo 用固定比例，真实场景应基于可验证事实）：
 *   若被挑战的里程碑评估结论为「通过」，按 agreedRatio 分给乙方；
 *   若为「不通过」，全额退回甲方。
 *
 * ⚠️ 本合约为演示实现。生产环境需更严谨的裁定依据，
 *    且应加入紧急暂停、二期申诉等机制。
 */
contract ArbitratorBot {
    address public immutable escrow;
    address public owner;

    /// @notice 争议里程碑的默认裁定比例（万分比，给乙方）
    uint16 public defaultRatio;

    event DisputeArbitrated(
        uint256 indexed projectId,
        uint256 indexed milestoneIndex,
        uint16 ratio,
        address indexed by
    );

    modifier onlyEscrow() {
        require(msg.sender == escrow, "not escrow");
        _;
    }

    constructor(address escrowAddress, uint16 ratio) {
        require(escrowAddress != address(0), "escrow=0");
        require(ratio <= 10000, "ratio>100%");
        escrow = escrowAddress;
        defaultRatio = ratio;
        owner = msg.sender;
    }

    /**
     * @notice 发起仲裁。由任意第三方调用（通常是挑战方或仲裁流程触发人）。
     * @dev 比例由合约逻辑决定，调用方**无法指定裁定结果**——这是去信任的关键。
     *      调用方能做的只是「启动流程」，不能左右结论。
     */
    function arbitrate(uint256 projectId, uint256 milestoneIndex) external {
        _resolve(projectId, milestoneIndex, defaultRatio);
    }

    /**
     * @notice 直接按传入比例结算。仅 escrow 可调用（供 escrow 内部流程使用）。
     */
    function resolveDispute(uint256 projectId, uint256 milestoneIndex, uint16 ratio) external onlyEscrow {
        require(ratio <= 10000, "ratio>100%");
        _resolve(projectId, milestoneIndex, ratio);
    }

    function _resolve(uint256 projectId, uint256 milestoneIndex, uint16 ratio) private {
        emit DisputeArbitrated(projectId, milestoneIndex, ratio, msg.sender);

        // 调用 escrow 完成实际划款
        (bool ok, bytes memory data) =
            escrow.call(abi.encodeWithSignature("resolveDispute(uint256,uint256,uint16)", projectId, milestoneIndex, ratio));
        require(ok, "escrow resolve failed");
    }

    /// @notice owner 只能调整「预设比例」，不能指定具体某个争议的裁定
    function setDefaultRatio(uint16 ratio) external {
        require(msg.sender == owner, "not owner");
        require(ratio <= 10000, "ratio>100%");
        defaultRatio = ratio;
    }
}
