@echo off
rem ===========================================================================
rem  DSH 悬浮球 —— 标准模式（严格）
rem
rem  和「启动悬浮球.cmd」的区别只有一个：这里不允许回退。
rem  沙箱起不来就直接报错停住，不会偷偷换成 --no-sandbox。
rem
rem  为什么要这么一个入口：正常机器上带 --no-sandbox 是白降安全性，
rem  而「兼容模式是不是被悄悄用上了」应当是你点出来的，不是它猜出来的。
rem  给别人排障时也好问：你点的是哪一个。
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

node "%APP_DIR%tools\launch.cjs" --strict-sandbox %*
set "CODE=%errorlevel%"

if not "%CODE%"=="0" (
  echo.
  echo   [x] 标准模式没能启动（退出码 %CODE%）。
  echo       说明这台机器初始化不了 Chromium 沙箱，请改用「启动（兼容模式）.cmd」。
  echo       日志： "%APPDATA%\DSH 悬浮球\pet-console.log"
  echo.
  pause
)
exit /b %CODE%
