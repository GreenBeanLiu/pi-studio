# Pi Studio 共享记忆

Pi Studio 现在提供一个本机共享记忆层，供 Pi Studio、其他 Pi 进程以及 Claude Code/Codex 等外部 Agent 使用。

## 设计

- 服务只监听 `127.0.0.1`，不会暴露到局域网或公网。
- 数据默认存放在 Pi Studio 的用户数据目录下：`pi-agent/shared-memory.json`。
- 服务启动后会生成同名的 `shared-memory.json.connection.json`，里面有临时端口、Bearer token 和数据文件路径。
- 记忆分为 `global` 和 `workspace` 两种 scope：前者所有工作区可见，后者只对对应项目可见。
- Agent 启动前根据当前 prompt 检索最多 8 条相关记忆；Agent 也会获得 `memory_search`、`memory_save`、`memory_list` 工具。
- 不自动保存整段对话。只有 Agent 明确调用 `memory_save` 或外部客户端调用写入接口时才会保存，避免把临时内容和秘密写进长期记忆。

## HTTP API

从 `.connection.json` 读取 `url` 和 `token`，请求添加：

```http
Authorization: Bearer <token>
Content-Type: application/json
```

### 搜索

```bash
curl -X POST "$URL/v1/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"打包命令","workspacePath":"D:/Works/pi-studio","limit":8}'
```

### 写入

```bash
curl -X POST "$URL/v1/memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"发布前运行 pnpm verify","scope":"workspace","workspacePath":"D:/Works/pi-studio","tags":["release"],"source":"codex"}'
```

### 列表和删除

```bash
curl "$URL/v1/memories?workspacePath=D:/Works/pi-studio" \
  -H "Authorization: Bearer $TOKEN"
curl -X DELETE "$URL/v1/memories/<id>" \
  -H "Authorization: Bearer $TOKEN"
```

## 接入其他 Agent

推荐给其他 Agent 写一个很薄的 adapter，而不是让它们直接解析 `shared-memory.json`：

1. 读取 `shared-memory.json.connection.json`。
2. 用 `url + Bearer token` 调用 API。
3. 在 Agent 开始任务前调用 `/v1/search`。
4. 只有用户确认的长期事实才调用 `/v1/memories` 写入。

直接读 JSON 只适合 Pi Studio 沙箱内部的降级路径；外部客户端应使用 HTTP API，以获得并发写入、认证和统一检索行为。

## 当前限制

这是第一版关键词检索，不是向量检索，也没有自动记忆摘要、embedding、冲突合并和时间衰减。下一步可以把 `SharedMemoryStore` 替换为 SQLite + FTS5，保留同一套 HTTP API；再往后添加 embedding 检索，兼容 MemOS/Memmy 的记忆导入。
