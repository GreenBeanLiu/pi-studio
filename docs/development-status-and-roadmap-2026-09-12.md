# Pi Studio 开发现状与后续路线

> 核查时间：2026-09-13 00:20，Asia/Shanghai。
> 范围：桌面、手机、设备后端、任务 Runtime、Agent Engine、Cloudflare Provider 六个仓库。
> 本文先记录状态核查和开发规划，随后执行了 M0 基线整合、P0 修复、生产发布和真实跨端 E2E。
> 本文把本地代码、已安装桌面、生产 Runtime/Engine 和真实任务证据分开记录。

## 1. 结论

### 2026-09-13 后续进展（优先于下文历史快照）

- Runtime follow-up `54528e6` 已部署，新增持久化 native Agent 重复调用保护：相同成功调用第 4 次前停止，相同失败达到阈值停止，显式重试清理 guard；Runtime 全量 **478 passed**。恢复矩阵见 [Runtime recovery matrix](../../personal-agent-runtime/docs/native-tool-recovery-matrix-2026-09-13.md)。
- 发布后 Mac smoke 正确在能力握手前失败，因为当前 Mac 设备离线，未创建 tool operation；在线 Windows 用旧能力面完成真实 `local.read` smoke，一次 v2 operation、一次续跑、任务完成、无 `native.loop_detected`。Windows 未声明 `local.list` schema v1，Runtime 正确排除而没有猜测或下发。

- 用户已反馈 Mac E2E 验收通过；本次未附逐项 task ID，证据等级为用户实测确认。操作手册见 [Mac E2E](mac-cloud-agent-e2e.md)。
- Runtime 远端已推进到 `5a3d6b8` 并部署，新增控制面 Skill 库、`repo-survey` / `code-review`、加载事件和效果聚合；这些能力不再列为整体待建设。
- 本轮继续实现模型调用前的设备工具筛选，保留上述 Skill 工作。任务工具、设备支持和权限共同决定模型可用工具；能力快照进入 checkpoint 和 `tool.surface` 事件，下发仍实时检查。
- 组合版本 Runtime `d2c6146` 已部署，保留线上 Engine `f253331`；Runtime 全量 **475 passed**。新增 Mac 只读 smoke `task_011675a5752b44fa9037eaa1d8826e38` 已完成：一个子任务、两轮模型、一次 v2 `local.list`、返回两项且 `truncated=true`。此 smoke 使用绝对路径绑定，未覆盖 workspace_id 入口。
- 显式重试或改派设备会重新握手。首轮握手失败提前报错，无工具操作产生；已经创建的操作保留离线等待与到期机制。手机默认入口尚未提供逐工具“必需”选择，Runtime 支持 `required_tools` 声明。
- 下一步补断线/取消/恢复的真实跨端矩阵和可复现评测；同时等待 Mac 恢复在线后重跑 `local.list` happy path。不启动新的框架迁移。发布证据见 [Runtime 发布记录](../../personal-agent-runtime/docs/tool-projection-rollout-2026-09-13.md)。

下文中的“Mac 待更新/待验收”和旧部署 SHA 属于当时记录，请以上述新进展及后续发布记录为准。

架构方向已成立，当前不是从零实现云端 Agent，而是进入跨端整合和可靠性收尾阶段。

其他开发已经完成 Workspace Registry、Agent/Tool 双目标、Run 增量事件，以及 ToolOperation v2 核心契约。不能再把这些整体列为待开发，也不应重写一套平行实现。

**下一阶段优先顺序：设备能力筛选与 Skill 组合版本验收 -> 重复调用及恢复矩阵 -> 发布清单与回滚门禁 -> 再评估受控 Shell。**

本轮确认了三个直接影响现有流程的问题：

1. `workspace_id` 写任务完成第一次工具调用后会重复索要审批，已隔离复现。
2. 离线设备的工具操作超过 deadline 后仍停在 pending，任务继续等待，已隔离复现。
3. 远端手机版缺少本地分支已有的 `waiting_for_async_tool` 状态处理，源码路径显示它会停止任务详情轮询。

前两项已经在本地修复并有回归测试；Windows 单设备 v2 写任务已经完成生产验收，但跨平台、离线过期、手机等待态和任意 Shell/MCP 仍不能据此宣布完成。

### 本轮执行结果（2026-09-12）

- Runtime 已发布 `297e46e`，并保留本地结构化工具错误码；新增 workspace 绑定持久化、离线 deadline 回收和 bounded `local.list`。
- Engine 已同步到 `origin/main@45a5ae2`；补上 Windows Code Mode 的本机 IPC 和解释器路径处理。
- Backend 已同步到 `origin/main@d6a0d24`；移动端和 Hatchet worker 均完成验证。
- Mobile 当前本地 `97f4fff` 已包含 `waiting_for_async_tool` 和 run event cursor 增量读取，未用远端旧 UI 覆盖本地修复。
- Cloudflare Provider 保留本地多上游/provider health 契约；远端单路由重写未直接合并，待消费者契约核对后单独迁移。

本轮验证：Runtime **441 passed**（含 `local.list` schema、路由和参数边界回归）；Engine **65 passed**；Backend Python **112 passed**；Backend worker **36 passed**；Mobile **154 passed**；桌面 **953 passed，5 skipped**，类型检查、lint 和构建通过。另有一次真实生产 smoke 通过，见第 2.2 节。
- 已完成一次生产发布：Runtime `297e46e`、Engine `0cdd839`；桌面 `be68c3b` 已推送但 Mac 尚待更新安装；生产模式为 `native-tools`。
- 真实 smoke `task_f7b9373388fc4eddaed3649149b2d020` 通过：一次审批、4 轮模型、3 次网关操作、服务器工具与桌面文件读写均执行，精确回读成功。
- 生产 run event 接口实测返回 `run_id=run_fd837a5d5fca41068ee88642e50d08d9`、`next_cursor=5`、`has_more=true`；手机端已按该契约增量合并并按旧 Runtime 回退。

## 2. 仓库与部署基线

### 2.1 本地与远端不是同一套代码

| 仓库 | 本地 HEAD | 本次抓取的远端 HEAD | 核查结论 |
| --- | --- | --- | --- |
| `pi-studio` | `be68c3b` | `origin/master@be68c3b` | 已推送；包含 bounded `local.list`、工作区库存、v2 能力声明和 Windows scope 路径规范化；Mac 尚待更新安装 |
| `personal-agent-runtime` | `297e46e` | `origin/main@297e46e` | 已部署；修复 workspace 绑定、离线过期、v2 能力握手并发布 `local.list` |
| `personal-agent-engine` | `0cdd839` | `origin/main@45a5ae2` | 已同步远端；Code Mode 已兼容 Windows |
| `pi-studio-backend` | `d6a0d24` | `origin/main@d6a0d24` | 已同步远端并通过 Python/worker 验证 |
| `pi-studio-mobile` | `97f4fff` | `origin/master@bd014f9` | 已分叉；本地保留异步工具等待态，并接入 Runtime run event cursor 增量读取 |
| `pi-cf-agent-provider` | `4f15972` | `origin/main@d3adc89` | 暂未合并；远端简化了上游路由，本地还有 provider 契约与 tool payload 透传声明 |

Runtime 本轮已提交并保留的文件包括：

- `docs/native-tool-transport.md`
- `src/personal_harness/executors/pi_studio.py`
- `src/personal_harness/tool_transport.py`
- `src/personal_harness/worker.py`
- `tests/test_worker.py`
- `tests/test_pi_studio_remote_executor.py`。

这些改动的功能是保留 `WORKSPACE_MISMATCH`、`EEXIST`、`ENOENT` 等错误码，并与远端 `ExecutionFailure` 分类协作。作者归属不作为判断完成度的依据。

### 2.2 服务器版本与真实验收

对 `trailai-cn` 的只读核查结果：

| 项目 | 实测结果 |
| --- | --- |
| Runtime 发布目录 | `/home/ubuntu/personal-harness/releases/297e46e` |
| Engine 发布目录 | `/home/ubuntu/deepseek-harness/releases/0cdd839` |
| Runtime 实际安装包 | 已由原子激活脚本安装，`personal_harness.executors.native_tools` 和 Engine bridge import 均验证 |
| API / Worker | 两个服务均 active，健康检查返回生产数据库；激活前数据库无 running/waiting/queued/tool pending |
| 默认与审批 | `native-tools`、`write_requires_approval`、独立 Worker |
| 版本环境变量 | Runtime `personal-agent-runtime@297e46e` / Engine `personal-agent-engine@0cdd839`，与发布目录一致 |
| 数据库迁移 | 已有 Workspace 表、Run event 信封字段和 ToolOperation v2 字段 |
| 生产 smoke | `task_f7b9373388fc4eddaed3649149b2d020`；一次审批、4 turns、3 gateway operations、精确文件复制 |
| 生产执行进程 | Worker PID `1918017` 与任务 checkpoint 身份匹配 |

结论：新版 Runtime 已上线，桌面 `be68c3b` 已推送且本地构建通过；当前生产只完成既有 Windows v2 smoke，Mac 必须更新客户端后才能验收 `local.list`，因此不把本轮代码上线误记为 Mac 真实闭环。

先前的 v1 生产验收仍有价值，但不能替代新 `workspace_id`、双目标和 v2 入口的验收。旧部署记录见 `personal-agent-runtime/docs/production-native-rollout-2026-09-12.md`，阅读时注意其中的历史版本与当前实测不同。

## 3. 已完成的工作

| 能力 | 当前落点与证据 | 不应过度解读为 |
| --- | --- | --- |
| 云端模型、本地文件工具 | Runtime `NativeToolExecutor` + Engine `dsh.tool_turn` + 桌面 `local.list/read/write`；保留 transcript 和原始 tool call ID | 任意桌面工具均可在 native 模式下使用 |
| Workspace Registry | Runtime `a572929`；桌面 `4306d51` 上报库存；手机 `b160798` 选择已注册工作区 | 云端 clone/worktree 已创建，或同仓库不同工作副本已经隔离 |
| Agent / Tool 双目标 | Runtime `cb417cc`、手机 `3c98a4e`；兼容旧 `execution_target` | 旧字段已可删除，或跨端每条提交路径都经过真实验收 |
| Run 增量事件 | Runtime `9c6d7b5`、手机 `3dcad8d`；稳定 task run_id、连续 seq、snapshot + cursor、旧事件回填 | Chat 与 Runtime 已共用完整会话历史；当前 task 重试仍复用 run_id |
| ToolOperation v2 | Runtime `586f806`、桌面 `aa718a2`；scope、deadline、幂等键、审计信息、v1 兼容 | 设备副作用 exactly-once、签名授权、离线 deadline 全覆盖 |
| 能力证据和路由 | claimed/assumed 分离；失败分类；默认偏好与净失败降级；设备 ACK 与结束事件兼容 | assumed 能力已被逐项验证，或成功一次就永远可用 |
| 手机体验 | 工作流图文输入、审核键盘处理、结论 Markdown、双目标选择、事件增量读取 | 异步工具等待页已经完整，或手机无需在线桌面就能写任意仓库 |
| Relay 恢复 | 后端 `d6a0d24` + 手机 `bc79457`；广播序号与有界内存 backlog | 持久事件库；服务重启、长时间离线仍需权威快照恢复 |
| Engine / Provider 兼容 | 空回复重试、模型配置调整、developer 角色归一、上游超时和取消处理 | Runtime 的模型流量已经统一经过 Cloudflare；provider 自己拥有任务状态 |

现有手机提案 `pi-studio-mobile/docs/EXECUTION_DECOUPLING_ARCHITECTURE.md@bd014f9` 可继续作为领域设计依据，但其中第 8、12 节仍有旧“缺口/先做三件事”的描述。应按实际代码更新状态，不要照着旧清单重复建设。

## 4. 验证结果与当前缺口

### 4.1 已运行的验证

- Runtime 当前组合：**441 passed**，有 1 条现存 Starlette/httpx 弃用警告。
- Engine 当前组合：**65 passed**；Windows Code Mode 通过本机 IPC 回归。
- Backend Python：**112 passed**，有 1 条现存 Starlette/httpx 弃用警告；Hatchet worker：**36 passed**，typecheck 通过。
- Mobile：**154 passed**，typecheck 通过。
- 桌面当前组合：**953 passed，5 skipped**；scope 规范化、`local.list` 回归、typecheck、lint 和 production build 均通过；Mac 新包尚未安装。
- 生产 smoke 已连接真实桌面和真实 API/Worker，创建并完成任务 `task_f7b9373388fc4eddaed3649149b2d020`；成本 `$0.001241232`，未发生第二次审批。
- Engine/Backend/Mobile/CF Provider 仍以本地测试结果为准；CF Provider 未完成分叉合并。

### 4.1.1 本轮新增：bounded `local.list`

Runtime、桌面端和 ToolTransport v2 已增加只读目录枚举工具：

- 只允许当前已绑定工作区及其相对目录，不递归，不跟随符号链接。
- 默认最多返回 100 项，硬上限 200 项；结果稳定排序并返回条目类型和 `truncated`。
- Runtime 对工具 schema、参数类型和范围做校验；非法 `limit` 不会创建网关操作。
- 桌面能力清单报告 `local.list`、`scopeVersion` 和 `maxEntries`；Windows 本地回归已覆盖根目录、嵌套目录和符号链接拒绝。
- 生产 Mac 真实 E2E 尚未执行：需要先让在线 Mac 安装包含该能力清单的桌面版本，再验证云端模型实际调用 `local.list` 并继续后续工具轮次。

### 4.2 P0：Registry 绑定与审批快照不一致

依据：Runtime `providers.py`、`executors/routing.py::_bind_workspace`、`store.py::_native_continuation_approved`。

手机只传 `workspace_id` 时，持久 TaskSpec 的 `tool_transport.workspace` 为 null。路由时才把路径解析到临时 ExecutionRequest；native checkpoint 保存解析后的 binding。同一尝试继续执行时，已消费审批的校验要求 checkpoint binding 等于持久 task binding，因此无法复用审批。

实测：批准一次 -> 模型发起一次 local.read -> 工具完成 -> 再次执行后状态为 `needs_approval`，模型仅调用 1 次，审批请求已经出现 2 次。

处理：在申请审批前由 router 解析并持久化不可变的本次执行绑定，审批和 native checkpoint 使用同一份 TaskSpec；绑定解析失败会使任务进入明确的 failed，而不是重复等待。必须明确绑定版本，并校验设备、实际目录、工具集合。不能通过删除绑定比较来“修复”重复审批。

验收：已通过隔离回归：workspace_id 写任务跨工具等待只批准一次；审批后改工作区绑定会失败，不会改写到新目录。显式 retry 仍需补真实设备验收。

### 4.3 P0：离线工具不会按 deadline 结束等待

依据：Runtime `worker.py::ToolOperationWorker.tick` 先跳过 offline target；`store.py` 的过期清理只在 `claim_tool_operations` 中执行。

实测：创建已过期的 v2 local.read，绑定 offline target，tick 后 `worked=false`、operation=pending、task=`waiting_for_async_tool`、`tool.expired` 数量为 0。

处理：将过期回收从在线设备 claim 路径独立出来，由 ToolOperationWorker 每次 tick 先执行；库存查询失败、设备完全不在目录中、所有网关离线时也能运行；最后一条工具进入终态后原子恢复任务。

验收：已通过离线目标回归：不靠设备上线即可写入过期事件、恢复任务入队。重复清理和迟到结果仍需放入真实 E2E 矩阵。

### 4.4 P0：手机分叉遗漏异步工具等待态

依据：远端 `src/harness.ts` 的状态类型、`src/components/harness-ui.tsx` 的 `LIVE_STATUSES` 均未包含 `waiting_for_async_tool`；`HarnessTaskScreen.refresh` 会对非 LIVE 状态停止轮询。

本地 `408fa5b` / `918d1fd` 已处理相关问题，本轮保留该分支，没有用远端旧 UI 覆盖；Mobile 测试和类型检查通过。

处理：当前本地已同时具备等待态、工具操作类型、工作区和双目标选择器；仍需在真实 API/设备上验证 snapshot + cursor 与等待期间轮询。

验收：工具等待期间持续更新、可取消；恢复后自动显示下一轮；断网重连不丢 cursor、不重复事件，历史过多时继续正确翻页。

### 4.5 P0：v2 版本协商与混合版本保护（Windows 真实闭环已完成）

历史依据：桌面曾只通过 `Number(protocolVersion) >= 2` 决定校验；capabilities 仅报告工具名字等信息，未报告逐项 schema/协议版本。Runtime 新操作直接生成 v2。

代码层面的风险：未知/非法版本处理不严格；旧桌面可能忽略 v2 元数据按旧 handler 执行。`scope.permissions` 是请求数据，不等于经过验证的审批凭据。v2 用原始路径字符串比较，跨 Windows 分隔符和路径表示形式也需验证。

处理：桌面 capabilities 现在显式声明 tool protocol 版本、支持版本和每个工具的 `schemaVersion`；Runtime 发 v2 操作前先握手校验，未知版本、缺少 v2 声明或未知工具 schema 都 fail closed。桌面也拒绝未知协议版本。v2 scope 比较按平台规范化绝对路径处理，避免 Windows 斜杠差异造成假失败。v1 仍仅保留给明确的旧 smoke/兼容路径，不代表 v2 入口可以降级。

验收：新 Runtime + 新 Windows desktop 已完成真实生产闭环；旧 desktop 首次 smoke 被正确拒绝为 `tool_protocol_missing`，更新客户端后通过。新/旧 Runtime × 新/旧 desktop 的完整四组合、Mac 和设备构建号仍需矩阵验收。

### 4.6 合并和版本核对是发布前置条件

- 本地 `38c0e91` 的严格参数类型、空参数与 Unicode 校验已随 Runtime 集成提交，v2 元数据生成和错误分类均有回归覆盖。
- 工具错误码回传已与远端失败分类一起保留，UI 和模型可以区分业务错误、环境离线与路由不满足。
- 版本环境变量和实际发布 SHA 不一致会误导健康检查、回滚与故障排查，需统一 release manifest 和健康信息。
- CF Provider 远端已主动移除旧多路由状态/健康接口。本轮实际合并时出现 README、入口和测试冲突，已退出未完成合并；先确认消费者是否使用旧契约，再决定兼容层；不要把被简化的整套路由逻辑盲目恢复。

## 5. 开发顺序与验收

以下是建议执行顺序，不是已经完成的任务，也不是未经评估的工期承诺。

### M0：统一集成基线（本轮完成本地部分）

**范围：六仓库代码与发布清单。依赖：无。**

1. 固定六仓库组合版本；保存 Runtime 未提交修改的独立补丁/提交，再进行合并，不使用 reset 覆盖。
2. Runtime 合并远端 v2 与本地参数校验、错误码；手机合并远端新功能与本地等待态。
3. 桌面、Engine、Backend 按最新远端基线校验；CF Provider 按实际消费者决定契约兼容，不把旧实现自动视为必须保留。
4. 核对服务器 manifest、Python 安装包、Engine 路径、桌面安装包和手机构建标识；将版本差异写入发布记录。

**当前交付：** Runtime/Engine 已按 `946c82f`/`0cdd839` 原子激活；桌面 `270e494` 已构建、安装并完成生产 smoke。Mobile 构建标识和 CF Provider 契约迁移仍未完成。

### M1：修复当前流程并验收 v2（代码层 P0 已部分完成）

**范围：Runtime + desktop + mobile。依赖：M0。**

1. ~~修复 Registry 审批快照问题，优先保证 workspace_id 主入口。~~ 已完成本地回归；保留真实设备验收。
2. ~~独立 deadline 回收器，覆盖 offline / missing / discovery failure。~~ 已完成离线目标回归；保留真实设备验收。
3. ~~合并手机等待态，补齐工具失败码、到期与取消的展示。~~ 本地代码已具备并通过 Mobile 测试；保留真实 API 验收。
4. ~~增加严格版本协商，关闭 native 写任务的隐式 v1 降级。~~ 已完成代码实现；保留真实四组合验收。
5. Windows 核心写任务已完成；继续按下面矩阵补齐跨平台、离线和手机恢复场景。

| 场景 | 必须观察到的证据 |
| --- | --- |
| 手机选择已注册工作区 + 云端 Agent + Windows 工具 | 待手机真实入口；Runtime/桌面直连等价路径已通过，产生 v2 操作 |
| 同一工作区写任务、多次工具等待 | 已通过：一次审批、4 轮模型、3 次操作、真实读写与回读一致 |
| 只读任务 | 不要求写审批，不向模型暴露写工具 |
| 审批前后修改 registry / 切桌面目录 | 不写入新目录，拒绝或重新授权；事件说明原因 |
| 完全离线并超过 deadline | 过期事件持久化，任务不永久等待，也不自动改派到另一台电脑 |
| 工具执行前取消、执行中取消、迟到结果 | 状态不复活；区分“停止等待”和“实际停止副作用” |
| 断网重连、API/Worker 重启、事件翻页 | cursor 连续、无重复终态、不丢任务与审批证据 |
| 相同幂等键重放 / 不同参数复用键 | 同请求复用已有操作，不同内容拒绝；不把此项当作设备 exactly-once |
| 旧桌面 / 新桌面，Windows / Mac | 旧桌面已证明 fail closed，新 Windows 已通过；Mac 和完整混合矩阵待做 |
| 真实错误与环境失败 | ENOENT / scope mismatch / offline 被区分，错误码到达事件、模型和 UI |

**交付：** task/run ID、操作协议版本、设备构建号、审批次数、事件 cursor、产物哈希、服务版本和回滚记录。不要仅写“smoke 通过”。

### M2：设备执行可靠性与受控 Shell

**范围：desktop 为执行边界，Runtime 为授权和调度边界。依赖：M1。**

先明确：工作目录绑定只是选择 cwd，不是安全沙箱。任意 shell 命令可能访问目录之外、网络和用户凭据，不能继承 `workspace_write` 的含义。

1. 定义独立 Shell 执行授权，绑定 task/attempt、设备、workspace binding、工具版本和有效期；默认 native 工具列表不增加 Shell。
2. 审计现有 `shell.exec` / `bash` 的 Pi RPC 路径是否经过预期沙箱和审批；`remote:control` / `remote:runtime` token 不能仅凭 scope 字符串被视为任意 Shell 授权。
3. 使用明确的参数 schema、固定绑定 cwd、参数长度、执行时限和输出上限；确认使用的 shell 及平台差异，不拼接模型提供的设备路径。
4. 将 operation deadline、Worker 租约、子进程取消关联起来；现有工具 Worker 没有像 execution Worker 那样的持续续租循环，长命令不能直接套用。
5. 增加设备侧持久执行回执、in-flight 排他和 fencing。崩溃发生在“副作用已发生、回执未保存”时标记结果不确定；对非幂等命令不得自动重跑。
6. 先灰度一台设备和无副作用短命令，再验证批准后的受控修改、超时和取消；MCP、Git push、部署分别审批，不打包进通用 Shell 权限。

**交付：** 真实云端模型 -> 明确批准 -> 指定设备执行 -> 返回退出码及受限输出 -> 模型续跑；未批准、错目录、旧 host、超时、重放均有拒绝证据。

### M3：云端 Git 工作区隔离

**范围：Runtime + Engine。依赖：M1；不必等待所有桌面 MCP 能力。**

- 以 repo + ref/commit 创建每任务 clone/worktree；记录 resolved commit、独立目录/分支和生命周期。
- 区分跨设备逻辑 workspace 与具体 working copy。同设备同 repo 的多个 worktree 不能只用一个 executor binding 覆盖；引入明确的 binding identity/version。
- Registry 库存去重目前存在大小写折叠和“一个 workspace 每设备一个路径”的限制；需按平台和真实文件系统语义处理。
- 不把本地未提交修改、数据库、证书或设备状态假设成云端可重建内容；这类任务继续绑定原设备。
- 测试同仓库并发任务、进程崩溃清理、凭据最小化、diff/commit 归属；push、PR、deploy 保持独立授权。

**交付：** 手机不选电脑也能在独立云端工作区完成仓库任务，并展示可审查 diff；尚未批准时不推送远端。

### M4：Artifact 数据面与 NAS/MinIO

**范围：Runtime 元数据 + 独立存储适配器 + mobile/desktop 下载入口。依赖：M1，可与 M3 并行。**

- 当前 `artifact.produced` 事件已有 ID/URI，但尚不等于完整 Artifact Registry 或内容寻址存储。
- 建立 artifact ID、run/attempt、producer、大小、SHA-256、内容类型、保存位置及访问策略。
- 大文件不放入模型 transcript、ToolOperation result 或任务事件；只传摘要和引用。
- 局域网设备可直连 NAS/MinIO；外网手机必须有实际可达的授权下载路径，不能把私网 URL 当作外网方案。
- 区分现有图片服务的 R2 路径与未来代码/日志产物存储，不为统一名词迁移已工作的图片链路。
- 验收短期凭据、权限隔离、断点续传、过期、哈希校验和失败回收；通过链路观测确认大产物未经过不应承载它的公共 API/模型代理。

**交付：** 大产物能在手机/桌面下载校验，控制面只保存元数据，小消息调度与大文件传输分离。

### M5：持久 Session 与交互整合

**范围：Runtime、Relay、desktop、mobile。依赖：M1，跨执行器延续还依赖 M3/M4 的可移植上下文。**

- 先写清 Workspace / Session / Task / Run / Attempt / Operation 的身份与状态表。
- 当前 run_id 对 task 稳定、retry 不换 run_id；在明确是否拆分之前先关联现有 execution attempt，避免悄悄改变 API 语义。
- Session 拥有持续上下文；关键聊天事件持久化，token delta 可有界缓存，Relay 仍只做低延迟交付。
- 支持长期离线后用权威 snapshot + cursor 恢复，再评估 Chat 与任务入口的界面整合。
- 跨设备迁移只迁移可验证的 transcript、checkpoint 和 artifact 引用，不迁移活跃本地进程或隐式设备状态。

**交付：** 同一会话可在不同执行位置继续后续任务，历史与工具结果不丢失；不要求先把全部 Chat 重写成后台任务。

## 6. 下一轮实际应做什么

下一轮优先做一个可验收切片：**把手机入口接到同一条生产 task 链，并验证 `waiting_for_async_tool` 的轮询、cursor 和恢复。** Windows 直连 v2 闭环已经完成，不再重复重写 Runtime/桌面协议。

| 工作包 | 主要文件/仓库 | 完成标志 |
| --- | --- | --- |
| A：Runtime 集成 | `native_tools.py`、`tool_transport.py`、`executors/pi_studio.py`、`worker.py` | 已完成本地集成、能力握手、全量测试和生产 Windows smoke |
| B：绑定与审批 | `providers.py`、`orchestrator.py`、`routing.py`、`store.py` | 已验证 registry 写任务只审批一次，绑定变更失败 |
| C：独立过期回收 | Runtime `store.py`、`worker.py` | 已验证离线目标按 deadline 结束等待 |
| D：手机整合 | mobile `harness.ts`、`harness-ui.tsx`、`HarnessTaskScreen.tsx` | 等待态和 cursor 增量读取已通过本地测试；生产 cursor 接口已实测，真机 UI 仍待验收 |
| E：版本与发布门禁 | desktop `remote-control.ts`、Runtime gateway、部署脚本 | Runtime/Engine 已部署；桌面 `270e494` 已安装；旧客户端拒绝和新客户端通过均有证据 |
| F：真实验收 | 现有 smoke 脚本扩展，发布记录 | Windows v2 已完成；待手机 API、离线 deadline、重连翻页、Mac 和幂等重放矩阵 |

A/B/C/E 的代码层工作已完成本地验证，A/E 已有生产证据；D 和 F 还需手机真实 API、离线、重连和跨平台矩阵。分工前固定契约和验收，不能让多个 LLM 同时修改同一工作区的同一文件再依赖“最后一次保存”。

## 7. 暂缓事项与发布原则

- 暂不合并两个后端、不迁移数据库、不重写全部 UI，不为这些基础设施工作增加不必要的并行项目。
- 暂不默认开放 Shell/MCP，也不让写任务自动改派到另一台设备。
- SQLite 迁移到 Postgres 应由实际多实例写入、锁竞争、容量与恢复需求触发，不因为架构图里有控制面就先迁移。
- 文档、源码、测试、安装包、生产状态分别标记；“提交了”不是“安装了”，“测试通过”不是“真实跨端通过”。
- 新 schema 回滚前验证旧代码读取迁移后数据库的兼容性；代码/配置回退不等于数据回退，禁止直接用旧备份覆盖期间产生的新任务。
- 桌面核心安全和 IPC 契约文件遵守 `AGENTS.md` 的先说明、再确认要求。文档中的方案不自动代表对所有破坏性或权限扩张操作的批准。

## 8. 后续核对入口

所有路径均相对于对应仓库，读取时使用本文固定 SHA 或新的已确认集成 SHA：

- Runtime：`src/personal_harness/{providers,models,workspaces,store,worker,orchestrator}.py`。
- Runtime 执行器：`src/personal_harness/executors/{native_tools,pi_studio,routing}.py`。
- Runtime 测试：`tests/test_workspaces.py`、`test_native_ingress.py`、`test_native_tools.py`、`test_tool_transport.py`、`test_worker.py`、`test_store.py`。
- 桌面：`src/main/remote-control.ts`、`workspace-inventory.ts`、`local-file-tools.ts` 及同目录测试。
- 手机：`src/harness.ts`、`src/harness-target.ts`、`src/components/harness-ui.tsx`、`src/screens/HarnessTaskScreen.tsx`。
- 设备后端：`remote.py`、`test_remote.py`；其 relay backlog 不承担 Runtime task 持久化。
- Engine：`dsh/tool_turn.py`、`dsh/loop.py`、`dsh/config.py`。
- CF Provider：`src/index.ts`、`src/openai.ts`、`src/config.ts`，先比对消费者再恢复旧契约。

本轮隔离核查材料保留在 `D:/Temp/pi-studio-development-audit-20260912/`；不包含生产数据库副本或凭据。可据此重跑远端 Runtime 快照，不能把临时目录作为正式代码源。
