@echo off
chcp 936 >nul 2>&1
setlocal

rem ====================================================================
rem  学习通学伴 启动脚本
rem  首次运行会自动准备环境（Node.js / 项目依赖 / Electron 运行时）
rem  全部安装在当前目录内，不修改系统、不需要管理员权限
rem ====================================================================

rem ---------- 统一变量 ----------
set "APP=%~dp0app"
set "RUNTIME=%~dp0runtime"
set "NODE_DIR=%~dp0runtime\node"
set "TEMP_DIR=%~dp0runtime\temp"
set "NPM_CACHE=%~dp0runtime\npm-cache"
set "EL_CACHE=%~dp0runtime\electron-cache"
set "PYENV_EXE=%~dp0tools\pyenv\Scripts\python.exe"
set "TRANSCRIBE_PS1=%~dp0tools\setup-transcribe.ps1"
set "NODE_VERSION=v24.22.1"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"
set "NODE_ZIP=node-v24.22.1-win-x64.zip"
set "NODE_URL=%NODE_MIRROR%/%NODE_VERSION%/%NODE_ZIP%"
set "NODE_TMP=%~dp0runtime\node-download.zip"
set "FLAG=%~dp0runtime\_done.flag"

rem ---------- 关键：把各种缓存/临时目录都指向程序内 ----------
rem 原因：有些用户的 AppData 或系统 Temp 不可写（公司电脑、受限账户），
rem       会导致 npm / Electron 下载报 EPERM。指到程序目录内最稳。
if not exist "%RUNTIME%" mkdir "%RUNTIME%" >nul 2>&1
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%" >nul 2>&1
if not exist "%NPM_CACHE%" mkdir "%NPM_CACHE%" >nul 2>&1
if not exist "%EL_CACHE%" mkdir "%EL_CACHE%" >nul 2>&1

set "TEMP=%TEMP_DIR%"
set "TMP=%TEMP_DIR%"
set "npm_config_cache=%NPM_CACHE%"
set "npm_config_registry=https://registry.npmmirror.com"
set "npm_config_audit=false"
set "npm_config_fund=false"
set "npm_config_update_notifier=false"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_CACHE=%EL_CACHE%"
set "electron_config_cache=%EL_CACHE%"

rem ================== 第 1 步：准备 Node.js ==================

where node >nul 2>&1
if not errorlevel 1 goto use_system_node
if exist "%NODE_DIR%\node.exe" goto use_local_node
goto download_node

:use_system_node
echo   检测到系统已安装 Node.js，直接使用
set "NODE_EXE=node"
set "NPM_CMD=npm"
goto node_ready

:use_local_node
echo   使用本目录内的便携版 Node.js
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "PATH=%NODE_DIR%;%PATH%"
goto node_ready

:download_node
echo.
echo   未检测到 Node.js，正在自动下载便携版
echo   约 36MB，只解压到本程序目录，不装进系统、不需要管理员权限
echo   下载地址：%NODE_URL%
echo.

if exist "%NODE_TMP%" del /f /q "%NODE_TMP%" >nul 2>&1
if exist "%FLAG%" del /f /q "%FLAG%" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_TMP%' -UseBasicParsing -TimeoutSec 900; 'OK' | Out-File -FilePath '%FLAG%' -Encoding ASCII } catch { ('FAIL: ' + $_.Exception.Message) | Out-File -FilePath '%FLAG%' -Encoding UTF8 }"

if not exist "%NODE_TMP%" goto download_failed

echo   正在解压 Node.js...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $u='%RUNTIME%\_uz'; if (Test-Path $u) { Remove-Item $u -Recurse -Force }; Expand-Archive -Path '%NODE_TMP%' -DestinationPath $u -Force; $d = Get-ChildItem $u -Directory | Select-Object -First 1; if (-not $d) { throw '压缩包内没有目录' }; if (Test-Path '%NODE_DIR%') { Remove-Item '%NODE_DIR%' -Recurse -Force }; Move-Item $d.FullName '%NODE_DIR%'; Remove-Item $u -Recurse -Force -ErrorAction SilentlyContinue } catch { ('FAIL: ' + $_.Exception.Message) | Out-File -FilePath '%FLAG%' -Encoding UTF8 }"

if not exist "%NODE_DIR%\node.exe" goto unzip_failed

del /f /q "%NODE_TMP%" >nul 2>&1
del /f /q "%FLAG%" >nul 2>&1
echo   便携版 Node.js 已就绪
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "PATH=%NODE_DIR%;%PATH%"
goto node_ready

:download_failed
echo.
echo   [失败] Node.js 便携版下载失败。
echo   详情：
if exist "%FLAG%" type "%FLAG%"
echo.
echo   请手动处理，二选一：
echo     1) 安装 Node.js 后【重启电脑】再双击本脚本
echo        下载：https://nodejs.org/zh-cn/download
echo        安装时保持勾选「Add to PATH」
echo     2) 手动下载便携版：%NODE_ZIP%
echo        下载地址：%NODE_MIRROR%/%NODE_VERSION%/
echo        解压后把里面的文件夹改名为 node，放到：
echo        %NODE_DIR%
echo        （最终应是 %NODE_DIR%\node.exe）
echo.
pause
exit /b 1

:unzip_failed
echo.
echo   [失败] Node.js 解压失败。
echo   详情：
if exist "%FLAG%" type "%FLAG%"
echo.
echo   请手动下载便携版：%NODE_ZIP%
echo   下载地址：%NODE_MIRROR%/%NODE_VERSION%/
echo   解压后把里面的文件夹改名为 node，放到：%NODE_DIR%
echo   （最终应是 %NODE_DIR%\node.exe）
echo.
pause
exit /b 1

:node_ready

rem ================== 第 2 步：项目依赖 ==================

cd /d "%APP%"
if errorlevel 1 goto no_app_dir
if not exist "package.json" goto no_app_dir

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   正在安装项目依赖，约 1-3 分钟，请保持联网...
  echo.
  call "%NPM_CMD%" install
  if errorlevel 1 goto npm_install_failed
)

rem ================== 第 3 步：Electron 运行时 ==================

if not exist "node_modules\electron\dist\electron.exe" (
  echo   正在下载 Electron 运行时，约 230MB，国内走镜像，请耐心等待...
  pushd "node_modules\electron"
  call "%NODE_EXE%" install.js
  popd
)

if not exist "node_modules\electron\dist\electron.exe" goto electron_failed

rem ================== 第 3.5 步：转写环境（可选） ==================
rem
rem 转写环境用来把视频语音转成文字稿（课程日志 / 自动答题要用）。
rem 它需要 Python + faster-whisper + 语音模型（模型约 1.6GB）。
rem 因为体积大、耗时长，这里不强制自动装，而是询问一次。

if exist "%PYENV_EXE%" goto transcriber_ready

echo.
echo   ------------------------------------------------------------
echo   [可选] 转写环境尚未准备
echo.
echo   它用于把课程视频的语音转成文字稿（AI 答题要用）。
echo   需要下载语音模型约 1.6GB，首次约 10-30 分钟。
echo.
echo   跳过也可以：应用能正常启动，只是「抓课程日志 / 自动答题」
echo   会提示找不到转写环境。之后随时可双击
echo   tools\setup-transcribe.ps1 单独补装。
echo   ------------------------------------------------------------
echo.
set "SB_ANS="
set /p SB_ANS=  现在准备转写环境吗？输入 Y 回车=现在装，直接回车=跳过: 
if /i "%SB_ANS%"=="Y" goto install_transcriber
echo.
echo   已跳过。之后如需使用，双击 tools\setup-transcribe.ps1 即可。
echo.
goto transcriber_ready

:install_transcriber
echo.
echo   正在准备转写环境，会下载 Python、依赖和模型，请耐心等待...
echo.
if not exist "%TRANSCRIBE_PS1%" goto transcriber_no_ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%TRANSCRIBE_PS1%"
if errorlevel 1 goto transcriber_failed
echo.
echo   转写环境已就绪。
echo.
goto transcriber_ready

:transcriber_no_ps1
echo   [失败] 找不到 tools\setup-transcribe.ps1，压缩包可能不完整。
echo.
pause
goto transcriber_ready

:transcriber_failed
echo.
echo   [注意] 转写环境准备失败。应用仍可启动，但抓日志会不可用。
echo   可稍后重试：双击 tools\setup-transcribe.ps1
echo.
pause
goto transcriber_ready

:transcriber_ready

rem ================== 第 4 步：创建快捷方式 ==================

if exist "%~dp0create-shortcut.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" -AppDir "%CD%" >nul 2>&1
)

rem ================== 第 5 步：启动 ==================

echo.
echo   正在启动学习通学伴...
echo.
call "%NPM_CMD%" start
if errorlevel 1 goto app_exit_error
goto end

:no_app_dir
echo.
echo   [失败] 找不到应用目录或 package.json：%APP%
echo   请确认压缩包完整解压，应能看到 app 文件夹。
echo.
pause
exit /b 1

:npm_install_failed
echo.
echo   [失败] 依赖安装失败。
echo   常见原因：网络不稳定、npm 源不可访问。
echo   可尝试：删除 app\node_modules 后重新双击本脚本。
echo.
pause
exit /b 1

:electron_failed
echo.
echo   [失败] Electron 运行时没能下载成功。
echo   请检查网络或代理，然后重新双击本脚本。
echo   若反复失败，可先手动下载 electron-v44-win32-x64.zip，
echo   放到：%EL_CACHE%
echo.
pause
exit /b 1

:app_exit_error
echo.
echo   [提示] 应用异常退出。
echo   若提示缺少模块，请删除 app\node_modules 后重新双击本脚本。
echo.
pause

:end
endlocal
