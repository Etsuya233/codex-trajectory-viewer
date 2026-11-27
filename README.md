# Codex Trajectory Viewer

在 Codex Desktop 内查看聊天轮次、工具调用与结果、已保存的思考摘要和执行时间线的本地轨迹查看器。

M1 提供可运行的本地网页。输入 Codex 会话 ID，即可查看最近 50 条轨迹摘要，展开工具的参数和结果，以及日志中已有的思考摘要。界面沿用 DeepSeek Harness（DSH）Trajectory 的表格、时间线和记录检查器布局。

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

打开 [本地轨迹查看器](http://127.0.0.1:4380/)，输入会话 UUID 后点击「打开」。也可以在浏览器地址中使用 `http://127.0.0.1:4380/?session=<会话 UUID>`。点击轨迹表格中的记录，在右侧检查器切换参数、结果或原始记录。内容较长时，点击「加载更多内容」。搜索范围为当前已加载摘要。

服务默认在 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 按文件名定位会话。可以通过 `CODEX_HOME` 指定日志根目录，通过 `TRAJECTORY_PORT` 指定端口。服务只在 IPv4 回环地址 `127.0.0.1` 监听，以只读方式访问指定会话。

React + TypeScript 前端使用 Vite 构建。Node.js 服务提供静态页面、最近摘要与按需详情。可执行 `npm run typecheck` 和 `npm test` 验证项目。历史分页、增量刷新、子代理导航和 Desktop 面板见后续里程碑。

## 上游版权

提取代码的 MIT 许可证和版权声明随源码保留。项目原创部分尚未指定开源许可证。具体来源及修改见 [M1 验证记录](docs/M1-VALIDATION.md)。
