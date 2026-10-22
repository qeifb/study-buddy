# 在桌面创建「学习通学伴」快捷方式（幂等，已存在就跳过）
param(
  [Parameter(Mandatory=$true)][string]$AppDir,
  [string]$OutPath = ""
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if ([string]::IsNullOrWhiteSpace($OutPath)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
  $OutPath = Join-Path $desktop '学习通学伴.lnk'
}

if (Test-Path $OutPath) {
  Write-Output "[跳过] 快捷方式已存在：$OutPath"
  exit 0
}

$exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  Write-Output "[失败] 找不到 electron.exe，请先让 npm install 跑完"
  exit 1
}

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($OutPath)
$s.TargetPath       = $exe
$s.Arguments        = '"' + $AppDir + '" --no-sandbox'
$s.WorkingDirectory = $AppDir
$s.IconLocation     = Join-Path $AppDir 'assets\tray.ico'
$s.Description      = '学习通学伴 - 网课转文字稿与 AI 答疑'
$s.Save()

if (Test-Path $OutPath) {
  Write-Output "[完成] 已在桌面创建快捷方式：$OutPath"
  Write-Output "       以后双击桌面上的「学习通学伴」就能直接启动，不用再跑这个 cmd。"
} else {
  Write-Output "[失败] 快捷方式创建失败"
  exit 1
}