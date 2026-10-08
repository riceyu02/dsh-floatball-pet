# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

- **修复**：悬浮球在某些机器上会被压到所有窗口下面。置顶原先只在**创建、显示、托盘点击、
  显示器变化**这几个时刻声明一次，而 Windows 会在别的置顶窗口／全屏程序抢走前台时把窗口
  移出置顶层，事后没有任何通知（`isAlwaysOnTop()` 只回报我们自己设的标志位，察觉不到被顶掉）。
  现在每 3 秒重申一次（`moveTop` 是无激活重排，不会抢焦点）。实测当前窗口的
  `WS_EX_TOPMOST` 为真。
- **文档**：新增「让 DSH 的 AI 帮你装」，含可直接转发给对方的提示词，以及各条安装路径下
  "哪些事必须由人来做"（应用内接口装完当场生效、命令行装完要重启、git 路线要放行构建脚本）。
- **文档**：记录 git 依赖的长期隐患——profile 里挂着 git 依赖时，后续任何一次装包都会让 pnpm
  重新解析它、重跑它的 `prepare`；而应用内安装用的是净化过的环境（没有代理、没有
  `ELECTRON_MIRROR`），这一步会静默卡到 10 分钟超时。长期使用建议换成 `file:` 形式的 tarball，
  放进 `<profile>\plugin-tarballs\`。
- **文档**：记录实测结论——走应用内插件管理接口安装会返回 `application: "applied"`，
  旧实例退出、新实例自动拉起，**不需要重启 DSH**。

## 0.2.2

从 git 装、从安装包装，都能真正跑起来了。0.2.1 的安装包有一个会让悬浮球"装了不出现"的缺陷。

- **修复** `plugin/host.mjs`：helper 原本会继承 DSH 宿主发给子进程的 `ELECTRON_RUN_AS_NODE=1`，
  于是 `DSH悬浮球.exe` 以**纯 Node 模式**启动——不创建窗口、日志一个字节不写、退出码 0。
  这正是"重启 DSH 后球不出现"的根因：插件挂载正常、运行时也在，但 helper 从来不是以
  Electron 应用的身份起来的（独立模式的 `.cmd` 启动器早就清掉了这个变量，插件侧漏了）。
  现在把 `ELECTRON_RUN_AS_NODE` 与 `ELECTRON_NO_ATTACH_CONSOLE` 从 helper 环境里剥掉，
  其余变量照旧继承，并补了单元测试。
- **修复** `tools/prepare-install.cjs`：原先按"路径里有 `node_modules`"判断这是不是一次安装，
  而 pnpm 拉 git 依赖时是在自己的构建目录里打包（路径里并没有 `node_modules`），于是**装出来的
  包里没有运行时**。现在改为看这棵树有没有 `.git`：工作副本跳过，抓取来的副本才组装。
- **修复** `tools/prepare-install.cjs`：只检查 `electron.exe` 存在是不够的——解压被中途打断
  （安装失败时 pnpm 会杀整棵进程树）会留下"有 exe、缺 `ffmpeg.dll` 和 locale"的残缺 dist，
  而 npm 不会为它认为已安装的包重跑 postinstall，这种运行时**根本起不来**。现在按
  `ffmpeg.dll` / `icudtl.dat` / `resources.pak` / `v8_context_snapshot.bin` 判断完整性，
  不完整就删掉重下，并在下载后复查。
- **修复** `tools/build-focus-dll.cjs`：静音会漏进构建日志的 CLIXML 进度流。
- **文档**：`github:` 简写会被解析成 SSH（没有 SSH key 的机器报 `Host key verification failed`），
  改用 `git+https://…` 写法；`allowBuilds` 的键是「包名@pnpm 解析出的地址」而不是裸包名，
  按 pnpm 打印的原文照抄；补上「`git` 必须在 PATH 上」这个前置条件。

## 0.2.1

仓库整理与安装路径完善，应用本体与 0.2.0 相同。

- **新增**三种安装方式并写进 README：Release 安装包、git 直装（新增 `prepare` 钩子，
  在用户机器上现场组装 Electron 运行时）、源码自行构建。
- **新增** GitHub Actions 工作流：推 `v*` 标签即自动构建插件包并挂到 Release。
- **新增** `tools/publish-release.ps1`：在 git 到 github.com 不通的机器上，
  改走 GitHub API 发布 Release 与上传安装包。
- **新增** `.gitattributes`：统一换行（`.cmd`、`.ps1` 固定 CRLF，其余 LF，二进制不转换），
  免得 `cmd.exe` 和 Windows PowerShell 在 LF 检出上翻车。
- **修复** `tools/assemble.cjs`、`tools/build-focus-dll.cjs` 里写死的绝对路径，
  现在从脚本位置推导仓库根目录，任何路径下都能构建。
- **补齐** `tar` 依赖声明（此前依赖 electron-builder 的传递依赖）、`node >= 22` 引擎声明。
- **清理** 44 个 `tools/*.bak*` 历史备份、`tools/launch-out.txt`、`dist/`（约 481 MB 组装产物）、
  一个临时测试 userData 目录、4 个一次性诊断/严格模式启动脚本，以及旧版本安装包
  （Release 里已有同一份，SHA256 一致）。

## 0.2.0

首次公开发布。

- 以 Cordis bundle 形式接入 DeepSeek Harness 桌面端：悬浮球 + 灵动岛（余额 / 运行时间）+ 设置面板。
- DSH 启动、禁用插件或退出时自动管理悬浮球 helper 生命周期，不留孤儿进程。
- 安装包内置 Windows x64 Electron 运行时，安装及首次启动无需再下载 Electron。
- 保留独立 Electron 程序运行方式（`启动悬浮球.cmd`）。
