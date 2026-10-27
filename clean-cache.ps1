<#
  StudyBuddy · 缓存清理
  ============================================================
  只清理「可重新生成的缓存」。绝不触碰以下内容（硬白名单之外一律不动）：

    data\                 对话、settings.json(API Key)、course-logs 课程日志
    repo\                 发布源码与 .git
    app\node_modules\     依赖 + Electron 运行时本体
    tools\pyenv\          转写环境（Python + faster-whisper）
    tools\models\         语音识别模型 1.6GB
    任何 Cookies / Login Data / History / Local Storage（登录态）

  用法：
    .\clean-cache.ps1                 清掉 N 天内没写入过的缓存（默认 30 天）
    .\clean-cache.ps1 -KeepDays 0     全清（不看时间，做一次大扫除用）
    .\clean-cache.ps1 -DryRun         只报告能释放多少，不删任何东西
    .\clean-cache.ps1 -SkipDownloads  跳过 pip/electron/npm 下载缓存
    .\clean-cache.ps1 -IncludeBackups 连 data\*.bak-* 备份一起清

  按「最后写入时间(LastWriteTime)」判断，不用访问时间——Windows 默认
  关闭 NtfsDisableLastAccessUpdate，LastAccessTime 不可靠。
#>
[CmdletBinding()]
param(
  [int]$KeepDays = 30,
  [switch]$DryRun,
  [switch]$SkipDownloads,
  [switch]$IncludeBackups
)

$ErrorActionPreference = 'Continue'
# ★ 2026-10-27 修：被 Node 以管道重定向捕获时，PowerShell 5.1 默认按系统 OEM
#   代码页（简体中文 = GBK/936）输出，Node 按 UTF-8 解码 → 中文全变乱码（用户实测）。
#   只在「输出确实被重定向」时切 UTF-8；用户手动双击/在 cmd 里运行时不动，
#   免得反而把控制台弄乱。
if ([Console]::IsOutputRedirected) {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
}
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath (Join-Path $Root 'app'))) {
  Write-Host "[中止] 这个脚本必须放在 StudyBuddy 根目录（和 app\ 同级）。当前：$Root" -ForegroundColor Red
  exit 1
}

$Cutoff = (Get-Date).AddDays(-[math]::Abs($KeepDays))
$script:FreedBytes = 0
$script:FreedFiles = 0
$script:Skipped = New-Object System.Collections.ArrayList
$script:Errors  = New-Object System.Collections.ArrayList

# ── 1. 下载缓存：东西已装好，删了只会让「将来重装」变慢 ──────────────
$downloadCache = @(
  'cache\pip\http-v2'
  'cache\pip\wheels'
  'cache\electron'
  'cache\npm\_cacache'
  'cache\npm\_logs'
  'cache\npm\_npx'
)

# ── 2. 专用浏览器 profile 里的可再生缓存（登录态不在其中）───────────
$profileCache = @(
  'tools\browser-profile\component_crx_cache'
  'tools\browser-profile\ProvenanceData'
  'tools\browser-profile\ProvenanceDataTensors'
  'tools\browser-profile\Edge Entity Extraction'
  'tools\browser-profile\Edge Wallet'
  'tools\browser-profile\Edge Shopping'
  'tools\browser-profile\Subresource Filter'
  'tools\browser-profile\GrShaderCache'
  'tools\browser-profile\GPUPersistentCache'
  'tools\browser-profile\ShaderCache'
  'tools\browser-profile\BrowserMetrics'
  'tools\browser-profile\EdgeLanguageDetectionModel'
  'tools\browser-profile\Speech Recognition'
  'tools\browser-profile\Safe Browsing'
  'tools\browser-profile\Default\Cache'
  'tools\browser-profile\Default\Code Cache'
  'tools\browser-profile\Default\GPUCache'
  'tools\browser-profile\Default\DawnGraphiteCache'
  'tools\browser-profile\Default\DawnWebGPUCache'
)

# ── 3. 应用自身（Electron）的运行时缓存 ─────────────────────────────
$runtimeCache = @(
  'runtime\Cache'
  'runtime\Code Cache'
  'runtime\GPUCache'
  'runtime\DawnGraphiteCache'
  'runtime\DawnWebGPUCache'
  'runtime\GrShaderCache'
  'runtime\ShaderCache'
)

# ══════════════════════════════════════════════════════════════════
# ★ 2026-10-25 新增：清理可能漏到系统盘（C 盘）的残留
#
# 动机：应用设计上把所有数据都放在程序目录（<root>\data、<root>\runtime、
#       <root>\cache），但不排除以下情况仍留下东西：
#   · 旧版本曾把数据写在 %APPDATA%\study-buddy / %LOCALAPPDATA%\dsh-study-companion
#   · pip / HuggingFace 在用户目录留缓存
#   · 系统 TEMP 里的 pip 构建目录、我们自己的临时文件
#
# 安全边界（硬性）：
#   · 只删「缓存类」内容，绝不碰 settings.json / chats.json（里面有 API Key 和聊天记录）
#   · 只删下列明确列出的路径，不做通配扫描
# ══════════════════════════════════════════════════════════════════

# ── 旧版数据目录里「可重建的缓存部分」（保留 settings.json 等）──
$legacyCache = @()
# 候选根目录：旧版在 Roaming 与 Local 都用过多个名字，全覆盖
$legacyBases = @(
  (Join-Path $env:APPDATA      'study-buddy'),
  (Join-Path $env:APPDATA      'study-buddy-app'),
  (Join-Path $env:APPDATA      'dsh-study-companion'),
  (Join-Path $env:LOCALAPPDATA 'study-buddy'),
  (Join-Path $env:LOCALAPPDATA 'study-buddy-app'),
  (Join-Path $env:LOCALAPPDATA 'dsh-study-companion')
)
# ★ 注意：Windows 文件系统大小写不敏感，Cache 与 cache 是同一个目录，
#   所以列表里只写一次；同时用 Resolve-Path 取真实全名做二次去重。
$legacySubs = @('runtime', 'Cache', 'Code Cache', 'GPUCache', 'browser-profile', 'app.log')
foreach ($base in $legacyBases) {
  if (-not $base -or -not (Test-Path -LiteralPath $base)) { continue }
  foreach ($sub in $legacySubs) {
    $q = Join-Path $base $sub
    if (-not (Test-Path -LiteralPath $q)) { continue }
    $real = (Resolve-Path -LiteralPath $q -ErrorAction SilentlyContinue).Path
    if (-not $real) { continue }
    $dup = $false
    foreach ($e in $legacyCache) {
      $er = (Resolve-Path -LiteralPath $e -ErrorAction SilentlyContinue).Path
      if ($er -and ($er -eq $real)) { $dup = $true; break }
    }
    if (-not $dup) { $legacyCache += $real }
  }
}

# ── HuggingFace 缓存（模型可能被下到用户目录）──
$hfCache = @()
foreach ($q in @(
  (Join-Path $env:USERPROFILE '.cache\huggingface'),
  (Join-Path $env:USERPROFILE '.cache\huggingface_hub')
)) {
  if ($q -and (Test-Path -LiteralPath $q)) { $hfCache += $q }
}

# ── 系统 TEMP 里我们相关的残留（名字前缀明确，避免误删别人的）──
$tempCache = @()
$tempRoot = $env:TEMP
if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
  $tempPatterns = @('sb-dl-*', 'sb-check-*', 'study-buddy*', 'pip-build-env-*', 'pip-install-*', 'pip-ephem-wheel-cache-*')
  foreach ($pat in $tempPatterns) {
    Get-ChildItem -LiteralPath $tempRoot -Filter $pat -ErrorAction SilentlyContinue |
      ForEach-Object { $tempCache += $_.FullName }
  }
}


function Format-Size([int64]$b) {
  if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
  if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
  return ('{0:N0} KB' -f ($b / 1KB))
}

# 在某个目录下，删掉「最后写入时间早于 Cutoff」的文件，然后清空空目录
function Invoke-DirClean([string]$label, [string]$relPath) {
  $full = Join-Path $Root $relPath
  if (-not (Test-Path -LiteralPath $full)) {
    [void]$script:Skipped.Add("$label  ($relPath) — 不存在")
    return
  }
  $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue)
  $hit = @($files | Where-Object { $_.LastWriteTime -lt $Cutoff })
  if ($hit.Count -eq 0) {
    [void]$script:Skipped.Add("$label  ($relPath) — 没有超过 $KeepDays 天的文件")
    return
  }
  $bytes = [int64](($hit | Measure-Object -Property Length -Sum).Sum)
  if ($DryRun) {
    Write-Host ("  [预演] {0,-46} {1,10}  ({2} 文件)" -f $relPath, (Format-Size $bytes), $hit.Count) -ForegroundColor DarkGray
    $script:FreedBytes += $bytes
    $script:FreedFiles += $hit.Count
    return
  }
  $ok = 0
  foreach ($f in $hit) {
    try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $ok++ }
    catch { [void]$script:Errors.Add("$($f.FullName) — $($_.Exception.Message)") }
  }
  # 清掉因此变空的子目录（不含根目录本身，避免把父目录结构删掉）
  Get-ChildItem -LiteralPath $full -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
      if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)) {
        try { Remove-Item -LiteralPath $_.FullName -Force -Recurse -ErrorAction Stop } catch { }
      }
    }
  Write-Host ("  [清理] {0,-46} {1,10}  ({2} 文件)" -f $relPath, (Format-Size $bytes), $ok) -ForegroundColor Green
  $script:FreedBytes += $bytes
  $script:FreedFiles += $ok
}

function Invoke-AbsClean([string]$label, [string]$fullPath) {
  # 与 Invoke-DirClean 相同逻辑，但接受绝对路径（用于系统盘残留）
  if (-not $fullPath) { return }
  if (-not (Test-Path -LiteralPath $fullPath)) { return }
  # ★ 安全检查：绝不删除根目录本身，只删里面的文件
  $files = @(Get-ChildItem -LiteralPath $fullPath -Recurse -File -Force -ErrorAction SilentlyContinue)
  $hit = @($files | Where-Object { $_.LastWriteTime -lt $Cutoff })
  if ($hit.Count -eq 0) { return }
  $bytes = [int64](($hit | Measure-Object -Property Length -Sum).Sum)
  $shownName = $fullPath
  if ($shownName.Length -gt 52) { $shownName = '...' + $shownName.Substring($shownName.Length - 49) }
  if ($DryRun) {
    Write-Host ("  [预演] {0,-52} {1,10}  ({2} 文件)" -f $shownName, (Format-Size $bytes), $hit.Count) -ForegroundColor DarkGray
    $script:FreedBytes += $bytes
    $script:FreedFiles += $hit.Count
    return
  }
  $ok = 0
  foreach ($f in $hit) {
    try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $ok++ }
    catch { [void]$script:Errors.Add("$($f.FullName) — $($_.Exception.Message)") }
  }
  Write-Host ("  [清理] {0,-52} {1,10}  ({2} 文件)" -f $shownName, (Format-Size $bytes), $ok) -ForegroundColor Green
  $script:FreedBytes += $bytes
  $script:FreedFiles += $ok
}


Write-Host ''
Write-Host '=================================================================='
Write-Host ("  StudyBuddy 缓存清理   根目录: $Root")
Write-Host ("  策略: 清理 {0} 天前写入的缓存文件{1}" -f $KeepDays, $(if ($DryRun) { '    【预演模式，不删除】' } else { '' }))
Write-Host '=================================================================='

# 应用/浏览器还开着的时候，不要去动它们的缓存目录
$procNames = @('electron', 'msedge', 'chrome')
$running = @($procNames | Where-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue })
$appBusy = $running.Count -gt 0
if ($appBusy) {
  Write-Host ("  [注意] 检测到正在运行: {0}" -f ($running -join ', ')) -ForegroundColor Yellow
  Write-Host '         本次跳过浏览器/应用缓存，只清下载缓存。' -ForegroundColor Yellow
}

if (-not $SkipDownloads) {
  Write-Host ''
  Write-Host '── 下载缓存（pip / Electron / npm）────────────────────────────────'
  foreach ($p in $downloadCache) { Invoke-DirClean '下载缓存' $p }
}

if (-not $appBusy) {
  Write-Host ''
  Write-Host '── 专用浏览器缓存（保留 Cookies / 登录态）─────────────────────────'
  foreach ($p in $profileCache) { Invoke-DirClean '浏览器缓存' $p }
} else {
  [void]$script:Skipped.Add('专用浏览器缓存 — 因浏览器正在运行而跳过')
}

if (-not $appBusy) {
  Write-Host ''
  Write-Host '── 应用运行时缓存 ────────────────────────────────────────────────'
  
foreach ($p in $runtimeCache) { Invoke-DirClean '运行时缓存' $p }

} else {
  [void]$script:Skipped.Add('应用运行时缓存 — 因应用正在运行而跳过')
}


# ── ★ 清理可能漏到系统盘（C 盘）的残留（2026-10-25 新增）──
Write-Host ''
Write-Host '── 系统盘残留（旧版数据 / HuggingFace / 临时文件）───────────────────'
$cCleaned = 0
foreach ($p in $legacyCache) { Invoke-AbsClean '旧版数据缓存' $p; $cCleaned++ }
foreach ($p in $hfCache)     { Invoke-AbsClean 'HuggingFace 缓存' $p; $cCleaned++ }
foreach ($p in $tempCache)   { Invoke-AbsClean '临时文件' $p; $cCleaned++ }
if ($cCleaned -eq 0) {
  Write-Host '  ✅ 系统盘没有本应用的残留（很干净）' -ForegroundColor Green
} else {
  Write-Host ("  检查了 {0} 个系统盘路径" -f $cCleaned) -ForegroundColor DarkGray
}

# 轮转出来的旧日志（app.log.1 / app.log.2 …）与临时文件
Write-Host ''
Write-Host '── 旧日志与临时文件 ──────────────────────────────────────────────'
$loose = @()
$loose += @(Get-ChildItem -LiteralPath (Join-Path $Root 'data') -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '\.log\.\d+$' })
$loose += @(Get-ChildItem -LiteralPath (Join-Path $Root 'runtime') -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '*.tmp' })
$loose += @(Get-ChildItem -LiteralPath (Join-Path $Root 'dist') -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '*.tmp' })
if ($IncludeBackups) {
  $loose += @(Get-ChildItem -LiteralPath (Join-Path $Root 'data') -File -Force -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match '\.bak-' })
}
$loose = @($loose | Where-Object { $_.LastWriteTime -lt $Cutoff })
if ($loose.Count -eq 0) {
  Write-Host '  （没有需要清理的）' -ForegroundColor DarkGray
} else {
  foreach ($f in $loose) {
    $rel = $f.FullName.Replace($Root + '\', '')
    if ($DryRun) {
      Write-Host ("  [预演] {0,-46} {1,10}" -f $rel, (Format-Size $f.Length)) -ForegroundColor DarkGray
      $script:FreedBytes += $f.Length; $script:FreedFiles++
    } else {
      try {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
        Write-Host ("  [清理] {0,-46} {1,10}" -f $rel, (Format-Size $f.Length)) -ForegroundColor Green
        $script:FreedBytes += $f.Length; $script:FreedFiles++
      } catch { [void]$script:Errors.Add("$rel — $($_.Exception.Message)") }
    }
  }
}

Write-Host ''
Write-Host '=================================================================='
if ($DryRun) {
  if ($script:FreedFiles -eq 0) {
    Write-Host '  预演结果：没有可清理的内容（缓存都是最近写入的）' -ForegroundColor Green
  } else {
    Write-Host ("  预演结果：可释放 {0}，共 {1} 个文件" -f (Format-Size $script:FreedBytes), $script:FreedFiles) -ForegroundColor Cyan
  }
  Write-Host '  去掉 -DryRun 即真正执行。' -ForegroundColor Cyan
} else {
  if ($script:FreedFiles -eq 0) {
    # ★ 2026-10-27：新装的包缓存都不到 KeepDays 天，或者浏览器/应用开着导致运行时缓存被跳过，
    #   这时报「已释放 0 KB」很像功能坏了。明确说清原因，别让用户以为清理失败。
    Write-Host '  这次没有需要清理的内容 —— 缓存都是最近写入的，或者被上面的「跳过」挡住了。' -ForegroundColor Green
  } else {
    Write-Host ("  已释放 {0}，删除 {1} 个文件" -f (Format-Size $script:FreedBytes), $script:FreedFiles) -ForegroundColor Cyan
  }
}
if ($script:Skipped.Count -gt 0) {
  Write-Host '  ── 跳过 ──' -ForegroundColor DarkGray
  foreach ($s in $script:Skipped) { Write-Host "    · $s" -ForegroundColor DarkGray }
}
if ($script:Errors.Count -gt 0) {
  Write-Host '  ── 失败 ──' -ForegroundColor Yellow
  foreach ($e in ($script:Errors | Select-Object -First 10)) { Write-Host "    · $e" -ForegroundColor Yellow }
}
Write-Host '=================================================================='
Write-Host ''

# 计划任务里跑的时候不要留下窗口
if (-not $DryRun -and $env:STUDY_BUDDY_CLEAN_QUIET -eq '1') { exit 0 }
