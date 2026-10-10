# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件只记录当前这条线（`dsh-floatball-pet`，版本号从 0.1.0 重新起算）。
> 改名前的 20 个版本（`dsh-desktop-pet` 0.2.0 – 0.2.20）已归档到
> [docs/CHANGELOG-0.2.x.md](docs/CHANGELOG-0.2.x.md)。

## 0.1.0

> 版本号重新起算：这是换到新仓库（`dsh-floatball-pet`）后的第一个发布，所以号比之前的 0.2.20 小。
> 已经装过 0.2.x 的人不会收到自动更新提示（0.1.0 比 0.2.20 小），需要手动重装一次，之后恢复正常。

**项目更名为 `dsh-floatball-pet`**（仓库与 npm 包名一致），并**把运行时从包里挪出去**：
插件包从 113.3 MB 瘦到 **2.21 MB**，升级不再下载任何东西。

- **变更**仓库与 npm 包名：`dsh-desktop-pet` → **`dsh-floatball-pet`**。原因是 npm 上那个裸名
  已被另一位作者的同类项目占用（`matchafrenchfries` / `sereinmono/dsh-desktop-pet`），发不上去。
  旧仓库 [riceyu02/dsh-desktop-pet](https://github.com/riceyu02/dsh-desktop-pet) 保留作存档，不再更新。
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

> 实测（真发布产物、Electron 33.2.0）：
> 精简包 **2.21 MB** / 解压 5.66 MB（原 113.3 MB / 269 MB）；
> 全新安装：下载 **109.6 MB / 8.1 秒（13.6 MB/s）** → 校验通过 → 组装出 273 MB 运行时 → koffi 自检 `OK`；
> 升级（把包目录整个换成 0.1.0）：**0.09 秒、零下载**，缓存命中；
> 整包 `npm run build:dsh-plugin` 仍产出 114.5 MB 的离线包，不受影响。

