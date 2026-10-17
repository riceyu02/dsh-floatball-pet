# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件记录 `dsh-floatball-pet` 的版本变更。
> 发布页用的精简摘要见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。

## 未发布

- **变更**移除独立运行版，只保留 DSH 插件一种发行方式：删掉 `启动悬浮球.cmd`、`tools/launch.cjs`、
  `npm start` / `npm run pack` 和 electron-builder 的 portable 配置。悬浮球本来就用自带的 Electron
  运行时承载，所以包体几乎不变（npm 包少约 6 KB，Release 整包相同）。
- **变更**开发调试入口改为 `npm run dev`，直接起 Electron 调界面，不经过 DSH。
- **移除**「开机自启动」功能：设置页的开关、宿主的注册表读写（`HKCU\...\Run`）、
  应用侧的 `setLoginItemSettings` 调用全部删除。需要开机启动请自行把 DSH 加进系统启动项。

## 0.1.0

首个发布：桌面悬浮球 + 灵动岛 + 设置面板，作为 DSH 插件运行。

- **悬浮球**：无边框、透明、置顶、可拖动，位置自动记忆；大小与不透明度可调。
- **灵动岛**：鼠标移入向右展开（贴近屏幕右侧时向左），显示 DeepSeek 余额与 DSH 运行时长。
- **设置面板**：点齿轮从上方升起，可换图标（GIF / PNG / JPG / WebP / BMP）、调大小与透明度、切换显示项。
- **唤起 DSH**：单击悬浮球把 DSH 窗口拉到最前（最小化也还原），未运行时启动它。
- **游戏让位**：检测到游戏全屏或无边框全屏时自动隐藏，退出全屏立刻回来。
- **托盘菜单**：显示悬浮球、打开 DSH、切换大小、退出。
- **插件包**：约 1.7 MB；Electron 运行时安装时下载到
  `<DSH_HOME>\dsh-floatball-pet\runtime\<electron 版本>\`，升级插件不重复下载。
- **下载兜底**：Electron 先走 `cdn.npmmirror.com`，失败再走 GitHub，两边都按 `SHASUMS256.txt` 校验 SHA-256。
- **koffi 随包**：置顶和游戏让位需要的原生模块随包分发，不依赖其他插件。
- **更新**：DSH 设置 →「灵动岛悬浮球」里检查更新并一键升级，装完重启 DSH 生效。
