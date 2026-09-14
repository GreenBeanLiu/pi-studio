# 目标解析预检发布记录

2026-09-14 22:34（Asia/Shanghai），Runtime `1657509` 已从 `94d0ddd` 升级并激活；
Engine 保持 `f253331`。本轮不改变 Mobile 现有提交协议。

## 代码与验证

- 新增 `POST /execution-targets/resolve`，契约见 [Target Resolution v1](contracts/target-resolution-v1.md)。
- 预检和正式提交共用 ProviderCommand 归一化；预检与执行共用 RoutingExecutor 的路由选择。
- 返回目标、工作区路径、环境能力需求和结构化拒绝原因，不创建任务、模型调用或工具操作。
- Runtime 全量 **530 passed**，一个既有 Starlette/httpx 弃用警告。
- 回归覆盖别名兼容、路径解析、平台选择、缺失绑定、冲突/离线拒绝、认证、无副作用与正式执行结果一致。
- 响应 fixture 位于 Runtime `tests/fixtures/target-resolution-v1.json`。

## 公网预检证据

使用服务认证访问 `https://trail-api.glanger.xyz/harness/execution-targets/resolve`：

| 场景 | 结果 |
| --- | --- |
| 云端 Agent + Mac 工具，workspace_id，无路径，run=true | HTTP 200，解析到 Mac 注册目录，advisory=true |
| 纯云端 Agent | HTTP 200，无工具设备，无本地路径 |
| 未注册 workspace_id | HTTP 422，invalid_intent |
| workspace_id 与 repository 冲突 | HTTP 422，invalid_intent |

Mac 目标：`pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320`。
工作区：`ws_6d93f9513759492d9d4d819451eaef4f`。
解析路径：`/Users/glanger/Works/pi-e2e-local-list.hHcH8i`。

四次预检前后数据库计数一致：tasks=120、tool_operations=109、native_agent_sessions=22。
没有创建验收任务，所以本轮没有新的 task ID；此前真实执行与重启恢复证据仍见
[工作区发布与恢复实测](workspace-runtime-rollout-2026-09-14.md)。

响应 `gateway_status=online` 来自设备库存；`tool_capabilities_verified=false` 保留未进行实时工具握手的事实。
这次预检不代替真实工具执行，也不证明物理断网或桌面崩溃恢复。

## 发布与后续

使用既有激活脚本检查空闲队列、备份数据库和旧 wheel、重装服务包并重启 API/Worker。
回滚目录：`/home/ubuntu/personal-harness/shared/native-rollout-20260914T143408Z-1657509`。
两服务发布后均 active/running，自动重启计数为 0。

下一步为 Mobile 接入可选预检和结构化错误展示，保留旧 Runtime 的 404/503 回退及旧字段兼容。
当前用户无需重装手机或 Mac；预检成功不能充当批准或设备预留。
