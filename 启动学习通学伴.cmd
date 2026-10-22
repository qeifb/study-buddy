@echo off
title 学习通学伴
cd /d "%~dp0app"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [步骤] 第一次运行，正在安装依赖，大约 3-10 分钟，请别关窗口...
  call npm install
  if errorlevel 1 (
    echo.
    echo [失败] 依赖安装失败。请确认已装 Node.js 18+ 且能访问网络，然后重新双击本文件。
    pause
    exit /b 1
  )
)

if not exist "%USERPROFILE%\Desktop\学习通学伴.lnk" (
  echo.
  echo [步骤] 首次运行，在桌面创建快捷方式...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" -AppDir "%CD%"
)

echo.
echo [启动] 正在打开学习通学伴...
call npm start
if errorlevel 1 (
  echo.
  echo [失败] 应用退出了。如果是窗口一闪而过，请把上面的报错截图发出来。
  pause
)