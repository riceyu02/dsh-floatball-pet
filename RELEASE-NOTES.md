# 发布说明（精简版）

给 GitHub Release 页面用的摘要。每个 `## <版本>` 一节对应同名 tag，发布时由
`.github/workflows/release.yml` 原样取用；完整的技术细节见 [CHANGELOG.md](CHANGELOG.md)。

## 0.1.0

换到新仓库 `dsh-floatball-pet` 后的第一个发布，版本号从 0.1.0 重新起算。

**主要变化**

- 仓库与 npm 包名改为 `dsh-floatball-pet`（原 `dsh-desktop-pet` 已停更）。
- 插件包从 113 MB 瘦到 **1.7 MB**：Electron 运行时不再打进包里，首次安装时按需下载
  （约 110 MB，装完约占 273 MB 磁盘）。
- 升级插件**不再下载运行时**，也不会再撞上 `ERR_PNPM_EPERM ... runtime`——升级前不用先退出悬浮球。
- 支持从 npm 安装；离线或连不上 GitHub 时仍可用本页的 Release 整包（约 114 MB，装完即用）。
- koffi 及其预编译二进制随包分发，置顶、游戏让位这些功能不再依赖机器上其他插件。

**升级提示**

- 已经装过 0.2.x 的人不会收到自动更新提示（0.1.0 比 0.2.20 小），需要手动重装一次，之后恢复正常。
- 球的大小、位置、透明度、自定义图标都保留在 `<profile>\data\dsh-desktop-pet\`，重装不会丢。

**安装**

```powershell
# npm（插件页里直接输入包名也可以）
dsh plugin --profile desktop add dsh-floatball-pet

# 离线：先下载本页的 dsh-floatball-pet-0.1.0.tgz
dsh plugin --profile desktop add "<下载目录>\dsh-floatball-pet-0.1.0.tgz"
```

装完完全退出并重新打开 DSH。
