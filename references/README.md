# DSH 参考源码

上游：https://github.com/deepseek-ai/deepseek-harness

固定提交：`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`

采用 Git submodule 保存上游完整仓库，便于跨包查找类型、样式及运行时依赖。父仓库只记录确定的提交，构建使用 `src/client/dsh/` 中提取的展示组件与样式。提取范围和本地修改见 [M1 验证记录](../docs/M1-VALIDATION.md)。

## 阅读顺序

1. `deepseek-harness/packages/client/ui-trajectory/package.json`：包边界及依赖。
2. `deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryView.tsx`：展示入口、状态和加载接口。
3. `deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`：轨迹表格。
4. `deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx`：时间线。
5. `deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx`：工具栏。
6. `deepseek-harness/packages/client/ui-trajectory/src/client/trajectory-contract.ts`：DSH 展示数据协议。
7. `deepseek-harness/packages/client/ui-trajectory/src/client/index.ts`：会话绑定与宿主集成。
8. `deepseek-harness/packages/client/ui-subagent/src/client/index.ts`：子代理会话打开方式。

展示代码还引用 conversation、primitives、slots、store 等包；完整仓库保留这些依赖供追踪。不要为复用界面直接引入整个 Harness 运行时，先评估组件的最小依赖闭包。

## 恢复与更新

在本项目根目录恢复固定版本：

```sh
git submodule update --init --recursive
```

确实需要升级参考版本时：

```sh
git -C references/deepseek-harness fetch origin
git -C references/deepseek-harness checkout <经过审查的提交>
git add references/deepseek-harness
```

同时更新本文的固定提交，检查组件变化并提交父仓库。不要直接在参考子模块中开发本项目功能。

## 许可

上游采用 MIT 许可证，原文见 [LICENSE](deepseek-harness/LICENSE)。未来提取文件时保留版权和许可声明，并记录来源提交及本地修改。
