# 工作区身份解析收敛

日期：2026-09-14。范围：`personal-agent-runtime` 的任务入口与路由器。

发布更新：Runtime `94d0ddd` 已于当日 07:18（Asia/Shanghai）部署，Mac 的 workspace_id 完整链路
与 checkpoint 后执行进程退出接续均实测通过，见 [发布与恢复实测](workspace-runtime-rollout-2026-09-14.md)。
下文“本轮未部署/未重跑”描述代码实现阶段的验证边界。

## 问题与职责

此前 HTTP 入口检查工作区是否注册、repository 是否一致，路由器另外查询注册记录并解析设备路径。
规则分散导致非 HTTP 入口缺少 repository 冲突检查，修改解析规则也需要同时维护两处。

本轮增加 `src/personal_harness/workspace_resolution.py`，以一个 `resolve_task_workspace` 函数统一规则。
依赖是查询注册工作区的 callable，可以接真实仓储，也可以在测试中提供内存记录；模块不依赖 HTTP、
数据库连接或具体执行器。

| 字段 / 职责 | 含义 / 所属位置 |
| --- | --- |
| `workspace_id` | 跨设备的稳定工作区身份 |
| `WorkspaceBinding.executor_id` | 路径所属设备 |
| `WorkspaceBinding.local_path` | 该设备上的注册路径 |
| `TaskSpec.workspace` | 解析后的设备路径，兼容旧客户端 |
| `metadata.tool_transport.workspace` | 本地工具执行所需的同一设备路径 |
| API | 调用解析模块校验身份，把解析错误映射为 HTTP 422 |
| RoutingExecutor | 选择设备后调用解析模块绑定路径；审批前准备任务也复用此规则 |
| TaskStore | 继续维护注册记录和既有原子事务 |

## 行为约束

1. 只有 `workspace_id` 时，入口补齐 repository，但不自行选取任何设备路径。
2. 选定 executor 后必须存在其 binding，不能使用另一台设备的路径作为回退。
3. repository 冲突在入口和执行前均拒绝，沿用现有精确字符串比较规则。
4. 已绑定的 `task.workspace` 与注册路径不一致时拒绝。审批或异步等待期间更改注册路径不会静默迁移任务。
5. Windows 与 Mac 路径按设备原值保留，不调用服务器上的路径规范化函数。
6. 返回新任务及必要的 metadata 副本，原始意图不被原地修改。
7. 无 `workspace_id` 的旧路径型任务直接通过，不要求访问 Workspace Registry。

工具运输的旧路径镜像仍由注册 binding 填充；本轮没有变更跨端请求字段或迁移数据库。
显式改派工具操作仍由 TaskStore 的既有事务处理，本模块不替代该事务。

## 验证与后续

新增跨设备路径解析、身份阶段不选路径、repository 冲突、缺失记录或设备绑定、路径漂移、
输入不可变及旧路径兼容测试；增加绕过 HTTP 入口的路由冲突回归。
已有原生工具审批复用和注册路径变更回归继续覆盖持久化后的执行流程。

Runtime 全量验证：**505 passed**，保留一个既有 Starlette/httpx 弃用警告。Windows 本地复现需
使用项目 `.venv/Scripts/python.exe`，设置 `PYTHONUTF8=1`、`PYTHONPATH=src` 后运行 `-m pytest -q`。

合入远端 Runtime `d29713f` 的沙箱网关与流程进度更新后，组合版本全量 **515 passed**。
其中补正了新引入的网关测试对本机 `DEEPSEEK_BASE_URL` 的依赖，分别覆盖未设置与已设置地址；
生产逻辑未因此修改。桌面合入 `d4b7c5f` 后完整 `pnpm run verify` 通过：**955 passed，5 skipped**，
编码检查、类型检查、lint 和构建通过。

真实 Mac / Windows 断线恢复没有在本轮重跑；代码推送也不代表生产 Runtime 已更新。
下一步在部署并验证本轮 Runtime 后，记录以 `workspace_id` 发起任务的实际设备、解析路径、
operation ID 和恢复结果，再推进目标解析契约。Mobile 兼容字段的删除应等待跨端契约验证完成。

## 契约锁定（Slice E 首切）

2026-09-15：词汇与跨设备同仓不同路径行为已写入
[Workspace Identity v1](contracts/workspace-identity-v1.md)，并由 Runtime fixture/测试钉死。
展示消歧仍为可选后续 UI 工作。
