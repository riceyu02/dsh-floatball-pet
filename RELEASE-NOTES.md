# 发布说明（精简版）

给 GitHub Release 页面用的摘要。每个 `## <版本>` 一节对应同名 tag，发布时由
`.github/workflows/release.yml` 原样取用；完整的技术细节见 [CHANGELOG.md](CHANGELOG.md)。

## 0.1.0

DSH 悬浮球桌宠的第一个发布：桌面上一颗小鲸鱼球，悬停展开灵动岛显示 DeepSeek 余额和 DSH 运行时长，
点齿轮打开设置面板，单击悬浮球唤起 DSH 窗口。

**功能**

- 悬浮球：无边框、透明、置顶、可拖动，位置自动记忆；大小与不透明度可调。
- 灵动岛：鼠标移入向右展开（贴近屏幕右侧时向左），上方余额、下方运行时长，各自定时刷新。
- 设置面板：点齿轮从上方升起，可换图标（GIF / PNG / JPG / WebP / BMP）、调大小与透明度、切换显示项。
- 单击悬浮球：DSH 在运行就把窗口拉到最前（最小化也还原），否则启动它。
- 游戏让位：检测到游戏全屏或无边框全屏时自动隐藏，退出全屏立刻回来；浏览器 F11、播放器不误判。
- 托盘菜单：显示悬浮球、打开 DSH、切换大小、退出。

**安装**

```powershell
# npm（插件页里直接输入包名也可以）
dsh plugin --profile desktop add dsh-floatball-pet

# 离线：先下载本页的 dsh-floatball-pet-0.1.0.tgz
dsh plugin --profile desktop add "<下载目录>\dsh-floatball-pet-0.1.0.tgz"
```

**包体**

- npm 包约 1.7 MB；Electron 运行时在首次安装时按需下载（约 110 MB）。
- Release 整包约 114 MB，自带运行时，装完即用、不需要联网下载。

装完完全退出并重新打开 DSH。
