# Slice D 跨版本验收证据包

日期：2026-09-15。范围：Mobile `applyCanonicalResolution`（master `02db8c65`）与 Runtime
`POST /execution-targets/resolve` 的跨版本安全边界。

**目的：**在删除 Mobile `executionTarget` 兼容镜像之前，用自动化契约测试 + 人工清单证明
预检→写回→提交路径不会发明设备、不会在预检时写库、并在旧 Runtime 上可回退。

**权威契约：**[Target Resolution v1](contracts/target-resolution-v1.md)。
**架构切片：**[架构解耦审查 · Slice D](architecture-decoupling-review-2026-09-13.md)。
**相关记录：**[目标解析发布](target-resolution-rollout-2026-09-14.md)、
[工作区解析收敛](workspace-resolution-2026-09-14.md)。

> 本轮**不删除** `executionTarget` 兼容镜像。镜像删除须等下方「解锁条件」全部满足。

---

## 1. 验收场景矩阵

| # | 场景 | 期望 | 自动化门禁 | 实机/生产清单 |
| --- | --- | --- | --- | --- |
| 1 | Cloud agent，无本地工具 | resolve：`agent_target=personal-agent-engine`，`tool_target=null`；apply 不钉电脑、清除 `toolTarget`，`executionTarget` 镜像 Agent | Mobile unit + Runtime `test_cloud_only_intent_has_no_local_gateway` | ☐ 未跑（无生产 token） |
| 2 | native-tools + `workspace_id` | resolve 返回绑定路径与 repository；apply 写回 `agentTarget`/`toolTarget`/`executionMode`/`workspaceId`，`executionTarget` 仍镜像工具电脑 | Mobile unit + Runtime `test_preview_and_execution_share_binding_without_preview_side_effects` | ☐ 未跑 |
| 3 | `selection_complete=false`（类路由） | apply **不得**发明钉死的 `pi-studio:<id>`；保留裸 `pi-studio` + `requires`；仅可同步 `executionMode` | Mobile unit（含「即便 resolution 带了 tool_target 也不钉」）+ Runtime `test_legacy_generic_device_remains_an_explicitly_unresolved_selector` | ☐ 未跑 |
| 4 | 结构化拒绝 422/409 | 客户端解析 `detail.code`（`invalid_intent` / `unroutable` / `target_unavailable` 等），阻断提交 | Mobile `harness.test.ts` + Runtime `test_rejected_intents_*` / `test_submit_uses_the_same_structured_rejections_as_resolve` | ☐ 未跑 |
| 5 | 404 / 503 resolve 不可用 | `resolveExecutionTargets` → `{status:'unavailable'}`；提交走本地意图原样路径（不 apply） | Mobile unit（404 + `resolution_unavailable`） | ☐ 未跑 |
| 6 | 正式提交决策与预检一致 | Runtime：`routed[0]`（去 task/subtask id）== `resolution.decision`；Mobile：apply 输出轴 == resolve 字段 | Runtime 已断言；Mobile apply 字段对齐 unit | ☐ 未跑 |
| 7 | 预检不创建 tasks / tool_ops | resolve（含 `run=true`）后 `list_tasks()==[]`，无 executor/route 调用 | Runtime `test_preview_and_execution_share_binding_without_preview_side_effects`、`test_rejected_intents_have_structured_reasons_and_create_no_tasks` | ☐ 生产侧已有 2026-09-14 计数证据（见发布记录）；本轮未复测 |

### 自动化 vs 人工

- **绿门（合并前必须绿）：** Mobile Vitest（本证据包配套 PR）+ Runtime 既有 `tests/test_target_resolution.py`（已在 Runtime main）。
- **人工清单：**上表 ☐ 行。无 `HARNESS_SHARED_TOKEN` / 生产访问时**不得编造** live 结果；保持未勾选。

---

## 2. Mobile 行为锁（`02db8c65` 起）

| 行为 | 位置 | 说明 |
| --- | --- | --- |
| 预检成功后写回规范轴 | `applyCanonicalResolution` | 写 `agentTarget` / `toolTarget` / `executionMode` / `workspaceId` |
| 兼容镜像 | 同函数 | `executionTarget` 在 native-tools 时镜像 `toolTarget`，否则镜像 `agentTarget`；**保留，不删** |
| 类选择未完成 | `selection_complete === false` | 提前返回；不钉设备；不改 `requires` |
| 404/503 回退 | `HarnessClient.resolveExecutionTargets` | 返回 `unavailable`；`HarnessHomeScreen.submit` 仅在 `resolved` 时 apply |
| 业务拒绝 | `HarnessError` + `formatHarnessError` | 422/409 带 code 时阻断提交并展示中文标签 |

配套测试强化（Mobile PR）：

- Cloud-only apply 清除 `toolTarget`、不以电脑为镜像。
- native-tools + workspace 字段对齐 resolve。
- `selection_complete=false` 即使 resolution 误带 `tool_target` 也不钉。
- apply 输出与 resolve 轴字段一一相等（场景 6 的客户端侧）。
- resolve 的 422 `invalid_intent` / 409 `target_unavailable` 结构化解析。

---

## 3. Runtime 已覆盖（无需本轮改生产代码）

文件：`personal-agent-runtime/tests/test_target_resolution.py`（发布基线含 `1657509` 及后续结构化拒绝提交对齐）。

已锁定：

1. 预检与执行共享 binding，预检零副作用。
2. Cloud-only 无本地网关。
3. 裸 `pi-studio` → `selection_complete=false`。
4. 422/409 结构化 code，且不建任务。
5. 正式 submit 与 resolve 使用同一套拒绝。
6. `resolution.decision` 与正式路由事件对齐。
7. 无路由器 → 503 `resolution_unavailable`。

生产预检计数证据（2026-09-14，见 [目标解析发布](target-resolution-rollout-2026-09-14.md)）：
四次预检前后 tasks/tool_operations/native_agent_sessions 计数不变。

---

## 4. 如何证明「正式提交 = 预检」（场景 6）

**Runtime（自动化，已有）：**

1. `POST /execution-targets/resolve` 取得 `resolution` 与 `decision`。
2. `POST /providers/pi-studio/commands` 创建任务并执行路由。
3. 断言执行使用的 `task.workspace == resolution.workspace`。
4. 断言路由事件（去掉 `task_id`/`subtask_id`）== `resolution.decision`。

**Mobile（自动化，本包加强）：**

1. 用 fixture resolution 调用 `applyCanonicalResolution`。
2. 断言输出的 `agentTarget` / `toolTarget` / `executionMode` / `workspaceId` /
   `executionTarget` 镜像规则与 resolution 字段一致。

**实机（人工，可选）：**

1. 对同一意图先 resolve，记录响应。
2. 提交任务，对比任务记录上的 `agent_target` / `tool_target` / workspace。
3. 不应出现 resolve 未给出的钉死设备。

---

## 5. 镜像删除解锁条件

| 条件 | 现状 |
| --- | --- |
| Mobile Slice D apply 已合入默认分支 | ✅ `02db8c65` on `pi-studio-mobile` master |
| Mobile 场景 1–6 的 unit/fixture 绿 | ⏳ 见配套 Mobile PR CI |
| Runtime 预检零副作用 + 拒绝码测试仍绿 | ✅ 已在 Runtime main |
| 旧 Runtime 404/503 回退有自动化 | ✅ Mobile `resolveExecutionTargets` tests |
| 生产/实机矩阵（上表 ☐）至少覆盖场景 1、2、3、5 各一次 | ❌ 本轮无 token，未勾选 |
| 产品确认所有仍在线的客户端已升级到含 apply 的版本，或可接受去掉镜像 | ❌ 需人工产品判断 |

**结论：镜像删除尚未解锁（no）。**

原因：自动化门禁可在 CI 绿后视为客户端契约侧就绪，但跨版本实机矩阵与「全客户端已升级」仍缺；
且契约原文要求「经过跨版本验证后再评估删除兼容镜像」。在 ☐ 行勾选且产品确认前，
**保留 `executionTarget` 镜像。**

---

## 6. 明确不做

- 不删除 `executionTarget` 字段或生成逻辑。
- 不改动 `autoPlan` / `workspaceReach` 等并行能力。
- 不调用生产 Runtime 编造 live 结果。
- 不把预检当作批准或设备预留。
