# 深海浮标遥测包次序恢复服务

从乱序且时间戳带误差的遥测包中联合恢复**发送次序、跨周绝对计数与整数发送时刻**，
区分真实缺包与计数器轮转，避免把下载顺序误当作采集顺序。

- 运行时零第三方依赖（仅 Node.js 内置 `http`）
- TypeScript 严格模式编译，单元 + 差分（对拍穷举参考实现）测试
- 多阶段 Docker 构建；`docker compose` 一键启动 API 与一次性 `verify` 服务

## 问题模型

输入 6–14 个唯一包，每包给出：

| 字段 | 含义 |
| --- | --- |
| `id` | 调用方指定的唯一编号（字符串或整数） |
| `remainder` | 轮转计数器余数，`0 ≤ remainder < modulus` |
| `timeLower` / `timeUpper` | 真实发送时刻所在的**整数闭区间** |

全局参数：`modulus`（模数/轮转周期）、`countLower`/`countUpper`（绝对计数搜索窗）、
`minInterval`/`maxInterval`（相邻采样间隔上下限）。

服务为每包联合选择：

1. 互不相同、严格递增、落在搜索窗内且与其余数**同余**的绝对计数 `c_i`；
2. 落在各自闭区间内的整数发送时刻 `t_i`；

使复原次序中每对相邻已观测包 `(i, j)` 满足

```
d * minInterval ≤ t_j - t_i ≤ d * maxInterval,   d = c_j - c_i ≥ 1
```

并按以下优先级词典序最小化：

1. 首尾已观测包之间的**缺包数**（`Σd − (n−1)`）；
2. 各选定时刻到区间中点的**总偏差**；
3. 复原的**包编号序列**（字典序；数字按数值、字符串按 UTF-16）。

若搜索窗内不存在任何整体一致的解释，返回稳定业务错误码
`NO_CONSISTENT_INTERPRETATION` 及**首个无法延伸的约束证据**（阶段、部分次序、
候选包、时间/计数允许范围）。

### 低电量休眠模型（可选）

浮标在低电量航段会**暂停采样但保持计数器内容**：恢复供电后首个包的时间戳
包含一段不随计数增长的休眠。若把这段静默误读为缺包，会高估丢包。

请求可同时提供正整数 `dormancyLower` 与 `dormancyUpper`（闭区间），声明本批包
之间**恰有一次**休眠及其时长范围。两字段必须同时给出、为正整数且下界 ≤ 上界，
否则为 `INVALID_REQUEST`。启用后求解器联合选择：

- **唯一一对**相邻已观测包承载休眠，及区间内整数休眠时长 `s`；
- 该对时差约束变为 `d·minInterval + s ≤ t_j − t_i ≤ d·maxInterval + s`，
  其余相邻约束不变（计数不受休眠影响）。

目标仍沿用原三级（缺包数、偏差、编号序列）；完全并列时依次选**较短休眠**与
**较早边界**（休眠所在相邻位置更靠前者）。成功响应在 `data.dormancy` 中返回
休眠时长与两侧包（`boundaryIndex`/`fromId`/`toId`/`fromCount`/`toCount`），
并在承载休眠的相邻证据 `adjacency[k]` 上给出 `dormancy` 子对象（时长与未加休眠的
基准范围），其 `allowedTimeGap` 已包含休眠。整体无解时仍返回
`NO_CONSISTENT_INTERPRETATION`，且首个无法延伸的证据附 `dormancyStatus`：
`unused`（休眠尚未使用）、`crossing`（正在跨越休眠的延伸被拒）、`used`
（休眠已用在更早边界）。未提供两字段时，请求、响应与裁决保持原样。

## HTTP API

### `GET /health`

```json
{ "status": "ok", "service": "buoy-telemetry-recovery", "time": "…" }
```

### `POST /api/v1/recover`

请求体：

```json
{
  "modulus": 10,
  "countLower": 0,
  "countUpper": 120,
  "minInterval": 9,
  "maxInterval": 11,
  "packets": [
    { "id": "A", "remainder": 8, "timeLower": 77, "timeUpper": 83 }
  ]
}
```

可选休眠字段（必须成对出现）：

```json
{
  "dormancyLower": 40,
  "dormancyUpper": 60
}
```

成功（200）：

```json
{
  "status": "ok",
  "data": {
    "order": ["A", "B", "C", "D", "E", "F", "G"],
    "assignments": [
      {
        "position": 0,
        "id": "A",
        "absoluteCount": 8,
        "time": 80,
        "remainder": 8,
        "timeInterval": { "lower": 77, "upper": 83 }
      }
    ],
    "missingSegments": [
      { "fromCount": 10, "toCount": 11, "length": 2 }
    ],
    "missingCountTotal": 17,
    "adjacency": [
      {
        "index": 0,
        "fromId": "A",
        "toId": "B",
        "fromCount": 8,
        "toCount": 9,
        "countGap": 1,
        "fromTime": 80,
        "toTime": 90,
        "timeGap": 10,
        "allowedTimeGap": { "min": 9, "max": 11 },
        "missingBetween": 0,
        "congruence": { "remainder": 9, "modulus": 10 },
        "absoluteCountCongruent": true,
        "timeWithinInterval": { "from": {"lower":77,"upper":83}, "to": {"lower":87,"upper":93} },
        "satisfied": true
      }
    ],
    "observedCountRange": { "first": 8, "last": 31 },
    "dormancy": {
      "duration": 50,
      "boundaryIndex": 3,
      "fromId": "D",
      "toId": "E",
      "fromCount": 21,
      "toCount": 22
    }
  }
}
```

`dormancy` 仅在请求启用休眠模型时出现；承载休眠的相邻证据条目同时带有
`dormancy: { duration, baseAllowedTimeGap }` 子对象。

错误：

| HTTP | error.code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求结构/取值非法 |
| 422 | `NO_CONSISTENT_INTERPRETATION` | 搜索窗内无整体一致解释（附首个阻断约束证据） |

## 算法概述

- **边可行性区间化**：每对包的可行计数差被表达为同余等差数列与三类区间
  （原始时间区间、运行时收紧时间窗、绝对计数搜索窗）的交集，避免逐差枚举。
  休眠模型下另有"承载休眠"的平移变体（时间界上移 `[dormancyLower, dormancyUpper]`）。
- **分支限界**：Held–Karp 预计算经过剩余包集合的最小计数差完成代价，作为主目标
  精确下界内联剪枝；休眠启用时使用"至多一次休眠平移"的松弛下界。相同
  （余数， 区间）的包做对称性破除。
- **三阶段词典序优化**：A 最小化总计数差；B 在主目标最优链上最小化中点偏差；
  C 用记忆化可行性判定贪心固定每一位最小编号。休眠启用时，恰一次休眠由叶级
  检查强制；编号序列（目标 3）横跨所有休眠边界，故逐边界重构字典序最小序列，
  再按（编号序列、休眠时长、边界）合并——完全并列选较短休眠与较早边界。
- **时刻优化**：固定次序与计数差后，这是路径差分约束上的整数 L1 问题；通过
  "枢轴值 × 任意上下限紧约束链"枚举候选值，再以滑动窗口最短路 DP 精确求解，
  并重建字典序最小时刻向量。休眠时长取"偏差最优前提下最短的合法休眠"（对承载边
  做 （偏差， 边差） 词典序 DP 求得）。

## 本地开发

需要 Node.js ≥ 22。

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest：单元测试 + 360 随机对拍穷举参考 + 2000 例时刻DP对拍
npm run build       # 输出 dist/
npm start           # 默认 0.0.0.0:3000
API_PORT=8080 npm start
node scripts/smoke.mjs http://127.0.0.1:8080
```

## Docker

镜像内服务监听容器内端口，容器自带 `HEALTHCHECK`。宿主机端口由宿主侧 `API_PORT`
控制（默认 3000）：

```bash
# 启动 API（宿主机 8080 -> 容器 8080）
API_PORT=8080 docker compose up --build -d api

# 一键校验：等待 API 健康 -> TypeScript 构建 -> 代码测试 -> HTTP 冒烟
# verify 为一次性服务，按自身退出码结束（成功 0 / 失败非 0）
docker compose up --build verify
docker compose ps   # verify 状态为 Exited (0)
```

`verify` 服务通过 `depends_on: condition: service_healthy` 等待 API 健康后执行
`scripts/verify.sh`，其中的跨周含缺包样例即
`tests/fixtures/sample.ts` / `scripts/smoke.mjs` 所用样例；冒烟另用
`tests/fixtures/sample.ts` 中的**低电量休眠样例**（必须经过休眠才可解释）核对
测试、构建与 HTTP 冒烟：带休眠字段应恢复出休眠时长与边界，去掉休眠字段则应为
`NO_CONSISTENT_INTERPRETATION`。
