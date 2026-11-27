# Codex 跨聊天 MCP 进程共享研究

2026-11-27 · Windows Codex Desktop 核心 `0.171.0-alpha.13.2`

## 结论

当前安装的 trajectory viewer 不能跨聊天共享 MCP 进程。这个版本的核心支持共享，但 `mcp_connection_sharing` 处于 UnderDevelopment，默认关闭。插件安装包支持的最高协议为 `2025-11-25`，共享要求实际协商到 `2026-07-28`。活跃 Desktop app-server 命令行未见显式 feature/profile 参数，默认用户配置中也没有该键。运行中的实际 feature 状态未直接内省。[Codex feature 定义](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/features/src/lib.rs) · [共享协商源码](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-mcp/src/connection_pool.rs)

显式启用开关后，用官方 TypeScript Server SDK 2.4.0 和本机实际安装的 `codex.exe app-server`，隔离环境中的两条临时聊天共用同一个 Node PID。第一条收到 `thread/closed` 后，第二条仍可通过同一 PID 调用。建议先做 preview 裁切后复制和隐藏面板停止轮询。MCP 共享可继续作为显式启用的试验，默认启用要等真实插件双面板验证和开关成熟。

## 共享门槛

- 使用活跃 Desktop app-server 对应的 WindowsApps 二进制运行 `--version`，隔离 app-server 的 `initialize` 也报告相同版本。以该版本官方 tag 对照代码。
- feature 打开本地 stdio discovery。服务需处于本地环境、非内置 Codex Apps、无运行期认证 provider、非 EmaAuth 且使用合格的 stdio 协议配置。连接管理器还检查非 Legacy，以及带认证的连接可追踪账号变化。[运行配置](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/core/src/config/mod.rs) · [stdio 条件](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-mcp/src/server.rs) · [连接管理器](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-mcp/src/connection_manager.rs)
- 共享池归 Codex 进程所有。连接键含 server 名、连接标识、账号、认证状态、启动超时和 catalog 上限。启动时触发 elicitation 会放弃共享。可选的 `codex/connection-lease` 扩展增加 open/release 和 `codex/connectionLease` 请求元数据。最小探针未声明该扩展，仍成功复用。[共享池源码](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-mcp/src/connection_pool.rs)
- 仓库 server 直接依赖 `@modelcontextprotocol/sdk@1.32.2`，通过 `connect(new StdioServerTransport())` 启动。npm 显示 v1 最新仍为 1.32.2，split `@modelcontextprotocol/server` 最新为 2.4.0。v2 的普通 `connect(StdioServerTransport)` 仍走 2025 协议。使用 `serveStdio(factory)` 显式接入现代协议，开场消息决定物理连接的协议版本，默认兼容旧客户端。[SDK 路线](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md) · [新版协议迁移](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

## 隔离验证

Node 24.18.0，Python 3.12 驱动 JSONL stdio。使用临时 `CODEX_HOME`，清除子进程中既有的 `CODEX_*`、`OPENAI_*` 和含 `API_KEY` 的变量，再设置临时 `CODEX_HOME`。临时配置注册一个 Node stdio `pool_probe`。未调用 `turn/start`。最初摸底曾以默认 provider 启动，退出日志有 Responses WebSocket 连接失败，未观察到模型结果。下列对照重跑时使用假 provider，指向回环地址并禁用 WebSocket。

```powershell
npm install --prefix $probe --no-audit --no-fund --ignore-scripts @modelcontextprotocol/server@2.4.0
$exe = (Get-Command codex.exe).Source
& $exe --version
# 共享组附加 --enable mcp_connection_sharing
& $exe app-server --stdio -c model_provider=pool_probe_local -c model_providers.pool_probe_local.name=PoolProbe -c model_providers.pool_probe_local.base_url=http://127.0.0.1:1 -c model_providers.pool_probe_local.supports_websockets=false
```

探针以 `serveStdio` 注册一个 `pid` 工具，回报 `process.pid`、`process.memoryUsage()`、`server.server.getNegotiatedProtocolVersion()` 和 `ctx.mcpReq._meta?.threadId`。驱动发送 `initialize`、`initialized`，并以 `thread/start` 创建两个 `ephemeral: true` 的线程 A/B，分别用 `mcpServer/tool/call` 调用探针。末次验证用 `_meta: {threadId}` 模拟面板元数据，并配置 `thread_unload_delay_secs = 2`。发 A 的 `thread/unsubscribe` 并等待 `thread/closed`，再重新调用 B。[RPC 类型](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) · [官方线程卸载测试](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs)

| 路径 | 协议 | A / B / B 重调 PID | B 重调时 A 状态 |
| --- | --- | --- | --- |
| 默认开关，同一 v2 探针 | 2025-06-18 | 13756 / 38660 / 38660 | 已 unsubscribe |
| 启用开关，同一 v2 探针 | 2026-07-28 | 49460 / 49460 / 49460 | 已 unsubscribe |
| 启用开关，等待卸载并回显线程元数据 | 2026-07-28 | 52984 / 52984 / 52984 | 已收到 A 的 `thread/closed` |

末次验证的 SDK handler 分别收到 A、B、B 的合成 `threadId`。这验证了 app-server 到 MCP 的元数据传递。Desktop webview 注入、panel 加载与重连和调用取消仍需实测。关闭 stdin 后 app-server 正常退出，验证组的探针子进程均已退出。

### 空载探针内存样本

单位 MiB，按不同 PID 求和。Working Set 来自 `Get-Process.WorkingSet64`，表示驻留内存，跨进程求和可重复计共享页。Private 来自 `PrivateMemorySize64`，表示私有提交。heapUsed 取自 Node 最近一次工具调用，受 GC 影响。

| 探针路径 | 已调用聊天数 | MCP PID 数 | Working Set | Private | heapUsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 默认开关 | 1 | 1 | 66.0 | 46.1 | 17.6 |
| 默认开关 | 2 | 2 | 132.7 | 92.0 | 35.7 |
| 启用开关 | 1 | 1 | 66.7 | 46.7 | 18.1 |
| 启用开关 | 2 | 1 | 66.9 | 46.7 | 18.5 |

对照差值约 66 MiB Working Set、45 MiB Private、17 MiB V8 heapUsed，均为探针数据。前轮另测既有安装包约 59 MiB RSS / 63 MiB private、每一万条合成记录约 11.89 MiB index heap 增量、8 项缓存约 99 MiB、preview 裁切后复制使单样本索引从 5.61 降至 1.16 MiB。真实插件启用共享后的内存尚未实测。

## 最小接入与工程量

1. 用 split Server SDK 加 `serveStdio(factory)` 建双协议入口，复用现有读接口及工具、资源定义。MCP Apps 2.x 对接 split SDK 2.x。保留 `ui://`、`_meta.ui`、visibility 和 Codex 面板上下文字段。[MCP Apps 2.x 迁移](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate-to-2.md)
2. 每次从 `ctx.mcpReq._meta` 取自定义线程字段，将 `ctx.mcpReq.signal` 传入现有读链路，保留冲突、缺失和无效线程 ID 的手动选择行为。现代协议将协议级上下文放进 `ctx.mcpReq.envelope`，绕开旧 `initialize` 的能力缓存。将来若需 elicitation，现代协议使用 `input_required` 续请求。[SDK v2 迁移](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md) · [现代协议迁移](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
3. 分别验收进程和缓存复用。`serveStdio` 按物理连接创建服务实例，discovery 也可能构造一个随探测丢弃的实例。当前缓存由 bridge 内的 `createTrajectoryApi` 持有。共享一条物理连接具备复用同一份缓存的条件，仍需用两条聊天读同一轨迹验证实际构建次数。不同轨迹文件仍可占用独立索引。[stdio 工厂语义](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
4. 粗估 2–4 个工程日完成双协议入口、打包和回归，另需 1–2 个工程日测试真实 Desktop 双面板、线程绑定、取消和内存。若 Desktop host 缺失现代路径的面板元数据，宿主改动另估。当前完成的是隔离 stdio/app-server 验证，真实插件的 UI、读取链、取消和缓存都尚未迁移或实测。

## 验证环境清理

验证用 app-server 均正常退出。复查全部 7 个探针 PID 时，存活数为 0。临时目录 `C:\Users\Etsuya\AppData\Local\Temp\codex-mcp-pool-408758f3-f5ae-4799-8c44-b144917230f4` 仍在，工具在启动删除命令前以 `blocked by policy` 拒绝执行。临时目录含验证脚本、SDK、隔离的 Codex 配置及运行数据。本轮仓库改动仅为此报告，生产代码、依赖、用户配置和已有工作区改动均保留。
