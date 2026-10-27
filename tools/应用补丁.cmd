@echo off
chcp 936 >nul 2>&1
title 学习通学伴 · 版本补丁
cd /d "%~dp0"

echo.
echo   学习通学伴 · 版本补丁
echo.

if not exist "apply-patch.ps1" (
  echo   [失败] 找不到 apply-patch.ps1，补丁包不完整。
  echo   请在解压出来的 patch-xxx 文件夹里运行本文件。
  echo.
  pause
  exit /b 1
)

if not exist "patch.json" (
  echo   [失败] 找不到 patch.json，补丁包不完整。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-patch.ps1"
if errorlevel 1 (
  echo.
  echo   [失败] 补丁没有应用成功，上面有具体原因。
  echo   如果提示一闪而过看不清，把整个窗口截图发出来。
  echo.
  pause
)
exit /b
