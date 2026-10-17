require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * 网络配置
 *
 * ⚠️ 安全提醒：PRIVATE_KEY 仅通过 .env 注入，切勿硬编码进代码或提交到版本库。
 *
 * - hardhat / localhost : 本地链，用于快速验证
 * - monad               : Monad 测试网（chainId 10143），里程碑多次交互场景体验最佳
 * - amoy                : Polygon Amoy 测试网（备用）
 *
 * Monad 注意（来自 monskills/concepts）：
 *   1. 共识与执行解耦，**新充值账户需等待约 1.2 秒**才能发出交易
 *   2. EOA 有 **10 MON 余额下限**，低于此值的账户交易频率受限（约 1.2 秒一笔）
 *   3. 区块状态：Proposed → Voted → Finalized → Verified，
 *      对应 RPC 的 latest / safe / finalized 三种视图
 *
 * MockToken 为本地部署的测试代币，不具备任何真实价值或流通性。
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true, // 解决 evaluate() 的 stack-too-deep
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // 账户一=甲方/部署者，账户二=乙方。仲裁者由 ArbitratorBot 合约担任。
    monad: {
      url: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean),
    },
    amoy: {
      url: process.env.POLYGON_AMOY_RPC || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean),
    },
  },
  etherscan: {
    apiKey: {
      monadTestnet: process.env.MONADSCAN_API_KEY || "",
      polygonAmoy: process.env.POLYGONSCAN_API_KEY || "",
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: { timeout: 120000 },
};
