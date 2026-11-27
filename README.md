# Codex Trajectory Viewer

在 Codex Desktop 内查看聊天轮次、工具调用与结果、已保存的思考摘要和执行时间线的本地轨迹查看器。

M2 提供日常使用的本地网页。打开 Codex 会话即可查看最近 50 条摘要、向上翻阅、更改搜索范围、查看实时追加的记录，以及独立打开子代理。界面沿用 DeepSeek Harness（DSH）Trajectory 的表格、时间线和记录检查器布局。

## 产品约定

- 保留 DSH 的主要布局、样式和交互，优先复用展示组件。
- 主会话只加载自身轨迹。点击子代理后独立加载，不递归查询或汇总子代理。
- 先展示最近记录，大段工具参数和结果按需读取。
- 只展示日志中实际存在的思考摘要、Token 和时间信息。
- 先实现本地网页，再接入 Desktop 面板；两种入口共用数据层。

## 文档与源码

| 路径 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求、范围、里程碑与验收标准 |
| [docs/M1-VALIDATION.md](docs/M1-VALIDATION.md) | M1 浏览器验证、性能实测、DSH 依赖与适配差异 |
| [docs/M2-VALIDATION.md](docs/M2-VALIDATION.md) | M2 索引和日志语义、浏览器验收及性能实测 |
| [docs/AUTO-HISTORY-VALIDATION.md](docs/AUTO-HISTORY-VALIDATION.md) | 自动翻页、子代理目录和按需详情验证 |
| [docs/M3-VALIDATION.md](docs/M3-VALIDATION.md) | Desktop 安装、协议实测和原生验收状态 |
| [docs/HTTP-MCP-VALIDATION.md](docs/HTTP-MCP-VALIDATION.md) | 独立 HTTP 后台的双聊天隔离验证 |
| [references/README.md](references/README.md) | DSH 参考源码导航与更新方式 |
| `references/deepseek-harness/` | 固定提交的上游完整源码，Git submodule |

## 获取项目

```sh
git clone --recurse-submodules <本项目仓库地址>
```

如果已经克隆：

```sh
git submodule update --init --recursive
```

DSH 子模块供查阅和对照。运行只依赖已提取到 `src/client/dsh/` 的展示代码和样式。

## 运行本地网页

在项目根目录使用 Node.js 24 或更新版本运行以下命令。

```sh
npm ci
npm run build
npm start
```

打开 [本地轨迹查看器](http://127.0.0.1:4380/)，输入会话 UUID 后点击「打开」，也可以通过「选择会话」浏览活动和归档日志，或使用 `http://127.0.0.1:4380/?session=<会话 UUID>` 直达。

- 在轨迹表格中向上滚动接近顶部时会自动加载更早的一页，并保留阅读位置。也可点击「加载更早」或重试。查看最新记录时，追加日志会自动跟随到底部。
- 搜索可以选择「已加载摘要」或「全会话」，两种范围都支持工具名和错误筛选。点击全会话结果可打开对应记录和附近历史。
- 在右侧检查器切换参数、结果、后台输出或原始记录。长输出可继续加载。
- 工具栏「子代理」从当前会话索引列出已知的子代理，包含更早轮次的派发记录。点击条目后打开其独立会话，返回时恢复父列表和阅读位置。
- 「统计」显示当前会话日志覆盖的 Token 和轮次耗时。缺失指标标为未知。

服务默认在 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 按文件名定位会话。可以通过 `CODEX_HOME` 指定日志根目录，通过 `TRAJECTORY_PORT` 指定端口。服务只在 IPv4 回环地址 `127.0.0.1` 监听，以只读方式访问指定会话。

React + TypeScript 前端使用 Vite 构建。Node.js 服务保留可重建的内存索引。服务重启后首次访问会先显示尾部预览，再补齐索引。可执行 `npm run typecheck` 和 `npm test` 验证项目。

## Codex Desktop 插件

在仓库目录执行以下命令。插件运行需要 Node.js 24 或更新版本在 Desktop 本地执行器的 PATH 中。

```sh
npm ci
npm run package:desktop
codex plugin marketplace add ./dist/desktop-marketplace
codex plugin add local-trajectory-viewer@local-trajectory
```

安装或更新后，如果当前窗口未出现新插件入口，请完全退出并重新启动 Codex Desktop。本机验证中需要重启才能加载新入口。

在本地聊天右侧新标签页点「打开」旁的「…」，选择「本地 Codex 轨迹」。旧版界面从 **+ → More tools… → Plugins and MCPs** 进入。如果宿主当前提供了有效聊天 UUID，面板打开该聊天。身份缺失或无效时，从会话选择器明确打开目标。打开工具 `show_local_trajectory_viewer` 也可以请求显示查看器。

打包目录 `dist/desktop-marketplace` 包含插件清单、MCP 启动配置、已打包的 stdio 服务与自包含面板资源。安装后直接由 Desktop 启动服务。独立网页仍可通过 `npm start` 使用。原生入口实测进度见 [M3 验证记录](docs/M3-VALIDATION.md)。

## 独立 HTTP MCP 后台

打包同时生成 `http-server.mjs`。一个后台可以供多条 Codex 聊天直接连接，并共享会话索引。已在隔离 app-server 验证工具、UI 资源和线程绑定。Desktop 图形界面的原生侧栏入口仍待验收。

执行 `npm run package:desktop`，然后进入 `dist/desktop-marketplace/plugins/local-trajectory-viewer`。可将整个目录复制到本机固定位置运行，所需资源和 JavaScript 依赖已包含在包内。

```powershell
node .\http-server.mjs config
node .\http-server.mjs start
```

`config` 只打印配置片段路径。用本机编辑器打开该文件，将 `[mcp_servers.local_trajectory_http]` 整段加入本机 Codex `config.toml`。片段包含本机 bearer 凭据，通过 `http_headers.Authorization` 交给 app-server。请勿把片段或同目录的 `token` 纳入版本控制、插件包或日志。该配置注册一个独立 MCP server。插件的来源标识及侧栏行为仍需在 Desktop 中测试。

后台默认监听 `127.0.0.1:4381`。如需换端口，先设置 `TRAJECTORY_HTTP_PORT`，再用同一设置生成配置和启动后台。`CODEX_HOME` 指定日志目录。Windows 凭据默认存放于 `%LOCALAPPDATA%\CodexTrajectoryViewer`，其他平台使用 `~/.codex/trajectory-http`。如需自定义，设置 `TRAJECTORY_HTTP_STATE_DIR` 指向当前用户控制的新目录。后台会检查已有目录和凭据权限。

前台后台可以用 Ctrl+C 停止。Windows 上也可用已打包的脚本隐藏启动，终端可以关闭。

```powershell
.\start-trajectory-http.ps1
node .\http-server.mjs status
node .\http-server.mjs stop
```

`stop` 向已认证的后台发送退出请求，后台最多等待五秒关闭在途 HTTP 连接。重启沿用端口和凭据即可。要回到默认 stdio 入口，移除本机添加的 HTTP MCP 配置并停止后台。默认插件的 `mcp.json` 仍使用 stdio。

## 上游版权

提取代码的 MIT 许可证和版权声明随源码保留。项目原创部分尚未指定开源许可证。具体来源及修改见 [M1 验证记录](docs/M1-VALIDATION.md)。
