# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件记录 `dsh-floatball-pet` 的版本变更。
> 发布页用的精简摘要见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。

## 0.3.1

- **修复**装了 NVIDIA GeForce Experience / NVIDIA App 的机器上，悬浮球一启动就被当成「全屏游戏」永久隐藏。
  桌面的覆盖层窗口（NVIDIA 的 `cef-osc-widget`、Steam、Xbox Game Bar 等）现在不参与全屏判定；真正全屏的
  游戏和视频仍会隐藏。

## 0.3.0

- **修复**设置里不显示「灵动岛悬浮球」：设置行的宿主入口一度指向 Electron 的 `src/main.js`，DSH 宿主导入时
  `require('electron')` 抛错，整行起不来；现在入口是宿主安全的 `plugin/client-host.mjs`。
- **修复**浏览器播放视频全屏时悬浮球仍置顶挡住画面：Chrome、Edge、Firefox、VLC、PotPlayer 等全屏时与游戏一样
  隐藏，退出全屏立即恢复。
- **修复**插件升级后悬浮球仍运行上一个版本的代码：运行时缓存只按 Electron 版本复用，瘦包升级会继续用旧的
  `resources/app`；现在每次启动前按插件版本把 `src`、`plugin`、`build`、`client.js`、`package.json` 和随包的
  koffi 同步进缓存（Electron 二进制不动，不重新下载）。

## 0.2.1

- **修复**设置里不显示「灵动岛悬浮球」：设置行的宿主入口改到 `plugin/client-host.mjs`。npm 瘦包此前把包入口
  `exports["."]` 指向 Electron 的 `src/main.js`，DSH 宿主进程导入时 `require('electron')` 直接抛错，整行没起来，
  设置区也就不出现。
- **修复**浏览器播放视频全屏时悬浮球仍置顶挡住画面：全屏判定新增浏览器与视频播放器名单（Chrome、Edge、Firefox、
  VLC、PotPlayer、B 站/爱奇艺等客户端），它们无边框全屏时和游戏一样隐藏，退出全屏立即恢复。

## 0.2.0

- **变更**移除独立运行版，只保留 DSH 插件一种发行方式：删掉 `启动悬浮球.cmd`、`tools/launch.cjs`、
  `npm start` / `npm run pack` 和 electron-builder 的 portable 配置。
- **变更**开发调试入口改为 `npm run dev`，直接起 Electron 调界面，不经过 DSH。
- **移除**「开机自启动」功能：设置页的开关、宿主的注册表读写（`HKCU\...\Run`）、
  应用侧的 `setLoginItemSettings` 调用全部删除。需要开机启动请自行把 DSH 加进系统启动项。
- **变更**发布产物不再包含 Electron 运行时：npm 包与 Release 附件都是约 1.7 MB；首次安装由
  `postinstall` 下载运行时（约 110 MB），升级复用缓存。
- **变更**设置页的更新优先从 npm 安装（约 1.7 MB），失败时回退到 GitHub 附件；升级前会把旧包里的
  运行时迁移到缓存，避免重新下载。

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
