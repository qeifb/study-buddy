param([Parameter(Mandatory=$true)][string]$Src, [Parameter(Mandatory=$true)][string]$Dst)

# 打包 zip，条目名统一用正斜杠（符合 ZIP 规范 APPNOTE 4.4.17.1）。
#
# 为什么不用 [IO.Compression.ZipFile]::CreateFromDirectory：
#   在 Windows 上它会把路径分隔符原样写成反斜杠（app\main.js），
#   产出的 zip 文件在 macOS / Linux / 部分解压器上会解出名为 "app\main.js"
#   的单个文件，而不是目录结构。实测资源管理器自己压缩用的是正斜杠。
#
# 用法：powershell -File zip-slash.ps1 -Src <目录> -Dst <zip路径>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path -LiteralPath $Src)) { throw "源目录不存在：$Src" }
if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Force }

$base = (Resolve-Path -LiteralPath $Src).Path
$fs = [IO.File]::Open($Dst, [IO.FileMode]::CreateNew)
$arch = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
$n = 0
try {
  Get-ChildItem -LiteralPath $base -Recurse -File | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/') -replace '\\', '/'
    $entry = $arch.CreateEntry($rel, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $_.LastWriteTime
    $es = $entry.Open()
    $in = [IO.File]::OpenRead($_.FullName)
    try { $in.CopyTo($es) } finally { $in.Dispose(); $es.Dispose() }
    $n++
  }
} finally {
  $arch.Dispose()
  $fs.Dispose()
}

Write-Output "OK $n $Dst"
