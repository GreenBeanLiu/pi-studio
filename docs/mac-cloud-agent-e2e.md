# Mac 云端 Agent / 本地工具 E2E 验收

更新日期：2026-09-13。测试入口为手机 Harness，执行链路为云端 Agent -> ToolTransport -> 指定 Mac -> 云端续跑。

本轮重点是 `local.list` 目录枚举，以及此前出现的重复执行和工作区选择问题。

验收状态：用户在 2026-09-13 反馈“验收过了。没问题”。记录为用户实测通过；本次反馈未附逐项 task ID、操作记录和构建 SHA，不补造这些证据。以下步骤保留用于后续回归，不代表后续所有 Runtime 版本自动通过。

## 1. 版本与更新

| 组件 | 本轮基线 | 操作 |
| --- | --- | --- |
| pi-studio Mac | 包含 `be68c3b`；`9476d1c` 为后续文档提交 | 拉取 master，重新构建并安装 |
| Runtime | 上轮已部署 `297e46e` | 本次手动测试无需重新部署；复测时保留实际版本 |
| Engine | `0cdd839` | 本轮无新增代码要求 |
| 手机 | 使用当前已安装、支持云端 Agent 和已注册工作区选择的版本 | `local.list` 本身不要求重新安装手机端 |

Mac 在 pi-studio 仓库中执行；若仓库不在下列位置，先进入实际目录：

```bash
cd ~/Works/pi-studio
git status --short
git pull --ff-only origin master
git rev-parse HEAD
git merge-base --is-ancestor be68c3b HEAD
pnpm --version
pnpm install --frozen-lockfile
pnpm run package:mac
open dist
```

逐条执行，遇到失败先停下并保留输出。工作区有自己的改动时先保留，不要 reset；无法快进也不要强行覆盖。pnpm 应为仓库指定的 `10.6.1`。

`package:mac` 当前打包 Apple Silicon（arm64），包含完整验证，不会上传发布。Intel Mac 不直接使用此包。若测试或构建失败，记录失败项和 HEAD，不能当作已经安装成功。

完全退出旧 pi-studio，打开本次生成的 DMG，将应用替换到 Applications，再从 Applications 启动。保留原有应用数据和配对信息，不需要卸载清空。Mac 不会自动收到这次能力更新；只拉代码或关闭窗口都不等于更新了运行中的应用。

记录构建 HEAD；界面版本号可能仍是 `0.13.0`，不能只靠版本号证明包含修复。

## 2. 准备可核对的测试工作区

在 Mac 终端创建独立测试目录。以下是人工准备测试数据，不属于 Agent 的只读操作：

```bash
E2E_DIR=$(mktemp -d "$HOME/Works/pi-e2e-local-list.XXXXXX")
mkdir "$E2E_DIR/folder"
printf 'local-list-e2e-%s\n' "$(uuidgen)" > "$E2E_DIR/folder/probe.txt"
printf 'alpha\n' > "$E2E_DIR/alpha.txt"
printf 'bravo\n' > "$E2E_DIR/bravo.txt"
ln -s folder "$E2E_DIR/link-folder"
printf 'Workspace: %s\n' "$E2E_DIR"
cat "$E2E_DIR/folder/probe.txt"
shasum -a 256 "$E2E_DIR/alpha.txt" "$E2E_DIR/bravo.txt" "$E2E_DIR/folder/probe.txt"
```

记录路径、随机标记和三个哈希。不要把随机标记填进手机任务提示词，它用于证明模型确实读取了 Mac 文件。

根目录应恰好有四项，按工具排序为：

| 名称 | 类型 |
| --- | --- |
| alpha.txt | file |
| bravo.txt | file |
| folder | directory |
| link-folder | symlink |

测试期间不要向目录增加其他文件；若 Finder 等软件新增了隐藏文件，也属于真实条目，应先核对实际目录再判断数量差异。

在 Mac pi-studio 打开这个目录作为当前工作区，确认远程控制已开启且 Mac 在线。测试期间保持应用打开、Mac 不休眠、当前工作区不切换。

## 3. 手机 Harness 设置

1. Agent 运行位置选“云端”。选“Mac”代表让 Agent 在 Mac 运行，不是本轮链路。
2. 本地工具选这台 Mac 的设备名称；不要选 Windows、任意电脑或“不使用”。
3. 权限选“只读”。
4. 工作区选刚才 Mac 上报的测试目录对应的已注册工作区，不选“手动仓库”。
5. 每个用例新建一个任务，只点一次“提交并执行”，记录各自任务 ID。

如果选不了工作区：先核对 Mac 当前打开的目录，等待库存同步后刷新手机；横向滚动工作区选项，确认目标目录出现。仍只有其他仓库时记录设备名、目录、构建 HEAD 和界面状态，不要选一个不匹配的仓库继续测。

注意：“Mac 在线”只证明连接存在，不证明工作区已经注册，也不证明已安装 `local.list`。设备能力握手应包含 `local.list`，其 `scopeVersion=1`、`maxEntries=200`；这是工具 scope 版本，实际操作仍应使用 ToolOperation 协议 v2。手机未展示清单时，后续由维护者通过任务 ID 核对。

## 4. 测试用例

### A. 根目录枚举与单次执行

在手机提交：

```text
验证云端 Agent 调用所选 Mac 的本地目录工具。
只调用一次 local_list，参数为 {"path":".","limit":10}。
不要调用 local_read、local_write、shell 或其他工具；不要重试。
返回工具实际给出的 path、entries（名称和类型）以及 truncated。
失败时报告原始错误，不猜测内容、不切换设备。
全程只读，完成后结束任务。
```

通过标准：四项名称和类型与上表一致，`truncated=false`；出现一次成功的 `local.list` 操作，目标是指定 Mac，scope 是测试目录；只有一个计划子任务。最终状态为“已完成”，不是只有结论写着“成功”而顶部仍显示执行中。

### B. 列目录后读取真实文件

```text
验证云端 Agent 在本地工具返回后能继续执行下一步。
先调用一次 local_list，参数为 {"path":"folder","limit":10}。
仅当实际结果包含 probe.txt 且类型为 file 时，再调用一次 local_read，参数为 {"path":"folder/probe.txt"}。
报告两次工具返回的结果和读到的完整文本；任何一步失败就报告错误并结束，不重试。
不得凭上下文猜测文件内容，不切换设备，不写入文件，不调用 shell。
```

通过标准：先成功 `local.list`，再成功 `local.read`，读出的随机标记与 Mac 人工准备时一致。应有两次工具操作、一个子任务，无写审批、无文件修改。多个云端续跑轮次是正常现象。

### C. 条目上限与截断

```text
只调用一次 local_list，参数为 {"path":".","limit":2}。
原样报告返回的 entries 和 truncated，不补列剩余条目、不重试、不调用其他工具。
全程只读。
```

通过标准：只返回 `alpha.txt` 和 `bravo.txt`，均为 `file`，`truncated=true`。不能把有更多条目误报为“目录只有两个文件”。

### D. 刷新页面不会重新执行

复用 A 的已完成任务，不重新提交提示词、不点击“重新执行”。记下当前过程记录，然后点击刷新、返回任务列表再进入，最后切后台再回前台。

通过标准：任务 ID 和完成状态保持不变，不产生新子任务或新工具操作；事件可能因增量加载而补齐，但同一事件不应重复展示。若手机无法显示操作 ID，记录现象和时间，由维护者核对后台。

### E. 可选：符号链接拒绝

```text
这是工作区内的符号链接边界测试。
只尝试调用一次 local_list，参数为 {"path":"link-folder","limit":10}。
报告实际工具结果或错误；不要改用 folder，不读取文件，不重试，不调用 shell。
```

通过标准：网关拒绝遍历符号链接，错误为 `INVALID_PATH`，不返回其目标目录内容。模型解释了预期拒绝后，任务本身可以是“已完成”，不要求整个任务失败。若模型根本没有调用工具，只凭文字拒绝，则本用例记为“未覆盖”。

## 5. 证据核对与常见问题

手机任务详情展开“过程”；当前界面会截断长事件，不保证展示所有工具参数。模型结论和截图只能作为初步证据，完整验收还需用任务 ID 核对持久化记录。

| 核对项 | 预期 |
| --- | --- |
| 绑定 | `agent_target=personal-agent-engine`，`tool_target` 为指定 Mac，`execution_mode=native-tools` |
| 工作区 | 有正确 `workspace_id`，工具 scope 中路径与 Mac 当前测试目录一致 |
| 操作 | A/C 各一次 `local.list`；B 一次 list 后一次 read；协议版本为 2 |
| 单次任务 | 单个计划子任务；D 刷新前后无新增实际操作 |
| 本地结果 | B 随机标记匹配；测试后重新运行三个文件的哈希检查，值保持一致 |
| 终态 | 成功用例最终 complete；页面不会永久停留在 running 或 waiting_for_async_tool |

需要后台取证时，维护者使用已有鉴权读取 Runtime 的 `GET /tasks/{task_id}` 和 `GET /tasks/{task_id}/events`。工具列表接口为 `GET /tool-operations?target_id=...&status=completed&limit=200`，按需要另查 `failed`、`pending`、`leased`、`cancelled`，再按返回记录的 `task_id` 筛选。该接口当前不支持 `task_id` 查询参数，默认只查 pending；结果受数量限制，历史较多时需只读查询服务端存储补齐，不能把列表未返回当成从未执行。不把访问令牌或完整凭据写入报告。

一次任务可以经过“模型调用 -> 等待工具 -> 模型续跑”多轮调度；execution attempt 或事件数量大于一不能单独证明重复执行。需要比较计划子任务、tool call ID、operation ID、参数和设备执行回执。单个 operation 记录本身也不足以证明设备端绝无重复副作用。

| 现象 | 下一步 |
| --- | --- |
| `tool gateway does not support local.list` | 核对安装的 Mac 应用是否来自新构建，完全退出旧进程再启动 |
| `WORKSPACE_MISMATCH` | 核对手机注册绑定与 Mac 当前打开目录 |
| 等待工具电脑或握手超时 | 保留任务 ID，检查 Mac 在线、远程控制和休眠状态；不要连续创建相同任务 |
| 一直用 local.read 猜目录 | 核对任务是否在 Runtime 更新前创建、是否暴露 local_list；用新任务测试 |
| 结论成功但工具实际失败 | 按工具记录记为失败，不按模型措辞判定 |
| 实际调用超过提示词要求 | 记录所有操作 ID；区分模型重新发起调用、规划重复和同一操作重放 |

## 6. 测试记录模板

可在同目录新增 `mac-cloud-agent-e2e-result-YYYY-MM-DD.md` 记录结果；不要将此手册改成未经验证的“全部通过”。

```text
测试时间 / 时区：
Mac 名称 / 芯片 / macOS：
桌面构建 HEAD / 实际安装与启动时间：
手机版本 / 构建号（可获取时）：
Runtime / Engine 实测版本（维护者核对）：
测试工作区绝对路径 / workspace_id：
Mac tool_target：

A：通过 / 失败 / 待后台核对；task_id：
B：通过 / 失败 / 待后台核对；task_id：
C：通过 / 失败 / 待后台核对；task_id：
D：通过 / 失败 / 待后台核对；复用 task_id：
E：通过 / 失败 / 未覆盖；task_id：

随机标记是否匹配：
前后文件哈希是否一致：
是否出现重复提交、工具调用、审批或停在执行中：
原始错误 / 发生时间 / 相关截图：
后台核对的子任务数、操作 ID、协议版本、结果与 scope：
```

A-D 通过且后台证据吻合后，可将本轮 Mac 只读链路记为通过。写入审批、离线到期、执行中取消、服务重启恢复和完整旧客户端兼容矩阵仍属于后续独立验收，不能由本轮结果推断完成。测试目录保留到证据核对结束，再人工删除该具体目录。
