# Codex Trajectory Viewer

在 Codex Desktop 内查看聊天轮次、工具调用与结果、已保存的思考摘要和执行时间线的本地轨迹查看器。

项目处于需求与初始化阶段，尚未实现可运行应用。界面以 DeepSeek Harness（DSH）的 Trajectory 为基准，重新实现 Codex 日志适配与增量读取。

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

当前没有配置远程仓库，也没有安装应用依赖。DSH 子模块用于查阅、比较和后续提取组件，不是已经接入的运行时依赖。

## 拟采用的技术方向

React + TypeScript 前端，Node.js 本地服务，独立的 Codex 日志解析模块，可重建的会话索引。具体构建工具、索引存储和 Desktop 桥接方式在第一阶段验证后确定。

## 上游版权

DSH 的许可证和版权声明保留在子模块中。未来复制或修改其代码时，应在本项目保留相应许可与来源记录。本项目原创部分尚未指定开源许可证。
