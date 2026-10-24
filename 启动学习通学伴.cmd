@echo off
chcp 936 >nul 2>&1
setlocal
rem 国内直连 GitHub 下载 Electron 运行时经常失败，默认走国内镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
cd /d "%~dp0app"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   首次运行，正在安装依赖（约 1-3 分钟，请保持联网）...
  echo.
  call npm install --no-audit --no-fund
)

rem Electron 43 及以后不再自动下载运行时，必须显式执行一次
if not exist "node_modules\electron\dist\electron.exe" (
  echo   正在下载 Electron 运行时（约 230MB，国内走镜像）...
  pushd "node_modules\electron"
  call node install.js
  popd
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   [失败] Electron 运行时没能下载成功。
  echo   请检查网络或代理，然后重新双击本脚本。
  echo.
  pause
  exit /b 1
)

if exist "%~dp0create-shortcut.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" -AppDir "%CD%" >nul 2>&1
)

call npm start
if errorlevel 1 pause