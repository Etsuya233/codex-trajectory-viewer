# Codex Trajectory Viewer 技术文档

日常安装和使用见[用户指南](../README.md)。

## 手动安装

在项目根目录使用 Node.js 24 或更新版本及支持 `codex plugin` 的 Codex CLI。Windows 上的命令可在命令提示符（CMD）执行。

```sh
npm ci --include=dev
npm run package:desktop
codex plugin marketplace add ./dist/desktop-marketplace
codex plugin add local-trajectory-viewer@local-trajectory
```

安装后完全退出并重新启动 Codex Desktop。Windows 安装脚本执行同样的流程，并检查 Node.js 版本和 CLI 命令是否可用。已验证的版本见 [M3 Desktop 验证记录](M3-VALIDATION.md)。

本地来源指向 `dist/desktop-marketplace`，Codex 安装时会将插件复制到自己的缓存。更新时从同一项目目录重建并重新执行 `codex plugin add`。更换源码或打包目录时，先解除旧的来源注册，再添加新路径。也可以从可信的预构建产物安装，保持 `desktop-marketplace` 目录完整，直接从注册来源这一步开始。

```sh
codex plugin marketplace list
codex plugin list
codex plugin remove local-trajectory-viewer@local-trajectory
codex plugin marketplace remove local-trajectory
```

前两条列出来源和插件，后两条分别卸载插件和移除来源。CLI 和 Desktop 应使用同一个 Codex 用户目录。卸载后重启 Desktop。

## 运行方式

| 入口 | 启动方式 | 默认地址或传输 |
| --- | --- | --- |
| Desktop 插件 | Codex Desktop 的本地执行器启动 `node` | stdio |
| 独立网页 | `npm run build` 后运行 `npm start` | `http://127.0.0.1:4380/` |
| 共享 HTTP MCP 后台 | 从打包目录运行 `node http-server.mjs start` | `http://127.0.0.1:4381/mcp` |

三个入口共用会话目录、日志解析、索引和详情读取逻辑。服务只读访问 `CODEX_HOME` 下的 `sessions` 和 `archived_sessions`，通过 `session_index.jsonl` 查阅会话目录，并参考可用的 `state_5.sqlite` 定位分段日志。索引保存在进程内存中，重启后按需重建。主会话和子代理会话分别打开，只展示各自日志实际保存的思考摘要、Token 和耗时。

Desktop 面板与独立网页共用 React 界面。面板通过宿主桥接读取轨迹，宿主提供有效聊天 UUID 时自动定位，身份缺失时由用户在面板选择。轨迹内容通过面板工具的私有元数据交付。调试打开入口时，可检查 `show_local_trajectory_viewer` 工具，工具调用本身会请求显示查看器。

独立网页支持通过 `http://127.0.0.1:4380/?session=<会话 UUID>` 直接打开会话。独立网页和 HTTP MCP 使用各自的回环地址和端口。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 用户目录，也是三种入口的会话日志根目录 |
| `TRAJECTORY_PORT` | `4380` | 独立网页端口 |
| `TRAJECTORY_HTTP_PORT` | `4381` | 共享 HTTP MCP 端口 |
| `TRAJECTORY_HTTP_STATE_DIR` | Windows 为 `%LOCALAPPDATA%\CodexTrajectoryViewer`，其他平台为 `~/.codex/trajectory-http` | HTTP MCP 凭据和生成的配置片段目录 |

## 打包产物

`npm run package:desktop` 先用 Vite 构建独立网页和面板，再用 esbuild 打包服务。`dist/desktop-marketplace/.agents/plugins/marketplace.json` 描述本地来源。以下文件位于插件目录 `dist/desktop-marketplace/plugins/local-trajectory-viewer/`。

- `plugin.json` 与 `mcp.json`，用于插件注册和 stdio 服务启动。
- `server.mjs` 与 `viewer.html`，包含服务所需的 JavaScript 依赖和内联面板资源。
- `http-server.mjs` 与 `start-trajectory-http.ps1`，用于单独运行共享 HTTP 后台。
- `licenses/`，包含上游界面和打包依赖的许可证声明。

安装后的插件运行时需要 Desktop 的本地执行器能从 PATH 找到 Node.js。`references/deepseek-harness/` 是供查阅的固定提交 Git 子模块，构建和运行直接使用仓库内 `src/client/dsh/` 的代码和样式。

## 可选的共享 HTTP MCP 后台

共享后台允许多条聊天共用一个进程和会话索引。独立 HTTP 配置已通过隔离 app-server 的工具调用和资源验证，Desktop 的原生侧栏入口仍待实测。默认的 Desktop 安装使用 stdio。[HTTP MCP 验证记录](HTTP-MCP-VALIDATION.md)

打包后进入 `dist/desktop-marketplace/plugins/local-trajectory-viewer`。如需在源码目录之外运行，可以将这个插件目录完整复制到一个固定位置。

```powershell
node .\http-server.mjs config
node .\http-server.mjs start
```

第一条命令输出配置片段文件的路径。用本地编辑器打开该文件，将 `[mcp_servers.local_trajectory_http]` 整段加入当前 Codex 用户目录的 `config.toml`，随后重启 Codex。已有同名段落时更新原段落；配置片段及同目录的 `token` 包含本地认证凭据，应保留在本机的私有目录中。自定义端口或状态目录时，生成配置、启动、查询和停止都使用相同的变量值。

前台启动时按 `Ctrl+C` 停止。Windows 用户也可从打包目录启动隐藏进程并关闭终端。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-trajectory-http.ps1
node .\http-server.mjs status
node .\http-server.mjs stop
```

要退出 HTTP 试用，先停止进程，再从 `config.toml` 移除上面添加的段落。如果试用期间曾禁用 stdio 插件，重新启用它并重启 Desktop。

## 开发和验证

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run package:desktop
```

在 Windows 上可额外运行 `node scripts/verify-trajectory-http.mjs`。它需要 PATH 中有可直接运行的 `codex.exe`，也接受该文件的绝对路径作为第一个参数。脚本在隔离配置和合成日志上验证共享后台。

| 文档 | 内容 |
| --- | --- |
| [产品需求](PRD.md) | 范围、产品约定、里程碑与验收标准 |
| [M1 浏览器验证](M1-VALIDATION.md) | 展示适配、性能与 DeepSeek Harness 源码出处 |
| [M2 日志验证](M2-VALIDATION.md) | 会话索引、日志语义、浏览器验收和性能 |
| [自动历史验证](AUTO-HISTORY-VALIDATION.md) | 自动翻页、子代理目录和详情读取 |
| [M3 Desktop 验证](M3-VALIDATION.md) | 插件安装、协议实测与原生面板的验证范围 |
| [HTTP MCP 验证](HTTP-MCP-VALIDATION.md) | 独立后台的双聊天隔离与重启恢复 |
| [参考源码导航](../references/README.md) | 上游 Git 子模块内容及更新方式 |

上游提取代码的 MIT 许可证和版权声明随源码保留。项目原创部分尚未指定开源许可证。
