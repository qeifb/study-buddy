# 验证四个发布包的真实内容（不重新打包）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-packages.ps1
Add-Type -AssemblyName System.IO.Compression.FileSystem

$REL = 'E:\StudyBuddy-Release'
$script:fail = 0

function Check($cond, $msg) {
  if ($cond) { Write-Host "    OK   $msg" }
  else { Write-Host "    FAIL $msg"; $script:fail++ }
}
function CheckNot($cond, $msg) { Check (-not $cond) $msg }
# zip 条目名是反斜杠，统一转正斜杠再比
function Norm($s) { return ($s -replace '\\', '/') }

$CORE = @(
  'app/main.js','app/preload.js','app/package.json',
  'app/renderer/index.html','app/renderer/app.js','app/renderer/style.css',
  'app/extension/manifest.json','app/extension/auto-pilot.js',
  'app/extension/pilot-core.js','app/core/extserver.js',
  'create-shortcut.ps1','README.md','启动学习通学伴.cmd'
)

$specs = @(
  @{ zip='study-buddy.zip';            needElectron=$true;  needPython=$true;  needModel=$false; minMB=150; core=$CORE },
  @{ zip='study-buddy-offline.zip';    needElectron=$true;  needPython=$true;  needModel=$true;  minMB=1000; core=$CORE },
  @{ zip='study-buddy-lite.zip';       needElectron=$false; needPython=$false; needModel=$false; minMB=0.3; core=$CORE },
  @{ zip='study-buddy-focus-only.zip'; needElectron=$false; needPython=$false; needModel=$false; minMB=0.001; core=@('manifest.json','focus-mode.js'); needCmd=$false }
)

foreach ($s in $specs) {
  $p = Join-Path $REL $s.zip
  Write-Host ""
  Write-Host ("=== {0} ===" -f $s.zip)
  if (-not (Test-Path $p)) { Write-Host "    FAIL 文件不存在"; $script:fail++; continue }

  $sizeMB = (Get-Item $p).Length / 1MB
  Check ($sizeMB -ge $s.minMB) ("体积 {0:N2} MB >= {1} MB" -f $sizeMB, $s.minMB)

  $zf = [IO.Compression.ZipFile]::OpenRead($p)
  $names = @($zf.Entries | ForEach-Object { Norm $_.FullName })

  # 1. 启动脚本必须是新版（GBK 解码读内容）
  $cmdEntry = $zf.Entries | Where-Object { (Norm $_.FullName) -eq '启动学习通学伴.cmd' } | Select-Object -First 1
  if ($s.needCmd -eq $false) {
    CheckNot ([bool]$cmdEntry) '不含启动脚本（仅扩展包，符合预期）'
  } elseif ($cmdEntry) {
    $sr = New-Object IO.StreamReader($cmdEntry.Open(), [Text.Encoding]::GetEncoding(936))
    $cmdText = $sr.ReadToEnd(); $sr.Close()
    Check ($cmdText.Length -gt 1500) ("启动脚本 {0} 字节（新版 >1500）" -f $cmdText.Length)
    Check ($cmdText -match 'ELECTRON_EXE') '启动脚本含 ELECTRON_EXE 直启逻辑'
    CheckNot ($cmdText -match 'call npm start\s*(\r|\n|$)') '启动脚本已无 call npm start'
    Check ($cmdText -match 'start "" "%ELECTRON_EXE%"') '启动脚本用 start "" 启动 electron'
  } else {
    Check $false '启动学习通学伴.cmd 存在'
  }

  # 2. electron.exe
  $hasExe = $names -contains 'app/node_modules/electron/dist/electron.exe'
  if ($s.needElectron) {
    Check $hasExe '自带 app/node_modules/electron/dist/electron.exe（免装 Node）'
    $distN = @($names | Where-Object { $_ -like 'app/node_modules/electron/dist/*' }).Count
    Check ($distN -ge 70) ("electron/dist 文件数 {0} >= 70" -f $distN)
  } else {
    CheckNot $hasExe '不含 electron.exe（符合预期）'
  }

  # 3. 核心文件逐个存在
  $missing = @($s.core | Where-Object { $names -notcontains $_ })
  Check (@($missing).Count -eq 0) $(if (@($missing).Count -eq 0) { '核心文件齐全 (' + $s.core.Count + ' 个)' } else { '缺少: ' + ($missing -join ', ') })

  # 4. Python 转写环境（必须自包含：换机器/换盘符/换用户名都要能直接跑）
  #    0.6.0 事故教训：pyenv 只是个 venv，标准库和 DLLs 都留在开发机的
  #    C:\Users\xxx\AppData\Local\Programs\Python\Python314 里，换台机器 python 直接 exit 103。
  $hasPy = $names -contains 'tools/pyenv/Scripts/python.exe'
  if ($s.needPython) {
    Check $hasPy '含 tools/pyenv/Scripts/python.exe'
    # 4.1 解释器本体：Python 3.14 要求 pyvenv.cfg 的 home 目录里必须有 python.exe
    Check ($names -contains 'tools/pyenv/python.exe') 'pyenv 根目录含 python.exe（缺了换机器必 exit 103）'
    Check ($names -contains 'tools/pyenv/python314.dll') '含 python314.dll'
    Check (@($names | Where-Object { $_ -like 'tools/pyenv/DLLs/*.pyd' }).Count -ge 30) 'DLLs 扩展模块 >= 30 个'
    foreach ($pyd in @('_ssl', '_sqlite3', 'unicodedata', '_ctypes')) {
      Check ($names -contains "tools/pyenv/DLLs/$pyd.pyd") "DLLs 含 $pyd.pyd"
    }
    # 4.2 标准库必须在包内
    Check ($names -contains 'tools/pyenv/Lib/os.py') 'Lib 含标准库 os.py'
    Check ($names -contains 'tools/pyenv/Lib/encodings/__init__.py') 'Lib 含 encodings（缺了连 utf-8 都起不来）'
    Check ($names -contains 'tools/pyenv/Lib/sqlite3/__init__.py') 'Lib 含 sqlite3'
    Check ($names -contains 'tools/pyenv/Lib/json/__init__.py') 'Lib 含 json'
    # 4.3 pyvenv.cfg 的 home 不许指向开发机上的 Python 安装
    $cfgEntry = $zf.Entries | Where-Object { (Norm $_.FullName) -eq 'tools/pyenv/pyvenv.cfg' } | Select-Object -First 1
    if ($cfgEntry) {
      $sr3 = New-Object IO.StreamReader($cfgEntry.Open(), [Text.Encoding]::UTF8)
      $cfgText = $sr3.ReadToEnd(); $sr3.Close()
      $homeLine = @($cfgText -split "`r?`n" | Where-Object { $_ -match '^\s*home\s*=' })
      $homeVal = if (@($homeLine).Count -gt 0) { ($homeLine[0] -replace '^\s*home\s*=\s*', '').Trim() } else { '' }
      Check ($homeVal -ne '') 'pyvenv.cfg 有 home 行'
      Check (-not ($homeVal -match 'Programs\\Python|AppData\\Local')) ("pyvenv.cfg home 不指向开发机 Python（当前: $homeVal）")
    } else {
      Check $false 'pyvenv.cfg 存在'
    }
    # 4.4 Python 依赖齐不齐（缺哪个转写就打不开）
    foreach ($m in @('faster_whisper', 'ctranslate2', 'av', 'numpy', 'tokenizers', 'huggingface_hub', 'onnxruntime')) {
      Check ($names -contains "tools/pyenv/Lib/site-packages/$m/__init__.py") "site-packages 含 $m"
    }
  }
  else { CheckNot $hasPy '不含 pyenv（符合预期）' }

  # 5. 模型
  $hasModel = $names -contains 'tools/models/large-v3-turbo/model.bin'
  if ($s.needModel) { Check $hasModel '含 large-v3-turbo/model.bin' }
  else { CheckNot $hasModel '不含语音模型（符合预期）' }

  # 6. 绝不该出现的东西
  $bad = @()
  foreach ($n in $names) {
    if ($n -match '(^|/)settings\.json$')   { $bad += "settings.json" }
    elseif ($n -match '(^|/)chats\.json$')  { $bad += "chats.json" }
    elseif ($n -match '(^|/)course-logs/')  { $bad += "course-logs" }
    elseif ($n -match '(^|/)browser-profile/') { $bad += "browser-profile" }
    elseif ($n -match '\.log$')             { $bad += "日志" }
    elseif ($n -match 'site-packages/nvidia') { $bad += "nvidia" }
    elseif ($n -match '(^|/)_[^/]+\.(mjs|js|ps1|cmd)$') { $bad += "临时脚本" }
  }
  Check (@($bad).Count -eq 0) $(if (@($bad).Count -eq 0) { '无用户数据/日志/nvidia/临时脚本' } else { "发现 $($bad.Count) 个不该有的条目 ($(@($bad | Select-Object -Unique) -join ','))" })

  # 7. 明文 API Key 扫描（只扫文本、跳过 >2MB 的）
  $keyHit = @()
  foreach ($e in $zf.Entries) {
    $n = Norm $e.FullName
    if ($e.Length -gt 2MB) { continue }
    if ($n -notmatch '\.(js|mjs|cjs|json|md|py|ps1|cmd|html|css|txt|yml|yaml)$') { continue }
    try {
      $sr2 = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8)
      $t2 = $sr2.ReadToEnd(); $sr2.Close()
      if ($t2 -match 'sk-[A-Za-z0-9]{20,}') { $keyHit += $n }
    } catch { }
  }
  Check (@($keyHit).Count -eq 0) $(if (@($keyHit).Count -eq 0) { '无明文 API Key' } else { "疑似密钥: $(@($keyHit | Select-Object -First 3) -join ', ')" })

  Write-Host ("    条目数 " + $zf.Entries.Count)
  $zf.Dispose()
}

Write-Host ""
Write-Host ("=" * 60)
if ($script:fail -eq 0) { Write-Host "PASS 四个包全部验证通过" }
else { Write-Host "FAIL 共 $script:fail 项失败" }
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
