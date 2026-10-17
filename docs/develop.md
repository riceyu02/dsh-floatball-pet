# 从源码运行 / 自己构建（开发用）

给想改代码、或想验证未发布改动的人。普通安装看 README 的「方式一 / 方式二」就够了。
本项目只以 **DSH 插件**形式发行，没有独立运行版；`npm run dev` 仅用于本地调界面。

## 克隆并本地调试

```powershell
git clone https://github.com/riceyu02/dsh-floatball-pet.git
cd dsh-floatball-pet
npm install        # 下载 Electron；慢就先设 $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm run dev        # 直接用 Electron 起悬浮球，只用于调界面
```

`npm run dev` 跑的是插件里同一个 Electron 程序，但**不经过 DSH**：偏好和日志写在
`%APPDATA%\DSH 悬浮球\`，不碰 profile 里的数据。要看真实的插件行为（设置页、
更新检查），按 README 装一次插件再测。

> `npm install` 会提示 `koffi` 有安装脚本（`cnoke … --prebuild`）要放行——**不用放行**。原生二进制来自
> `@koromix/koffi-win32-x64`（预编译），`cnoke` 那步是给想现场自己编译的人准备的，跳过不影响功能。

## 自己打插件包

```powershell
npm run build:dsh-plugin     # 产出 artifacts\dsh-floatball-pet-<版本>.tgz（约 114 MB，含运行时）
dsh plugin --profile desktop add "$PWD\artifacts\dsh-floatball-pet-0.1.0.tgz"
```

`npm test` 跑单元测试；`npm run build:dsh-plugin` 会顺带重新组装运行时，不需要额外命令。

## 直接从 git 安装（不推荐长期用）

```powershell
dsh plugin --profile desktop add git+https://github.com/riceyu02/dsh-floatball-pet.git#v0.1.0
```

前置条件：`git` 在 PATH 上；用 `git+https://…` 而不是 `github:` 简写（后者会解析成 ssh，没配 key 的
机器直接 `Host key verification failed`）。**钉 tag，别跟 `main`**：放行键里带 commit，换一个 commit
就要重新放行一次。

第一次会停在构建脚本这一步，把 pnpm 打印的那行照抄进 `<profile>\pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "dsh-floatball-pet@https://codeload.github.com/riceyu02/dsh-floatball-pet/tar.gz/2f1a…": true
```

然后在你的机器上现装依赖、现组装运行时（下载约 110 MB，`runtime\` 最终占 273 MB）。

> **别长期把 git 依赖挂在 profile 上。** 之后任何一次装包都会让 pnpm 重新解析它、重跑 `prepare`
> （可能再下一次 Electron）；而应用内安装用的是净化过的环境（没有代理、没有 `ELECTRON_MIRROR`），
> 这一步会静默卡到 DSH 的 10 分钟超时。尝鲜可以，长期请换回 tgz 或 npm。
