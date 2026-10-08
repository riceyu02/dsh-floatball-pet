# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.5

修「运行时间」的两处不准：一开始显示「未运行」，以及时间从"打开之后"开始算。

- **修复** `src/main.js`：运行时间的探针原本固定 15 秒一次，而插件模式下悬浮球是在 DSH
  **启动过程中**被拉起的——那时 DSH 的 Web 端口还没监听，头几次探针当然什么都看不到，
  于是最长要等 15 秒才纠正（表现为「开 DSH 后显示未运行，过一会儿/动一下窗口才更新」）。
  现在改成自适应节奏：**没探到 DSH 时每 2 秒一次，探到之后回到 15 秒**。
- **修复** `src/dsh.js`：拿到 DSH 的进程启动时刻要靠 PowerShell 读 `StartTime`，而受限令牌下
  **枚举不到其它进程**（正是焦点帮手存在的那个限制）。取不到时代码退化成
  「从我发现它活着的那一刻开始算」——这就是"时间从打开后开始计算"。现在退化成两级更好的猜测：
  ① 上一次探到端口**关闭**的时刻（DSH 必然在它之后启动，配合 2 秒快探误差只有一两秒）；
  ② 插件模式下**本进程自己的启动时刻**（约等于 DSH 启动 +2 秒）。等 Windows 之后能给出真实值时，
  依然会自动纠正回来。

## 0.2.4

修掉 0.2.3 引入的置顶回归——那个"每 3 秒重申置顶"的看门狗，**本身就是把窗口踢出置顶层的操作**。

- **修复** `src/main.js`：看门狗里的 `win.moveTop()` 会清除 `WS_EX_TOPMOST`（把一个
  `WS_EX_LAYERED | WS_EX_NOACTIVATE` 的窗口按 `HWND_TOP` 重排，就把它从置顶带里挪出来了），
  而随后的 `win.setAlwaysOnTop(true, 'floating')` 因为 Chromium 缓存了"已经是置顶"而**直接返回、
  不发原生调用**，于是永远修不回来。净效果：窗口在 3 秒周期里短暂浮到非置顶带最上面，再被下一个
  激活的窗口盖住——正是"打开浏览器几秒后浮上来、随即又被盖住"那个现象。
  现在置顶一律走 `assertOnTop()`：先 `setAlwaysOnTop(false)` 再 `setAlwaysOnTop(true, 'floating')`，
  强制发出 `HWND_NOTOPMOST` → `HWND_TOPMOST` 两次原生调用，把位元真正设回去；`moveTop()` 从代码里
  彻底移除（创建、显示器变化、托盘、second-instance 四处都改用它）。
  实测：修好后 `WS_EX_TOPMOST` 在 15 秒连续采样（跨 5 个看门狗周期）**零次翻转**，稳定为
  `0x08080028`；0.2.3 上同样的测量是约 2.5 秒被抹掉一次。

> 感谢测试者提供的定位报告：3 秒网格的相位分析、外部 `SetWindowPos` 对照、以及"DSH 自身窗口
> 不受影响"的对照实验，直接把范围缩到了看门狗自己身上。

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
