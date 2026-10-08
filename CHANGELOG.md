# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.10

两个"体感很糟"的问题：**按住拖动几秒后球沉到最底层**，以及**按 Win 键之后球不回来**。

- **修复**拖动沉底：拖动每帧都在 `setBounds` 移动窗口，而每次移动都会让 Chromium 重刷扩展
  窗口样式、把 `WS_EX_TOPMOST` 抹掉；此前只有 3 秒的 JS 重申与 15 秒的原生兜底，所以按住不动
  几秒后（第一次 tick）球就掉到最底下。现在：① 每次窗口移动后**立即原生复位置顶**，并在
  **40 ms 后**再复检一次（那次样式重刷约 1 ms 后落地）；② 悬停/点击穿透样式变化
  （`setIgnoreMouseEvents`）后同样处理——它是另一个重刷触发点；③ 原生看护在**拖动期间提速到
  60 ms**（静止时仍是 250 ms）。
- **修复**按 Win 键后球不回来：桌面、任务栏、开始菜单、Alt-Tab 这些**外壳窗口的矩形同样是
  "覆盖全屏"**，被误判成"有全屏程序在前台"而继续撤置顶。现在按窗口类名排除
  （`Progman` / `WorkerW` / `Shell_TrayWnd` / `Windows.UI.Core.CoreWindow` 等），并把类名写进
  日志便于排查。类名与判定都用真实窗口核对过。

## 0.2.9

修两个体感问题：**悬浮球忽隐忽现地闪**，以及**盖在全屏游戏上**。

- **修复**闪烁：鼠标移入移出会改变"点击穿透"样式（`setIgnoreMouseEvents`），而 Chromium 每次
  都会**重刷整个扩展样式**，把 `WS_EX_TOPMOST` 抹掉——于是悬浮球在"最上层"和"被盖住"之间跳。
  修法是提高原生复查的频率，但 PowerShell 一次要几百毫秒，扛不住用户级的交互频率，所以新增
  `src/win32.js`：**借用 profile 里已有的 koffi**（`dsh-orb` 或 DSH 自带）在**进程内**直接调
  `GetWindowLong` / `SetWindowPos`，每 250 ms 读一次真实的置顶位，缺了就写回去；拿不到 koffi
  时自动退回原来的 15 秒 PowerShell 兜底（行为不变，只是慢）。
  实测：外部强行清掉置顶位后 **120 毫秒**恢复（旧版 2.6 秒），连清 5 次 **5/5** 恢复。
- **新增**全屏让位：只要有**覆盖整个显示器**的窗口在前台（游戏、视频），就主动**撤掉置顶**，
  悬浮球不再画在它上面；那个窗口不再在前台时自动恢复置顶。判定用前台窗口矩形与悬浮球所在
  显示器的 bounds 比对（留 2 px 容差），并排除自己的窗口。四种几何情形已用真实窗口验证。

> 说清楚依赖关系：koffi 是**可选**的加速路径，不是新依赖——`package.json` 里没有它，加载不到就
> 走兜底。它带来的差别是"闪烁窗口 250 ms"与"最长 15 秒"。

## 0.2.8

修 0.2.6 自动更新会把 profile 弄坏的问题。测试者的失败记录把链路拆得很清楚：**不是装不上，
而是失败后 DSH 直接起不来**。

- **修复** 交接脚本只等主进程的问题。桌宠退出后会按设计留下一个 **detached 的焦点帮手**
  （就是包内那个 `runtime\DSH悬浮球.exe`，以 `ELECTRON_RUN_AS_NODE=1` 当 Node 跑），它继续占用
  `runtime\`，于是 pnpm 的 `importPackage` 必然 `ERR_PNPM_EPERM`。现在等的是
  **"所有镜像位于该包目录下的进程都消失"**（按可执行文件路径枚举，不依赖记 pid），并且桌宠在
  交接前会先 `stopFocusAgent()`，让这个等待通常一两秒就结束。
- **修复** 超时不再硬上。以前等待循环到期就照样安装（那正是必然 EPERM 的情形）；现在超时即中止，
  写 `reason: "helper-running"`，**一个字节都不动你的安装**。
- **修复** 失败后可自愈。安装后会校验包是否完整（`package.json` 可解析、`dsh.bundle.patch`、
  `cordis.patch.yml`、`plugin/host.mjs` 都在）；不完整就杀掉残留进程、清掉被掏空的包目录与
  pnpm 的 `*_tmp_*` 孤儿目录，**重装一次**；仍然失败则把**恢复命令**写进状态文件。
- **面板**：失败时显示原因（例如"还有进程在跑，为避免只装一半已中止"）与恢复步骤；
  点「更新」前的提示也改成"期间请勿重开 DSH"。
- **README**：手工升级那条坑补上——**焦点帮手是独立进程，托盘退出不会带走它**，必须确认没有
  `DSH悬浮球` 进程残留再升级。

> 更新模块的自测同步扩到 10 项：把 CLI 换成"第一次失败、第二次成功"的桩，验证它确实清理了
> 被掏空的目录与 `_tmp_` 残留、重试一次并判定成功。全过。

## 0.2.7

置顶这次是真的修好了，并且**更正 0.2.4 的错误归因**。

- **修复** 置顶：0.2.4 把看门狗换成 `setAlwaysOnTop(false)` + `setAlwaysOnTop(true)` 的"切换"，
  以为单发 `true` 会因为 Chromium 缓存而不发原生调用。**这个判断是错的**：测试者用微秒级原生
  采样证明两个调用都真的落到了 Win32 —— `false` 清掉位元、`true` 又把位元设上，但约 **0.7 毫秒
  后**窗口样式被再次应用、位元又被抹掉。而同一版本还删掉了唯一会"抬升"窗口的 `moveTop()`，
  净效果就从「每 3 秒冒一下」变成了**永久沉底**（实测 z 序第 27/32）。
  现在：看门狗只调用 `setAlwaysOnTop(true, 'floating')`（**再也不调 `false`、也不调 `moveTop`**），
  另外每 5 个周期通过随包的 `PetFocus.dll` 读一次真实的 `WS_EX_TOPMOST`，**只有真的缺了**才用
  `SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 写回去——原生路径不受
  Chromium 缓存影响。
  实测（本机、同一套判据）：静置 10 秒位元稳定为 `0x08080028`、零次翻转；从外部用
  `HWND_NOTOPMOST` 强行清掉后 **2.6 秒自行恢复**，再观察 10 秒保持稳定。
- **修复** `tools/publish-release.ps1`：Release 正文里的 SHA256 与附件对不上，根因是
  **PowerShell 的 `Invoke-RestMethod -InFile` 上传会改文件**——同一份本地包经它上传后，
  GitHub 收到的是"少 289 字节、摘要不同"的另一份（改用 `curl.exe` 重传后摘要与本地逐字节一致）。
  现在上传一律走 `curl.exe`，并把 GitHub 返回的 `digest` 与本地哈希**比对通过才算成功**；
  已存在的附件也先校验摘要再复用。旧 Release 正文里的哈希不准，附件本身是完整的
  （校验请以 GitHub 的 `digest` 为准）。
- **修复** `tools/build-focus-dll.cjs`：`PetFocus.dll` 新增 `Topmost(IntPtr)` 导出
  （读 `GWL_EXSTYLE`，缺位元才写 `HWND_TOPMOST`）。

> 感谢测试者的第二份报告：微秒级位翻转序列、"外部 SetWindowPos 能长期存活"的对照、
> 以及 Release 哈希核对，三条都直接指向了正确修法。

## 0.2.6

新增：**在设置面板里检查更新，并一键升级到最新版。**

- 面板底部多了一栏「版本」：显示当前版本，点「检查更新」就向
  `api.github.com/.../releases/latest` 查询最新 Release；有新版本时按钮变成
  「更新到 vX.Y.Z」，并显示安装包大小。
- 点「更新」会：把 Release 里的 `.tgz` 下载进 `<profile>\plugin-tarballs\`（先写 `.part`
  再改名，下载中断不会留下半个包）→ 写一个**脱离悬浮球的安装脚本** → 悬浮球自己退出。
- **为什么必须交接**：悬浮球的可执行文件就在 pnpm 要替换的那个目录里，进程活着时替换
  必然 `ERR_PNPM_EPERM`（实测过）。所以由那个脚本等悬浮球退出后，再调用 DSH 的 CLI
  `plugin --profile <名称> add <安装包>` 完成安装。
- 装完**重启 DSH 生效**（DSH 对"同一个包换版本"会报 `restart-required`，新代码无法热加载）。
  下次打开面板会显示上一次更新的结果（成功，或失败加退出码）。
- 请求走 Electron 的 `net` 而不是 node 的 http：这样会自动使用系统代理设置——在
  github.com 只能走代理的网络里，这是"能用"和"超时"的区别。
- 独立运行模式（非插件）只提供检查与下载信息，不自动安装——它没有 profile 和 CLI。

> 更新模块带了一套不依赖 Electron 的自测（把 `electron.net` 换成假响应，跑通
> 查版本 → 选附件 → 下载 → 生成交接脚本 → 脚本真的执行并写回状态），15 项全过。

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
