@echo off
chcp 936 >nul 2>&1
title 学习通学伴
setlocal
rem ===== 缓存统一放本目录，避免往 C 盘写 =====
set "PIP_CACHE_DIR=%~dp0cache\pip"
set "ELECTRON_CACHE=%~dp0cache\electron"
set "npm_config_cache=%~dp0cache\npm"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
cd /d "%~dp0app"

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

rem ===== 运行时自检：离线版/完整版自带 electron.exe，极简版需要现装 =====
if not exist "%ELECTRON_EXE%" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [失败] 这个包里没有 Electron 运行库，机器上也没找到 Node.js / npm。
    echo.
    echo   下载的是「离线版」或「完整版」：压缩包不完整，请重新解压。
    echo   下载的是「极简版」：请先安装 Node.js  https://nodejs.org/  ^(选 LTS^)
    echo                       装完再双击本文件。
    echo.
    pause
    exit /b 1
  )
  echo.
  echo [步骤 1/2] 第一次运行，正在安装依赖，大约 3-10 分钟，请别关窗口...
  call npm install --no-audit --no-fund
  rem Electron 43 及以后不再自动下载运行时，必须显式执行一次
  if not exist "%ELECTRON_EXE%" (
    echo.
    echo [步骤 2/2] 正在下载 Electron 运行时（约 230MB，走国内镜像）...
    pushd "node_modules\electron"
    call node install.js
    popd
  )
  if not exist "%ELECTRON_EXE%" (
    echo.
    echo [失败] Electron 运行时没下载成功。
    echo        请检查网络后重试，或手动执行：
    echo        cd /d "%~dp0app\node_modules\electron"
    echo        node install.js
    echo.
    pause
    exit /b 1
  )
)

rem ===== 桌面快捷方式（只建一次）=====
if not exist "%USERPROFILE%\Desktop\学习通学伴.lnk" (
  echo.
  echo [设置] 首次运行，在桌面创建快捷方式...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" -AppDir "%CD%"
)

rem ===== 转写环境检查 =====
rem 更新包/极简版不带 Python 环境，缺了会导致「能启动但抓日志失败」
if not exist "%~dp0tools\pyenv\Scripts\python.exe" (
  echo.
  echo [提示] 没有找到转写环境（抓课程日志需要它）。
  echo        第一次装请先双击：tools\setup-transcribe.ps1
  echo        如果只是更新代码、之前已装过，忽略这条即可。
  echo.
)

rem ===== 启动：直接用包内 Electron，不经过 npm =====
rem 用 start "" 脱离 cmd，本窗口启动后自动关闭，不用手动 x 掉。
echo [启动] 正在打开学习通学伴...
start "" "%ELECTRON_EXE%" "%CD%" --no-sandbox
exit /b 0
