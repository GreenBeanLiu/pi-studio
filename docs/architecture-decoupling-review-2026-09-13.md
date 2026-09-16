# 架构解耦审查与后续切片

> 审查时间：2026-09-13
>
> 范围：`pi-studio`、`pi-studio-mobile`、`pi-studio-device-plane`、`pi-studio-control-plane`、`pi-studio-engine`、`pi-studio-llm-provider`。

## 1. 结论

当前架构方向是成立的，问题不在于仓库太多，而在于同一份业务语义在多个仓库各自实现了一部分：

- Runtime、桌面端、手机端都理解 `ToolOperation`，但没有唯一的契约来源。
- 手机端生成一套目标字段，Runtime 又重新解析和校验一套目标字段。
- Backend 既是设备身份/中转边界，又是 Runtime 的外部入口，导致 Runtime 依赖 Backend 的 token 和 WebSocket 细节。
- 桌面端的 `remote-control.ts` 和 Runtime 的 `TaskStore` 都承担了过多不同职责。

因此下一阶段应优先做**契约和职责收敛**，而不是继续拆成更多服务。目标是让每个变化只需要修改一个权威模块，再由适配器承担跨端差异。

## 2. 当前职责归属

| 模块 | 应该拥有的事实和行为 | 不应该拥有的职责 |
| --- | --- | --- |
| `pi-studio-mobile` | 用户意图、目标选择 UI、任务和事件投影 | 最终目标解析、工具状态机、设备执行细节 |
| `pi-studio-device-plane` | 安装认证、配对、设备在线状态、Relay、媒体/工作流入口 | Harness 任务状态、Agent loop、工具参数解释 |
| `pi-studio-control-plane` | 任务状态、审批、workspace identity、目标解析、ToolOperation、Agent loop、运行事件 | 本机文件和 Shell 执行、Provider HTTP 细节 |
| `pi-studio-engine` | 无状态的模型调用桥接、provider transcript/tool result 透传 | Durable task、设备路由、本地工具执行 |
| `pi-studio-llm-provider` | Provider 请求/响应适配、模型别名和上游路由 | Agent loop、权限、设备和工作区 |
| `pi-studio` 桌面端 | 本地 Agent session、本地工具执行、桌面 IPC、设备能力声明 | 云端任务状态和模型决策 |

这份归属应作为后续设计的判断标准。特别是：Backend 是边界和中转，不应成为第二个 Agent control plane；Engine 是 Provider adapter，不应吸收 ToolTransport。

## 3. 真实调用链

### 3.1 Native tools

```text
Mobile
  -> Backend /harness edge
  -> pi-studio-control-plane
  -> NativeToolExecutor
  -> pi-studio-engine / Provider
  -> ToolTransport / ToolOperationWorker
  -> PiStudioRemoteExecutor
  -> Backend internal device token + Relay WebSocket
  -> pi-studio remote-control / local tool gateway
  -> tool_result
  -> Runtime resume agent loop
```

现在云端已经运行 Agent loop 和 Provider 调用；桌面端负责的是本地执行，不再是“未来才会迁移的完整云端 loop”。桌面仍保留 `desktop-agent` 模式，这是另一条明确的本地 Agent session 链路，不应与 `native-tools` 混为一谈。

### 3.2 Relay 和任务状态

Backend 的 Relay 可以转发设备命令和事件，但不应复制 Runtime 的任务状态。Harness 任务、审批、工具操作和运行事件的权威来源是 Runtime；设备连接、配对和 controller 房间的权威来源是 Backend。

## 4. 主要耦合点

### P0：ToolOperation 契约重复

同一概念目前分布在：

- Runtime：`personal_harness/tool_transport.py`、`executors/pi_studio.py`、`NativeToolExecutor`
- Desktop：`src/main/remote-control.ts` 的本地工具 schema、执行和结果转换
- Mobile：`src/harness.ts` 的 `HarnessToolOperation`、状态和 payload 转换

这已经造成了真实的漂移风险：能力声明、错误码、scope、`source`、恢复结果和状态值只要有一端漏改，就会出现“任务创建成功但设备不能执行”或“执行完成但 Runtime 无法恢复”。

**解耦方向：**建立一个版本化的 `Tool Gateway Contract v1`，至少覆盖：

- `ToolCapabilities`
- `ToolOperationRequest`
- `ToolOperationResult`
- `ToolScope` 和权限错误码
- `source`、`deadline`、幂等键和 resume envelope

第一步只建立 JSON Schema、跨仓库 fixture 和兼容性测试，不立刻重写三端实现。Runtime、Desktop、Mobile 都保留适配器，但不能再各自发明字段。

### P0：目标解析重复

Mobile 的 `harness-target.ts` 生成 `executionTarget`、`agentTarget`、`toolTarget`、`executionMode`；Runtime 的 `routing.py`、`runtime_targets.py` 和 Provider API 又重新解析这些字段。现在的兼容镜像可以保留一段时间，但权威性必须收回 Runtime。

**解耦方向：**手机只提交用户意图：目标偏好、`workspace_id`、工具要求和风险确认。Runtime 负责 canonical resolution，并把解析后的 target 和 capabilities 写入 checkpoint/event。手机只展示结果，不再根据本地字段推断最终状态。

### P1：桌面 `remote-control.ts` 过宽

当前模块同时承担连接重试、心跳、命令分发、工具执行、routine/image/video host 和事件广播。它已经有注入式 host 类型，这是好的依赖反转基础，但内部职责仍然过密。

**解耦方向：**保留 `RemoteControlManager` 作为外部 facade，内部拆成四个模块：

1. `remote-transport`：WebSocket、认证、重连、心跳。
2. `remote-command-dispatch`：命令路由和响应 envelope。
3. `tool-gateway`：能力声明、scope 校验、本地工具执行。
4. `host-projections`：routine、media、review 等桌面宿主能力。

这应是同一进程内的模块拆分，不是新增网络服务。

### P1：Runtime `TaskStore` 过宽

`store.py` 同时覆盖 task、execution、tool operation、native session、workspace、approval、notification 和 queue。集中事务本身没有问题，但调用者已经被迫依赖一个大接口，导致任何表结构变化都可能波及多个领域。

**解耦方向：**先不拆数据库，增加面向领域的 repository facade：

- `ToolOperationRepository`
- `NativeSessionRepository`
- `WorkspaceRepository`
- `TaskRepository`

它们共享同一个 connection/transaction context。优先迁移 ToolOperation 和 NativeSession，因为它们正处于当前闭环的高频变化区。

### P1：Workspace identity 和本机路径混用

Runtime 的 `workspace_id` 是跨设备稳定身份，桌面上报的是本机绝对路径，Backend 的 workflow 又有自己的 `workspace_path`。这些值不能继续使用相似命名。

**解耦方向：**明确区分：

- `workspace_ref` / `workspace_id`：Runtime 管理的稳定身份。
- `executor_binding`：某台设备上的绑定。
- `local_path`：只在 Desktop tool gateway 内部使用的本机路径。
- `workflow_workspace_path`：媒体/工作流域的路径字段，如仍需要则保持独立命名。

### P2：双云平面的部署耦合

Runtime 通过 Backend 获取 controller token 并连接 Relay，说明两者之间已有稳定依赖，但目前依赖的是 Backend 的内部 URL、token 和 WebSocket 细节，而不是一个独立的 Device Gateway Contract。

**解耦方向：**Backend 继续负责身份和 Relay，Runtime 继续负责任务和调度；双方之间增加版本化的内部 Device Gateway Contract 与能力握手。不要把任务表或 Agent loop 复制到 Backend。

## 5. 状态和事件的权威性

后续代码和 UI 需要遵守以下规则：

| 状态 | 权威来源 | 其他端的角色 |
| --- | --- | --- |
| Harness task / approval / tool operation | Runtime | Mobile 展示，Desktop 执行 |
| Agent run / checkpoint / tool result | Runtime | Mobile 增量投影 |
| 设备在线、配对、controller 房间 | Backend | Runtime 和 Mobile 查询/订阅 |
| 本地 Pi session 和本地进程生命周期 | Desktop | Mobile 通过 relay 观察 |
| 例程、图片、视频工作流 | Backend/对应宿主 | Harness 不吸收其状态机 |

Mobile 不应从多个事件拼出第二套状态机；Desktop 也不应把本地 session 状态写回成 Harness task 状态。

## 6. 建议的目标形态

```text
Mobile: intent + projection
        |
        v
Edge/API: auth + route + relay
        |
        +--> Runtime control plane
        |      task / approval / workspace / events
        |      agent loop / provider adapter
        |      tool operation scheduler
        |              |
        |              v
        |        Device Gateway Contract
        |              |
        |              v
        +--------> Backend Relay --------> Desktop Tool Gateway
                                           local files / shell / IPC / MCP
```

工作流和媒体继续作为独立域存在，通过明确 API 被调用，不并入 ToolTransport。

## 7. 落地顺序

### Slice A：契约固化，低风险

- 在 `pi-studio/docs` 记录 `Tool Gateway Contract v1` 的字段和状态表。
- 从当前 Runtime/Desktop/Mobile payload 提取 fixture。
- 增加三端兼容性测试，先保证现有生产 payload 不变。
- 增加版本和未知字段策略：读取端允许向后兼容，写入端只发送声明过的字段。

验收：同一组 request/result fixture 能被 Python、TypeScript Desktop、TypeScript Mobile 解析；现有真实 smoke 不改变。

### Slice B：桌面工具执行模块化

- 从 `remote-control.ts` 提取 `tool-gateway`。
- 保持 `RemoteControlManager` 的公开命令和事件不变。
- 将 scope 校验和本地文件/Shell handler 的测试迁移到新模块。

验收：桌面全量 verify、真实 `local.read` smoke、拒绝越界路径和重复创建回归均通过。

### Slice C：Runtime repository facade

- 先抽 `ToolOperationRepository`，再抽 `NativeSessionRepository`。
- 保持单库和现有事务语义不变。
- Worker 和 NativeToolExecutor 不再直接依赖整块 `TaskStore`。

验收：Runtime 全量测试、断线恢复、取消、过期和显式 retry 矩阵不变。自动化边界现由 [Reliability Matrix v1](contracts/reliability-matrix-v1.md) 锁定（现场物理场景仍见恢复验收补充）。

### Slice D：Runtime 成为唯一目标解析者

- Mobile 保留显示和兼容字段，但新增 canonical intent 字段。
- Runtime 返回解析后的 target、capabilities 和拒绝原因。
- ~~经过一个兼容周期后删除 Mobile 的兼容镜像生成逻辑。~~ → **已完成**（2026-09-15 product confirmation；Mobile PR `#5`）。

验收：同一个意图在 Web、Mobile、脚本入口得到相同 target resolution。

跨版本验收证据包见
[Slice D 跨版本验收证据包](slice-d-cross-version-validation-2026-09-15.md)。
**镜像删除已解锁并落地**（不再保留 `executionTarget` 兼容镜像）。

### Slice E：工作区命名清理

- 明确 `workspace_id`、`executor_binding`、`local_path` 的边界。
- 增加跨设备同仓库不同路径的契约测试。
- 禁止 Mobile 或 Backend 将本机绝对路径当作跨设备 workspace identity。

**首切已落地（2026-09-15）：** 契约 + Runtime fixture/测试，见
[Workspace Identity v1](contracts/workspace-identity-v1.md)
（Runtime 权威实现与 `tests/fixtures/workspace-identity-v1.json`）。
未改 wire 字段名、未删除 path-only 旧路径、未做生产注册表 rename/merge。

**剩余（可选 UI 切）：** 同名工作区展示消歧（例如两个 local「Works」）、客户端文案提示；不阻塞契约生效。

## 8. 明确不做的事情

- 不新增一个“总 Agent 服务”来包住现有 Runtime。
- 不把 Agent loop、ToolTransport 或任务表搬进 Backend。
- 不把本地工具执行搬进 Engine 或 Provider adapter。
- 不把 routine/media 状态机并入 ToolOperation。
- 不在没有 repository seam 和回归矩阵前拆数据库或改成事件溯源。

## 9. 本次审查后的下一步

2026-09-14 Slice D 首步：新增 Runtime 目标解析预检，复用 ProviderCommand 和正式路由器，
返回目标、设备路径、环境能力需求及结构化拒绝原因。见 [Target Resolution v1](contracts/target-resolution-v1.md)。
Mobile 可选预检与跨版本回退已接入；**compatibility mirror 已于 2026-09-15 删除**；预检并非设备预留或授权。

2026-09-14 发布验收：Runtime `94d0ddd` 已上线，workspace_id 到 Mac 路径解析及 checkpoint 后执行
进程退出接续均取得真实证据，见 [发布与恢复实测](workspace-runtime-rollout-2026-09-14.md)。
下一开发切片可进入 Runtime 目标解析契约；物理断网、桌面崩溃和取消/过期场景继续保留现场验收。

2026-09-14：Slice E 的 Runtime 解析收敛已落地。`workspace_resolution.resolve_task_workspace`
统一 API 身份校验与路由器设备路径绑定，并补齐非 HTTP 入口的 repository 冲突检查。
跨端字段和持久化结构保持兼容，详见 [工作区解析收敛记录](workspace-resolution-2026-09-14.md)。
后续优先部署后收集真实设备的 workspace_id 与断线恢复证据，再继续目标解析契约；下段为上一轮记录。

2026-09-15：Mobile master `02db8c65` 已接入预检后 `applyCanonicalResolution`。
同日 product confirmation 后，Mobile PR `#5` **删除** `executionTarget` 兼容镜像。
证据与解锁结论见
[Slice D 跨版本验收证据包](slice-d-cross-version-validation-2026-09-15.md)。

2026-09-15：Slice E **首切**落地 —— [Workspace Identity v1](contracts/workspace-identity-v1.md)
契约 + Runtime fixture/测试锁定词汇与跨设备同仓不同路径行为；剩余为可选 UI 展示消歧。

2026-09-15：Reliability Matrix Contract v1 **首切**落地 —— [Reliability Matrix v1](contracts/reliability-matrix-v1.md)。
将既有 Runtime 恢复回归（12 个 `scenario_id`）提升为跨仓契约；矩阵自动化 SoT 已锁定。
物理断网、桌面崩溃、write-then-lost-ack 现场验收仍开放（见
[Native Tool 恢复验收补充](native-tool-recovery-acceptance-2026-09-13.md)）。
Slice C 要求的断线恢复 / 取消 / 过期 / 显式 retry 自动化矩阵验收边界不变，仅提升为契约。

Slice A 已完成第一轮：契约草案和 v2 request/result fixture 位于 [Tool Gateway Contract v1](contracts/tool-gateway-v1.md) 及其 `fixtures/` 目录；Runtime、Desktop、Mobile 已分别加入 v2 字段兼容测试。Slice B 的桌面内部提取也已完成，`src/main/tool-gateway.ts` 现在承载本地工具能力、scope 校验和执行；`RemoteControlManager` 的公开命令与 Relay envelope 保持不变。Runtime 的 `ToolOperationRepository` 和 `NativeSessionRepository` 已接入 API、ToolTransport、Worker、NativeToolExecutor 和 Orchestrator；Workspace Identity v1 与 Reliability Matrix v1 契约首切已落地。下一步仍应收集真实物理断网 / 桌面崩溃 / write-then-lost-ack 现场证据，再决定是否继续拆 SQL。
