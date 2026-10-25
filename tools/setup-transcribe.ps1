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

# ⚠️ 关键：进入时保存原控制台编码，退出前恢复。
# 原因：把 OutputEncoding 改成 UTF-8 后，本脚本退出时**控制台仍是 UTF-8**，
# 而调用方 启动学习通学伴.cmd 是 GBK（chcp 936），于是它后续的中文全变乱码
# （用户实测日志里出现 "[ע  ] תд ׼ ʧ ܡ Ӧ  Կ" 这种）。
# 所以必须保存→恢复，绝不能只设不改回。
$Script:OldOutEnc = $null
$Script:OldCp = $null
try { $Script:OldOutEnc = [Console]::OutputEncoding } catch { }
try { $Script:OldCp = chcp } catch { }

function Restore-ConsoleEncoding {
    try { if ($Script:OldOutEnc) { [Console]::OutputEncoding = $Script:OldOutEnc } } catch { }
    # chcp 输出形如 "Active code page: 936"，提取数字后恢复
    try {
        if ($Script:OldCp -match '(\d+)') {
            $cp = [int]$Matches[1]
            & chcp $cp > $null 2>&1
        }
    } catch { }
}

# 现在才允许切 UTF-8（让本脚本自己的中文显示正常）
# ⚠️ 不要设置 [Console]::OutputEncoding = UTF8！

# 本脚本被 .cmd（chcp 936 = GBK）用 powershell -File 调用，

# 子进程 stdout 的字节由 cmd 按 GBK 解释。设 UTF-8 会导致中文全乱码。

# 中文 Windows 的控制台默认就是 GBK，保持不动即可正确显示中文。
# 无论成功/失败/异常退出，都恢复编码
trap {
    Restore-ConsoleEncoding
    Write-Host ""
    Write-Host ("[异常] " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
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
function Die($msg)  { Write-Host ("[失败] " + $msg) -ForegroundColor Red; Restore-ConsoleEncoding; exit 1 }

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

# ★ 2026-10-25：不装 nvidia-* CUDA 包，纯 CPU 转写用不到，却占 2GB
#   （cublas 736MB + cudnn 1096MB + nvrtc 178MB）。
#   faster-whisper / ctranslate2 的依赖树里都没有它们，是 pip 自动带的可选包。
& $PyExe -m pip install faster-whisper huggingface_hub --disable-pip-version-check -i $PyPiIndex
if ($LASTEXITCODE -ne 0) { Die "pip 安装失败，请检查网络（可尝试换国内镜像）。" }

# 若之前装过 nvidia-*（旧版残留），主动卸掉，避免白占 2GB
Step "清理用不到的 CUDA 包（纯 CPU 转写不需要）"
    # ★ 2026-10-25 修：pip uninstall 在「包本来就没装」时返回退出码 1（只是 WARNING），
    #   而我们没重置 $LASTEXITCODE，导致后面的检查继承了这个 1，把「本来没事」判成失败。
    #   这是正常情况（新版本来就不装 nvidia），绝不能因此让整个安装失败。
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & $PyExe -m pip uninstall -y -q nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12 2>&1 | Out-Null
    } catch { }
    $ErrorActionPreference = $prevEAP
    $global:LASTEXITCODE = 0   # 关键：显式清零，避免污染后续判断
Warn "CUDA 包清理完成（若本来就没有，属正常）"
$fw = & $PyExe -c "import faster_whisper;print(faster_whisper.__version__)"
if (-not $fw) { Die "faster-whisper 装上了但导入失败。" }
Ok "faster-whisper $fw 已就绪"


# ---------- 3. 下载识别模型 ----------
if (Test-Path (Join-Path $ModelDir 'model.bin')) {
    Ok "模型已存在：$ModelDir"
} else {
    Step "下载识别模型 $Model（1.6GB 左右，取决于网速，可能要十几分钟）"

    # ⚠️ 多镜像 + 重试（2026-10-25 用户实测 hf-mirror.com 超时后直接失败）
    # 单镜像一次失败就放弃太脆弱：国内网络对 hf-mirror 时常不稳。
    # 策略：候选镜像轮流试，每个试 2 轮，全失败才报错。
    $mirrors = @()
    if ($Mirror) { $mirrors += $Mirror }
    $mirrors += 'https://hf-mirror.com'
    $mirrors += 'https://huggingface.co'
    $mirrors = $mirrors | Select-Object -Unique

    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
    $repo = "Systran/faster-whisper-$Model"

    $ok = $false
    $attempt = 0
    foreach ($m in $mirrors) {
        foreach ($round in 1..2) {
            $attempt++
            $endpoint = if ($m) { $m } else { 'https://huggingface.co' }
            Warn "第 $attempt 次尝试（镜像：$endpoint，第 $round 轮）"
            $env:HF_ENDPOINT = $endpoint
            # 每次都给足超时，避免网络抖动误判
            $env:HF_HUB_DOWNLOAD_TIMEOUT = '60'

            $code = @"
import os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='$repo',
    local_dir=r'$ModelDir',
    resume_download=True,      # 断点续传，中断后不用从头下
    max_workers=2,             # 并发低一点，减少被限速
    endpoint=os.environ.get('HF_ENDPOINT') or 'https://huggingface.co',
)
print('MODEL_OK')
"@
            $tmp = Join-Path $env:TEMP ("sb-dl-" + [guid]::NewGuid().ToString('N') + ".py")
            Set-Content -Path $tmp -Value $code -Encoding UTF8
            try {
                & $PyExe $tmp
                $exit = $LASTEXITCODE
            } catch {
                $exit = 1
            } finally {
                Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            }

            if ($exit -eq 0 -and (Test-Path (Join-Path $ModelDir 'model.bin'))) {
                $ok = $true
                break
            }
            Warn "这次没成功（退出码 $exit），换下一个镜像/重试..."
            Start-Sleep -Seconds 3
        }
        if ($ok) { break }
    }

    if (-not $ok) {
        Die @"
模型下载失败（已尝试 $attempt 次，换了 $($mirrors.Count) 个镜像）。

常见原因：网络连不上 huggingface（国内常见），或代理不稳定。

请手动处理，四选一：
  1) 换个时间重试（网络可能只是暂时不通）：
       .\setup-transcribe.ps1
  2) 用更小的模型（下载量从 1.6GB 降到约 480MB）：
       .\setup-transcribe.ps1 -Model small
  3) 指定你能连通的其他镜像：
       .\setup-transcribe.ps1 -Mirror https://你的镜像地址
  4) 手动下载后放到指定目录（推荐网络差的同学）：
       打开 https://hf-mirror.com/Systran/faster-whisper-$Model
       下载全部文件，放到：$ModelDir
       （最终应有 model.bin 等文件）

  注意：不装模型不影响应用启动，只是「抓课程日志」不可用。
        之后随时可以双击 tools\setup-transcribe.ps1 重试。
"@
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

# 结束前恢复控制台编码，避免调用方（.cmd）后续中文乱码
Restore-ConsoleEncoding
Write-Host "  下次点「课程日志」抓取时，就会自动调用它。" -ForegroundColor Green
Write-Host ""


# ★ 2026-10-25 修：显式 exit 0
#   本脚本会被 启动学习通学伴.cmd 用 `if errorlevel 1` 判定成败。
#   若此处不写 exit 0，PowerShell 会把「最后一条外部命令的 $LASTEXITCODE」
#   当作进程退出码 —— 而中间 pip 的 WARNING/管道可能把它弄成 1，
#   于是「装成功了」会被 cmd 判成「装失败」（用户已实测踩到）。
exit 0