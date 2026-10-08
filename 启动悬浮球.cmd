@echo off
rem 控制台默认是 GBK，而本文件是 UTF-8 —— 不切码页的话中文全是乱码，
rem 用户就完全看不出启动到哪一步了。
chcp 65001 >nul
rem ===========================================================================
rem  DSH 悬浮球 —— 启动器
rem
rem  真正的启动逻辑在 tools\launch.cjs：
rem    先按标准模式启动 Electron（不加 --no-sandbox，进程权限完整，
rem    「点击悬浮球唤起 DSH」需要完整权限才能枚举窗口）；
rem    如果几秒后进程已经消失（说明 Chromium 沙箱在本机无法初始化），
rem    自动改用 --no-sandbox 重试。两种模式都会把日志写到 userData 目录。
rem ===========================================================================
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

node "%APP_DIR%tools\launch.cjs" %*
set "CODE=%errorlevel%"

rem 失败时把日志路径打出来并停住，否则窗口一闪就没了，用户不知道发生了什么。
if not "%CODE%"=="0" (
  echo.
  echo   [x] 启动失败（退出码 %CODE%）。
  echo       日志： "%APPDATA%\DSH 悬浮球\pet-console.log"
  echo.
  pause
)
exit /b %CODE%
