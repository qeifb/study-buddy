@echo off
chcp 936 >nul 2>&1
setlocal

rem ====================================================================
rem  创建桌面快捷方式
rem
rem  为什么需要这个文件：
rem    「启动学习通学伴.cmd」会在首次成功启动后自动建快捷方式，
rem    但如果当时没建成功（比如环境还没装好），用户就不知道自己
rem    手动执行 PowerShell 该怎么写——那些命令带引号转义，极易出错。
rem    本文件双击即可，不需要记住任何命令、不需要输入路径。
rem ====================================================================

echo.
echo ===============================================
echo   学习通学伴 · 创建桌面快捷方式
echo ===============================================
echo.

rem 本文件在解压根目录，app 就在旁边
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "APPDIR=%ROOT%\app"
set "EXE=%APPDIR%\node_modules\electron\dist\electron.exe"

echo   检查应用目录：%APPDIR%
if not exist "%APPDIR%\package.json" goto no_app
if not exist "%EXE%" goto no_electron

echo   [OK] 找到 electron.exe
echo.
echo   正在创建快捷方式...
echo.

if not exist "%ROOT%\create-shortcut.ps1" goto no_script

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\create-shortcut.ps1" -AppDir "%APPDIR%"
if errorlevel 1 goto failed

echo.
echo ===============================================
echo   完成。桌面上应已出现「学习通学伴」图标。
echo   以后直接双击那个图标启动，不会弹 cmd 窗口。
echo ===============================================
echo.
pause
exit /b 0

:no_app
echo.
echo   [失败] 这个目录看起来不是学习通学伴的安装目录。
echo          应该在解压后的根目录里（能看到 app 文件夹）。
echo          当前目录：%ROOT%
echo.
pause
exit /b 1

:no_electron
echo.
echo   [失败] 还没装好运行环境：找不到 electron.exe
echo.
echo   请先双击同目录下的「启动学习通学伴.cmd」，
echo   等它把 Node.js / 依赖 / Electron 都装好，再回来双击本文件。
echo.
echo   （首次安装约 1-3 分钟，需要联网）
echo.
pause
exit /b 1

:no_script
echo.
echo   [失败] 缺少 create-shortcut.ps1，压缩包可能不完整。
echo          请重新下载完整的 zip 再解压。
echo.
pause
exit /b 1

:failed
echo.
echo   [失败] 快捷方式创建失败。
echo          常见原因：桌面不可写、或桌面路径被重定向到了不存在的目录。
echo          可尝试右键本文件「以管理员身份运行」。
echo.
pause
exit /b 1
