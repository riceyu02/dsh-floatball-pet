# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件只记录当前这条线（`dsh-floatball-pet`，版本号从 0.1.0 重新起算）。

## 未发布

- **变更**移除独立运行版，只保留 DSH 插件一种发行方式：删掉 `启动悬浮球.cmd`、`tools/launch.cjs`、
  `npm start` / `npm run pack` 和 electron-builder 的 portable 配置。悬浮球本来就用自带的 Electron
  运行时承载，所以包体几乎不变（npm 包少约 6 KB，Release 整包相同）。
- **变更**开发调试入口改为 `npm run dev`，直接起 Electron 调界面，不经过 DSH。

## 0.1.0

> 版本号重新起算：这是换到新仓库（`dsh-floatball-pet`）后的第一个发布，所以号比之前的 0.2.20 小。
> 已经装过 0.2.x 的人不会收到自动更新提示（0.1.0 比 0.2.20 小），需要手动重装一次，之后恢复正常。

**项目更名为 `dsh-floatball-pet`**（仓库与 npm 包名一致），并**把运行时从包里挪出去**：
插件包从 113.3 MB 瘦到 **1.7 MB**，升级不再下载任何东西。

- **变更**仓库与 npm 包名：`dsh-desktop-pet` → **`dsh-floatball-pet`**。原因是 npm 上那个裸名
  已被另一位作者的同类项目占用（`matchafrenchfries` / `sereinmono/dsh-desktop-pet`），发不上去。
  旧仓库 `riceyu02/dsh-desktop-pet` 已下线，不再更新。
- **兼容**旧名：宿主与自更新器同时认 `dsh-floatball-pet` 与 `dsh-desktop-pet` 两种安装名、
  两种 tarball 文件名，所以从旧名升级上来不会丢掉"清理旧安装包"这类逻辑。
- **刻意保留**两个旧名字，都是为了不打扰已装用户：运行时缓存目录仍是 `<DSH_HOME>\dsh-desktop-pet\`
  （改了要重新下 269 MB），设置与日志目录仍是 `<profile>\data\dsh-desktop-pet\`
  （改了球的尺寸、位置、不透明度会复位）。
- **新增**发布用的精简包：`runtime/` 不再进包（它是个 Electron 副本，占了整包的 100%），
  改由安装钩子 `tools/prepare-install.cjs` 在用户机器上组装；koffi 与其预编译二进制通过
  `bundledDependencies` 随包分发，自证逻辑照旧。
- **新增**运行时缓存 `<DSH_HOME>\dsh-desktop-pet\runtime\<electron 版本>\`，**放在包外**。
  `node_modules\dsh-floatball-pet` 每次升级都会被 pnpm 删掉重建，缓存因此得以跨版本复用。
  判定靠组装完才写的 `.ready.json` 标记——中断的组装不会被当成可用运行时。
- **新增** Electron 下载的镜像兜底与校验：先问 `cdn.npmmirror.com`，失败再问 GitHub；
  两者都按该版本自己发布的 `SHASUMS256.txt` 校验 SHA-256（实测三个源的校验和完全一致），
  校验不过就换下一个源。可在下载慢或需要自建源时用 `DSH_PET_ELECTRON_MIRROR` 覆盖。
- **修复**升级时 `ERR_PNPM_EPERM ... runtime`：运行时不再位于包目录内，pnpm 替换包时不会再撞上
  被悬浮球占用的文件，**升级前不必先退出悬浮球**了。
- **变更** `plugin/host.mjs` 的运行时查找顺序：显式覆盖 → 包内 `runtime/` → 源码检出
  `dist/DSH悬浮球` → 版本化缓存。包内路径仍然优先，所以自带运行时的整包行为完全不变。
- **新增** npm 发布：包名 `dsh-floatball-pet` 发到 `registry.npmjs.org`（`publishConfig` 把源钉死，
  本机 `~/.npmrc` 指向 npmmirror 也能发）。新增 **`postinstall`** 钩子——npm 不会为 registry 包执行
  `prepare`，少了它从 npm 装出来的插件就没有运行时；git 安装仍走 `prepare`，两个钩子是同一个脚本。
  **已发布 `0.1.0`**（2026-10-17，经 staged publishing 审核上线；npmjs 与 npmmirror 均可查）。
  npm 已限制 bypass-2FA 的直接发布 token，后续发版走 staged publishing / trusted publishing
  （维护者流程，不随仓库公开）。
- **变更**安装时直接复用包里预编译的 `build/PetFocus.dll`，不再跑 PowerShell 的 `Add-Type`：
  这个 DLL 本来就是为了绕开"目标机器上编不了 C#"才存在的，安装过程不该又把它依赖回来。
  发版构建（`npm run build:dsh-plugin`）不受影响，照旧重新编译。

> 实测（npm 包 `dsh-floatball-pet@0.1.0`、Electron 33.2.0）：
> npm 包 **1.7 MB** / 解压 5.1 MB（原 113.3 MB / 269 MB）；
> 全新安装真跑 `postinstall`：**66.6 秒**，其中下载 **109.6 MB**（镜像源那次连接被掐断，
> 自动回落 GitHub 成功，sha256 校验通过）→ 组装出 273 MB 运行时 → koffi 自检 `OK`；
> `resolveRuntime` 解析到缓存里的 `DSH悬浮球.exe`；
> 升级（把包目录整个换掉）：**0 秒、零下载**，缓存命中；
> 整包 `npm run build:dsh-plugin` 仍产出 114.5 MB 的离线包，不受影响。

