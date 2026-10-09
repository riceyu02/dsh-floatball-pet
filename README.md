# DSH 悬浮球桌宠（dsh-floatball-pet）

> 由 [Riceyu02](https://github.com/riceyu02) 维护的第三方社区插件。本项目与 DeepSeek AI
> 无隶属、认可或合作关系。

一个常驻桌面的**系统级悬浮球**：平时就是一颗小鲸鱼球，鼠标移上去**向右展开成灵动岛**——
上方显示 DeepSeek 余额、下方显示 DSH 运行时长（精确到秒）、最右侧一个设置按钮；点设置按钮，
**上方升起设置面板**，拖滑块就能同时改变悬浮球和灵动岛的大小。**单击悬浮球即可唤起
DeepSeek Harness 窗口**。

它有两种运行方式：

- **DSH 插件（推荐）**：装进 profile，由 DSH 启动和回收；DSH 退出后悬浮球自动退出。
- **独立 Electron 程序**：仓库里自带启动器；DSH 关掉或最小化到托盘，悬浮球仍可独立运行。

| 待机 | 悬停展开灵动岛 | 点齿轮升起设置面板 |
|---|---|---|
| ![待机](docs/01-idle.png) | ![悬停](docs/02-hover.png) | ![设置](docs/03-panel.png) |

```
         ┌─────────────────────────────┐
         │  悬浮球设置                  │
         │                             │  ← 点齿轮后从上方升起
         │  悬浮球大小          56 px  │
         │  ●━━━━━━━━━━━━━━━━━━━━━━━   │  ← 拖动即实时缩放
         │  灵动岛会随悬浮球一起缩放    │
         │                             │
         │  不透明度            100%   │
         │  ●━━━━━━━━━━━━━━━━━━━━━━━   │
         │  ○── 开机自动启动            │
         │  [ 打开 DSH ]   [ 退出 ]     │
         └─────────────────────────────┘
   ╭───────╮
   │🐋     │ 余额 ¥6.77              │  ← 悬停时向右展开成灵动岛
   ╰───────┤ 运行 5时 46分 33秒   ⚙  │
           ╰─────────────────────────╯
```

---

## 功能

| 能力 | 说明 |
|---|---|
| **悬浮球** | 无边框、透明、置顶、不占任务栏；可任意拖动，位置自动记忆 |
| **灵动岛** | 鼠标移入球体 → 向右展开（贴近屏幕右侧时自动改为**向左展开**） |
| **余额** | 实时读取 DeepSeek 账户余额，变化时数字有一次高亮闪烁 |
| **运行时间** | **精确到秒**，每秒自增；DSH 未运行时显示「未运行」 |
| **设置面板** | 点灵动岛内侧的齿轮，面板从上方升起（贴近屏幕顶部时改为下方） |
| **大小滑块** | 拖动即改悬浮球直径（40–96 px），灵动岛、字号、齿轮同步等比缩放 |
| **唤起 DSH** | 单击悬浮球：DSH 在运行就把窗口拉到最前（最小化也会还原），否则启动它 |
| **自定义图标** | 可换成 GIF 动图或 PNG / JPG / WebP / BMP，随时一键恢复默认立绘 |
| **游戏让位** | 检测到**游戏**全屏 / 无边框全屏时自动隐藏悬浮球，退出全屏立刻回来。独占全屏由系统识别；无边框全屏按"无边框 + 占满整屏"判定，浏览器 F11、播放器、最大化窗口都不会误判（判定依据与可配置名单见下文） |
| **版本更新** | DSH 设置 →「灵动岛悬浮球」里检查更新并一键升级（装完重启 DSH） |
| **托盘** | 托盘菜单可显示悬浮球、打开 DSH、快速切换大小、退出 |
| **开机自启** | DSH 设置 →「灵动岛悬浮球」里的开关（插件模式下等于让 DSH 开机启动；独立模式仍是面板里的开关） |

---

## 安装：作为 DSH 插件

需要 Windows 10/11 与已安装的 DeepSeek Harness。下面命令里的 `dsh` 指桌面版自带的 CLI，它在：

```text
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
```

它默认**不在 PATH 上**，所以先挑一种叫法（下文统一写成 `dsh`，你替换成自己选的那种）：

```powershell
# 1) 已经把它加进了 PATH，直接用
dsh plugin --profile desktop add <参数>

# 2) 用完整路径调用（把 <DSH 安装目录> 换成真实目录，例如 D:\DeepSeekHarness）
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <参数>

# 3) 或先切到它所在目录，再用相对路径
cd "<DSH 安装目录>\resources\runtime\cli\bin"
.\dsh.cmd plugin --profile desktop add <参数>
```

`--profile desktop` 是桌面版实际使用的 profile 名，**不要改**。

装法一共五条，代价差得很多，按省事程度排：

| 方式 | 需要什么 | 代价 |
|---|---|---|
| **方式四**（从 npm 装，插件页一键） | 能连 npm 源（国内选「中国大陆镜像源」） | 2.2 MB 的包，装时**另下约 110 MB 的 Electron**；**唯一能在插件页里一键装的方式** |
| **方式零**（用本地 Release 包，最适合发给别人） | 只要能收到 `dsh-floatball-pet-0.2.21.tgz` 这个文件 | 约 114.5 MB 的包（内含运行时），装完即用：不构建、**不下载 Electron**、不需要放行构建脚本 |
| **方式一**（Release 下载地址，推荐） | 能连 `github.com` | 下载 114.5 MB |
| **方式二**（git 仓库地址） | 能连 `github.com`、`git` 在 PATH、放行构建脚本 | 包里只有代码（约 2 MB），装的时候**另下约 110 MB 的 Electron**；换 commit 要重新放行一次 |
| **方式三**（自己构建） | Node.js 22+，能连 `github.com` 与 npm 源 | `npm install` 之后自己跑一条打包命令；不需要放行构建脚本，适合想改代码的人 |

两个包的体积差在哪：**0.2.21 起，从源码构建出来的包不含 Electron**（`runtime/` 占了旧包的
100%），改为安装时按需下载并缓存；而 Release 里那份是特意打进包的，给**装完即用、甚至离线**的场景。
两条路的运行时位置、下载时机和缓存规则见文末「运行时放在哪、什么时候下载」一节。

**要发给别人，用方式零**——不依赖对方能否连 GitHub、也不用等他构建，最不容易中途卡住。方式二更适合想跟源码、或拿不到 Release 资产的人。

> 下面的小节顺序是「方式一 → 方式零 → 方式二 → 方式三」：方式一和方式零用的是同一个包、同一条命令，只是包从哪来不同，所以放在一起讲。

### 方式一：装 Release 里的安装包（推荐，不需要编译）

**第一步：拿到这个文件。** 两种途径，任选其一。

浏览器下载：打开 [Releases](https://github.com/riceyu02/dsh-floatball-pet/releases) 页面，
在 `v0.2.21` 那一条下面点 `dsh-floatball-pet-0.2.21.tgz`（约 114.5 MB）。

命令行下载（省得点）：

```powershell
curl.exe -L -o "$env:USERPROFILE\Downloads\dsh-floatball-pet-0.2.21.tgz" `
  https://github.com/riceyu02/dsh-floatball-pet/releases/download/v0.2.21/dsh-floatball-pet-0.2.21.tgz
```

> **`curl.exe` 不会自动走系统代理**：代理只配在浏览器里的话，这条会变成直连 `github.com`，
> 实测能连上但慢到几 KB/s。有代理就显式加上（端口按自己的代理软件改）：
>
> ```powershell
> curl.exe -L --proxy http://127.0.0.1:7897 -o "$env:USERPROFILE\Downloads\dsh-floatball-pet-0.2.21.tgz" `
>   https://github.com/riceyu02/dsh-floatball-pet/releases/download/v0.2.21/dsh-floatball-pet-0.2.21.tgz
> ```
>
> 不想折腾命令行就走浏览器下载那条。

**第二步：用本地路径装它。**

```powershell
dsh plugin --profile desktop add "$env:USERPROFILE\Downloads\dsh-floatball-pet-0.2.21.tgz"
```

**第三步：完全退出并重新打开 DSH**，悬浮球就会出现。

> 也可以跳过第一步，直接把地址交给 DSH 去取：
>
> ```powershell
> dsh plugin --profile desktop add https://github.com/riceyu02/dsh-floatball-pet/releases/download/v0.2.21/dsh-floatball-pet-0.2.21.tgz
> ```
>
> 但下载是 **DSH 自己在做**，走的是命令行网络：如果这台机器只有浏览器能连 GitHub（代理只配在
> 浏览器里），这条会卡住或报错，那就换回本地路径那条。**别用会被清理的目录**——`file:` 依赖会记住
> 路径，之后文件没了，升级或重装时就取不到源。

### 方式零：用本地 tgz 装（最适合发给别人，也最稳）

和方式一的第二步是同一条命令，区别只在于**包从哪来**：对方收你的微信/网盘/邮件附件，而不是自己去下。
包名固定是 `dsh-floatball-pet-<版本>.tgz`，当前发布版是 `dsh-floatball-pet-0.2.21.tgz`。

```powershell
dsh plugin --profile desktop add "<放 tgz 的目录>\dsh-floatball-pet-0.2.21.tgz"
```

体积约 114.5 MB。**把这个文件放在一个不会被清理的地方**：本地路径装出来的依赖会记住这个位置
（profile 的 `package.json` 里写着 `file:` 加该路径），日后升级或在插件页重装时还要回来找它；
放在临时目录里、或装完就删掉，之后就取不到源了。路径也**建议全英文**（原因见「独立运行」一节）。
0.2.20 起安装包内已自带 koffi 及其原生二进制，对方不需要装 Node、也不需要联网。

### 方式二：直接用 GitHub 仓库安装（不需要 Release）

```powershell
dsh plugin --profile desktop add git+https://github.com/riceyu02/dsh-floatball-pet.git#v0.2.21
```

前置条件：**`git` 必须在 PATH 上**（pnpm 靠它取仓库）。用 `git+https://…` 而不是 `github:` 简写
——后者会被解析成 `git+ssh://git@github.com/…`，没有配 SSH key 的机器会直接
`Host key verification failed`。

**建议钉一个 tag（如上面的 `#v0.2.21`），不要跟着 `main` 走。** 原因见下：放行的键里带着 commit，
跟 `main` 意味着插件每更新一次，装的人就要重新放行一次；钉 tag 则一个版本只需放行一次。

这条路径不下载预编译包，而是在你机器上现装依赖、现组装 Electron 运行时——实测装完 `runtime\`
目录占 273 MB（tgz 里已经装好的那一份解压出来也是这个数），加上下载和解压，要几分钟。
第一次跑通常会在**构建脚本**这一步停下：pnpm 11 默认拦截依赖的构建脚本，并把它要求的那一行
原样打印出来，例如

```yaml
allowBuilds:
  "dsh-floatball-pet@https://codeload.github.com/riceyu02/dsh-floatball-pet/tar.gz/2f1a…": true
```

把这行照抄进 `<profile>\pnpm-workspace.yaml` 再跑一次。**注意键是「包名@pnpm 解析出的地址」，
不是裸包名**——pnpm 对 git 依赖只认这个精确匹配（裸包名与通配符都不生效），而地址里带着它给
这次抓取算的 commit，所以换一个 commit 就得换一行。DSH 插件页上也有对应的
「允许这些脚本并重试」按钮。Electron 下载慢时先设 `$env:ELECTRON_MIRROR`，见「常见问题」。

### 方式四：从 npm 装（DSH 插件页里一键安装）

包名是 **`dsh-floatball-pet`**，与仓库同名。

> **改过名。** 这个项目原本叫 `dsh-desktop-pet`，npm 上那个裸名已被另一个作者的同类项目占用
> （作者 `matchafrenchfries`），所以 npm 包名换成了 `dsh-floatball-pet`；GitHub 仓库也迁到了
> [riceyu02/dsh-floatball-pet](https://github.com/riceyu02/dsh-floatball-pet)，旧仓库保留作为存档。
> 已经装过旧版的人：旧版的自更新器指向旧仓库，需要按方式一/方式零重装一次才能跟到新仓库。

这是**唯一能让"DSH 插件页 → 添加插件 → 中国大陆镜像源"生效**的方式：那个面板里只有
npm 包名会走镜像源，GitHub 地址和 `.tgz` 直链都会绕过它。

**在插件页里**：DSH 设置 → 插件 → 添加插件 → 填 `dsh-floatball-pet` →
安装源选「中国大陆镜像源」→ 安装 → **完全退出并重开 DSH**。

**命令行等价**：

```powershell
dsh plugin --profile desktop add dsh-floatball-pet
```

它和方式二一样是**不含运行时的包**（约 2.2 MB），安装时按需下载 Electron——首次约 110 MB，
之后升级不再下载。缓存规则见文末「运行时放在哪、什么时候下载」。

> 中国大陆镜像源同步需要一点时间：刚发布的版本可能还没同步过去，查不到就先用方式一/方式零，
> 或把安装源换成默认源再试。

### 方式三：自己构建

用 Node.js 22 或更高版本（`package.json` 的 `engines` 要求 `>=22`）：

```powershell
git clone https://github.com/riceyu02/dsh-floatball-pet.git
cd dsh-floatball-pet
npm install                      # 若 Electron 下载太慢，先设镜像，见「常见问题」
npm run build:dsh-plugin         # 产出 artifacts\dsh-floatball-pet-<版本>.tgz
dsh plugin --profile desktop add "$PWD\artifacts\dsh-floatball-pet-0.2.21.tgz"
```

`npm install` 时 `prepare` 钩子**会跳过运行时组装**——它认得出这是工作副本（有 `.git`），
组装只在你显式执行 `npm run pack`（独立程序用）或 `npm run build:dsh-plugin`（插件安装包用）
时才做，所以不会白等，也不会重复下载 Electron。

这条路**不需要等 pnpm 来拦构建脚本**：你是自己跑 `npm run build:dsh-plugin` 把包造出来的，
最后那一步 `add` 喂给 DSH 的是一个已经造好的本地 tgz，走的就是方式零那条路。

> **`npm install` 会提示 `koffi` 有安装脚本（`cnoke … --prebuild`）需要放行——不用放行。**
> 包内自带的那个原生二进制来自 `@koromix/koffi-win32-x64`（预编译），`cnoke` 那一步是给
> 想现场自己编译的人准备的，跳过它不影响任何功能。实测从零 `npm install koffi@3.3.1
> @koromix/koffi-win32-x64@3.3.1`：两个包装好、二进制就位，只是打一条 allowScripts 提示。

### 让 DSH 的 AI 帮你装（把下面这段发给它就行）

DSH 的 agent 手上有插件管理接口，能自己装完这一套：下载、登记 bundle、处理放行、校验装没装上。
把下面这段连同链接（或文件）发给对方的 DSH 即可：

> 帮我装这个插件：`https://github.com/riceyu02/dsh-floatball-pet`
> 用 Release **v0.2.21** 里的 `dsh-floatball-pet-0.2.21.tgz`，装进 `desktop` profile。
> 需要放行构建脚本就先问我；装完告诉我结果。

对方网络连不上 `github.com` 时，改成把 tgz 直接发给他：

> 这是我给你的插件包 `dsh-floatball-pet-0.2.21.tgz`（DSH 悬浮球桌宠），帮我装进 `desktop` profile。

会发生什么：

| 情形 | 需要人做的事 |
|---|---|
| agent 走**应用内**插件管理接口（`plugin_manager`，Creator 模式默认启用） | 基本不用管：实测 `application: "applied"`，**不重启 DSH 也会当场生效**（旧实例退出、新实例自动拉起） |
| agent 退回**命令行** `dsh plugin --profile desktop add …` | 装完必须**完全退出并重开 DSH** |
| agent 装的是 **git 路线**（`git+https://…`） | 它会先问你是否放行构建脚本，之后**每换一个 commit 都要再问一次** |
| agent 的 shell 起不来（Windows 沙箱下 `pwsh` 可能直接起不来，退出码 `0xC0000142`） | 需要把该会话的文件权限放行到 `danger-full-access`，或让对方用 DSH 的插件页手动装 |

两个提醒：

- **确认包是从哪来的。** 让 AI 装插件 = 在那台机器上运行插件作者的代码，这正是 pnpm 要求 build 放行的原因。
- **长期使用别把 git 依赖挂在 profile 上。** 实测：profile 里存在 git 依赖时，之后任何一次装包都会让 pnpm
  重新解析它、重跑它的 `prepare`（可能再下一次 Electron）；而应用内安装用的是**净化过的环境**
  （没有代理、没有 `ELECTRON_MIRROR`），这一步会静默卡到 DSH 的 10 分钟超时。尝鲜可以，长期建议换成
  tarball：把 tgz 放进 `<profile>\plugin-tarballs\`，依赖写成 `file:` 形式（`dsh-orb` 就是这么放的）。

### 装上了吗

- `<profile>\package.json` 的 `dsh.profile.bundles` 里会出现 `dsh-floatball-pet`；
- 重启 DSH 后桌面出现小鲸鱼球；
- 插件模式的日志与偏好在 `<profile>\data\dsh-floatball-pet\`（`pet.log` 先看这个）。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-floatball-pet
```

### 插件模式的行为差异

- DSH 启动时自动拉起悬浮球；插件卸载、禁用或 DSH 退出时自动关闭，不留孤儿进程。
- 偏好和日志写入 `<profile>\data\dsh-floatball-pet\`，与独立模式互不干扰。
- 设置面板不再显示「开机自动启动」——开机启动由 DSH 自己负责。
- 标准模式若在 5 秒内异常退出（Chromium 沙箱起不来的机器），宿主会自动用
  `--no-sandbox` 兼容模式重试一次。

---

## 独立运行（不装成插件）

```powershell
npm install
```

双击 **`启动悬浮球.cmd`**（等同 `npm start`）。它会先起焦点帮手，用标准模式启动 Electron，
4 秒后若进程已经没了（说明本机 Chromium 沙箱起不来），自动改用 `--no-sandbox` 重试一次。
日志在 `%APPDATA%\DSH 悬浮球\pet-console.log`。

> **路径请保持纯英文。** 安装路径含中文等非 ASCII 字符时，Chromium 沙箱一定初始化失败；
> 表现是进程一闪就没、日志一个字节都不写。

---

## 数据从哪来

**余额**按优先级依次尝试，任何一步失败都自动降级，不会显示成 0：

1. **DSH 登录态（零配置）** —— 读 `$DSH_HOME/.credentials.yaml` 的授权 token，请求
   `https://platform.deepseek.com/api/v0/users/get_user_summary`，请求头与 DSH 自己一致。
2. **`DEEPSEEK_API_KEY`** —— 有平台 key 时改用 `https://api.deepseek.com/user/balance`。
3. **离线兜底** —— 都拿不到时退回鲸鱼挂件账本里的上次观测值，并标注「离线」。

刷新：启动一次、每 5 分钟一次；悬停不会额外请求。余额只读、只发往上面写死的官方域名，
**不会修改或清除 DSH 的任何凭据**。

**运行时间**：先 TCP 连 DSH 的 Web 端口判断存活（纯 Node，不起子进程），再用 PowerShell
取 `DeepSeek Harness` 进程里最早的 `StartTime` 作为起始时刻；每 15 秒刷新，界面每秒重绘。

---

## 目录结构

```text
dsh-floatball-pet/
├── package.json                 # Electron 应用元数据 + DSH bundle 声明
├── cordis.patch.yml             # 把宿主生命周期插件插入 DSH 配置树
├── plugin/host.mjs              # 启动/停止 helper、沙箱回退、DSH 父进程看门狗
├── 启动悬浮球.cmd                # 独立模式启动器
├── src/                         # Electron 应用（主进程 / 渲染进程 / 托盘 / 图标）
├── tools/                       # 构建与运维脚本（组装运行时、打包插件、发布 Release）
├── test/host.test.mjs           # 宿主插件的单元测试（node --test）
├── docs/                        # 三张状态截图
└── build/icon.ico               # 应用图标
```

安装后插件包里的 `runtime/` 是组装好的 Electron 运行时，由 `tools/assemble.cjs` 生成，
**不进入 git 仓库**。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `npm install` 卡在 Electron 下载 | `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; npm install`；npm 11 若提示 `allowScripts`，补跑 `node node_modules/electron/install.js` |
| 双击启动器什么都没发生 | 路径含非 ASCII 字符，或本机沙箱起不来；改用 `dsh plugin` 的插件模式（会自动重试兼容模式） |
| 日志说「找不到悬浮球运行时」 | `runtime/` 没组装好。源码安装执行 `npm run pack`；插件安装重新装一次以触发 `prepare` |
| 单击悬浮球没反应 | 看 `pet.log` 里的 `reason`；受限令牌下抢前台靠 `tools/focus-agent.cjs` 帮手，插件模式会在启动时自动拉起它 |
| 悬浮球周围有一圈黑框 | 属已知的透明窗口合成问题，当前实现已规避；若复现请附上系统版本与显卡驱动 |

---

## 致谢

- **[DeepSeek Harness](https://github.com/deepseekharness)**（DSH）——本插件跑在它的插件系统上：
  宿主半边由 DSH 以 bundle patch 装载，设置页走它的客户端 Slot（`settings.section`）与 `webServer`
  路由，桌面窗口由它拉起与回收。没有 DSH 就没有这个插件。
- **提 issue 与帮忙实测的朋友**——置顶闪烁、按 Win 键后球不回来、自动更新失败、拖动沉底、
  全屏切换后卡死这些 bug 都是实测报上来的，修复依据（含他们的测量数据）都记在
  [CHANGELOG.md](CHANGELOG.md) 里。

> 说明：本项目是**第三方社区插件**，与 DeepSeek 官方无隶属或合作关系；致谢仅表示对平台与
> 反馈者的感谢。

---

## 许可证

项目原创代码使用 [MIT License](LICENSE)。Electron、Chromium 与美术素材的说明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。美术素材允许随本应用及其插件包公开分发，
但不包含在 MIT 授权范围内，也不授权脱离本应用单独复用。

## 更新插件时的一个坑（0.2.21 起已解决）

0.2.20 及更早的版本里，悬浮球（以及它拉起的**焦点帮手**，那是一个 detached 的 `DSH悬浮球.exe`
进程，托盘退出不会带走它）运行时会锁住 `node_modules\dsh-floatball-pet\runtime\` 里的文件，pnpm
因此在替换时报 `ERR_PNPM_EPERM ... runtime`（已实测，状态会干净回滚、旧版本照常可用）。那时的
办法是**升级前先退出悬浮球**，并确认没有 `DSH悬浮球` 进程残留（托盘 → 退出，或先
`dsh plugin --profile desktop remove dsh-floatball-pet`），装完再重启 DSH。

**0.2.21 起这个坑消失了**：运行时不再放在包目录里，而是落在
`<DSH_HOME>\dsh-floatball-pet\runtime\<electron 版本>\`（见「安装」一节）。pnpm 替换包目录时碰不到
正在运行的 exe，升级前不必再退出悬浮球。仍然要记得：同一个包换版本后 DSH 会报
`restart-required`——新代码要重启才能加载。

## 运行时放在哪、什么时候下载

0.2.21 起，插件包本身不含 Electron（`runtime/` 是个 269 MB 的 Electron 副本，占了整包的 100%）。
安装时由 `tools/prepare-install.cjs` 组装，落在**包外**的版本化缓存里：

```text
<DSH_HOME>\dsh-floatball-pet\
├── downloads\              # 下载的 Electron 压缩包与解压结果，可整个删掉
└── runtime\<electron 版本>\ # 组装好的运行时；含 .ready.json 标记
```

| 情形 | 会发生什么 |
|---|---|
| 全新安装 | 下载 Electron（约 110 MB）→ 校验 SHA-256 → 解压 → 组装，约 10–40 秒 |
| **升级插件版本**（如 0.2.21 → 0.2.22） | **什么都不做**，缓存命中，实测 0.09 秒、零下载 |
| 升级到新的 Electron 版本 | 新版本有自己的目录，需再下载一次；旧目录可手动删除 |
| 装了自带运行时的整包 | 包内 `runtime/` 优先，缓存完全不参与 |

下载顺序是 `cdn.npmmirror.com` → GitHub Releases，两者都用该版本自己发布的 `SHASUMS256.txt`
校验（实测三个源的校验和完全一致）。想换源或走自建镜像：

```powershell
$env:DSH_PET_ELECTRON_MIRROR = "https://your-mirror.example.com/electron/v{version}"
```

`{version}` 会被替换成 Electron 版本号。删掉整个 `<DSH_HOME>\dsh-floatball-pet\` 即可让下次安装
重新下载一份干净的。
