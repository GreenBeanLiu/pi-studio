# Pi Studio 共享记忆

Pi Studio 现在提供一个本机共享记忆层，供 Pi Studio、其他 Pi 进程以及 Claude Code/Codex 等外部 Agent 使用。

## 设计

- 服务只监听 `127.0.0.1`，不会暴露到局域网或公网。
- 数据存放在 Pi Studio 用户数据目录下的 `pi-agent/shared-memory.sqlite3`（`node:sqlite`，WAL）。
- 服务启动后会生成 `pi-agent/shared-memory.connection.json`，里面有临时端口、Bearer token 和数据文件路径；退出时删除。
- 记忆分为 `global` 和 `workspace` 两种 scope：前者所有工作区可见，后者只对对应项目可见。
- Agent 启动前根据当前 prompt 检索最多 8 条相关记忆；Agent 也会获得 `memory_search`、`memory_save`、`memory_list` 工具。
- 不自动保存整段对话。只有 Agent 明确调用 `memory_save` 或外部客户端调用写入接口时才会保存，避免把临时内容和秘密写进长期记忆。

### 检索

FTS5 索引 + bm25 排序。Electron 内置的 SQLite 没有编 ICU，也就没有中文分词器，所以入库时把
连续的汉字段切成**重叠二元组**再交给 `unicode61`，查询侧做同样切分后用 `OR` 连接
（`src/main/memory-segment.ts`）。这样「怎么打包」能命中「打包命令是 pnpm package:mac」——
迁移前那版关键词匹配只做字面子串比较，这类查询一条都搜不到。

`score` 是同一次查询内的相对分（bm25 取负，越大越相关）。语料很小时它的绝对值会非常接近 0，
不要跨查询比较，也不要拿它做阈值。已知限制：索引里只有二元组，单个汉字的查询命中不了。

### 写入者只有一个

SQLite 库只由 Electron 主进程写，外部一律走 HTTP。主进程每次保存或删除后会把全库导出成
只读镜像 `pi-agent/shared-memory.snapshot.json`；沙箱里的 agent 够不到 `127.0.0.1` 时，
内置扩展降级去读这份镜像（`PI_STUDIO_MEMORY_FILE` 指向它）。**降级只读**——降级状态下
`memory_save` 直接报错，不会绕过服务落盘，因此不存在两个写者互相覆盖的问题。

### 从 JSON 迁移

首次启动会把旧的 `shared-memory.json` 在一个事务里导入 SQLite，并另存
`shared-memory.json.backup-v1`，之后不再读它。条目的 `id`、`createdAt`、`accessCount` 原样保留。
旧的连接文件 `shared-memory.json.connection.json` 会被删除，以免外部 adapter 指向一个已经关掉的端口。

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

推荐给其他 Agent 写一个很薄的 adapter，而不是让它们直接打开 `shared-memory.sqlite3`：

1. 读取 `shared-memory.connection.json`。
2. 用 `url + Bearer token` 调用 API。
3. 在 Agent 开始任务前调用 `/v1/search`。
4. 只有用户确认的长期事实才调用 `/v1/memories` 写入。

直接读 `shared-memory.snapshot.json` 只适合 Pi Studio 沙箱内部的降级只读路径；外部客户端应使用 HTTP API，以获得写入、认证和统一检索行为。SQLite 库本体不要直接打开——它只有主进程一个写者。

## 当前限制

这是关键词检索（FTS5 + 二元组），不是向量检索，也没有自动记忆摘要、embedding、冲突合并和时间衰减。
下一步可以加 embedding 检索，兼容 MemOS/Memmy 的记忆导入。
