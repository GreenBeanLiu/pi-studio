# 沙箱模式（Docker）实现说明

> 状态：已实现第一版执行链路（v0.3.39 后续开发中）。设置页可探测 Docker、构建版本绑定的镜像；开启后工作区通过 RPC shim 在容器内运行。

## 现状

pi-studio 默认把 pi CLI 作为子进程跑在 Windows 主机上；开启沙箱后，
`src/main/pi-client.ts` 会把 `RpcClient` 的 `cliPath` 切到
`%APPDATA%/pi-studio/sandbox-rpc-shim.cjs`。shim 透明转发 stdin/stdout，
再由 `docker run` 启动容器内的 `pi --mode rpc`。

唯一防护是可选的 **securityGuard** 扩展（`src/main/security-guard-extension.ts`）——
进程内软拦截危险命令/敏感路径写入，基于规则黑名单，**不是隔离**，而且用户默认可关。

沙箱容器只挂载当前工作区到 `/workspace`，并挂载 pi-studio 专用的
`agentConfigDir()` 到 `/agent`；API key 等环境变量按名称透传，不把值写进镜像或命令行。
未开启时仍保持原有本机执行行为。

## 关键架构发现（决定可行性）

`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js` 里
`RpcClient.start()` **写死了** `spawn("node", [cliPath, "--mode", "rpc", ...])` ——
命令固定是 `"node"`，`RpcClientOptions` 只有 `cliPath/cwd/env/provider/model/args`，
**没有 command/spawn 覆盖点**。所以不能直接让 RpcClient 去跑 `docker run`。

**但是**：RPC 协议是纯 **LF 分隔 JSONL over stdio**（见 pi 的 `docs/rpc.md`）——
RpcClient 只是管这条 stdin/stdout 管道，所有方法（prompt/getState/getMessages/…）
都操作 `this.process` 的 stdio。

⇒ 只要让 RpcClient 启动的那个 `node <cliPath>` 进程**透明地把字节转发进容器**，
所有方法零改动即可工作。这就是**中继 shim** 方案。

## 方案：中继 shim（复用 RpcClient，改动最小）

1. 打包一个 `docker-rpc-shim.cjs`（~30 行）。沙箱模式下把 `cliPath` 指向它。
2. RpcClient 启动 `node docker-rpc-shim.cjs --mode rpc --provider X --model Y`。
3. shim 读自己的 argv（RpcClient 追加的那些参数），`spawn("docker", ["run","-i","--rm", …挂载/env…, IMAGE, "pi", ...forwardedArgs], { stdio: "inherit" })`，
   把主机侧 stdin/stdout（RpcClient 握着的那对）直接继承给 docker——纯字节管道，shim 不需要解析 JSON。
4. RpcClient 以为自己在跟本地 `node` 说话，实际在跟容器里的 pi 说话。

`PiClientManager.startWorkspace` 里按 `settings.sandboxEnabled` 分叉：
- 关：`cliPath = resolvePiCliPath()`，`env = 主机 env`（现状）。
- 开：`cliPath = <shim 路径>`，env 里塞好给 shim 用的挂载/转发信息（或写进临时配置文件让 shim 读）。

## 需要解决的硬骨头

| 项 | 说明 |
|---|---|
| **镜像** | 需要一个含 node + 对应版本 pi + git + ripgrep 的镜像（pi 现为 **v0.79.10**，见 `docs/containerization.md` 的 `Dockerfile.pi`）。electron-builder 塞不进 Docker 镜像，得首次 `docker build`（拉 npm 装 pi，约几分钟）或 `docker pull` 预构建镜像。版本要跟 pi-studio 捆的一致，否则行为漂移。 |
| **工作区挂载** | `-v <host workspace>:/workspace -w /workspace`。Windows 路径要转 Docker Desktop 接受的形式；WSL2 跨界文件性能/大小写/换行有坑。 |
| **agent 配置目录** | pi-studio 把 models.json 覆盖、扩展（web-search/security-guard）、sessions 都写在 `agentConfigDir()`（userData/pi-agent）。要 `-v agentConfigDir:/agent` 挂进去 + `-e PI_CODING_AGENT_DIR=/agent`，容器里 pi 才能读到网关覆盖/扩展、且 session 落回主机。 |
| **env 转发** | API key、TAVILY_API_KEY、PI_* 等要用 `-e` 传进容器（注意别把主机绝对路径类的 env 原样带进去）。 |
| **session 目录名** | pi 按 cwd 生成 session 子目录名；容器里 cwd 是 `/workspace`，和主机模式的目录名不同 ⇒ 沙箱/非沙箱模式的历史会分叉（session sidebar 靠 getState().sessionFile 仍能找到当前会话，但两套历史不互通）。可接受，需提示。 |
| **cli 路径** | shim 里用镜像内的 `pi` bin（`docker run … IMAGE pi --mode rpc …`）最省心。 |
| **可用性检测** | 开沙箱前检查 `docker` 在 PATH + daemon 在跑 + 镜像存在；缺则引导用户装 Docker Desktop / 构建镜像。 |
| **不受影响的** | git-diff 读、ComfyUI、云端生图都是 pi-studio **主进程**功能，不是 pi 工具；工作区是共享挂载，主机侧读得到 agent 的改动。 |
| **代价** | 每次开工作区多一次 docker run 启动延迟；容器/WSL2 开销；工具在 **Linux** 里跑（和 Windows 原生工作流有路径/换行差异）。 |

## UI

设置「安全策略」页加一个「沙箱模式（Docker）」开关 + 状态行（Docker 是否可用/镜像是否就绪 + 「构建镜像」按钮）。开关存 `settings.sandboxEnabled`，改后需重开工作区生效。

## 工作量估计

- shim + PiClientManager 分叉 + 挂载/env 组装：中等。
- 镜像检测/构建流程 + UI：中等。
- Windows 路径映射、agentConfigDir 挂载联调、session 目录分叉处理：细节坑多，需实机反复测。
- 总体：**一个完整功能**，不是小改。核心难点在"首次镜像就绪"体验和 Windows/WSL2 挂载联调。

## Windows 上有没有比 Docker 更轻的方式？

**核心事实：Windows 上"真隔离"绕不开虚拟机（Hyper-V）。** Docker Desktop、WSL2、
Windows Sandbox 底层都是 Hyper-V 虚机。Linux 那种内核级、便宜的 namespace/cgroup
容器，Windows 没有对应物（Windows 容器要么重、要么是 Windows 环境）。所以不存在
"又轻又强隔离"的原生方案。

"Docker 重"重的是 **Docker Desktop 常驻的那套**（一个 WSL2 虚机 + daemon），
**不是每个容器**——容器跟那一个虚机共享，`docker run` 边际成本只是启动延迟。

按推荐度排：

| 选项 | 是否真隔离 | 相对 Docker | 说明 / 坑 |
|---|---|---|---|
| **WSL2 直连** | 是（虚机） | 更轻 | 装 Docker 就已有 WSL2。shim 把 `docker run` 换成 `wsl.exe -d <distro> -- pi --mode rpc …`，**架构原封不动**。省掉 Docker Desktop 后台 + 容器层。**坑**：WSL2 默认把 C: 挂到 `/mnt/c`，agent 能写主机 ⇒ 必须关 automount（`wsl.conf [automount] enabled=false`）或只挂工作区，否则等于没隔离。 |
| **Docker** | 是（虚机） | 基准 | 最省心最标准最鲁棒；已装且能用就用它。 |
| **Windows Sandbox** | 是（虚机） | 差不多重且不合适 | Win11 Pro 自带，但一次性重置不留工作区、面向 GUI、跑 Windows 非 Linux（pi 要 bash）、stdio RPC 管道难接。**排除**。 |
| **进程级限制**（低完整性 token / Sandboxie-Plus） | 否 | 最轻（无虚机） | 只降权/减小破坏范围（挡系统路径写入等），不是真隔离；DIY 要写 Win32 原生（CreateProcessAsUser + 受限 token）或依赖 Sandboxie。可做"沙箱-lite"过渡。 |

**结论**：真隔离就选 Docker（已装、稳）或 WSL2 直连（同架构、更轻，但要处理 automount）；
两者对 pi-studio 的改动量几乎一样（都是"中继 shim + 主机侧组命令行"）。真正
"又轻又强"的原生 Windows 方案不存在，不值得耗。

## 其它备选

- **Gondolin 微 VM**：对 pi-studio 改动更小（pi 仍在主机，spawn 加 `-e gondolin` 扩展把工具路由进 Linux micro-VM），但要装 QEMU + Node≥23.6，工具也在 Linux 跑。
- **只强化 securityGuard**：非真沙箱，但零额外环境、当天可用——默认打开 + 扩黑名单 + 可选"危险命令执行前确认弹窗"。可作为真沙箱前的过渡。

## 当前落地状态与后续任务

1. **已完成**：设置开关、Docker/WSL 探测、版本绑定的镜像 tag、镜像构建进度，以及 Docker RPC shim。
2. **已完成**：工作区 `/workspace`、agent 配置 `/agent` 的挂载和 API key/TAVILY/Helicone/代理环境变量透传；Docker 未就绪或镜像缺失时会在打开工作区阶段明确报错。
3. **已完成**：容器返回的 `/agent/...` 会映射回 Windows 主机路径，历史会话列表、切换和导出仍可用；停止工作区时 shim 会把 SIGTERM/SIGINT 转发给 `docker run`，避免后台容器残留；镜像构建请求互斥，重复点击会复用同一次构建。
4. **待验证**：在真实 agent 工作区执行一次 prompt→bash→文件写入，并确认写入范围只落在挂载的工作区；同时补充 Docker Desktop 未运行、镜像构建失败、停止超时的 UI 回归测试。
5. **后续增强**：沙箱模式切换后可选择自动重启当前工作区；增加容器 CPU/内存/网络策略配置，并在会话列表中标注当前会话运行于沙箱。
