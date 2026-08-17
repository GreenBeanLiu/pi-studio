# DeepSeek Harness 架构分析与 pi-studio 优化建议

更新日期：2026-08-17

## 研究范围与结论

本文仅使用 DeepSeek 官方仓库中的 README、架构文档、源码目录与提交快照。研究基准固定为 commit [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)（2026-08-13）；pi-studio 对照基准为 commit [`2d22b52db1e52e843888a3d19ccf144d8db0540e`](https://github.com/GreenBeanLiu/pi-studio/tree/2d22b52db1e52e843888a3d19ccf144d8db0540e)。固定 commit 是为了避免开发者预览阶段快速变动导致链接和结论漂移。

最重要的判断是：**DeepSeek Harness 值得 pi-studio 学习的是契约，不是整套替换。** pi-studio 已经有成熟的 Electron 产品外壳、Pi agent 进程和图像/3D/Routine 产品能力；直接迁移到 Cordis 会产生很大的重写成本。更合理的路线是保留 Pi 作为执行引擎，在 Electron main 内逐步引入以下契约：

1. 一个 Pi 专用的 `PiRuntime` 深模块，隔离 RPC、进程和私有 JSONL 格式。
2. 仅追加事件 + 纯投影的会话读模型，替代 renderer 猜状态和直接扫文件。
3. 单一、可审计、fail-closed 的工具策略/审批流水线。
4. 有明确取消、终态和资源回收语义的 Workflow/Job 运行时。
5. 基于真实会话日志的 record/replay 与自动评测入口。

在这些架构工作之前，pi-studio 有两个应立即修复的 P0 一致性问题：**安全守卫实际被固定卸载，而沙箱默认关闭；Routine 又使用 `agent_end` 而非 `agent_settled` 判定 agent 节点完成。**

## 1. DeepSeek Harness 是什么

DeepSeek 将它定义为开源 **agent harness**，不是模型本身，也不是训练框架。当前根包版本是 `0.1.0-rc.5`，README 明确标注“developer preview”并预告破坏性兼容变更。[README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L5-L11) [package.json](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json#L1-L10)

它的目标是把“模型适配、提示词、工具、会话、审批、沙箱、持久化、UI、子代理、工作流”拆成可组装、可替换的插件。一切运行实例都是 Cordis 插件树；插件贡献服务、类型化事件和可撤销副作用，不存在必须打补丁的特权内核。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L9-L27)

官方提供的主要产品面是：

- `base`：模型、工具、会话持久化、策略、凭据、遥测和子代理提供方的公共底座。[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/README.md#L1-L9)
- `web`：在 base 上增加 Web host、浏览器 client、workspace、projection cache 等。[web bundle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/web-app/README.md#L1-L5)
- `headless`：在同一 base 上增加一次性运行器，不启动 Host、HTTP server 或浏览器插件。[headless bundle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/headless/README.md#L1-L7)
- Python SDK / JSON-RPC / ACP：为评测、自动化和跨进程调用提供协议入口，而不是把 UI 与运行时绑死。[Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L1-L27) [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/acp/acp/README.md#L1-L12)

## 2. 架构与关键抽象

### 2.1 插件树、Profile、Bundle

Profile 是用户可选择的具名组装；Bundle 是可叠加的配置/挂载层。加载顺序是 profile 中列出的 bundles、profile patch、home patch、命令行 overlay，后层可替换前层配置。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L15-L37)

这使产品形态和执行内核分离：Web、headless、测试回放都可以使用同一组核心能力，只改变组装。它并不意味着每个应用都应该采用 Cordis；真正可复用的原则是“能力通过接口注册，产品通过组合选择提供方”。

### 2.2 Capability seam

Harness 将一项可替换能力拆成三种角色：声明接口的 Service Definition、实现接口的 Service Provider、暴露给模型或产品的 Consumer。替换文件系统/进程提供方就能把 Bash、PTY、LSP 一起移到另一个执行世界，而消费方不用分叉。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L102-L106)

官方包目录体现了这一分层：core、llm、fs、shell、sandbox、workflow、subagent、jobs、session、sdk、client 等均是独立能力族；扩展包依赖抽象定义而不是具体 provider，agent loop 本身也是可替换实现。[包目录](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/README.md#L11-L59) [依赖规则](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/README.md#L63-L69)

### 2.3 Agent、Session 与 Scope

`Agent` 是外部插件面对的稳定句柄，提供 session、inbox、状态、取消、idle 等能力；具体 loop 隐藏在实现内部。创建者拿到 `AgentHandle`，只有持有者能 dispose，且 dispose 会停止 loop、注销 agent、释放 session 和 agent-scoped 世界。[core](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/core.md#L24-L53) [Agent handle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/core.md#L57-L118)

Scope 同时表达两件事：某项注册对哪个 agent 可见，以及它由谁拥有、何时释放。它用对象身份做路由，并把注册和 teardown 绑定在同一个 context 中。[scope](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/scope.md#L9-L42)

`Session` 则是 agent 整段交互的**唯一事实源**：只追加的类型化事件日志。模型历史从日志派生，而不是另存一份；raw chunk、assembled message、tool call/result、request header 都可重放。[session](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session.md#L1-L11) [事件词汇](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session.md#L20-L100)

持久化是另一个 seam，同一事件类型可落到 JSONL 或 SQLite；冷启动遇到中断轮次时追加合成的 `interrupted` 终点，而不是丢掉已经持久化的长轮次。[persistence](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/persistence.md#L1-L19)

### 2.4 Projection：让 UI 不再猜状态

每个投影由 `init/apply/view/stateVersion` 三个纯同步函数和 schema 组成；框架在每个已提交事件上 fold，快照带统一 `asOfSeq` 水位。UI 读取的是一致的 whole-value snapshot 和 change feed，而不是在组件里按到达顺序拼状态。[session projection](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session-projection.md#L9-L57) [快照与 feed](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session-projection.md#L59-L93)

这一点对 pi-studio 的价值非常直接：它已经把 agent 生命周期做成 main 进程权威快照，但消息、工具、审批、Routine 展示仍有多套局部状态。

## 3. 一轮请求的执行链路

Harness 对“轮次”和“步骤”有严格定义：一个 step 是一次模型请求及它调用的工具；一个 turn 可以包含多个 step，直到没有待处理工作才结束。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L67-L94)

```text
用户输入 -> Agent inbox
  -> turn/start
  -> 领取消息 + 组装 system prompt / tool schemas
  -> step/start
  -> 从 Session log 派生模型历史
  -> LLM stream
  -> assistant/chunk* -> assistant/message
  -> tool/call*
       -> pre-execute / 审批 / 单调守卫
       -> execute / timeout / retry
       -> post-execute / result normalization
       -> tool/result*
  -> step/end
  -> 如工具或新输入要求继续，则进入下一 step
  -> turn/end
```

关键点不是事件名称，而是三个不变量：

1. 模型可见的事实必须已经记录，下一步上下文可由日志重建。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L96-L100)
2. `tool/call` 在执行前记录，最终只有一个权威 `tool/result` 进入模型历史。[工具流水线](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.md#L4-L60)
3. 取消和 idle 是整个 agent activity 的语义，不等同于“收到某个看似结束的事件”。

## 4. 工具、审批、工作流和后台任务

### 4.1 工具不是一个回调，而是一份完整契约

`ToolDefinition` 同时声明参数 schema、规范化输出 schema、执行函数、超时/并发元数据，以及纯函数式 UI presenter。模型只收到显式 allowlist 中的 schema 字段，host-only 信息不会泄漏到 prompt。[tools](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/tools.md#L9-L96)

执行经过 `pre-execute -> monotonic guards -> execute -> post-execute -> finalizeContent -> result`。可重排的 hook 可以改写请求或结果，但 owner policy 是单调守卫，只能拒绝或 abstain，不能被后注册的 allow 覆盖。[tools](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/tools.md#L170-L212)

审批是独立 seam。结果是封闭联合 `allowed-once | rejected | cancelled | unavailable`，只有 `allowed-once` 放行；缺失、抛错或不拥有该请求的 answerer 都归一为 `unavailable` 并 fail closed。每次 ask/decision 还会写入 session 审计事件。[approval](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/approval.md#L9-L33) [dispatch/audit](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/approval.md#L84-L88)

### 4.2 Workflow 和 Job 有清楚的所有权

Workflow 是可选能力，不侵入 agent loop。默认 provider 用一个 worker thread 执行一个 workflow script；运行句柄暴露 `result/cancel/dispose`，取消后必须在有界宽限期内终止，即使脚本永远不返回，`dispose()` 也必须等待子 agent 回收且不能无限挂住。[workflow](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/workflow.md#L1-L13) [run lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/workflow.md#L63-L116)

后台任务由通用 Job runtime 管理。producer 负责真实资源，runtime 负责 identity、owner、状态、取消和可见快照；`done` 表示资源已经释放，不只是业务函数返回。[jobs](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/jobs.md#L7-L26) [producer contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/jobs.md#L28-L95)

这两套抽象解决的是 pi-studio 当前 Routine、后台 chat、subagent 各自定义生命周期的问题：并不需要允许模型写 JavaScript，先统一 `RunHandle`/`JobHandle` 就有价值。

### 4.3 Subagent provider descriptor：能力发现与持久身份分开

Subagent 是多 provider registry，而不是单实现 service；`spawn-in-process`、`fork`、ACP、Codex、Claude Code、dsh SDK 等 provider 可以按名字共存。开始一次 one-shot run 前，runtime 先检查 provider 的静态 `SubagentCapabilities`：`outputSchema`、`depthLimit`、`toolFilter`、`persona`。请求使用了 provider 不支持的能力时必须以 `UNSUPPORTED_CAPABILITY` 明确失败，不能接受后静默忽略。[subagent providers](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/subagent.md#L1-L13) [capability descriptor](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/subagent.md#L15-L37)

这里还有第二种容易混淆的 descriptor：`SubagentDescriptorData` 是写入 child Session 的**版本化、模型不可见的持久身份**。one-shot 记录 provider 和可选 label；continuable child 还快照恢复所需的 provider/model/persona/tool filter。冷恢复从 descriptor 重建，不把某次 live run 或 `AgentHandle` 持久化。[resolved start descriptor](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/subagent.md#L99-L112) [durable descriptor](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/subagent.md#L283-L289)

这正好说明 durable Session event 与 live Agent event 的边界：provider、组成和 lineage 是重启后仍需解释 child 的事实，应持久化；某次 activation 的 running/idle、取消信号和 handle 所有权只属于进程内生命周期，应通过 live event/registry 观察。pi-studio 后续的 `EngineCapabilities` 也应采用同一原则：静态能力在启动握手中声明，subagent 的 provider/模式/父子谱系进入 session metadata，活动进程对象绝不落盘。

## 5. 沙箱与安全边界

DeepSeek 的 `SandboxMode` 只有三档：`read-only`、`workspace-write`、`danger-full-access`。它明确只描述**文件效果**，不承诺网络和进程可见性；并显式报告 `full | partial` enforcement，Windows ACL 与旧 Landlock ABI 可能只有 partial。[sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L9-L39)

策略不是进程全局开关，而是每次 capability call 都携带 `mode/workspaceRoot/sessionId`。同一 provider 可以同时服务只读 Bash、可写子 agent 和一次性批准的提权重试。[sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L41-L93)

受约束策略找不到 backend 时必须抛 `SANDBOX_UNAVAILABLE`，不允许静默退化为裸执行；runner 自身失败与“沙箱正常拦截了命令”也使用不同分类证据。[sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L96-L154)

对 pi-studio 的启示不是把 WSL/Docker 换成 bwrap，而是：

- UI 必须显示“策略”和“实际 enforcement”，而非只显示“沙箱开/关”。
- 沙箱不可用时要 fail closed 或明确让用户选择 full access，不能暗中回退。
- 对不同工具使用不同 capability policy；整个 agent 进容器仍可保留为更强的外层隔离。
- 网络白名单、文件写边界、审批和容器隔离必须分别建模，不能用一个 `sandboxEnabled` 概括。

## 6. 训练、评测和可复现性

### 6.1 它不是训练系统

截至该 commit，官方包目录没有 trainer、dataset、reward model 或参数更新模块；`BENCHMARK.md` 只要求通过 Python SDK 运行 `jsonrpc-agent` minimal variant，并为独立任务使用不同 workspace/session id。[包目录](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/README.md#L11-L59) [BENCHMARK.md](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/BENCHMARK.md#L1-L3)

因此“训练机制”应准确表述为：Harness 可以作为 rollout/trajectory 采集与执行底座，但仓库本身不负责训练、打分或聚合 benchmark 指标。

### 6.2 它已经提供很好的评测接入面

Python SDK 可对隔离 workspace 发起任务；结果包括 final response、finish reason、root events、descendant notifications 和 session root。JSONL 同时记录已组装请求和工具调用，适合作为外部 grader 的输入。[Python 教程](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.md#L40-L81) [SDK result](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md#L41-L49)

测试侧还有一个很值得借鉴的 `llm-replay`：它从已记录 Session JSONL 的 `assistant/chunk` 重建模型 stream，无 API key 启动真实 agent loop；对于 pre-chunk throw、hang/cancel 这类无法从 chunk 还原的行为，用显式 sidecar 描述。[llm-replay](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/llm-replay/README.md#L1-L23)

官方测试纪律同时要求：单测、100% package source coverage、真实 API e2e、keyless snapshot 和 Web browser snapshot 分层；端到端断言要重新读文件或运行命令验证真实世界，不相信 agent 自己说“完成了”。[testing](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/testing.md#L7-L29)

## 7. 可移植设计与明确局限

### 可移植设计

- 同一 base 组合出 Web、headless、SDK/ACP 自动化入口，产品面不反向污染 agent loop。
- fs、subprocess、shell、sandbox、LLM、persistence 都有 provider seam，可替换本地、远程或测试实现。
- Python SDK 安装同版本的 bundled runtime wheel，目标机不需要系统 Node.js。[Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.md#L15-L27)
- Linux、macOS、Windows 分别有 bwrap/Landlock、Seatbelt、ACL restricted-token 文件沙箱 provider。[sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L1-L6)
- Session 事件是 lossless JSON，host/client/持久化/回放共享同一事实模型。

### 局限

1. 官方明确处于 developer preview，API 和配置会破坏性变化。
2. Python SDK 教程当前只列 Linux x64/arm64 与 macOS arm64；示例依赖 POSIX PTY，明确不支持 Windows agent。[Python 教程](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.md#L7-L13) [运行边界](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.md#L98-L104)
3. 沙箱只承诺文件效果，网络与进程可见性不在其词汇范围；Windows 可能只有 partial enforcement。
4. Profile patch 替换整段 config，不做 deep merge，用户 override 必须重述保留字段。[base limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/README.md#L19-L23)
5. 持久化格式遇到旧版本或新版本会拒绝加载，当前没有迁移链。[persistence format](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/persistence.md#L92-L98)
6. ACP 目前仅支持新会话、纯文本和单 workspace，不支持 list/resume/delete/fork、图片、MCP 或实时 reasoning/tool progress。[ACP limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/acp/acp/README.md#L76-L81)
7. 官方没有内建 benchmark dataset、grader、reward 或训练闭环；评测编排仍需外部系统。
8. 高度模块化也带来数量可观的 package/config/生命周期认知成本。对 pi-studio 而言，全量移植的成本显著高于采用少数关键契约。

## 8. pi-studio 现状对照

pi-studio 当前已经做对了几件事：每个聊天拥有独立 Pi 进程，避免切换会话时 dispose 正在运行的轮次；main 维护带 revision 的 `AgentRuntimeSnapshot`；沙箱通过 stdio shim 保持 RpcClient API 不变；Routine agent 节点与当前聊天隔离。[PiClientManager](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/pi-client.ts#L116-L177) [runtime snapshot](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/agent-runtime.ts#L4-L35) [sandbox shim](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/sandbox.ts#L10-L17) [Routine](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/routines.ts#L48-L54)

主要结构性风险是：

| 现状 | 风险 | DeepSeek Harness 对应做法 |
| --- | --- | --- |
| main 直接依赖 `RpcClient`，并自行定位包内 `dist/cli.js` | Pi 升级、ESM/打包、协议事件变化会穿透整个应用 | `Agent`/SDK/ACP 稳定 surface，具体 loop/provider 隔离 |
| 会话列表因 RPC 无 list API 而直接扫描 Pi 的私有 JSONL | 上游格式变化会破坏 UI；冷读与 live event 没统一水位 | persistence seam + typed event log + projection snapshot |
| renderer 根据 `pi:event` 拼消息、工具、审批状态 | reload、切 session、后台运行时容易丢事件或产生竞态 | main-side pure projections + `asOfSeq` change feed |
| Routine 是大型 type switch，运行状态主要保存在内存 map，完成后才写结果 | 崩溃恢复、取消、插件节点、并发和审计扩展困难 | WorkflowRun/JobHandle + durable run events + bounded dispose |
| subagent 能力通过复制上游 example 源码和写入配置目录安装 | 上游目录或 API 改动易静默失效，缺少 manifest/capability handshake | provider registry + scoped lifecycle + package version contract |
| 安全策略、审批、沙箱是分散的开关和扩展 | UI 配置可能不等于真正执行路径，难以审计 | tool pipeline + approval seam + per-call sandbox policy |

上述现状可由 pi-studio 源码直接验证：会话扫描的原因写在 [`pi-sessions.ts`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/pi-sessions.ts#L6-L13)；subagent 的 fallback 明确依赖上游 example 的 `index.ts/agents.ts` 快照，[`subagent-workflow.ts`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/subagent-workflow.ts#L145-L188)。

## 9. pi-studio 优化路线

### P0：先修两个语义错误

#### P0.1 让安全 UI 与真实执行路径一致

当前默认设置仍是 `securityGuardEnabled: true`、`sandboxEnabled: false`，[`contracts.ts`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/shared/contracts.ts#L76-L88)；但打开 workspace 时无条件调用 `syncSecurityGuardExtension(false)`，[`ipc.ts`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/ipc.ts#L382-L400)。Routine 也固定卸载 guard，只有用户显式打开 sandbox 才走隔离路径，[`routines.ts`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/routines.ts#L374-L395)。

这意味着配置值、产品文案和执行事实可能互相矛盾。建议：

1. 删除已经失效的 `securityGuardEnabled` 设置，或真正按它安装 guard，不能保留“看似开启”的死配置。
2. workspace 启动返回统一 `ExecutionSecuritySnapshot`：`filesystemMode`、`networkMode`、`backend`、`enforcement`、`reason`。
3. 若产品决定“只信沙箱”，则 sandbox 关闭时必须明确显示 full access；若用户选择 confined 而 backend 不可用，应 fail closed。
4. 审批记录必须携带 `sessionId/runId/callId/tool/action/policy/outcome/time`，由 main 持久化，不只存在 ChatPane 内存。

#### P0.2 Routine 等待真正 settled

`pi-client.ts` 已写明：`agent_end` 后可能重试或压缩，`agent_settled` 才是真正结束，[`nextRunActive`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/pi-client.ts#L84-L92)。但 Routine 的 agent step 在第一个 `agent_end` 就 resolve，[`runAgentStep`](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/routines.ts#L401-L438)。

应改为等待 `agent_settled`，并补三类回归测试：普通完成、`agent_end { willRetry: true }` 后继续、压缩后继续。超时路径要调用 abort/stop 并等待子进程退出后才把 step 标为终态。

### P1：引入 Pi 专用的 Runtime 深模块

新建 pi-studio 自己的最小接口，而不是让 `RpcClient` 类型流向多个域：

```ts
interface PiRuntime {
  open(request: OpenAgentRequest): Promise<AgentRunHandle>
  listSessions(workspace: string): Promise<SessionSummary[]>
  readSession(id: string, fromSeq?: number): Promise<SessionPage>
  capabilities(): PiRuntimeCapabilities
}

interface AgentRunHandle {
  readonly id: string
  readonly sessionId: string
  send(input: UserInput): Promise<string>
  cancel(reason: string): void
  whenIdle(): Promise<void>
  events(fromRevision?: number): AsyncIterable<StudioAgentEvent>
  dispose(): Promise<void>
}
```

这不是提前抽象“多 Agent provider”。产品仍然只有 Pi；`PiRuntime` 的深度来自它把启动、idle/cancel、会话读取和事件规范化隐藏在一个小接口后面。真正的 seam 只放在已存在的变化点：生产使用 stdio `RpcClient` adapter，测试/回放使用 in-memory adapter。现有 `pi-client.ts` 可以逐步变成实现细节，Pi 版本变化只在此处吸收，Routine、remote、renderer、测试不再分别理解 Pi 的事件语义。

同时给 runtime 做启动 handshake：engine version、protocol version、capabilities（list/resume/fork/subagent/approval/images/compact）、session format version。缺能力时 UI 明确降级，不通过 try/catch 猜测。

### P1：增加 RunProfileCompiler，消除四条启动链漂移

当前 chat、Routine、code-model、blender-model 分别组装 provider、model、env、CLI、sandbox、扩展和 thinking level；其中 chat/Routine 还会写同一个全局 `agentConfigDir()/extensions`。这使“某类运行究竟拥有什么能力”变成调用顺序和共享文件状态的副作用。

建立一个深模块：

```ts
type RunKind = 'chat' | 'routine' | 'code-model' | 'blender-model'

type CompiledRunProfile = {
  cwd: string
  provider: string
  model?: string
  env: Record<string, string>
  cliPath: string
  args: string[]
  sandbox: ExecutionSecuritySnapshot
  profileDigest: string
}

interface RunProfileCompiler {
  compile(kind: RunKind, workspace: string): Promise<CompiledRunProfile>
}
```

它应该把 app-owned Pi extensions 作为显式 `-e/--extension` 参数传入，而不是在每次启动前改写共享扩展目录。交互 chat 可以保留用户扩展发现；无人值守 Routine 应使用 `--no-extensions` 后只显式装载审核过的扩展，并给出确定性的工具 allowlist。code-model 至少应禁用不需要的 Bash/网络能力；blender-model 还要把“生成代码”和“宿主执行代码”分别建模，因为后者不受 Pi 子进程沙箱保护。每次运行记录 `profileDigest`，诊断和 replay 才知道当时真实启用了什么。

### P1：把事件投影放到 main，形成一致读模型

不要复制 DeepSeek 的全部 Session 实现，也不要与 Pi 对话日志竞争“唯一事实源”。可采用两层：

1. Pi JSONL 仍是模型对话的执行事实。
2. runtime 把 live event 与冷日志规范化为 `StudioAgentEvent { seq, sessionId, type, data }`。
3. main 注册纯投影：`conversation`、`runtime`、`toolExecutions`、`approvals`、`usage`、`artifacts`、`changeset`。
4. IPC 提供 `snapshot(sessionId)` 与 `changes(afterSeq)`；renderer 只渲染 whole-value snapshot。

先迁移 `AgentRuntimeTracker` 和 ToolCall/approval，最后迁移完整消息列表。这样可以消除 ChatPane 重挂载、后台会话审批缓存和远程端事件漏收产生的状态分叉。

### P1：把 Routine 从 type switch 提升为运行时

保留现有可视化节点和数据模型，但引入：

```ts
type WorkflowRunState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

interface WorkflowNodeDefinition<I, O> {
  type: string
  inputSchema: Schema<I>
  outputSchema: Schema<O>
  execute(input: I, ctx: NodeContext): Promise<O>
  present?(output: O): NodePresentation
}

interface WorkflowRunHandle {
  result: Promise<WorkflowResult> // 永不 reject，错误进入封闭终态
  cancel(reason?: string): void
  dispose(): Promise<void>
}
```

每个 run/step 的 start/end、输入引用、输出摘要、artifact、审批和错误都即时写 SQLite，而不是完成后才整体保存。`review` 是 `waiting` 状态，不是悬空 Promise；Electron 重启后可恢复或明确标记 interrupted。现有 `folder-input/imagegen/model3d/...` nested ternary 改为 node registry，新增节点不再修改核心 executor。[现有 dispatch](https://github.com/GreenBeanLiu/pi-studio/blob/2d22b52db1e52e843888a3d19ccf144d8db0540e/src/main/routines.ts#L766-L838)

### P1：建立评测与 replay

新增一个无 UI 的 pi-studio eval driver，不需要训练系统：

- 输入：task id、workspace fixture、prompt、engine/model/security profile、timeout。
- 输出：final response、finish reason、事件 JSONL、tool calls、token/latency、workspace diff、artifact 清单。
- grader：先支持 exit code、测试命令、文件断言和 diff 规则；LLM judge 是可选层。
- 每个 case 使用独立 checkout 和 session id；断言重新读文件/运行测试，不采用 agent 自报完成。
- 允许从成功运行录制 LLM stream，测试时 replay 到真实 adapter/projector/UI，固定事件时序和异常分支。

优先覆盖当前最脆弱的场景：重试、compaction、工具审批、后台会话切换、Routine review、sandbox unavailable、agent 进程崩溃恢复。

### P2：统一工具策略和 Job/Subagent 生命周期

受限于 Pi 工具在子进程内执行，短期不能照搬 DeepSeek 的整个 `ToolRuntime`。可以先定义跨进程稳定 envelope：

```ts
type ToolExecutionEnvelope = {
  callId: string
  sessionId: string
  runId: string
  tool: string
  action: 'read' | 'write' | 'execute' | 'network' | 'credential' | 'external-side-effect'
  argsSummary: unknown
  policy: { decision: 'allow' | 'deny' | 'ask'; reason?: string }
  result?: { status: 'ok' | 'error' | 'cancelled'; summary: string; artifactIds?: string[] }
}
```

把 path policy、命令 policy、审批、沙箱 enforcement 和 UI 卡片都投影自同一个 envelope。策略合并必须是单调的：任一强制 deny 不可被后续 allow 覆盖，ask 只有 `allowed-once` 才放行；非交互 Routine 默认不可回答时 fail closed。

Subagent 与后台 chat 则统一注册为 `Job`：owner session、parent lineage、状态、cancel、done、output cursor、resource cleanup。当前 `MAX_LIVE_AGENTS = 4` 的 LRU 可保留，但应该建立在 Job registry 上，而不是只靠 `AgentEntry[]` 和 UI 前后台概念。

## 10. 推荐实施顺序与验收

| 顺序 | 交付 | 关键验收 |
| --- | --- | --- |
| 1 | 修复 guard/sandbox 真值和 Routine settled 语义 | sandbox 关时 UI 明示 full access；retry/compaction 不提前完成 Routine |
| 2 | `PiRuntime` + capability handshake | Pi 升级相关代码集中；Routine/chat/remote 使用同一 idle/cancel 语义 |
| 3 | `RunProfileCompiler` | 四条启动链能力一致；无人值守运行可审计、最小权限且不再争用全局扩展目录 |
| 4 | main-side event normalizer + tool/approval projections | reload、切会话、手机重连后状态一致；审批有完整审计记录 |
| 5 | WorkflowRun + node registry + durable step journal | 可取消、可中断恢复；新增节点不改 executor switch |
| 6 | eval driver + record/replay | 无 API key 可重放典型会话；真实 e2e 验证 workspace 结果 |
| 7 | per-call policy + Job/Subagent registry | 非交互 fail closed；后台任务有 owner、终态和资源回收证据 |

不建议现在做三件事：不把 pi-studio 整体迁移到 Cordis；不直接嵌入 DeepSeek Harness 作为第二套 agent 内核；不为了追求“插件化”把每个现有函数拆成 package。先统一事件、生命周期、安全和评测契约，收益最大，也最容易在现有产品中渐进落地。
