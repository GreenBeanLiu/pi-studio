# Native Tool 恢复验收补充

2026-09-14 更新：Runtime `94d0ddd` 已部署，Mac 在线且 workspace_id 只读链路通过；
checkpoint 提交后执行进程退出、正式 Worker 接续的真实实验也通过，两条任务各只有一次工具操作。
见 [发布与 Mac 恢复实测](workspace-runtime-rollout-2026-09-14.md)。下文离线状态和版本为历史记录；
物理断网、桌面崩溃与等待期间取消/过期仍待现场验收。

## 发布与验证

- Runtime `22be76e` 已推送 main，并于 2026-09-13 11:51 UTC 激活；Engine 保持 `f253331`，API 和独立 worker 健康。
- Runtime 全量 **490 passed**，含本轮新增 12 项恢复测试；一个已有 Starlette/httpx 弃用提示。
- pi-studio `pnpm run verify` 通过：编码、类型、lint、构建通过，测试 **953 passed / 5 skipped**。
- 真实 Windows smoke：`task_2960495214ce4f50ab464a629e55c7bd`，run `run_8dcc9dc3ef1649528a045a68511ffca6`；一次成功 v2 `local.read`、两轮模型、任务 complete、无循环事件；另外检查了持久化消息中的调用与结果配对。
- 此 smoke 为 `home-win` 的注册工作区 `ws_0909dc0638f746c3b8c82e702a17a875`，不是 Mac 实测。Mac 在本轮库存查询中仍为 offline。
- 回滚目录：`/home/ubuntu/personal-harness/shared/native-rollout-20260913T115103Z-22be76e`。

## 本轮修复

2026-09-13 对 Runtime `54528e6` 做恢复检查时，新增测试复现了两个问题：

- 循环保护停止后，最后一条 assistant 工具调用缺少对应结果；普通假模型接受这种消息，但严格检查调用与结果配对时，重试失败。
- 服务器工具或无效调用插入后，连续本地调用计数没有重置，后续合法调用可能被误拦截。

修复后，阻止执行的调用也会收到 `NATIVE_LOOP_DETECTED`、`executed: false` 的工具结果。重试会保留历史真实结果，补齐旧版停止记录，并清理计数。服务器工具、Skill、无效调用和并行批次会打断串行计数。

阈值表述也已纠正：连续相同调用的第 4 次提议被阻止；连续两次相同失败后，第 3 次调用提议被阻止。被阻止的调用没有执行，不能称为已经发生的第 3 次失败。

## 自动化覆盖

**2026-09-15：矩阵自动化 SoT 已落地。** 跨仓契约见
[Reliability Matrix Contract v1](contracts/reliability-matrix-v1.md)
（Runtime 权威 fixture `tests/fixtures/reliability-matrix-v1.json`，**12** 个稳定
`scenario_id`；映射测试 `tests/test_reliability_matrix_contract.py`）。
以下表格仍为行为说明；物理断网 / 桌面崩溃 / write-then-lost-ack **现场验收仍开放**，
不因契约落地而宣称完成。

Runtime `tests/test_native_tool_recovery_regression.py` 共 12 项测试使用真实会话、SQLite 和两类 worker，模型与网关使用测试替身，时间推进可控；现由 Reliability Matrix v1 以 `scenario_id` 锁定。

| 场景 | 验收结果 |
| --- | --- |
| 新版循环停止后重试 | 调用与结果完整配对，可继续执行 |
| 旧版停止记录重试 | 补齐拒绝结果，不重放已完成操作 |
| 服务器工具、无效调用、并行批次 | 分别验证串行计数重置 |
| 设备离线后重连 | 恢复同一 operation 和幂等键 |
| 传输失败后重连 | 保持等待，恢复后续跑一次 |
| pending / leased 时取消 | 迟到结果不恢复任务，模型不续跑 |
| 离线直到 deadline 到期 | 失败结果只恢复一次，迟到成功不覆盖失败 |
| 完成前后重复回传 | 保留第一次结果，不重复调模型 |
| worker 租约过期被接管 | 旧 worker 的结果不覆盖新 worker |

以上通过不代表真实 Mac 的断网、退出进程和休眠场景已经验收。

## Mac 下一轮操作

沿用 [Mac 云端 Agent E2E](mac-cloud-agent-e2e.md) 的隔离工作区和任务证据格式；每个场景记录 task ID、operation ID、终态及实际调用次数。

1. Mac 恢复在线，选择云端 Agent、Mac 本地工具和已注册工作区。先验证一次 `local.list` 成功，确认只有一次 operation。
2. 在已有工具等待期间断开网络，再在 deadline 前恢复。验证同一个 operation 继续执行，任务最终收尾。首轮能力握手前离线会直接报错，不属于此场景。
3. 等待期间取消任务，再恢复网络。任务应保持 cancelled，迟到结果不得再次启动模型。
4. 等待超过 deadline。应产生 `tool.expired`，模型拿到失败结果；后续上线不得执行已经到期的操作。
5. 执行期间关闭并重新启动桌面端。先用只读任务验证恢复；写入后、结果回传前崩溃仍无持久化执行回执，不能宣称副作用只发生一次。

上述等待窗口较短时，需要测试网关控制派发时机才能稳定复现；不要把未命中故障窗口的一次普通完成记为断线恢复通过。

本轮修复位于云端 Runtime，手机和 Mac 不需要为这两项修复重新安装。设备缺少 `local.list` 能力声明时，仍需更新相应桌面版本。
