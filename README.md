# 里程碑验收存证系统

> 远程劳务里程碑存证与条件托管合约的**可运行实现**
> 基于可行性评估报告的**路径 A（合规优先）**：放弃资金托管，只做「验收规则标准化 + 存证凭证」

---

## 为什么要按路径 A 重做

原方案存在四个致命问题（详见同目录可行性评估报告）：

| 问题 | 本实现的应对 |
|---|---|
| 差异化已被 ERC-8183 标准化 | 不自造标准，聚焦**验收规则引擎**这个垂直深度 |
| 自动验收的信任漏洞 | 规则模板库 + 双签锁定 + 硬门槛 + 链上判定 |
| ZK 凭证不可行 | **删除 ZK**，改用哈希承诺 + 事实报告可审计复算 |
| 合规（银发〔2026〕42 号） | **不做资金托管**，不处理法币或代币转移 |

**价值主张的转变**：不是「没有中间人」，而是「验收规则标准化 + 过程可追溯 + 履历可自证」。

---

## 三个信任漏洞的技术解法

这是本实现的核心，也是与原方案最大的差异。

### 漏洞 1：规则由甲方单方定义 → 规则锁定 + 双签

```
甲方想写「必测用例通过率 30%」？
→ 规则哈希在 createProject 时写入链上
→ signRule 需甲乙双方各签一次
→ 合约中不存在任何修改 ruleHash 的函数入口（结构性保证）
```

规则不来自甲方的自由文本，而来自 `ruleTemplates.ts` 中的**标准化模板**。甲方只能从模板中选，不能自定义。

### 漏洞 2：验收环境由单方控制 → 硬门槛 + 链上判定

这是最容易被忽略的一点。原文方案的隐含假设是「客观规则 = 确定性 = 无需信任」，但：

```
甲方自建一个永远返回 200 的接口 → 预言机忠实地把谎话送上链 → 合约照常放款
```

本实现的处理分两层：

**第一层 · 硬门槛机制**（防止「只挑软指标达标」）

```
事实：测试 80%（未达 90% 门槛）· 接口 100% · 字段 100%
结果：加权 90 分（很高）→ 仍判定不通过
```

三个维度**各自独立设门槛**，任一不达标直接否决，不能靠其他维度的高分补齐。这是 `evaluate()` 里 `gateTest && gateApi && gateField` 的作用。

**第二层 · 判定逻辑上链，采集器无法操纵**

```solidity
function evaluate(
    uint256 projectId, uint256 milestoneIndex,
    bytes32 ruleSetId,           // 只能来自已注册的不可变规则集
    uint16 testPassRate,         // 事实值
    uint16 apiAvailability,      // 事实值
    uint16 fieldCoverage,        // 事实值
    bytes32 reportHash
) external
```

注意参数里**没有 threshold、没有 weight、没有 required**。判定阈值与权重只存在于链上的 `ruleSets` mapping 中，注册后不可修改。采集器能做的只是提交事实值，无法左右结论。

**采集器可以撒谎，但撒谎是可被检测的** —— 事实报告哈希上链可审计复算，且有 3 天挑战期由仲裁者裁决。这比追求「绝对可信的预言机」务实：后者在链下现实中不存在。

### 漏洞 3：商业逻辑自相矛盾 → 范围克制

方案原本同时主张「面向文档/设计类外包」和「拒绝主观验收」。本实现选择**只保留可客观复算的部分**：

| 模板 | 适用 | 拒绝 |
|---|---|---|
| `standard-interface-v1` | 代码 / 接口开发 | |
| `data-pipeline-v1` | 数据处理 / ETL | |
| `lightweight-doc-v1` | **结构可枚举**的技术文档 | 观点、策略类文档 |
| `strict-release-v1` | 高风险核心链路 | |
| — | — | **设计 / 创意**（完全拒绝） |

`POST /api/validate-deliverable` 会强制校验交付类型与模板匹配，主观需求塞不进来。

---

## 目录结构

```
milestone-escrow/
├── contracts/                      # 智能合约
│   ├── src/
│   │   ├── MilestoneEscrow.sol      # 状态机 + soulbound 凭证
│   │   └── DeterministicEvaluator.sol  # 纯函数判定 + 硬门槛
│   ├── test/MilestoneEscrow.test.js   # 39 个测试
│   └── scripts/
│       ├── deploy.js               # 部署 + 注册规则模板
│       └── demo.js                 # 端到端演示
├── server/
│   └── src/
│       ├── ruleTemplates.ts        # 验收规则模板库 ★核心差异化
│       ├── collector.ts            # 事实采集器 + 复算 ★信任分离
│       └── index.ts                # 编排 API
└── web/index.html                  # 演示台（零依赖，可直接打开）
```

---

## 快速开始

```bash
# 1. 合约：编译 + 测试
cd contracts
npm install
npx hardhat compile
npx hardhat test              # 39 passing

# 2. 端到端演示（10 步全流程）
npx hardhat run scripts/demo.js

# 3. 服务端：事实采集与编排 API
cd ../server
npm install
npx ts-node src/index.ts      # http://localhost:4000

# 4. 前端演示台：直接用浏览器打开
open web/index.html
```

---

## 状态机

```
项目    Draft ──双签──> Active ──全部终结──> Completed
                     └─取消──> Cancelled

里程碑  Pending ──提交──> Submitted ──评估通过──> Passed ──过挑战期──> FinalizedPassed（铸凭证）
                    │                    └─评估不通过──> Failed ──终结──> FinalizedFailed（无凭证）
                    └─> Challenged ──仲裁──> Passed / Failed
```

**挑战期 3 天**：验收通过后进入挑战期，期内任一方可挑战，期内不可 finalize。这是合规优先路线**主动接受的取舍** —— 用结算延迟换取争议可达性。

**终结的判定基于终结数而非通过数**，因此与 `finalize` 的调用顺序无关（修复了顺序依赖 bug）。

---

## 测试覆盖

39 个测试，重点覆盖**信任漏洞的防护效果**而非 happy path：

- 规则哈希不可变更（检查 ABI 中不存在修改入口）
- 评估器不接受调用方传入阈值（检查参数签名）
- 硬门槛：单维度不达标 → 高分仍不通过（3 个维度各一个用例）
- 门槛全过但加权分低 → 不通过
- `preview` 与 `evaluate` 结论一致（可复算性）
- 采集者被撤销授权后无法评估（可问责）
- 恶意采集者无法篡改阈值
- 挑战期内不可 finalize
- 仲裁者可推翻 / 维持结论
- 凭证 soulbound 不可转让
- 回归测试：不达标里程碑可终结、finalize 顺序无关

---

## 合规边界

**本系统不做的事**（这是设计约束，不是未完成项）：

- 不托管任何资金
- 不处理法币或代币转移
- 不铸造可交易代币（凭证为 soulbound，永久不可转让）
- 不承诺任何收益

**依据**：银发〔2026〕42 号（2026-02-06，中国人民银行等八部门）明确虚拟货币相关业务活动属非法金融活动。本实现将业务形态限定为「验收结论存证」，规避资金流转环节。

**仍需注意**：凭证铸造是否构成代币发行需专业法律意见。本项目为技术可行性验证，不构成法律意见。

---

## 与原方案的差异清单

| 项目 | 原方案 | 本实现 | 原因 |
|---|---|---|---|
| 资金托管 | L2 合约托管 USDC/USDT | **不做** | 合规红线 |
| 差异化 | 自建合约 | 验收规则引擎 | ERC-8183 已标准化 |
| 凭证 | ZK-SNARK + SBT | 哈希承诺 + 事实报告 | ZK 电路成本不可承受 |
| 规则 | 甲方自定义 | 模板库 + 双签锁定 | 防甲方设卡 |
| 验收 | Chainlink 预言机 | 独立采集器 + 硬门槛 | 预言机只保证传递不保证真实 |
| 争议 | DAO 全体投票 | 独立仲裁者 + 3 天挑战期 | DAO 有冷启动问题 |
| 评估器 | **未定义** | 合约级独立角色 | 原方案缺失的关键模块 |

---

*本项目为技术可行性验证实现，不构成法律意见。涉及跨境资金与代币化的合规判断，请咨询目标法域持牌律师。*

---

## 支付版（v2）：真实资金托管 · 代币转账

> 用户明确要求取消合规限制，实现真实的代币托管、转账与支付。

### 新增合约

| 合约 | 说明 |
|---|---|
| `MilestonePaymentEscrow.sol` | 资金托管 + 状态机。注资、按里程碑锁定、放款、退款、争议按比例分配、紧急暂停 |
| `MockToken.sol` | 测试用 ERC-20（含 `mint`），无真实价值 |

### 资金流转路径

```
createProject → fundProject(甲方注资) → 双签 → 项目转 Active
     ↓
每个里程碑：submit → 评估器判定 → Passed（挑战期3天） → releaseMilestone → 放款
                                        → Failed → refundMilestone → 退款甲方
                                        → Challenged → 仲裁者按 0-100% 裁定
     ↓
全部里程碑结算完毕 → 项目 Completed（或甲方 cancelProject → 剩余全退）
```

### 三条资金安全硬规则

1. **合约内无任何 owner 提款函数**（测试检查 ABI 确认无 `withdraw`/`sweep`/`rescue`）
2. **每个里程碑金额独立锁定**，不可挪用；总额校验 `sum(amounts) == totalAmount`
3. **争议分配比例之和恒等于 100%**，精度残差归甲方

### 开发中修复的真实缺陷

| 缺陷 | 后果 | 修复 |
|---|---|---|
| `signRule` 只发事件不改状态 | 注资后项目永不转 `Active`，所有提交被拒 | 新增 `_maybeActivate()`，注资 + 双签同时满足才激活 |
| `_tokenBalance` 用 `projects[0]` | 多代币场景取错余额 | 改用 `p.token.balanceOf()` 直接查询 |
| MockToken `decimals` public 与函数同名 | 编译失败 | 改为 private `_decimals` |
| 模板分数线贴着门槛 | 「硬门槛全过但分数不够」成为不可达死代码 | 新增 `balanced-4d-v1`（门槛 70% / 分数线 85） |
| 前端 `score` 算法用 `Math.round(weighted+50)/100` | 全 0 算出 1 分、全 10000 算出 101 分，与合约偏差 1 | 改为 `Math.floor((weighted+50)/100)`，与合约整数除法一致 |
| `onTplChange()` 从 DOM 读回值 | 程序改 `S.tpl` 被旧 DOM 值覆盖，切换模板状态错乱 | 改为 `onTplChange(value)`，传入值优先 |
| `settle(kind, ratio)` 忽略第二参数 | 争议比例只能靠滑块，API 不一致 | 支持传参 + 边界钳制 + 滑块回写 |
| `reset()` 未重渲染 `#audit` | 重置后面板残留上次结果 | reset 中显式清空并调 `audit()` |

### 测试规模

| 层次 | 数量 | 覆盖 |
|---|---|---|
| 合约（资金） | 35 | 资金守恒、部分分配、重复提款、暂停、权限 |
| 合约（存证） | 39 | 硬门槛、挑战期、凭证、访问控制 |
| 前端引擎 | 23 | 判定逻辑，含与合约输出的交叉校验 |
| UI 集成（jsdom） | 34 | DOM 渲染、步骤流转、结算、模板切换 |
| **合计** | **131** | 全部通过 |

### 运行

```bash
cd contracts
npx hardhat test                                    # 74 passing
npx hardhat run scripts/deploy-payment.js           # 本地链部署
npx hardhat run scripts/demo-payment.js             # 资金流转端到端演示

cd ../
node web/test/engine.test.js                        # 23 passing
node web/test/ui.test.js                            # 34 passing
```

### 部署到 Polygon Amoy 测试网

```bash
# 1. 领测试币（当前部署者余额为 0）
#    https://faucet.polygon.technology/

# 2. 配置私钥到 contracts/.env（已在 .gitignore 中）
#    PRIVATE_KEY=0x...

# 3. 部署
cd contracts && npx hardhat run scripts/deploy-payment.js --network amoy
```

部署者地址：`0x2b0ECb4FFbCDbaA63E7F1f10c55bf2FF41F7D41E`（**当前 Amoy 余额为 0，需先领测试币**）

> 安全提醒：该私钥已在对话中暴露。若对应地址在主网或其他网络有资产，应立即转移并更换。

### 前端

`web/index.html` — 四步引导式工作台（选规则 → 配项目 → 看验收 → 结算），
零依赖可直接打开。判定引擎 `web/assets/engine.js` 与合约逻辑一一对应，
改动任一侧必须同步另一侧并跑测试。

---

## v3：Monad 测试网真实部署（已完成）

### 部署地址

| 项目 | 地址 |
|---|---|
| 网络 | Monad 测试网（chainId 10143）· https://testnet.monadscan.com |
| MockToken | `0x353d417Bdb668A11E90cEE93A70e9a185B6FA012` |
| MilestonePaymentEscrow | `0x32B3CCeEDBd5ce76B0ED283C9Da6210cDbB5472f` |
| DeterministicEvaluator | `0xc725998b616fe19454979891Bd06bB7943d23D44` |
| ArbitratorBot | `0xa0fb2D1274EeDe8CB4e9BC92b51481D69592b558` |

角色：**甲方 = 账户一** `0x2b0E...41E`　**乙方 = 账户二** `0x1Ee0...31f`　**仲裁者 = ArbitratorBot 合约**

### 链上实测结果

| 环节 | 结果 |
|---|---|
| 注资 100 TUSD | ✓ 资金进入托管 |
| 甲乙双签 | ✓ 两个独立签名身份，项目转 `Active` |
| M0 验收 97 分 | ✓ 通过（挑战期 3 天，真实时间） |
| 争议裁定 | ✓ ArbitratorBot 按**链上预设 30%** 分配，乙方实收 6/20 |
| M1 得分 90 但门槛未过 | ✗ 不通过 → 退款 30 全额 |
| 取消项目 | ✓ 剩余资金全退 |
| 资金对账 | ✓ 放款 6 + 退款 94 + 未结算 0 = 100，合约余额归零 |

### Monad 特有的三个坑

1. **必须显式管理 nonce** —— 同一地址连续发交易会因乐观并行执行冲突。脚本中用 `getTransactionCount(addr,"pending")` 后传 `{nonce}`
2. **新充值账户需等约 1.2 秒**状态同步（共识与执行解耦）
3. **EOA 有 10 MON 余额下限**

测试币领取（无需注册）：
```bash
curl -s -X POST https://agents.devnads.com/v1/faucet \
  -H "content-type: application/json" \
  -d '{"chainId":10143,"address":"0x..."}'
```

### 本轮修复的安全漏洞

**① 资金归属漏洞（严重）**

`cancelProject` 曾用 `token.balanceOf(address(this))` 作为 leftover —— 那是**合约全局余额**，包含其他项目的托管资金，却转给本项目甲方并记入其 `refundedAmount`。

后果：**甲方取消自己的项目，即可顺走其他项目的资金。**

修复：leftover 只退本项目的记账差额；异常时 emit `EscrowAccountingAnomaly`。已加双项目回归测试验证。

**② 缺少重入锁**

引入 ArbitratorBot 合约间回调后攻击面变化，四个资金函数全部加 `whenNotReentrant`。

**③ `getPayoutSummary` 算术下溢**

`totalAmount - released - refunded` 在 refunded 超额时 revert，改为饱和运算。

### 测试规模

合约 77 + 前端引擎 23 + UI 集成 34 = **134 个测试全通过**

```bash
cd contracts
npx hardhat test                                          # 77
npx hardhat run scripts/deploy-payment.js --network monad   # 部署
npx hardhat run scripts/demo-onchain.js --network monad     # 链上全流程
```

> 两把私钥均已在对话中暴露，仅用于测试。若对应地址在主网或其他链有资产，请立即转移。
