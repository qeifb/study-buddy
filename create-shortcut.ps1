# 在桌面创建「学习通学伴」快捷方式（幂等，已存在就跳过）
#
# 2026-10-25 改进：
#   · 图标文件不存在时回退到 electron.exe 图标（原来会写入无效路径导致空白图标）
#   · 创建后读回并打印真实的目标/参数/图标，方便用户核对
#   · 参数引号严格用「单引号包双引号」拼法，避免 '\"' 变成 反斜杠+引号
param(
  [Parameter(Mandatory=$true)][string]$AppDir,
  [string]$OutPath = ""
)
$ErrorActionPreference = 'Stop'
# 保存原控制台编码，结束时恢复（否则调用方 .cmd 的 GBK 中文会乱码）
$Script:OldOutEnc2 = $null
$Script:OldCp2 = $null
try { $Script:OldOutEnc2 = [Console]::OutputEncoding } catch { }
try { $Script:OldCp2 = chcp } catch { }
function Restore-ConsoleEncoding2 {
    try { if ($Script:OldOutEnc2) { [Console]::OutputEncoding = $Script:OldOutEnc2 } } catch { }
    try {
        if ($Script:OldCp2 -match '(\d+)') { & chcp ([int]$Matches[1]) > $null 2>&1 }
    } catch { }
}
# ⚠️ 不要设置 [Console]::OutputEncoding = UTF8！

# 本脚本被 .cmd（chcp 936 = GBK）用 powershell -File 调用，

# 子进程 stdout 的字节由 cmd 按 GBK 解释。设 UTF-8 会导致中文全乱码。

# 中文 Windows 的控制台默认就是 GBK，保持不动即可正确显示中文。
if ([string]::IsNullOrWhiteSpace($OutPath)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
  $OutPath = Join-Path $desktop '学习通学伴.lnk'
}

if (Test-Path $OutPath) {
  Write-Output "[跳过] 快捷方式已存在：$OutPath"
  Write-Output "       如需重建，请先删掉它再运行本脚本。"
  Restore-ConsoleEncoding2;
  exit 0
}

$exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  Write-Output "[失败] 找不到 electron.exe：$exe"
  Write-Output "       请先双击「启动学习通学伴.cmd」让它把环境装好。"
  Restore-ConsoleEncoding2;
  exit 1
}

# ★ 图标：优先用应用自带 ico，没有就回退到 exe 自带图标
$icoFile = Join-Path $AppDir 'assets\tray.ico'
if (Test-Path $icoFile) {
  $iconLoc = $icoFile + ',0'
} else {
  $iconLoc = $exe + ',0'
  Write-Output "[注意] 没找到 assets\tray.ico，使用 electron.exe 自带图标"
}

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($OutPath)
$s.TargetPath       = $exe
# ★ 引号拼法：单引号里放一个双引号字符，得到 "C:\path" 而不是 \"C:\path\"
$s.Arguments        = '"' + $AppDir + '" --no-sandbox'
$s.WorkingDirectory = $AppDir
$s.IconLocation     = $iconLoc
$s.Description      = '学习通学伴 - 网课转文字稿与 AI 答疑'
$s.Save()

if (Test-Path $OutPath) {
  # ★ 读回校验：确认参数里没有多余的反斜杠
  $v = $w.CreateShortcut($OutPath)
  Write-Output "[完成] 已在桌面创建快捷方式：$OutPath"
  Write-Output "       目标: $($v.TargetPath)"
  Write-Output "       参数: $($v.Arguments)"
  Write-Output "       图标: $($v.IconLocation)"
  if ($v.Arguments -like '*\"*') {
    Write-Output "[警告] 参数里出现了反斜杠引号，可能无法启动。请删除快捷方式后重跑。"
  } else {
    Write-Output "       以后双击桌面上的「学习通学伴」就能直接启动，不用再跑 cmd。"
  }
} else {
  Write-Output "[失败] 快捷方式创建失败"
  Restore-ConsoleEncoding2;
  exit 1
}

Restore-ConsoleEncoding2;
