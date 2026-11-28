# Codex Trajectory Viewer

在 Codex Desktop 里打开「本地 Codex 轨迹」，查看本机聊天的执行时间线、工具调用和结果、已保存的思考摘要，以及子代理的独立轨迹。

## 安装前准备

1. 安装 Codex Desktop。如果终端无法运行 `codex --version`，按官方指南安装 Codex CLI。在 Windows 上也可以用命令提示符（CMD）检查这条命令。[Codex CLI 安装指南](https://learn.chatgpt.com/docs/codex/cli#install-codex)
2. 安装 Node.js 24 或更新版本（含 npm）。安装后重新打开终端，用 `node --version` 确认版本。[Node.js 下载](https://nodejs.org/en/download)
3. 将维护者提供的项目源码解压或克隆到一个长期保留的目录。打开包含 `package.json` 和 `scripts` 的项目根目录。首次安装需要联网下载依赖。

## 安装并打开面板

在项目根目录打开 Windows PowerShell，运行下面的命令。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop.ps1
```

脚本会下载依赖、构建插件，并通过 Codex CLI 注册本地来源和安装插件。执行策略参数只作用于这次启动的 PowerShell 进程。其他系统或希望逐条执行的用户可参考[手动安装](docs/TECHNICAL.md#手动安装)。

1. 安装完成后，**完全退出并重新启动 Codex Desktop**。
2. 打开一条本地聊天。在右侧新标签页点击「打开」旁的「…」，选择「本地 Codex 轨迹」。旧版入口在 **+ → More tools… → Plugins and MCPs**。
3. 面板能识别当前聊天时会自动打开对应轨迹。顶部选择器显示正在查看的聊天，可以从本机历史切换，或点搜索框右侧的「当前聊天」回到 Codex 当前打开的聊天。使用工具栏里的「代理」查看子代理，或选择「主代理」回到根会话。

主线程默认在后台加载完整历史，子代理按页加载。工具栏「代理」右侧的「设置」可将主线程切换为部分加载，向上滚动即可翻阅更早的记录；也可关闭工具折叠，或设置末尾连续工具记录是否保持展开。

「搜索轨迹」会搜索所选会话的历史，支持关键词或工具名。「仅错误」可单独开启，也可与关键词一起使用。点击记录可查看参数、结果和原始记录。工具栏里的「统计」显示日志中保存的 Token 用量和轮次耗时。滚动时当前轮次固定在表格上方，也可用上一轮/下一轮跳转。界面跟随系统亮暗主题。

## 配置和常见问题

- **使用默认 Codex 目录**。安装后即可使用，配置由 Codex CLI 写入。Windows 默认目录为 `%USERPROFILE%\.codex`。查看器以只读方式打开本机已保存的聊天日志。
- **使用自定义 Codex 目录**。如果已把 Codex 数据存放在其他位置，请让安装终端和 Desktop 使用相同的 `CODEX_HOME`。Windows 可在开始菜单搜索「编辑帐户的环境变量」，在用户变量中将 `CODEX_HOME` 设为包含 `sessions` 的 Codex 根目录，再重新打开终端和 Desktop。
- **找不到插件入口**。先确认安装命令成功结束，再完全退出并重开 Desktop。检查终端能运行 `node --version`。如果刚装好 Node.js，先关闭旧终端并重新打开，也重新启动 Desktop，让它读取更新后的 PATH。
- **找不到目标聊天**。先在「选择会话」中查找。该聊天需要有保存在本机的日志，请同时确认 Desktop 使用的 Codex 目录。

## 更新和卸载

在原目录获取新版源码，重新运行安装命令，再重启 Codex Desktop。若将项目移到了新位置，先移除旧的本地来源，再从新位置安装。

在项目根目录运行以下命令卸载插件，再重启 Codex Desktop。聊天日志会保留。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-desktop.ps1
```

如果要同时移除本地插件来源，在命令末尾加 `-RemoveMarketplace`。移除来源后，即可从新位置再次安装。

## 使用浏览器

也可以在项目根目录启动独立网页。Windows 用户可在命令提示符（CMD）执行下面的命令。

```sh
npm ci --include=dev
npm run build
npm start
```

打开[本地轨迹查看器](http://127.0.0.1:4380/)，点击「选择会话」或输入会话 ID。使用完毕后，在启动服务的终端按 `Ctrl+C`。

打包方式、配置变量、共享 HTTP 后台和验证命令见[技术文档](docs/TECHNICAL.md)。
