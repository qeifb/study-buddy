/**
 * 从「运行副本」打包完整版 study-buddy.zip（2026-10-26）
 *
 * 为什么单独写：repo/tools/pack-release.mjs 是从 repo/ 源码打包的，
 * 而 repo/ 里没有 pyenv / models / node_modules，
 * 打不出用户要的「解压即用」完整版。
 *
 * 打包源 = E:\StudyBuddy\（运行副本，用户明确要求过）
 *
 * 包含：app/（含 node_modules）+ tools/（含 pyenv，但不含 models/nvidia）
 *      + 根目录的 .cmd/.ps1/README
 * 排除：data/ runtime/ browser-profile/ cache/ dist/ repo/ archive/
 *      tools/models/（1.5GB 模型单独放离线版）
 *      tools/pyenv 里的 nvidia*（2GB，按需下载）
 *      docs/ publish/ 等源码目录
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'E:/StudyBuddy'
const OUT_DIR = 'E:/StudyBuddy-Release'

/* ★ 2026-10-27 用户要求：把各版本要压缩的内容摊成文件夹，由用户手动压缩。
 *   设 SB_PACK_MODE=folder 时，不再产 zip，而是在
 *   E:\StudyBuddy-Release\pack\<包名>\ 下放好该版本的完整文件树。
 *   白名单/排除规则与 zip 模式完全同源，不会出现「文件夹里多了/少了」的问题。 */
const FOLDER_MODE = process.env.SB_PACK_MODE === 'folder'
const PACK_DIR = path.join(OUT_DIR, 'pack')


/* ══════ 排除规则 ══════
 *
 * ★ 2026-10-26 修 bug：原先把 'dist' 放进「路径段排除」，
 *   结果把 app/node_modules/electron/dist/electron.exe（244MB，必需）排掉了。
 *   排除必须区分「顶层目录」和「任意层级」：
 *
 *   ① TOP_EXCLUDE：只匹配**一级目录名**（rel 的第一段）
 *      → data/ runtime/ dist/ cache/ 等用户数据与旧产物
 *   ② PATH_EXCLUDE：匹配**任意层级**（相对 TOOLS/APP 的完整路径前缀）
 *      → tools/models/、pyenv 里的 nvidia
 *   ③ NAME_EXCLUDE：任意层级的垃圾文件名/临时脚本
 */
const TOP_EXCLUDE = new Set([
  'data', 'runtime', 'browser-profile', 'cache', 'dist', 'repo', 'archive',
  'publish', 'docs', 'acl-recovery', '__stage', '.git',
  '.agent-teams', '.dsh-meow', 'node_modules',
])
/* 注意：node_modules 在**顶层**要排除（根目录没有），但 app/ 下必须保留 */

/* 需要排除的路径前缀（按包类型决定是否排除） */
const EXCLUDE_MODELS = 'tools/models/'
let SKIP_MODELS = true        /* 由包类型决定：offline 版要含模型 */

/* ★ 2026-10-27：极简版要带 tools/ 的脚本（transcribe.py / perf-bench.py /
 *   setup-transcribe.ps1），但不带 pyenv（那是它「首次运行自动装」的部分）。
 *   教训：极简版以前只打 app\，结果包里根本没有 tools\ 目录 ——
 *   启动脚本和设置页都让用户去双击 tools\setup-transcribe.ps1，
 *   而那个文件不存在，转写功能永远装不上。 */
let SKIP_PYENV = false

/* pyenv 里的 nvidia 组件（2GB，按需下载） */
const NV_RE = /(^|\/)tools\/pyenv\/Lib\/site-packages\/(nvidia\/|nvidia_[^/]*\.dist-info\/)/

/* 垃圾文件 */
/* 垃圾 + 第三方测试数据（不被运行时使用，可安全剔除以减小体积） */
const JUNK_RE = /(\.log$|\/Thumbs\.db$|\/desktop\.ini$|\.pyc$|\/_done\.flag$|__pycache__|\/site-packages\/[^/]+\/(?:lib|typing|random|_core|tests?)\/tests?\/|\/site-packages\/[^/]+\/tests?\/|\/site-packages\/[^/]+\/typing\/tests\/)/

/* ★ 2026-10-27：.speed-bench.json 是「打包这台机器」的实测速度缓存
 *   （CPU/GPU 每音频秒耗时）。催它进包会出事：
 *   transcribe.py 的缓存失效条件只看「模型名 + CPU 逻辑核数」，
 *   我这台是 Ryzen 5 5600（12 线程），用户那台正好也是 12 线程
 *   → 缓存被判定有效 → 拿 RTX 5060 Ti 的 GPU 速度去给用户机器分负载，
 *   分流比例完全错。必须排除，让目标机器首跑自己测（10~30 秒）。 */
const MACHINE_CACHE_RE = /\/\.speed-bench\.json$/





/* ══════════════════════════════════════════════════════════════
 * 可复用构建器（2026-10-26 扩展为一次产四包）
 *
 * opts: { outName, label, skipModels, topDirs, rootFiles, must, noAppNoModules }
 * ══════════════════════════════════════════════════════════════ */
function buildPackage(opts) {
  const { outName, label, skipModels, topDirs, rootFiles, must, excludeAppNodeModules, skipPyenv } = opts

  const files = []
  let skJunk = 0, skNv = 0, skMd = 0, skPy = 0

  function walkPkg(dir, rel = '') {
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name
      const abs = path.join(dir, it.name)
      const top = r.split('/')[0]
      if (r === top && TOP_EXCLUDE.has(top)) continue
      if (excludeAppNodeModules && /^app\/node_modules\//.test(r)) { skJunk++; continue }
      if (skipModels && r.startsWith(EXCLUDE_MODELS)) { skMd++; continue }
      if (skipPyenv && r.startsWith('tools/pyenv/')) { skPy++; continue }
      if (NV_RE.test('/' + r)) { skNv++; continue }
      if (MACHINE_CACHE_RE.test('/' + r)) { skJunk++; continue }
      if (JUNK_RE.test('/' + r)) { skJunk++; continue }
      if (/^_.*\.(mjs|js|cjs|txt|ps1|cmd)$/.test(it.name)) { skJunk++; continue }
      if (it.isDirectory()) walkPkg(abs, r)
      else {
        let size = 0
        try { size = fs.statSync(abs).size } catch { continue }
        files.push({ rel: r, abs, size })
      }
    }
  }

  for (const d of topDirs) {
    const p = path.join(ROOT, d)
    if (!fs.existsSync(p)) { console.log(`  ❌ 缺少目录 ${d}`); return null }
    walkPkg(p, d)
  }
  for (const f of rootFiles) {
    let p = path.join(ROOT, f)
    if (!fs.existsSync(p)) {
      const alt = path.join(ROOT, 'repo', f)
      if (fs.existsSync(alt)) p = alt
      else continue
    }
    files.push({ rel: f, abs: p, size: fs.statSync(p).size })
  }

  console.log('')
  console.log('═'.repeat(60))
  console.log(`=== ${label} (${outName}) ===`)
  console.log(`  收录 ${files.length} 文件，跳过 junk=${skJunk} nvidia=${skNv} models=${skMd} pyenv=${skPy}`)

  /* 关键文件 */
  let mustFail = 0
  for (const m of must) {
    const hit = files.find((x) => x.rel === m)
    if (!hit) { console.log(`  ❌ 缺 ${m}`); mustFail++ }
  }
  if (mustFail) { console.log('  ❌ 关键文件缺失，跳过'); return null }

  /* 危险闸门 */
  const DANGER2 = [
    [/^data\//, 'data'], [/^app\/data\//, 'app/data'], [/^app\/_data\//, 'app/_data'],
    [/^settings\.json$/, 'settings'], [/^app\/settings\.json$/, 'app settings'],
    [/^chats\.json$/, 'chats'], [/^app\/chats\.json$/, 'app chats'],
    [/^app\.log$/, 'app.log'], [/^app\/app\.log$/, 'app app.log'],
    [/^course-logs\//, 'course-logs'], [/^runtime\//, 'runtime'], [/^browser-profile\//, 'browser-profile'],
  ]
  let danger = 0
  for (const f of files) {
    for (const [re, lb] of DANGER2) { if (re.test(f.rel)) { console.log(`  ❌ ${lb}: ${f.rel}`); danger++ } }
  }
  if (danger) { console.log('  ❌ 检出用户数据，跳过'); return null }

  /* 明文 Key */
  let keyHit = 0
  for (const f of files) {
    if (f.size > 2 * 1024 * 1024) continue
    if (!/\.(js|mjs|cjs|json|md|py|ps1|cmd|html|css|txt)$/i.test(f.rel)) continue
    try { if (/sk-[A-Za-z0-9]{20,}/.test(fs.readFileSync(f.abs, 'utf8'))) { console.log(`  ❌ Key: ${f.rel}`); keyHit++ } } catch { }
  }
  if (keyHit) { console.log('  ❌ 检出明文密钥，跳过'); return null }

  const total = files.reduce((a, x) => a + x.size, 0)
  console.log(`  体积 ${(total / 1048576).toFixed(1)} MB`)

  /* ── 文件夹模式：只摊文件，不压缩（用户手动压） ── */
  if (FOLDER_MODE) {
    const dirName = outName.replace(/\.zip$/, '')
    const dstRoot = path.join(PACK_DIR, dirName)
    fs.rmSync(dstRoot, { recursive: true, force: true })
    fs.mkdirSync(dstRoot, { recursive: true })
    for (const f of files) {
      const dst = path.join(dstRoot, f.rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(f.abs, dst)
    }
    /* 读回验证：直接走文件系统，比解 zip 更可靠 */
    const got = []
    const walkDst = (d, base) => {
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = base ? base + '/' + it.name : it.name
        if (it.isDirectory()) walkDst(path.join(d, it.name), rel)
        else got.push(rel)
      }
    }
    walkDst(dstRoot, '')
    let fFail = 0
    const fTotal = got.reduce((a, r) => a + fs.statSync(path.join(dstRoot, r)).size, 0)
    if (got.length !== files.length) { console.log(`  ❌ 落地 ${got.length} ≠ 期望 ${files.length}`); fFail++ }
    for (const m of must) { if (!got.includes(m)) { console.log(`  ❌ 目录内缺 ${m}`); fFail++ } }
    const nvDir = got.filter((e) => NV_RE.test('/' + e))
    if (nvDir.length) { console.log(`  ❌ 目录内 nvidia ${nvDir.length} 个`); fFail++ }
    if (skipModels) {
      const mdIn = got.filter((e) => /^tools\/models\//.test(e))
      if (mdIn.length) { console.log(`  ❌ 目录内不应有 models: ${mdIn.length}`); fFail++ }
    } else {
      const mdIn = got.filter((e) => /^tools\/models\/large-v3-turbo\/model\.bin$/.test(e))
      if (!mdIn.length) { console.log('  ❌ 离线版缺 model.bin'); fFail++ }
    }
    console.log(`  ✅ ${dirName}\\  ${(fTotal / 1048576).toFixed(2)} MB  ${got.length} 文件`)
    console.log(fFail === 0 ? '  ✅ 落地校验通过' : `  ❌ 落地校验失败 ${fFail} 项`)
    return { name: dirName + '/', size: fTotal, sha256: '', files: got.length, ok: fFail === 0 }
  }

  /* 打包 */
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const zipPath = path.join(OUT_DIR, outName)
  try { fs.unlinkSync(zipPath) } catch { }
  const stage = path.join(ROOT, '__stage_' + outName.replace(/\.zip$/, '') + '_' + Date.now())
  fs.rmSync(stage, { recursive: true, force: true })
  console.log('  压缩中…')

  try {
    for (const f of files) {
      const dst = path.join(stage, f.rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(f.abs, dst)
    }
    /* ★ 2026-10-27 改：CreateFromDirectory 在 Windows 上写的是反斜杠条目名，
     *   不符合 ZIP 规范（应用正斜杠），改用 tools/zip-slash.ps1 显式写正斜杠。 */
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'zip-slash.ps1'),
      '-Src', stage, '-Dst', zipPath,
    ], { encoding: 'utf8', stdio: 'pipe' })  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }

  const buf = fs.readFileSync(zipPath)
  const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
  console.log(`  ✅ ${outName}  ${(buf.length / 1048576).toFixed(2)} MB  ${files.length} 文件`)
  console.log(`     SHA256: ${sha}`)

  /* 读回验证 */
  /* ★ 2026-10-27 修：zip 条目名是反斜杠（Windows ZipFile 行为），且中文名
   *   经 PowerShell → Node 会因输出编码错乱，导致「包内缺 启动学习通学伴.cmd」假阴性。
   *   这里显式把 PowerShell 的输出编码设成 UTF-8，读回后再统一分隔符。 */
  const ps2 = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/\//g, '\\')}')`,
    '$z.Entries | ForEach-Object { $_.FullName }',
    '$z.Dispose()',
  ].join('\n')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps2], { encoding: 'utf8' })
  const entries = out.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean)
    .map((e) => { const s = e.split('/'); return (s.length > 1 && /^__stage_/.test(s[0])) ? s.slice(1).join('/') : e })

  let vFail = 0
  if (entries.length !== files.length) { console.log(`  ❌ 条目 ${entries.length} ≠ 期望 ${files.length}`); vFail++ }
  for (const m of must) { if (!entries.includes(m)) { console.log(`  ❌ 包内缺 ${m}`); vFail++ } }
  const nvIn = entries.filter((e) => NV_RE.test('/' + e))
  if (nvIn.length) { console.log(`  ❌ 包内 nvidia ${nvIn.length} 个`); vFail++ }
  if (skipModels) {
    const mdIn = entries.filter((e) => /^tools\/models\//.test(e))
    if (mdIn.length) { console.log(`  ❌ 包内不应有 models: ${mdIn.length}`); vFail++ }
  } else {
    const mdIn = entries.filter((e) => /^tools\/models\/large-v3-turbo\/model\.bin$/.test(e))
    if (!mdIn.length) { console.log('  ❌ 离线版缺 model.bin'); vFail++ }
  }

  console.log(vFail === 0 ? '  ✅ 读回验证通过' : `  ❌ 读回验证失败 ${vFail} 项`)
  return { name: outName, size: buf.length, sha256: sha, files: files.length, ok: vFail === 0 }
}

/* ══════════════════════════════════════════════════════════════════
 * 一次产出四个包（2026-10-26 用户要求「把所有包都打包好，包含有模型的」）
 *
 *   ① study-buddy.zip            完整版  app + tools(pyenv) + 根文件       ≈239MB
 *   ② study-buddy-offline.zip    离线版  完整版 + tools/models            ≈1.7GB
 *   ③ study-buddy-lite.zip       极简版  纯源码（无 electron/pyenv/models） ≈0.8MB
 *   ④ study-buddy-focus-only.zip 仅扩展  extension-focus-only 两文件        ≈5KB
 * ══════════════════════════════════════════════════════════════════ */

const RESULTS = []

console.log('')
console.log('█'.repeat(60))
console.log('  产出四个包')
console.log('█'.repeat(60))

/* ── ① 完整版 ── */
{
  const r = buildPackage({
    outName: 'study-buddy.zip',
    label: '完整版（app + pyenv，含模型需联网下载）',
    skipModels: true,
    topDirs: ['app', 'tools'],
    rootFiles: ['README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1',
      'clean-cache.ps1', '启动学习通学伴.cmd', '创建快捷方式.cmd'],
    must: [
      'app/main.js', 'app/preload.js', 'app/package.json',
      'app/renderer/index.html', 'app/renderer/app.js', 'app/renderer/style.css',
      'app/extension/manifest.json', 'app/extension/auto-pilot.js', 'app/extension/pilot-core.js',
      'app/node_modules/electron/package.json',
      /* ★ 必须校验 electron.exe 本体。
       * 教训（2026-10-26）：只校验了 electron/package.json，dist/electron.exe 丢了没人发现，
       * 结果用户机器没有 npm，`call npm start` 直接报「'npm' 不是内部或外部命令」，应用起不来。 */
      'app/node_modules/electron/dist/electron.exe',
      'tools/transcribe.py', 'tools/perf-bench.py', 'tools/setup-transcribe.ps1',
      /* ★ pyenv 必须自包含（2026-10-27 事故：只带 site-packages 的 venv，
       * 换机器后 python.exe 找不到标准库/DLL 直接 exit 103，
       * 用户看到「测试音频生成失败：Command failed: ...」完全没法查） */
      'tools/pyenv/Scripts/python.exe',
      'tools/pyenv/python.exe',
      'tools/pyenv/python314.dll',
      'tools/pyenv/Lib/encodings/__init__.py',
      'tools/pyenv/DLLs/_socket.pyd',
      'tools/pyenv/pyvenv.cfg',
      'create-shortcut.ps1', '启动学习通学伴.cmd', 'README.md',
    ],
  })
  if (r) {
    RESULTS.push(r)
    /* ★ 顺手把「这一版的可补丁文件清单」留档：下次生成补丁只需要它 + 新包，
     * 不必再保存旧的完整包（238MB）。同名清单已存在时不覆盖，
     * 避免一次忘改版本号就把基线冲掉。 */
    try {
      const { manifestFromZip } = await import('./patch-lib.mjs')
      const m = await manifestFromZip(path.join(OUT_DIR, 'study-buddy.zip'))
      const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/package.json'), 'utf8')).version
      const mf = path.join(OUT_DIR, `manifest-${ver}.json`)
      if (fs.existsSync(mf)) {
        console.log(`  [留档] manifest-${ver}.json 已存在，不覆盖（保持基线）`)
      } else {
        fs.writeFileSync(mf, JSON.stringify(m, null, 2), 'utf8')
        console.log(`  [留档] 已写 manifest-${ver}.json（${m.fileCount} 文件）供下次生成补丁用`)
      }
    } catch (e) {
      console.log('  [留档] 清单留档失败（不影响打包）：' + e.message)
    }
  }
}

/* ── ② 离线版（含 models）── */
{
  const r = buildPackage({
    outName: 'study-buddy-offline.zip',
    label: '离线版（完整版 + 语音模型，解压即用不联网）',
    skipModels: false,
    topDirs: ['app', 'tools'],
    rootFiles: ['README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1',
      'clean-cache.ps1', '启动学习通学伴.cmd', '创建快捷方式.cmd'],
    must: [
      'app/main.js', 'app/renderer/app.js', 'app/extension/manifest.json',
      'app/node_modules/electron/package.json',
      'app/node_modules/electron/dist/electron.exe',
      'tools/transcribe.py', 'tools/perf-bench.py', 'tools/pyenv/Scripts/python.exe',
      /* 同上：pyenv 自包含四件套，缺一个换机器就起不来 */
      'tools/pyenv/python.exe',
      'tools/pyenv/python314.dll',
      'tools/pyenv/Lib/encodings/__init__.py',
      'tools/pyenv/DLLs/_socket.pyd',
      'tools/pyenv/pyvenv.cfg',
      'tools/models/large-v3-turbo/model.bin',
      'create-shortcut.ps1', 'README.md',
    ],
  })
  if (r) RESULTS.push(r)
}

/* ── ③ 极简版（纯源码，无运行时）── */
{
  const r = buildPackage({
    outName: 'study-buddy-lite.zip',
    label: '极简版（纯源码，首次运行自动装 Node/Electron/Python/模型）',
    skipModels: true,
    skipPyenv: true,            /* ★ 带 tools\*.py/ps1，但不带 pyenv（首次运行现装） */
    excludeAppNodeModules: true,
    topDirs: ['app', 'tools'],
    rootFiles: ['README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1',
      'clean-cache.ps1', '启动学习通学伴.cmd', '创建快捷方式.cmd'],
    must: [
      'app/main.js', 'app/preload.js', 'app/package.json',
      'app/renderer/index.html', 'app/renderer/app.js', 'app/renderer/style.css',
      'app/extension/manifest.json', 'app/extension/auto-pilot.js',
      /* ★ 极简版必须带这三个：启动脚本和设置页都指向 tools\setup-transcribe.ps1，
       *   缺了它转写环境永远装不上（2026-10-27 发现） */
      'tools/transcribe.py', 'tools/perf-bench.py', 'tools/setup-transcribe.ps1',
      '启动学习通学伴.cmd', 'README.md',
    ],
  })
  if (r) RESULTS.push(r)
}

/* ── ④ 仅扩展（focus-only，zip 内不带目录前缀）── */
{
  const label = '仅扩展 study-buddy-focus-only.zip'
  const outName = 'study-buddy-focus-only.zip'
  const FOC = path.join(ROOT, 'repo', 'extension-focus-only')
  console.log('')
  console.log('═'.repeat(60))
  console.log(`=== ${label} ===`)

  if (!fs.existsSync(FOC)) {
    console.log('  ❌ repo/extension-focus-only 不存在')
  } else if (FOLDER_MODE) {
    /* 文件夹模式：直接摊到 pack\study-buddy-focus-only\ */
    const focFiles = fs.readdirSync(FOC, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
    const dirName = outName.replace(/\.zip$/, '')
    const dstRoot = path.join(PACK_DIR, dirName)
    fs.rmSync(dstRoot, { recursive: true, force: true })
    fs.mkdirSync(dstRoot, { recursive: true })
    let focTotal = 0
    for (const f of focFiles) {
      fs.copyFileSync(path.join(FOC, f), path.join(dstRoot, f))
      focTotal += fs.statSync(path.join(FOC, f)).size
    }
    const gotFoc = fs.readdirSync(dstRoot).sort()
    const okFoc = gotFoc.length === focFiles.length && focFiles.every((f) => gotFoc.includes(f))
    console.log(`  文件: ${focFiles.join(', ')}`)
    console.log(`  ✅ ${dirName}\\  ${(focTotal / 1024).toFixed(1)} KB  ${gotFoc.length} 文件`)
    console.log(okFoc ? '  ✅ 落地校验通过' : '  ❌ 落地校验失败')
    RESULTS.push({ name: dirName + '/', size: focTotal, sha256: '', files: gotFoc.length, ok: okFoc })
  } else {
    const focFiles = fs.readdirSync(FOC, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
    console.log(`  文件: ${focFiles.join(', ')}`)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const zipPath = path.join(OUT_DIR, outName)
    try { fs.unlinkSync(zipPath) } catch { }
    const stage = path.join(ROOT, '__stage_foc_' + Date.now())
    fs.rmSync(stage, { recursive: true, force: true })
    try {
      fs.mkdirSync(stage, { recursive: true })
      for (const f of focFiles) fs.copyFileSync(path.join(FOC, f), path.join(stage, f))
      execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'zip-slash.ps1'),
        '-Src', stage, '-Dst', zipPath,
      ], { encoding: 'utf8', stdio: 'pipe' })
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }

    const buf = fs.readFileSync(zipPath)
    const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
    console.log(`  ✅ ${outName}  ${(buf.length / 1024).toFixed(1)} KB  ${focFiles.length} 文件`)
    console.log(`     SHA256: ${sha}`)
    RESULTS.push({ name: outName, size: buf.length, sha256: sha, files: focFiles.length, ok: true })
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════ */
console.log('')
console.log('█'.repeat(60))
console.log('  四个包汇总')
console.log('█'.repeat(60))
console.log('')
console.log('  ' + '包名'.padEnd(30) + '大小'.padStart(12) + '  文件数  状态')
console.log('  ' + '─'.repeat(66))
let allOk = true
for (const r of RESULTS) {
  const mb = r.size >= 1048576 ? (r.size / 1048576).toFixed(2) + ' MB' : (r.size / 1024).toFixed(1) + ' KB'
  console.log(`  ${r.name.padEnd(30)}${mb.padStart(12)}  ${String(r.files).padStart(6)}  ${r.ok ? '✅' : '❌'}`)
  if (!r.ok) allOk = false
}
console.log('')
for (const r of RESULTS) {
  if (r.name.endsWith('/')) console.log(`  ${r.name}  （文件夹，无 SHA256）`)
  else console.log(`  ${r.name}\n    SHA256 ${r.sha256}`)
}

/* 写 meta */
const meta = {
  builtAt: new Date().toISOString(),
  mode: FOLDER_MODE ? 'folder' : 'zip',
  packages: RESULTS,
  note: FOLDER_MODE
    ? 'folder 模式：各版本文件已摊到 E:/StudyBuddy-Release/pack/<包名>/，由用户手动压缩；白名单与 zip 模式同源'
    : '四包均由 tools/pack-full.mjs 从运行副本 E:/StudyBuddy 打包；nvidia 组件按需下载，不随包',
}
fs.writeFileSync(path.join(OUT_DIR, FOLDER_MODE ? '_pack-folders-meta.json' : '_release-meta.json'), JSON.stringify(meta, null, 2), 'utf8')
console.log('')
console.log(`  ✅ ${FOLDER_MODE ? '_pack-folders-meta.json' : '_release-meta.json'} 已写入`)

console.log('')
console.log(allOk ? '✅ 四包全部通过 readback 验证' : '❌ 有包未通过验证，请检查上方日志')
process.exit(allOk ? 0 : 1)
