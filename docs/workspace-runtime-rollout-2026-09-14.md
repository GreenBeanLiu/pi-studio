# 工作区解析发布与 Mac 恢复实测

验收时间：2026-09-14 07:18 至 07:21，Asia/Shanghai。

## 已发布版本

- Runtime 从 `d29713f` 更新至 `94d0ddd`，包含工作区解析收敛提交 `7fbf46c`。
- Engine 保持 `f253331`；手机和 Mac 本轮均未重装。
- 使用 `activate-native-release.sh`：空闲队列检查、数据库备份、旧版本 wheel 备份、安装新包和双服务健康检查均完成。
- 已确认新解析模块从服务虚拟环境的 `site-packages/personal_harness/workspace_resolution.py` 导入，非仅切换 release 软链。
- 回滚备份：`/home/ubuntu/personal-harness/shared/native-rollout-20260913T231831Z-94d0ddd`。
- 最终 API / Worker 均为 active/running，自动重启计数均为 0。恢复实验后的正式 Worker PID 为 `3065723`。

回滚沿用版本脚本：

```bash
bash /home/ubuntu/personal-harness/releases/94d0ddd/scripts/activate-native-release.sh rollback /home/ubuntu/personal-harness/shared/native-rollout-20260913T231831Z-94d0ddd
```

脚本恢复旧包、软链及配置，不覆盖本轮之后的业务数据库。

## 实际设备与请求

Mac `GlangerdeMacBook-Air.local` 实时能力握手成功，声明 `local.list` schema v1 和工具协议 v2。
设备为 `pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320`。Windows 在本轮查询时离线。
设备列表的历史 `last_seen_at` 与 online 状态不一致，因此以实际握手和工具响应作为在线证据。

两条任务均通过公网 `POST /harness/providers/pi-studio/commands` 提交：

- `workspace_id=ws_6d93f9513759492d9d4d819451eaef4f`，请求不带 `workspace` 路径。
- `agent_target=personal-agent-engine`、`tool_target` 指定上述 Mac、`execution_mode=native-tools`。
- `risk=read_only`；要求只调用一次 `local_list`，路径 `.`、最多 3 项、不递归。

Runtime 将注册路径 `/Users/glanger/Works/pi-e2e-local-list.hHcH8i` 写入任务、工具参数与 scope；
scope 同时保留原 `workspace_id`。没有切换 Mac 当前工作区，没有文件写入、删除或 Shell 执行。

## 任务证据

| 项目 | 普通完整链路 | 执行进程退出后接续 |
| --- | --- | --- |
| task ID | `task_1715a952bad64be98af384d694f4e30d` | `task_4d9ae396933d4215b3d3a157d9198649` |
| run ID | `run_9b8449636c3b4979810339ff04be5c0a` | `run_debba266bb9742539c15a2c044e106f0` |
| operation ID | `toolop_37aa00c24c7047a0b782452c776e113e` | `toolop_bdaebb5b70c0495186379b1b08e207e1` |
| 终态 | complete | complete |
| 本地工具操作 | 1 次 completed，v2 local.list | 1 次 completed，v2 local.list |
| 模型轮数 | 2 | 2 |
| 原生会话调用/结果 | 1 对匹配的 call ID | 1 对匹配的 call ID |
| 循环事件 | 无 | 无 |

两次返回 `alpha.txt`、`bravo.txt`、`folder`，`truncated=true`。证据来自持久化操作记录、事件和
原生会话消息，而非只依赖模型结论。`run.attempt_started` 出现两次代表初始执行与结果续跑，
不能据此判断工具执行两遍。

## 恢复实验过程与边界

1. 确认无运行/等待任务、无 pending/leased 工具操作、执行队列和 routine 队列为空，且 embedded worker 关闭。
2. 暂停独立 `personal-agent-worker.service`，再次检查队列为空，API 保持运行。
3. 通过公网创建只读任务；独立子进程确认队列中只有此任务，然后使用正式安装版本的 `ExecutionWorker.tick()` 执行首轮。
4. 子进程退出后，从 API 确认任务为 `waiting_for_async_tool`。此时模型调用与待执行操作已持久化，尚无工具 Worker 派发。
5. 在 finally 中启动正式 Worker。新进程从数据库接续，向真实 Mac 派发工具，并完成模型续跑。
6. 核对最终只有一个工具操作、一对调用/结果 ID，原生会话记录的 Worker PID 与正式服务 PID 一致。

本次是真实云端模型、生产数据库、正式 Worker 与 Mac 工具的进程退出恢复实验。
退出发生在 checkpoint 提交之后、工具派发之前，是受控正常退出；没有模拟突然断电、Mac 断网、
桌面崩溃或写入完成但回执丢失。上述故障窗口继续按
[恢复验收补充](native-tool-recovery-acceptance-2026-09-13.md) 现场验证。

## 下一步

工作区身份解析与 checkpoint 后的进程接续已有真实证据，可以继续收敛 Runtime 目标解析契约。
物理断网/桌面重启、等待期间取消、deadline 后重新上线仍保留在真实故障验收清单中；
不要因本轮通过而删除这些项目，也不要提前删除 Mobile 的旧字段兼容逻辑。
