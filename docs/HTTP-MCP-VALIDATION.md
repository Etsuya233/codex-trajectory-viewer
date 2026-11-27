# 独立 HTTP MCP 后台验证

## 复现

在仓库根目录使用 Node 24 运行。

```powershell
npm run typecheck
npm test
npm run package:desktop
$exe = (Get-Command codex.exe).Source
node scripts/verify-trajectory-http.mjs $exe
```

最后一步将打包产物复制到独立临时目录。在其中生成测试凭据、Codex 配置和合成 JSONL 日志。启动真实 app-server，只创建两个临时聊天，直接发 MCP RPC。脚本用本机回环占位模型服务并禁用 WebSocket，未调用模型或读取真实聊天历史。退出后回收测试进程并清理临时目录。

## 已通过

提交前另从 Git 暂存区导出独立副本，排除其他未提交修改；该副本通过类型检查、21 项测试、Desktop 打包及下述真实 app-server 双聊天/重启验证。

| 检查 | 结果 |
| --- | --- |
| 打包产物脱离源码运行 | 临时目录无仓库依赖。检查第二个启动对于相同端口报冲突。 |
| 本机认证交付 | Windows 状态文件通过账户和 SYSTEM ACL 检查。生成配置文件，设置静态 `Authorization` header 后真实 app-server 可调用，未设置 token 环境变量。 |
| 请求保护 | 错 token 返回 401，错误 Host 和带 Origin 请求返回 403。声明长度或分块正文超过 64 KiB 返回 413，坏 JSON 返回 400。 |
| 双聊天与索引 | 两个聊天通过同一个后台 PID 发起并发查询，读同一份合成日志得到相同的非空 index generation。 |
| 线程与原生资源契约 | RPC 不额外发送 `_meta`，Codex 注入各自线程 ID。catalog 的 `openai/ui.entrypoints` 保留 `thread`，`ui://` 可读到实际打包的面板 HTML。 |
| 卸载和重启 | 等待 A 的 `thread/closed` 后 B 保持索引 generation。后台停止时 B 调用失败，同端口重启后同一 B 的下一次调用成功并取得新的 generation。 |
| 请求取消隔离 | 两个并发的 HTTP 工具请求各有信号。断开 A 的 HTTP 连接，A 的读取收到 abort，B 正常完成。 |

## 待在 Desktop 图形界面验证

2026-11-27 已在本机部署 HTTP 后台并将 Codex 用户配置切换到 `local_trajectory_http`，禁用原 stdio 查看器插件。重启 Codex 后，当前聊天已加载 HTTP 版工具，三个旧 stdio 进程退出，仅剩一个共享后台。该次快照驻留内存 80.3 MiB、私有提交 84.3 MiB；此前三个实例驻留内存合计 174.1 MiB。两次快照缓存负载未控制，不能视为同负载基准。凭据与本机配置备份均在版本库外；未配置开机自启。

- 独立 `[mcp_servers.local_trajectory_http]` 已有原生入口元数据和资源。尚需确认 Desktop 是否从独立配置注册侧栏入口，并实测两条聊天里打开、切换和重连面板。
- 当前无状态 HTTP 连接的读取取消来自原请求的断开。单独 POST 的 MCP cancel notification 没有跨请求归属，不能据请求 ID 取消其他连接的读取。真实 Desktop 在面板取消时是否断开在途 HTTP 请求仍需验证。现有读层在搜索时消费 AbortSignal。
- 打包默认保留 stdio 清单，HTTP 独立注册作为试用入口。当前 Codex 会剥除 portable 插件清单内的 `Authorization` header。如 Desktop 要求工具有插件注册来源，需要验证宿主支持的本机凭据配置。[Codex portable MCP 清单解析](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-mcp/src/agent_plugin_config.rs)
- 会话索引仍受既有 LRU 上限约束，目录元数据使用既有缓存在长时间运行时没有独立容量上限。尚未测量真实 Desktop 长时间运行的内存。
