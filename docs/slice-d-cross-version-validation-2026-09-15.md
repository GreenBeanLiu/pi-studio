# Slice D 跨版本验收证据包

日期：2026-09-15。范围：Mobile `applyCanonicalResolution`（master `02db8c65`）与 Runtime
`POST /execution-targets/resolve` 的跨版本安全边界。

**目的：**用自动化契约测试 + 人工清单证明预检→写回→提交路径不会发明设备、不会在预检时写库、
并在旧 Runtime 上可回退；**随后（2026-09-15 product confirmation）解锁并删除** Mobile
`executionTarget` 兼容镜像（见 Mobile PR `#5`）。

**权威契约：**[Target Resolution v1](contracts/target-resolution-v1.md)。
**架构切片：**[架构解耦审查 · Slice D](architecture-decoupling-review-2026-09-13.md)。
**相关记录：**[目标解析发布](target-resolution-rollout-2026-09-14.md)、
[工作区解析收敛](workspace-resolution-2026-09-14.md)。

> **镜像删除已解锁并落地。** Product confirmation ✅ 2026-09-15（Eng chat 用户确认）；
> Mobile PR [`#5`](https://github.com/GreenBeanLiu/pi-studio-mobile/pull/5) 删除 `executionTarget` / `execution_target` 兼容镜像。

---

## 1. 验收场景矩阵

| # | 场景 | 期望 | 自动化门禁 | 实机/生产清单 |
| --- | --- | --- | --- | --- |
| 1 | Cloud agent，无本地工具 | resolve：`agent_target=personal-agent-engine`，`tool_target=null`；apply 不钉电脑、清除 `toolTarget`，**不写** `executionTarget`（镜像已删） | Mobile unit + Runtime `test_cloud_only_intent_has_no_local_gateway` | ☑ 2026-09-15 22:20 CST 生产 HTTP 200（见 §1.1） |
| 2 | native-tools + `workspace_id` | resolve 返回绑定路径与 repository；apply 写回 `agentTarget`/`toolTarget`/`executionMode`/`workspaceId`，**不写** `executionTarget` | Mobile unit + Runtime `test_preview_and_execution_share_binding_without_preview_side_effects` | ☑ 同次；路径回写，repository 该工作区未注册（见 §1.1） |
| 3 | `selection_complete=false`（类路由） | apply **不得**发明钉死的 `pi-studio:<id>`；保留裸 `pi-studio` + `requires`；仅可同步 `executionMode` | Mobile unit（含「即便 resolution 带了 tool_target 也不钉」）+ Runtime `test_legacy_generic_device_remains_an_explicitly_unresolved_selector` | ☑ 同次打了裸 `pi-studio` + `requires=["workspace.local"]`。**现网两台都在线时 Runtime 会选完**（`selection_complete=true`，钉 Windows）。未完成选择仍由 unit 覆盖。 |
| 4 | 结构化拒绝 422/409 | 客户端解析 `detail.code`（`invalid_intent` / `unroutable` / `target_unavailable` 等），阻断提交 | Mobile `harness.test.ts` + Runtime `test_rejected_intents_*` / `test_submit_uses_the_same_structured_rejections_as_resolve` | ☑ 同次：未注册 workspace 422 `invalid_intent`；workspace/repo 冲突 422 `invalid_intent` |
| 5 | 404 / 503 resolve 不可用 | `resolveExecutionTargets` → `{status:'unavailable'}`；提交走本地意图原样路径（不 apply） | Mobile unit（404 + `resolution_unavailable`） | ☒ 本生产已部署 resolve，无法在此主机打出 404/503。覆盖面 = Mobile unit。 |
| 6 | 正式提交决策与预检一致 | Runtime：`routed[0]`（去 task/subtask id）== `resolution.decision`；Mobile：apply 输出轴 == resolve 字段 | Runtime 已断言；Mobile apply 字段对齐 unit | ☑ 2026-09-15 `task_c84db0cbaec1423f8cd7e1ac62517788`（见 §1.2） |
| 7 | 预检不创建 tasks / tool_ops | resolve（含 `run=true`）后 `list_tasks()==[]`，无 executor/route 调用 | Runtime `test_preview_and_execution_share_binding_without_preview_side_effects`、`test_rejected_intents_have_structured_reasons_and_create_no_tasks` | ☑ 同次复测：`GET /tasks?limit=20` 20 条 id 不变；`/runs?since=24h` count=3 不变；`/tool-operations` 0 条不变。2026-09-14 计数证据仍有效。 |

### 自动化 vs 人工

- **绿门（合并前必须绿）：** Mobile Vitest（证据包配套 PR `#4`，已合 `15015fd`）+ Runtime 既有 `tests/test_target_resolution.py`（已在 Runtime main）。
- **人工清单：**上表生产列。无 token 时不得编造 live 结果。

### 1.1 2026-09-15 生产预检（`https://trail-api.glanger.xyz/harness`）

服务认证。§1.1 只打 `POST /execution-targets/resolve`（`run: false`）。§1.2 另建一条 **read_only** 任务核对提交决策。
Runtime health：`ok=true`，`executor=dsh`，进程自 2026-09-14T22:40Z 起。

在线执行器：云端 Engine；Mac `pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320`（GlangerdeMacBook-Air）；Windows `pi-studio:472bfcb2-506f-45f7-9fe3-b7689c1c4efd`（home-win）。

| 场景 | HTTP | 关键字段 |
| --- | --- | --- |
| S1 纯云端 | 200 | `execution_mode=desktop-agent`，`agent_target=personal-agent-engine`，`tool_target=null`，`selection_complete=true`，`workspace=null`，`advisory=true` |
| S2 native-tools + `ws_6d93f9513759492d9d4d819451eaef4f` | 200 | `execution_mode=native-tools`，`tool_target=pi-studio:ff1b3f56-…`，`workspace=/Users/glanger/Works/pi-e2e-local-list.hHcH8i`，`required_runtime_capabilities=["tool.local-files"]`，`gateway_status=online`，`tool_capabilities_verified=false` |
| S3 裸 `execution_target=pi-studio` + `requires=["workspace.local"]` | 200 | **现网完成选择**：`selection_complete=true`，钉 `pi-studio:472bfcb2-…`（Windows，decision.mode=`capability`，scores Win 7 / Mac 1）。不是 Mobile 发明设备。`selection_complete=false` 路径仍由 unit + Runtime `test_legacy_generic_device_remains_an_explicitly_unresolved_selector` 锁。 |
| S4 未注册 workspace | 422 | `detail.code=invalid_intent`，`workspace is not registered: ws_does_not_exist_slice_d` |
| S4b workspace/repo 冲突 | 422 | `detail.code=invalid_intent`，`repository conflicts with registered workspace: ws_216f613bdb394faeb4331f0a4494a8da` |

副作用：预检前后最近 20 个 task id 相同；24h runs count=3；tool_operations 空列表。

### 1.2 2026-09-15 S6 只读提交（同一意图先 resolve 再 create）

意图：native-tools + Mac 工具 + `ws_6d93f9513759492d9d4d819451eaef4f`，`risk=read_only`，`run=true`。
文案要求只列工作区根目录文件名、不改文件。

1. resolve 200：`decision={mode: native-tools, target: personal-agent-engine, agent_target: personal-agent-engine, tool_target: pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320}`，`workspace=/Users/glanger/Works/pi-e2e-local-list.hHcH8i`。
2. `POST /providers/pi-studio/commands` 200 → `task_c84db0cbaec1423f8cd7e1ac62517788` / `run_6354c18e8adb45d4b9ed04fa7a5151f3`，`execution_mode=native-tools`。
3. 任务 `spec` 的 `agent_target` / `tool_target` / `workspace` / `workspace_id` **全部等于** resolve。
4. 四次 `subtask.routed` 去掉 id 后均等于 `resolution.decision`。`workspace.bound` 路径与 resolve 相同。
5. 结束状态 `complete`。中途有 `tool.failed` 后重试（网关握手），**路由决策未变**。

---

## 2. Mobile 行为锁（`02db8c65` 起）

| 行为 | 位置 | 说明 |
| --- | --- | --- |
| 预检成功后写回规范轴 | `applyCanonicalResolution` | 写 `agentTarget` / `toolTarget` / `executionMode` / `workspaceId` |
| 兼容镜像 | 同函数 → Mobile PR `#5` | **已删除**（2026-09-15 product confirmation + live S6）。wire 不再发 `execution_target`；`commandFieldsFor.executionTarget` 仅作内部 class-routing → `agentTarget` |
| 类选择未完成 | `selection_complete === false` | 提前返回；不钉设备；不改 `requires` |
| 404/503 回退 | `HarnessClient.resolveExecutionTargets` | 返回 `unavailable`；`HarnessHomeScreen.submit` 仅在 `resolved` 时 apply |
| 业务拒绝 | `HarnessError` + `formatHarnessError` | 422/409 带 code 时阻断提交并展示中文标签 |

配套测试强化（Mobile PR `#4` → `15015fd`；镜像删除 Mobile PR `#5`）：

- Cloud-only apply 清除 `toolTarget`、**不包含** `executionTarget`。
- native-tools + workspace 字段对齐 resolve、**不包含** `executionTarget`。
- `selection_complete=false` 即使 resolution 误带 `tool_target` 也不钉。
- apply 输出与 resolve 轴字段一一相等（场景 6 的客户端侧）。
- serialize / resolve 请求体 **不发** `execution_target`。
- resolve 的 422 `invalid_intent` / 409 `target_unavailable` 结构化解析；404 fallthrough 保留。

---

## 3. Runtime 已覆盖（无需本轮改生产代码）

文件：`personal-agent-runtime/tests/test_target_resolution.py`（发布基线含 `1657509` 及后续结构化拒绝提交对齐）。

已锁定：

1. 预检与执行共享 binding，预检零副作用。
2. Cloud-only 无本地网关。
3. 裸 `pi-studio` → `selection_complete=false`（无在线路由候选 / legacy 选择器）。现网两台在线时会走 capability 打分并钉设备，见 §1.1 S3。
4. 422/409 结构化 code，且不建任务。
5. 正式 submit 与 resolve 使用同一套拒绝。
6. `resolution.decision` 与正式路由事件对齐。
7. 无路由器 → 503 `resolution_unavailable`。

生产预检计数证据：2026-09-14（见 [目标解析发布](target-resolution-rollout-2026-09-14.md)）以及 2026-09-15 复测（§1.1）。

---

## 4. 如何证明「正式提交 = 预检」（场景 6）

**Runtime（自动化，已有）：**

1. `POST /execution-targets/resolve` 取得 `resolution` 与 `decision`。
2. `POST /providers/pi-studio/commands` 创建任务并执行路由。
3. 断言执行使用的 `task.workspace == resolution.workspace`。
4. 断言路由事件（去掉 `task_id`/`subtask_id`）== `resolution.decision`。

**Mobile（自动化，本包加强）：**

1. 用 fixture resolution 调用 `applyCanonicalResolution`。
2. 断言输出的 `agentTarget` / `toolTarget` / `executionMode` / `workspaceId`
   与 resolution 字段一致，且 **不含** `executionTarget`。

**实机（人工，已做一次）：** 见 §1.2。

1. 对同一意图先 resolve，记录响应。
2. 提交任务，对比任务记录上的 `agent_target` / `tool_target` / workspace。
3. 不应出现 resolve 未给出的钉死设备。

---

## 5. 镜像删除解锁条件

| 条件 | 现状 |
| --- | --- |
| Mobile Slice D apply 已合入默认分支 | ✅ `02db8c65` on `pi-studio-mobile` master |
| Mobile 场景 1–6 的 unit/fixture 绿 | ✅ Mobile PR `#4` → `15015fd` |
| Runtime 预检零副作用 + 拒绝码测试仍绿 | ✅ 已在 Runtime main |
| 旧 Runtime 404/503 回退有自动化 | ✅ Mobile `resolveExecutionTargets` tests |
| 生产/实机矩阵至少覆盖场景 1、2、3、5 各一次 | ⚠ 1、2、3、6、7 已在生产勾选；**5 无法在已部署 resolve 的主机上复现**（unit 覆盖，可接受） |
| 产品确认所有仍在线的客户端已升级到含 apply 的版本，或可接受去掉镜像 | ✅ **2026-09-15 Eng chat 用户 product confirmation** |

**结论：镜像删除已解锁（yes），并已在 Mobile PR [`#5`](https://github.com/GreenBeanLiu/pi-studio-mobile/pull/5) 落地 / 合入中。**

依据：live S6 `task_c84db0cbaec1423f8cd7e1ac62517788` + resolve 已在 `trail-api.glanger.xyz` + 产品确认可删镜像。
本证据包原先的 hold **作废**。

---

## 6. 明确不做（证据包当时） / 后续已做

证据包起草时：
- ~~不删除 `executionTarget` 字段或生成逻辑。~~ → **已解锁并删除**（Mobile PR `#5`，2026-09-15）。
- 不改动 `autoPlan` / `workspaceReach` 等并行能力。（仍成立）
- 不把预检当作批准或设备预留。（仍成立）
- 本轮只创建了 §1.2 那一条 read_only 验收任务，无写入。（仍成立）
