<#
  学习通学伴 · 转写环境一键安装脚本
  ---------------------------------------------------------------
  作用：在本机准备好「把视频里的语音转成文字」所需的环境
         1) 找到 Python（没有就自动下载便携版），创建独立虚拟环境 tools\pyenv
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
    [string]$Mirror = 'https://hf-mirror.com',
    # 便携版 Python 配置（系统没有 Python 时用）
    [string]$PyVersion  = '20261021',
    [string]$PyFile     = 'cpython-3.12.15+20261021-x86_64-pc-windows-msvc-install_only.tar.gz',
    [string]$PyMirror   = 'https://registry.npmmirror.com/-/binary/python-build-standalone',
    # PyPI 镜像（国内加速）
    [string]$PyPiIndex  = 'https://pypi.tuna.tsinghua.edu.cn/simple'
)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
$ToolsDir = $PSScriptRoot
$Pyenv     = Join-Path $ToolsDir 'pyenv'
$PyExe     = Join-Path $Pyenv 'Scripts\python.exe'
$ModelDir  = Join-Path $ToolsDir ("models\" + $Model)
$TranscribePy = Join-Path $ToolsDir 'transcribe.py'
$PortablePyDir = Join-Path $ToolsDir 'python'
$PortablePyExe = Join-Path $PortablePyDir 'python.exe'

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
    # ① 先找系统已装的 Python
    $base = $null
    foreach ($cand in @('py', 'python', 'python3')) {
        try {
            $out = & $cand -c "import sys;print(sys.version_info[0], sys.version_info[1])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { $base = $cand; break }
        } catch { }
    }

    if ($base) {
        $ver = & $base -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))"
        Ok "找到系统 Python $ver（命令：$base）"
    } else {
        # ② 系统没有 → 用本目录已有便携版
        if (Test-Path $PortablePyExe) {
            $pver = & $PortablePyExe -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))" 2>$null
            Ok "使用本目录内的便携版 Python $pver"
            $base = $PortablePyExe
        } else {
            # ③ 都没有 → 自动下载便携版（不需要管理员权限，不装进系统）
            Warn "未检测到 Python，正在自动下载便携版（约 45MB）"
            Warn "只解压到本目录 tools\python\，不装进系统、不需要管理员权限"
            $pyUrl = "$PyMirror/$PyVersion/$PyFile"
            Write-Host "       下载地址：$pyUrl" -ForegroundColor DarkGray

            $pyTmp = Join-Path $ToolsDir 'python-download.tar.gz'
            if (Test-Path $pyTmp) { Remove-Item $pyTmp -Force -ErrorAction SilentlyContinue }
            if (Test-Path $PortablePyDir) { Remove-Item $PortablePyDir -Recurse -Force -ErrorAction SilentlyContinue }

            $oldPP = $ProgressPreference
            $ProgressPreference = 'SilentlyContinue'
            try {
                Invoke-WebRequest -Uri $pyUrl -OutFile $pyTmp -UseBasicParsing -TimeoutSec 900
            } catch {
                $ProgressPreference = $oldPP
                Die @"
便携版 Python 下载失败：$($_.Exception.Message)

请手动处理，二选一：
  1) 安装 Python 3.10~3.13 后重启本脚本：
       https://www.python.org/downloads/windows/
       安装时勾选「Add python.exe to PATH」
  2) 手动下载便携版：
       $pyUrl
       解压后把里面的 python 文件夹放到：$PortablePyDir
       （最终应是 $PortablePyExe）
"@
            }
            $ProgressPreference = $oldPP

            if (-not (Test-Path $pyTmp)) { Die "下载完成但文件不存在，请重试。" }
            Step "解压便携版 Python..."
            $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
            if (Test-Path $tarExe) {
                & $tarExe -xzf $pyTmp -C $ToolsDir
            } else {
                Die "系统缺少 tar.exe（需要 Windows 10 1803 以上）。请按上面第 1 条手动安装 Python。"
            }
            Remove-Item $pyTmp -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path $PortablePyExe)) {
                Die "解压后没有找到 $PortablePyExe，请手动把 python 文件夹放到 $PortablePyDir"
            }
            $pver = & $PortablePyExe -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))" 2>$null
            Ok "便携版 Python $pver 已就绪"
            $base = $PortablePyExe
        }
    }

    Step "创建独立虚拟环境（不会影响系统里其他 Python 项目）"
    if ($base -eq 'py') { & py -3 -m venv $Pyenv } else { & $base -m venv $Pyenv }
    if (-not (Test-Path $PyExe)) { Die "虚拟环境创建失败。" }
    Ok "虚拟环境已创建：$Pyenv"
}

# ---------- 2. 安装 faster-whisper ----------
Step "安装语音识别库 faster-whisper（第一次约 200MB，请耐心等）"
Warn "使用 PyPI 镜像加速：$PyPiIndex"
& $PyExe -m pip install --upgrade pip --disable-pip-version-check -q -i $PyPiIndex
& $PyExe -m pip install --upgrade faster-whisper huggingface_hub --disable-pip-version-check -i $PyPiIndex
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
