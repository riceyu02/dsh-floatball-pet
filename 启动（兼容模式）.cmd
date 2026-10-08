@echo off
rem ===========================================================================
rem  DSH 悬浮球 —— 兼容模式（严格）
rem
rem  直接带 --no-sandbox 启动，不做标准模式的尝试，也不自动回退。
rem  沙箱初始化不了的机器（安装路径含非 ASCII 字符时必然如此）用这个。
rem
rem  代价：--no-sandbox 会让本进程拿到受限令牌，它自己抢不到 DSH 的前台；
rem  这件事由焦点帮手 tools\focus-agent.cjs 代劳 —— 悬浮球启动时会自己把
rem  帮手拉起来，不用你管。
rem ===========================================================================
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "APP_DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没有找到 Node.js。
  echo       本启动器需要 Node 来启动 Electron，请先安装 Node.js。
  echo.
  pause
  exit /b 1
)

node "%APP_DIR%tools\launch.cjs" --force-no-sandbox %*
set "CODE=%errorlevel%"

if not "%CODE%"=="0" (
  echo.
  echo   [x] 兼容模式也没能启动（退出码 %CODE%）。
  echo       日志： "%APPDATA%\DSH 悬浮球\pet-console.log"
  echo.
  pause
)
exit /b %CODE%
