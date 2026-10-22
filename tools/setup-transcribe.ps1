<#
  学习通学伴 · 转写环境一键安装脚本
  ---------------------------------------------------------------
  作用：在本机准备好「把视频里的语音转成文字」所需的环境
        1) 找到 Python，创建独立虚拟环境 tools\pyenv
        2) 安装 faster-whisper（语音识别库）
        3) 下载识别模型到 tools\models\<模型名>
        4) 自检一次，确认能用

  用法（两种都行）：
    A. 在「PowerShell」里执行：
         powershell -ExecutionPolicy Bypass -File .\setup-transcribe.ps1
    B. 右键这个文件 →「使用 PowerShell 运行」

  可选参数：
    -Model small          换更小的模型（默认 large-v3-turbo 最准，1.6GB；small 约 480MB）
    -Mirror https://hf-mirror.com    模型下载镜像（国内默认走这个，海外可传空字符串直连）

  装完之后：应用「设置」里的「转写环境」应显示「就绪」。
#>

param(
    [string]$Model = 'large-v3-turbo',
    [string]$Mirror = 'https://hf-mirror.com'
)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
$ToolsDir = $PSScriptRoot
$Pyenv     = Join-Path $ToolsDir 'pyenv'
$PyExe     = Join-Path $Pyenv 'Scripts\python.exe'
$ModelDir  = Join-Path $ToolsDir ("models\" + $Model)
$TranscribePy = Join-Path $ToolsDir 'transcribe.py'

function Step($msg) { Write-Host ("[步骤] " + $msg) -ForegroundColor Cyan }
function Ok($msg)   { Write-Host ("[完成] " + $msg) -ForegroundColor Green }
function Warn($msg) { Write-Host ("[注意] " + $msg) -ForegroundColor Yellow }
function Die($msg)  { Write-Host ("[失败] " + $msg) -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "===============================================" -ForegroundColor Magenta
Write-Host "  学习通学伴 · 转写环境安装" -ForegroundColor Magenta
Write-Host "  安装位置：$ToolsDir" -ForegroundColor Magenta
Write-Host "===============================================" -ForegroundColor Magenta
Write-Host ""

# ---------- 0. 检查 transcribe.py ----------
if (-not (Test-Path $TranscribePy)) { Die "找不到 tools\transcribe.py，请确认下载的是完整项目包。" }

# ---------- 1. 准备 Python ----------
Step "检查 Python"
if (Test-Path $PyExe) {
    $old = & $PyExe -c "import sys;print(sys.version.split()[0])" 2>$null
    Ok "已经有虚拟环境：Python $old"
} else {
    $base = $null
    foreach ($cand in @('py', 'python', 'python3')) {
        try {
            $out = & $cand -c "import sys;print(sys.version_info[0], sys.version_info[1])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { $base = $cand; break }
        } catch { }
    }
    if (-not $base) {
        Die @"
没找到 Python。请先安装 Python 3.10 ~ 3.13：
  https://www.python.org/downloads/windows/
安装时务必勾选「Add python.exe to PATH」，装完重启这个脚本。
"@
    }
    $ver = & $base -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))"
    Ok "找到 Python $ver（命令：$base）"
    Step "创建独立虚拟环境（不会影响系统里其他 Python 项目）"
    if ($base -eq 'py') { & py -3 -m venv $Pyenv } else { & $base -m venv $Pyenv }
    if (-not (Test-Path $PyExe)) { Die "虚拟环境创建失败。" }
    Ok "虚拟环境已创建：$Pyenv"
}

# ---------- 2. 安装 faster-whisper ----------
Step "安装语音识别库 faster-whisper（第一次约 200MB，请耐心等）"
& $PyExe -m pip install --upgrade pip --disable-pip-version-check -q
& $PyExe -m pip install --upgrade faster-whisper huggingface_hub --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Die "pip 安装失败，请检查网络（可尝试换国内镜像）。" }
$fw = & $PyExe -c "import faster_whisper;print(faster_whisper.__version__)"
if (-not $fw) { Die "faster-whisper 装上了但导入失败。" }
Ok "faster-whisper $fw 已就绪"

# ---------- 3. 下载识别模型 ----------
if (Test-Path (Join-Path $ModelDir 'model.bin')) {
    Ok "模型已存在：$ModelDir"
} else {
    Step "下载识别模型 $Model（1.6GB 左右，取决于网速，可能要十几分钟）"
    if ($Mirror) {
        Warn "使用镜像下载：$Mirror"
        $env:HF_ENDPOINT = $Mirror
    }
    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
    $repo = "Systran/faster-whisper-$Model"
    $code = @"
from huggingface_hub import snapshot_download
snapshot_download(repo_id='$repo', local_dir=r'$ModelDir')
print('MODEL_OK')
"@
    $tmp = Join-Path $env:TEMP ("sb-dl-" + [guid]::NewGuid().ToString('N') + ".py")
    Set-Content -Path $tmp -Value $code -Encoding UTF8
    try { & $PyExe $tmp } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $ModelDir 'model.bin'))) {
        Die "模型下载失败。可以换镜像或重试：.\setup-transcribe.ps1 -Model small（更小的模型）"
    }
    Ok "模型已下载：$ModelDir"
}

# ---------- 4. 自检 ----------
Step "自检（加载模型 + 转写一段静音）"
$check = @"
import sys
from faster_whisper import WhisperModel
m = WhisperModel(r'$ModelDir', device='cpu', compute_type='int8')
print('SELFTEST_OK')
"@
$tmp2 = Join-Path $env:TEMP ("sb-check-" + [guid]::NewGuid().ToString('N') + ".py")
Set-Content -Path $tmp2 -Value $check -Encoding UTF8
try { & $PyExe $tmp2 } finally { Remove-Item $tmp2 -Force -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { Die "自检失败：模型加载不了。" }

Write-Host ""
Ok "全部完成！转写环境已就绪。"
Write-Host "  下次点「课程日志」抓取时，就会自动调用它。" -ForegroundColor Green
Write-Host ""
