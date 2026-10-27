<#
    学习通学伴 · 版本补丁应用器
    ─────────────────────────────
    运行前提：
      1. 补丁压缩包已解压到「安装目录」（能看到 app 文件夹和 启动学习通学伴.cmd 的那一层）
      2. 学习通学伴已完全退出（含托盘图标右键退出）

    做的事：
      读 patch.json → 核对版本 → 校验补丁文件 sha256 → 检测文件占用
      → 检测用户本地改动 → 备份 → 覆盖/删除 → 复验 → 失败自动回滚

    不会动：data/（课程日志、聊天记录、设置）、browser-profile/、node_modules/、
            pyenv/、models/ —— 补丁内容本身就不含这些。
#>

# ⚠️ 这里绝对不能设 [Console]::OutputEncoding = UTF8。
# 本脚本被 应用补丁.cmd（chcp 936 = GBK）用 powershell -File 调用，
# 一改 OutputEncoding 就等于把整块控制台的输出代码页改成 65001，
# 脚本退出后 cmd 自己 echo 的 GBK 中文全变成乱码
# （同 setup-transcribe.ps1 踩过的坑：日志里出现 "[ע  ] תд ׼ ʧ ܡ Ӧ  Կ"）。
# 中文 Windows 控制台本来就是 GBK，不碰它，中文才能正常显示。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$RULE = '─' * 62

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg)  { Write-Host ('  [完成] ' + $msg) -ForegroundColor Green }
function Bad($msg) { Write-Host ('  [失败] ' + $msg) -ForegroundColor Red }
function Info($msg) { Write-Host ('  ' + $msg) -ForegroundColor Gray }

function Pause-End {
    Write-Host ''
    Read-Host '按回车键关闭' | Out-Null
}

function Get-Sha256($path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
}

function RelToFull($rel) {
    return (Join-Path $installRoot ($rel -replace '/', '\'))
}

Write-Host ''
Say $RULE 'DarkGray'
Say '  学习通学伴 · 版本补丁' 'Cyan'
Say $RULE 'DarkGray'
Write-Host ''

# ────────────────────────────── 1. 读补丁信息 ──────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$jsonPath = Join-Path $scriptDir 'patch.json'

if (-not (Test-Path -LiteralPath $jsonPath)) {
    Bad '补丁包不完整：找不到 patch.json'
    Info '请确认是在解压出来的 patch-xxx 文件夹里双击「应用补丁.cmd」。'
    Pause-End
    exit 1
}

try {
    $pj = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Bad ('patch.json 读不出来：' + $_.Exception.Message)
    Pause-End
    exit 1
}

$fromVer = [string]$pj.fromVersion
$toVer = [string]$pj.toVersion
Info ('补丁：' + $fromVer + '  →  ' + $toVer)
Info ('内容：修改 ' + $pj.stats.modified + ' · 新增 ' + $pj.stats.added + ' · 删除 ' + $pj.stats.deleted)
Write-Host ''

# ────────────────────────────── 2. 定位安装目录 ──────────────────────────────
$installRoot = Split-Path -Parent $scriptDir
$appPkgPath = Join-Path $installRoot 'app\package.json'
$runCmdPath = Join-Path $installRoot '启动学习通学伴.cmd'

if (-not (Test-Path -LiteralPath $appPkgPath)) {
    Bad '位置不对：这个补丁必须解压到安装目录里再运行。'
    Write-Host ''
    Info '安装目录的样子是：'
    Info '    安装目录\'
    Info '       app\            ← 这个文件夹在'
    Info '       启动学习通学伴.cmd'
    Info ('       patch-' + $fromVer + '-to-' + $toVer + '\   ← 本补丁解压到这里面')
    Write-Host ''
    Info ('现在补丁的上一级目录是：' + $installRoot)
    Info '这个目录里没有 app\package.json，所以不敢动手。'
    Write-Host ''
    Info '正确做法：把补丁压缩包解压到安装目录，然后进解压出来的文件夹双击本脚本。'
    Pause-End
    exit 1
}

Info ('安装目录：' + $installRoot)

# ────────────────────────────── 3. 核对版本 ──────────────────────────────
$curVer = ''
try {
    $curVer = [string]((Get-Content -LiteralPath $appPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version)
} catch { }

Info ('当前版本：' + $curVer)
Write-Host ''

if ($curVer -eq $toVer) {
    Ok ('你已经是 ' + $toVer + '，不需要装这个补丁。')
    Pause-End
    exit 0
}

if ($fromVer -and $curVer -ne $fromVer) {
    Bad ('版本对不上：这个补丁只能装到 ' + $fromVer + ' 上，你现在是 ' + $curVer + '。')
    Write-Host ''
    Info '可能原因：'
    Info '   1. 你之前装过别的补丁，版本已经往后走了'
    Info '   2. 下载错了补丁包'
    Write-Host ''
    Info '最稳的办法：重新下载对应版本的完整安装包，或下载最新完整包覆盖安装'
    Info '（完整包不会动你的课程日志和聊天记录）。'
    Pause-End
    exit 1
}

# ────────────────────────────── 4. 校验补丁文件 ──────────────────────────────
$filesDir = Join-Path $scriptDir 'files'
Info '正在校验补丁文件完整性…'

$brokenCount = 0
foreach ($e in $pj.entries) {
    $src = Join-Path $filesDir ($e.rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src)) {
        Bad ('缺文件：' + $e.rel)
        $brokenCount++
        continue
    }
    $h = Get-Sha256 $src
    if ($h -ne ([string]$e.sha256).ToLower()) {
        Bad ('校验不符：' + $e.rel)
        $brokenCount++
    }
}

if ($brokenCount -gt 0) {
    Write-Host ''
    Bad ('有 ' + $brokenCount + ' 个文件损坏或缺失，已中止。你现有的程序一点没动。')
    Info '多半是解压不完整（压缩包还在下载中？）—— 重新解压一次再试。'
    Pause-End
    exit 1
}
Ok ('文件校验通过（' + $pj.entries.Count + ' 个）')
Write-Host ''

# ────────────────────────────── 5. 检测文件占用 ──────────────────────────────
$allRel = @()
foreach ($e in $pj.entries) { $allRel += [string]$e.rel }
foreach ($d in $pj.deleted) { $allRel += [string]$d.rel }

$locked = @()
foreach ($rel in $allRel) {
    $full = RelToFull $rel
    if (-not (Test-Path -LiteralPath $full)) { continue }
    try {
        $stream = [IO.File]::Open($full, 'Open', 'ReadWrite', 'None')
        $stream.Close()
        $stream.Dispose()
    } catch {
        $locked += $rel
    }
}

if ($locked.Count -gt 0) {
    Bad '这些文件正被占用，说明学习通学伴还在运行：'
    foreach ($l in $locked) { Info ('     ' + $l) }
    Write-Host ''
    Info '请完全退出应用：右下角托盘图标 → 右键 → 退出。'
    Info '（只关窗口不够，窗口关了它还在托盘里后台跑。）'
    Info '然后重新双击「应用补丁.cmd」。'
    Pause-End
    exit 1
}
Info '没有文件被占用'

# ────────────────────────────── 6. 检测本地改动 ──────────────────────────────
$diverged = @()
foreach ($e in $pj.entries) {
    if (-not $e.oldSha256) { continue }
    $full = RelToFull ([string]$e.rel)
    if (-not (Test-Path -LiteralPath $full)) { continue }
    if ((Get-Sha256 $full) -ne ([string]$e.oldSha256).ToLower()) { $diverged += [string]$e.rel }
}
foreach ($d in $pj.deleted) {
    $full = RelToFull ([string]$d.rel)
    if (-not (Test-Path -LiteralPath $full)) { continue }
    if ((Get-Sha256 $full) -ne ([string]$d.oldSha256).ToLower()) { $diverged += [string]$d.rel }
}

if ($diverged.Count -gt 0) {
    Write-Host ''
    Say ('  注意：这 ' + $diverged.Count + ' 个文件和你机器上的原版不一样：') 'Yellow'
    foreach ($x in $diverged) { Say ('     ' + $x) 'Yellow' }
    Write-Host ''
    Info '可能是你自己改过，或者之前装过别的补丁。继续应用会覆盖它们。'
    $answer = (Read-Host '  输入 y 继续覆盖，直接回车取消')
    $answer = ([string]$answer).Trim().ToLower()
    if ($answer -ne 'y' -and $answer -ne 'yes' -and $answer -ne '是') {
        Write-Host ''
        Info '已取消，什么都没改。'
        Pause-End
        exit 1
    }
}

# ────────────────────────────── 7. 备份 + 应用 ──────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $installRoot ('backup-' + $stamp)
$backedUp = 0

function Backup-One($rel) {
    $full = RelToFull $rel
    if (-not (Test-Path -LiteralPath $full)) { return }
    $relDir = Split-Path $rel -Parent
    if ($relDir) {
        $destDir = Join-Path $backupDir ($relDir -replace '/', '\')
    } else {
        $destDir = $backupDir
    }
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $full -Destination (Join-Path $destDir (Split-Path $rel -Leaf)) -Force
    $script:backedUp++
}

# 记录本次新建的文件（回滚时要删掉）
$newly = New-Object System.Collections.ArrayList

function Restore-All {
    if (Test-Path -LiteralPath $backupDir) {
        $items = Get-ChildItem -LiteralPath $backupDir -Recurse -File
        foreach ($it in $items) {
            $rel = $it.FullName.Substring($backupDir.Length + 1)
            $dst = Join-Path $installRoot $rel
            $dstDir = Split-Path $dst -Parent
            if (-not (Test-Path -LiteralPath $dstDir)) {
                New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $it.FullName -Destination $dst -Force
        }
    }
    foreach ($n in $newly) {
        if (Test-Path -LiteralPath $n) {
            Remove-Item -LiteralPath $n -Force -ErrorAction SilentlyContinue
        }
    }
}

Info '正在备份将被覆盖的文件…'
foreach ($e in $pj.entries) { Backup-One ([string]$e.rel) }
foreach ($d in $pj.deleted) { Backup-One ([string]$d.rel) }

if (Test-Path -LiteralPath $backupDir) {
    Ok ('已备份 ' + $backedUp + ' 个文件 → backup-' + $stamp)
} else {
    Info '本次没有需要备份的文件（全是新增）'
}

Write-Host ''
Info '正在写入…'

try {
    foreach ($e in $pj.entries) {
        $src = Join-Path $filesDir ($e.rel -replace '/', '\')
        $dst = RelToFull ([string]$e.rel)
        $dstDir = Split-Path $dst -Parent
        if (-not (Test-Path -LiteralPath $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }
        if (-not (Test-Path -LiteralPath $dst)) { [void]$newly.Add($dst) }
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
    foreach ($d in $pj.deleted) {
        $dst = RelToFull ([string]$d.rel)
        if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
    }
} catch {
    Write-Host ''
    Bad ('写入失败：' + $_.Exception.Message)
    Info '正在回滚，把你原来的文件放回去…'
    Restore-All
    Ok '已回滚到应用前的状态'
    Pause-End
    exit 1
}

# ────────────────────────────── 8. 复验 ──────────────────────────────
Info '正在复验写入结果…'
$verifyBad = 0
foreach ($e in $pj.entries) {
    $dst = RelToFull ([string]$e.rel)
    if (-not (Test-Path -LiteralPath $dst)) { $verifyBad++; continue }
    if ((Get-Sha256 $dst) -ne ([string]$e.sha256).ToLower()) { $verifyBad++ }
}

if ($verifyBad -gt 0) {
    Write-Host ''
    Bad ('复验失败：有 ' + $verifyBad + ' 个文件写完后内容和预期不一致。')
    Info '正在回滚…'
    Restore-All
    Ok '已回滚到应用前的状态'
    Info '如果反复出现，请换完整安装包（可能是杀毒软件拦截了写入）。'
    Pause-End
    exit 1
}

# ────────────────────────────── 9. 完成 ──────────────────────────────
Write-Host ''
Say $RULE 'DarkGray'
Ok ('补丁应用完成：' + $toVer)
Say $RULE 'DarkGray'
Write-Host ''
Info ('原始文件备份在：backup-' + $stamp)
Info '确认用着没问题之后，这个备份文件夹可以删掉。'
Write-Host ''

# 补丁动到了扩展，就提醒重载
$hitExt = $false
foreach ($e in $pj.entries) {
    if (([string]$e.rel).StartsWith('app/extension/')) { $hitExt = $true; break }
}
if ($hitExt) {
    Say '  这次补丁更新了浏览器扩展，需要重载一次：' 'Yellow'
    Info '   1. 打开 edge://extensions'
    Info '   2. 找到「学习通学伴」→ 点「重新加载」'
    Info '   3. 回到学习通页面按 F5 刷新'
    Write-Host ''
}

Info '现在可以双击桌面「学习通学伴」正常使用了。'
Pause-End
exit 0
