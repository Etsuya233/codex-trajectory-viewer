# 独立 HTTP MCP 后台共享研究

2026-11-27 · Windows Codex Desktop 核心 `0.171.0-alpha.13.2`

## 结论

**可以用一个本机 Streamable HTTP MCP 进程服务多条 Codex 聊天。** 使用仓库现有的 `@modelcontextprotocol/sdk@1.32.2`、一个回环端口和正常的 Codex HTTP MCP 配置，无需每聊天 Node 代理或 `mcp_connection_sharing` 开关。真实 app-server 隔离实测通过工具调用、`ui://` 资源读取、线程元数据、卸载一条聊天以及后台重启。建议采用无状态 HTTP 传输和进程内共享索引，先验证本地插件的 Desktop 面板入口。

**可继续实现小范围验证，暂不替换现有 Desktop 入口。** 已验证的是当前 Desktop 核心的 HTTP MCP 通路。隔离测试直接配置具名 MCP server，未安装 HTTP 版插件或打开真实 Desktop webview。仍需在 Desktop 验证插件注册来源、聊天侧栏入口、渲染及面板发起工具调用后的线程归属。粗估 HTTP 入口和启停配置 1–2 个工程日，双面板、共享索引、故障和打包验证另 1–2 日。若 Desktop 限制本地 HTTP 插件的原生面板注册，就需要另行选择面板入口或宿主支持，范围另估。

## HTTP MCP 和面板证据

- 官方 Codex 支持 `[mcp_servers.NAME]` 的 Streamable HTTP `url` 和 `bearer_token_env_var`。官方插件打包也支持 `mcp.json` 的 `type: "streamable-http"` 和 `url`。打包文档的远程示例使用 HTTPS，Desktop-only 指南展示本机 stdio，尚无明确的本机 HTTP 原生线程面板示例。[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) · [插件封装](https://developers.openai.com/plugins/build/plugins) · [Desktop-only 插件](https://developers.openai.com/plugins/deploy/desktop-only)
- 官方插件扩展以 `_meta.ui.resourceUri` 连接 HTML 资源，以 `_meta["openai/ui"].entrypoints` 的 `{type:"thread"}` 选择聊天面板。仓库 bridge 已提供这两处字段。隔离 HTTP 探针验证了 `_meta.ui.resourceUri` 和 `visibility:["app"]` 保留在 catalog，`mcpServer/resource/read` 通过 HTTP 读取了 `ui://` 的 `text/html;profile=mcp-app` 和资源元数据。探针无真实侧栏入口，尚未覆盖 `openai/ui.entrypoints` 的 Desktop 注册与挂载。[OpenAI 插件拓展](https://developers.openai.com/plugins/build/extensions) · [MCP Apps 规范和实现](https://github.com/modelcontextprotocol/ext-apps)
- 当前 app-server 的 `mcpServer/tool/call` 从 RPC 的顶层 `threadId` 加入转发工具请求的 `params._meta.threadId`。B 的 RPC 刻意省去 `_meta`，两个 HTTP 模式的探针均收到实际 B 的 `threadId`。现有 `callingThread` 从每个工具请求读取此字段，可沿用。资源读取走独立流程，顶层 `threadId` 用于选择连接，调用者在其 `_meta` 填 `threadId` 会被代码以保留键拒绝。探针读取时改传非保留标记，服务端确认标记到达，资源请求没有自动线程字段。资料只证明实际调用进入该 app-server RPC 后的行为，Desktop webview 的入口到 RPC 路由仍待验证。[该版本 app-server MCP 请求处理器](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/app-server/src/request_processors/mcp_processor.rs)

## 隔离测试与重启行为

使用已经安装的 WindowsApps `codex.exe`、Node 24.18.0、仓库 SDK 1.32.2。Python 3.12 驱动 JSONL，分别设置临时 `CODEX_HOME`、随机 bearer token 和随机端口。HTTP 进程绑定 `127.0.0.1:0`，重启沿用分配到的端口。app-server 使用回环假 provider，关闭 WebSocket，两组均未调用 `turn/start`。HTTP 路由校验请求路径、Host、无 Origin 和 Authorization。测试配置如下，端口用子进程实际分配值代入。

```toml
thread_unload_delay_secs = 2

[mcp_servers.http_probe]
url = "http://127.0.0.1:57312/mcp"
bearer_token_env_var = "HTTP_POOL_TOKEN"
startup_timeout_sec = 5
tool_timeout_sec = 6
```

```powershell
$exe = (Get-Command codex.exe).Source
& $exe --version
# Python 启动子进程前设置临时 CODEX_HOME 与 HTTP_POOL_TOKEN
& $exe app-server --stdio -c model_provider=pool_probe_local -c model_providers.pool_probe_local.name=PoolProbe -c model_providers.pool_probe_local.base_url=http://127.0.0.1:1 -c model_providers.pool_probe_local.supports_websockets=false
```

探针使用 Node 原生 HTTP 和 SDK `Server`、`StreamableHTTPServerTransport`。JSON 响应模式下，无状态组用 `sessionIdGenerator: undefined`，每个 POST 新建 transport/server，关闭响应时释放实例。状态组在 `initialize` 时分配随机 ID，之后按 `Mcp-Session-Id` 查 transport，未知 ID 返回 HTTP 404。驱动顺序为 `initialize`、两条 `thread/start(ephemeral:true)`、`mcpServer/tool/call`、`mcpServerStatus/list`、`mcpServer/resource/read`、A 的 `thread/unsubscribe`、等 A 的 `thread/closed`、B 再调。两组都故意停 HTTP 后调一次 B，再用相同端口启动并对原 B 调一次。未发 reload 或重开线程。[MCP Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [SDK 无状态迁移说明](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

| 模式 | A / B / A 关闭后 B 的 PID | 后台停止时 B | 同端口重启后原 B 首次新调用 |
| --- | --- | --- | --- |
| 无状态 | 50220 / 50220 / 50220 | 返回 transport error | 直接 `POST tools/call` 成功，PID 27752，未重新 initialize |
| 有状态 | 47572 / 47572 / 47572 | 返回 transport error | 请求带旧 ID，后台返回 404。Codex 自动 initialize、收到新 ID、重发工具调用成功，PID 10540 |

有状态组的 A/B 各有独立 session ID。A 关闭后，wire 上出现 A 的 DELETE，B 继续用自己的 session ID。无状态组始终没有 session ID、GET SSE 或 DELETE。两组在 HTTP 正常时均验证工具、UI 资源及元数据。探针未注册资源模板，因此 catalog 查询伴随一条模板方法不存在警告，不影响已确认的工具或资源。故障期间已失败的请求没有自动复活。重启恢复指现有聊天的下一次新调用。后台在握手前就不可用、面板端的重试交互、并发取消和生产缓存性能均未测。

## 最小落地

1. **保留现有 SDK，增加无状态 HTTP 入口。** 启动 Node 时只建一次 `createTrajectoryApi(codexHome)`，作为共享依赖注入每请求的 bridge。现有 bridge 在自身闭包里创建读接口，若照搬到每请求初始化，进程虽共享，索引仍会重建。请求各自拥有 MCP Server/transport、线程上下文和取消信号。共享范围限于该本地用户、固定 Codex 数据根下有界的索引与 catalog，保持文件身份校验、失效处理和当前信号语义。[SDK 传输复用约束](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7)
2. **先用显式启动与固定回环端口。** 提供一次启动和停止入口，从稳定安装路径启动，无需系统服务或每聊天 hook。可选用户级登录任务。仅监听 `127.0.0.1`，启动时直接绑定固定可配置端口，让 OS 的端口独占阻止第二实例。遇到 `EADDRINUSE` 报清楚冲突，不切到随机端口或停止占用者。退出时停止接收新请求，有限等待在途读取并释放 transport。若安排自动启动，优先确保在 Codex 首次连接前就绪。端口只在隔离验证中随机选择。
3. **用独立凭据保护本机历史。** 回环地址配合精确 Host 检查、拒绝非预期 Origin、每请求 bearer token 和请求大小上限。token 放仅本人可访问的本地配置，由已受信的启动方式提供给后台，并通过 Codex 环境变量或本机配置支持的 header 交给 app-server。使用环境变量时要确认 Desktop 进程实际继承了它。禁止把 token 写在插件包、URL 或面板 JavaScript。面板继续通过宿主 MCP Apps bridge，直接浏览器访问 HTTP 不在此方案内。现有测试仅证明临时 app-server 的 `bearer_token_env_var` 配置。插件 `mcp.json` 的本机认证交付、来源归属与 UI 注册需一起测。[MCP HTTP 安全要求](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [Codex MCP 鉴权配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
4. **Desktop 验收只需一套双面板场景。** 确认 HTTP 插件确实出现聊天侧栏入口，A/B 切换时各读本聊天并共用同一后台 PID。两个聊天请求同一轨迹时只构建一次索引，取消 A 的请求或关闭 A 后 B 可用。重启后台，原 B 可重试并恢复，错误态可辨识。验证期间保留现有 stdio 入口作为可恢复路径。仅当这些检查通过，才适合把独立 HTTP 后台设为默认。

## 清理

隔离 app-server 均正常退出，5 个 HTTP 探针 PID 已退出。复用了前一轮 Windows Temp 隔离目录，存留 `http-probe.mjs`、`http-run.py` 和临时 `CODEX_HOME`。生产代码、依赖、已安装插件、默认 Codex 配置和已有工作区改动均保留。
