# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.1

仓库整理与安装路径完善，应用本体与 0.2.0 相同。

- **新增**三种安装方式并写进 README：Release 安装包、`github:` 直装（新增 `prepare` 钩子，
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
- **修复** `tools/prepare-install.cjs`：原先按"路径里有 `node_modules`"判断这是不是一次安装，
  而 pnpm 拉 git 依赖时是在自己的构建目录里打包（路径里并没有 `node_modules`），于是**装出来的
  包里没有运行时**。现在改为看这棵树有没有 `.git`：工作副本跳过，抓取来的副本才组装；
  并且 npm 11 拦截 Electron 的 postinstall 时会自动补下二进制。已在两种情形下分别实测。
- **修复** `tools/prepare-install.cjs`：只检查 `electron.exe` 存在是不够的——解压被中途打断
  （安装失败时 pnpm 会杀整棵进程树）会留下一个"有 exe、缺 `ffmpeg.dll` 和 locale"的残缺
  dist，而 npm 不会为它认为已安装的包重跑 postinstall。实测这种运行时**根本起不来**。
  现在按 `ffmpeg.dll` / `icudtl.dat` / `resources.pak` / `v8_context_snapshot.bin` 判断完整性，
  不完整就删掉重下，并在下载后复查。
- **文档**：`github:` 简写会被解析成 SSH（无 key 的机器报 `Host key verification failed`），
  改为给出 `git+https://…` 写法；`allowBuilds` 的键是「包名@解析出的地址」而非裸包名，
  按 pnpm 打印的原文照抄。

## 0.2.0

首次公开发布。

- 以 Cordis bundle 形式接入 DeepSeek Harness 桌面端：悬浮球 + 灵动岛（余额 / 运行时间）+ 设置面板。
- DSH 启动、禁用插件或退出时自动管理悬浮球 helper 生命周期，不留孤儿进程。
- 安装包内置 Windows x64 Electron 运行时，安装及首次启动无需再下载 Electron。
- 保留独立 Electron 程序运行方式（`启动悬浮球.cmd`）。
