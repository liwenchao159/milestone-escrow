# 接口交付物参考样例 · 汇率换算服务

一个**最小但完整**的接口交付物，用来演示「什么样的交付物能被客观验收」。

## 快速开始

```bash
cd samples/sample-api

# 本地跑测试
node test/run-tests.js                    # 全部 15 条
node test/run-tests.js --suite=required   # 仅必测组 12 条

# 本地起服务（需要平台注入运行时，见下）
node src/server.js
```

## 让验收平台跑一遍

```bash
cd milestone-escrow
node -e "
const path=require('path');
const {runAcceptance}=require('./acceptance-demo/harness/acceptance-harness-v2.js');
const root=path.resolve('.');
runAcceptance(
  path.join(root,'samples','sample-api'),
  path.join(root,'samples','sample-api','acceptance-spec.json'),
  'sample-fx'
);"
```

## 目录结构

```
sample-api/
├── acceptance-spec.json    ← 验收规格（签约时锁定，哈希上链）
├── package.json
├── src/
│   ├── fx.js               ← 纯计算逻辑（无 IO，易写必测用例）
│   ├── server.js           ← HTTP 接口（依赖 DB 与缓存）
│   └── runtime-bridge.js   ← 运行时桥接（照平台约定写）
└── test/
    └── run-tests.js        ← 输出机器可读 JSON 报告
```

## 交付物该长什么样

### 1. 入口约定

| 项 | 值 | 说明 |
|---|---|---|
| 纯逻辑入口 | `src/fx.js` | 供单元测试直接 require |
| 服务入口 | `src/server.js` | 验收平台用 `node src/server.js` 拉起 |
| 监听地址 | `127.0.0.1:$PORT` | 端口由平台通过环境变量注入 |
| 就绪信号 | `GET /health` 返回 200 | 平台轮询这个端点判断是否 ready |

### 2. 测试报告必须机器可读

关键：`stdout` 要输出 JSON，验收平台直接解析它提取通过率。

```json
{
  "total": 12,
  "passed": 12,
  "failed": 0,
  "passRate": 10000,
  "cases": [
    { "name": "用例名", "group": "required", "status": "passed", "ms": 0 }
  ]
}
```

**`passRate` 用万分比**（10000 = 100%），与链上判定一致。

### 3. 分组：必测组 vs 自测组

```js
{ name: '...', group: 'required', fn: ... }   // 必测，验收平台只跑这些
{ name: '...', group: 'extra',   fn: ... }   // 自测，不计入验收
```

平台执行的是**规格里指定的命令**（`--suite=required`），乙方无法更改。

### 4. 依赖数据库怎么办

不直接连数据库，而是通过 `runtime-bridge.js`：

```js
const { db, cache } = require('./runtime-bridge');
const row = await db.one('SELECT rate FROM fx_rates WHERE base = $1', ['USD']);
```

平台在验收时注入隔离运行时（每个项目独立一份 PG + KV），生产环境把 bridge 换成真 `pg` / `ioredis` 即可，**交付物代码零改动**。

占位符必须用 `$1` 不是 `?`。

---

## ⚠️ 本样例故意留了两个缺陷

用来看验收平台怎么抓问题。

### 缺陷 1：状态码错误

`src/server.js` 里，无汇率数据时返回 200 而非 404：

```js
if (!r) {
  // ⚠️ 应为 404
  return json(res, 200, { base });   // 字段也不全
}
```

**验证方式** —— 在 `acceptance-spec.json` 的 `probe.targets` 加入：

```json
{ "path": "/rates/JPY", "method": "GET", "expectStatus": [404] }
```

平台实测结果：

```
可用率   : 83.33%（30 次探测，25 次成功）
覆盖率   : 90.00%（/rates/JPY 无响应）
结论     : ✗ 验收不通过
  硬门槛未过 — 接口可用率，当前 83.33，需要 95
```

### 缺陷 2：缺少入参预校验

`POST /quote` 没有预校验 `amount` 是否为正，负数要走到业务逻辑深处才报错。

这类问题**平台测不出来** —— 需要人工评审或更细的用例。

---

## 这个样例想说明什么

| 能自动测出 | 测不出（需人工） |
|---|---|
| 计算逻辑错误 | 代码是否优雅、可维护性 |
| 状态码不符 | 架构是否合理 |
| 响应字段缺失 | 有无隐藏后门 |
| 接口不可达 | 需求理解是否到位 |
| 必测用例被删减 | — |

**前提：验收规格必须写全。** 平台只测清单里的东西。规格漏了，平台就测不到 —— 这不是平台的缺陷，而是双方签约时的责任。
