# Tool Gateway Contract v1

> 状态：草案，基于 2026-09-13 生产闭环字段整理。
>
> 目标：固定 Runtime、Desktop、Mobile 之间的工具调用边界，不改变当前线上行为。

## 1. 版本关系

- `contract_version: 1`：本文件定义的跨仓库对象契约版本。
- `protocol_version: 2`：一次工具操作的 scope、deadline、幂等和审计协议版本。
- Desktop Relay 的命令 envelope 可以继续使用 camelCase；它是传输适配，不是另一套业务契约。
- Runtime/Mobile 的控制面 JSON 使用 snake_case。Desktop adapter 在进入本地 handler 前转换为内部 canonical object。

未知字段必须被忽略并记录诊断；未知的必需版本、工具或 scope 必须 fail closed，不能猜测执行。

## 2. Tool capabilities

Runtime 从设备能力握手得到以下结构的语义：

```json
{
  "manifest_version": 1,
  "operation_protocols": [1, 2],
  "tools": [
    {
      "name": "local.read",
      "scope_version": 1,
      "requires_workspace": true,
      "max_bytes": 65536
    }
  ]
}
```

现有 Desktop Relay 的 `toolGateway.manifestVersion`、`operationProtocols` 和 camelCase tool entries 由适配器映射到上述 canonical 结构。滚动升级期间，缺少 manifest 的旧桌面仍按兼容策略处理，但不能把缺少声明当成支持全部工具。

## 3. Tool operation request

控制面到设备网关的 canonical request：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "arguments": {
    "workspace": "/Users/example/Works/demo",
    "path": "README.md"
  },
  "idempotency_key": "idem-example-001",
  "scope": {
    "workspace": "/Users/example/Works/demo",
    "permissions": ["local.read"]
  },
  "deadline_at": "2026-09-13T01:00:00+00:00",
  "audit": {
    "approved_capabilities": []
  }
}
```

必需字段：`operation_id`、`task_id`、`subtask_id`、`call_id`、`target_id`、`tool_name`、`arguments`、`source`、`protocol_version`。

当 `protocol_version >= 2` 时还必须有：

- 非空 `idempotency_key`
- 带时区的 `deadline_at`
- `scope.workspace`，且必须等于 `arguments.workspace`
- `scope.permissions`，且必须包含 `tool_name`
- Shell 工具额外要求 `scope.permission` 与命令所需权限一致

设备网关必须重新校验 scope、活动工作区和 deadline，不能只信任 Runtime 的预检查。

## 4. Tool operation result

成功结果：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "ok": true,
  "result": {
    "path": "README.md",
    "content": "# Demo\n",
    "bytes": 7,
    "encoding": "utf-8"
  },
  "error": null
}
```

结构化失败结果：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "ok": false,
  "result": {},
  "error": {
    "code": "ENOENT",
    "message": "file does not exist"
  }
}
```

`error.code` 是机器可判断的稳定值；`error.message` 只用于诊断和 UI。当前至少保留：`INVALID_TOOL_OPERATION`、`INVALID_TOOL_ARGUMENTS`、`UNSUPPORTED_TOOL`、`UNSUPPORTED_TOOL_PROTOCOL`、`INVALID_DEADLINE`、`DEADLINE_EXPIRED`、`SCOPE_MISMATCH`、`WORKSPACE_MISMATCH`、`EEXIST`、`ENOENT` 和 `LOCAL_FILE_ERROR`。

## 5. Resume envelope

Runtime 把设备结果回灌 Agent loop 时，必须保留 `operation_id`、`call_id`、`tool_name`、`ok`、`result` 和 `error`。不得仅用自然语言拼接结果，也不得在恢复时重新生成一个新的 `call_id`。

`waiting_for_async_tool` 只表示 Runtime 正在等待这一次 operation；它不是设备连接状态，也不是 Mobile 自己推导的终态。

## 6. 适配器边界

| 端 | canonical contract 责任 | 传输适配 |
| --- | --- | --- |
| Runtime | 生成、持久化、校验、resume | HTTP API、Backend Relay、Provider transcript |
| Desktop | 本地能力和执行结果符合契约 | camelCase Relay envelope、当前工作区和 OS 文件 API |
| Mobile | 读取任务/操作/能力并做 UI 投影 | Runtime API 字段转换和旧版本兼容 |
| Backend | 不解释 operation payload | 认证、房间、帧转发、controller token |

Backend 不应根据 `tool_name` 执行路由或修改结果；它只负责把已认证的帧送到目标设备。

## 7. Fixture 使用规则

`fixtures/` 中的样例是跨仓库兼容测试输入，不是生产配置：

- 每个 fixture 必须能被 Python Runtime、Desktop TypeScript 和 Mobile TypeScript 解析。
- fixture 的字段变更必须同时更新本文件、兼容测试和版本说明。
- 添加可选字段不升级 contract version；改变必需字段、错误语义或幂等语义时升级版本。
- 新 Desktop 先支持 v1 contract + protocol v2，再删除旧字段兼容。
