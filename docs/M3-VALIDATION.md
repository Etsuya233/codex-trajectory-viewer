# M3 Desktop 验证记录

MCP Apps 面板通过 stdio 工具复用独立网页的数据接口和 React 界面。面板使用独立的静态入口，由 `resources/read` 返回包含脚本、样式的自包含 HTML，网络访问通过宿主工具桥接。独立网页保留回环 HTTP 入口。

## 已验证

| 验证层 | 实测 |
|---|---|
| Codex Desktop 内置浏览器 | 打开独立回环网页，输入真实会话 UUID 并显示 50 条摘要。目录列出 4 个子代理，打开子会话显示其 50 条记录，返回父会话后目录仍展开。 |
| 本地安装 | Codex CLI 0.166.0 成功添加 `local-trajectory` 市场并安装 `local-trajectory-viewer@local-trajectory` 1.0.0。安装缓存中的服务与 HTML 文件哈希均与打包文件一致。 |
| Desktop 自带加载器 | 使用 Desktop 捆绑的 `codex.exe 0.171.0-alpha.13.2` 复现入口缺失。插件已安装且启用，加载器拒绝便携 stdio 清单中的 `env_vars`，工具枚举未返回该服务器。移除该字段并重装后，用同一二进制枚举得到服务器及全部四项工具，包括原生入口 `open_local_trajectory_viewer`。 |
| 独立运行 | 从安装缓存启动 `server.mjs`，工作目录为临时目录。标准 MCP SDK 客户端完成初始化、工具和资源发现，并读取内联资源。运行不依赖仓库目录或仓库的 `node_modules`。 |
| Edge 隔离 MCP Apps 宿主 | 沙箱 iframe 从已安装的服务加载资源。模拟首次握手失败，点击「重试连接」成功。验证宿主提供 UUID 时显示当前聊天、参数和结果按需读取、子代理往返、关闭后重开。宿主缺失 UUID 时先显示选择器，选择后才显示所选轨迹。 |
| 两种界面一致性 | 使用同一隔离合成会话比对，独立网页和模拟面板显示的 50 个源偏移以及顺序完全一致。 |
| 自动检查 | 生产构建、Desktop 打包、类型检查和 18 项测试通过。协议测试验证便携清单字段、工具与资源元数据、身份缺失/冲突、共享查询结果、私有详情和非法路径拒绝。 |

2026-11-27 用户确认重启 Codex 后入口问题解决，并要求提交。重启后，当前聊天的工具列表已实际暴露 `mcp__local_trajectory_viewer__show_local_trajectory_viewer`。因此，本机安装后的入口发现需重启 Desktop，不能仅以 CLI 安装成功判断当前窗口已热加载。

真实原生面板的宿主身份、详情/子会话与关闭重开尚未由代理逐项实测；上表对应交互测试使用 Edge 隔离模拟宿主，Desktop 内置浏览器测试使用独立网页。新标签页界面可从「打开」旁的「…」菜单进入，旧版界面从 **+ → More tools… → Plugins and MCPs** 进入。

## 身份、隐私与打包

- 开面板只识别每次调用 `params._meta` 中的 `threadId` 或 `thread_id`。只接受格式有效且一致的 UUID。身份不可用时由用户选择会话，工具打开阶段无需读取日志。
- 开面板工具的可见文本是固定提示。轨迹查询由 app-only 工具发出，私有 `_meta` 承载会话身份与数据。工具正文、摘要和发现结果不写入模型可见的 `content` 或 `structuredContent`。
- 面板资源使用 `ui://local-trajectory-viewer/viewer-v1.html` 及 `text/html;profile=mcp-app`。面板内无独立 HTTP 连接需求，也无需为它开放回环跨域或外部资源。独立网页继续使用自己的回环 HTTP 服务。
- `npm run package:desktop` 输出可安装的 `dist/desktop-marketplace`。该目录包含便携插件清单、stdio 配置、内联面板资源、捆绑服务和第三方许可。启动和安装命令见 [README](../README.md)。

协议与安装依据：[MCP Apps 协议概览](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)、[OpenAI 本地插件打包说明](https://developers.openai.com/plugins/build/plugins)、[OpenAI Desktop-only stdio 配置](https://developers.openai.com/plugins/deploy/desktop-only)。
