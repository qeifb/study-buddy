/**
 * 打包发布产物：dist/study-buddy.zip + dist/study-buddy-focus-only.zip
 *
 * 用法：
 *   node tools/pack-release.mjs
 *
 * 设计要点（2026-10-24 用户踩坑后修订）：
 *
 *  ⚠️ 核心变更：**完整版 zip 不再包含 extension-focus-only/**
 *     原来完整版包里同时放了 app/extension（13 文件）和 extension-focus-only（2 文件），
 *     用户解压后看到两个「扩展目录」，很自然地点了名字更短的那个，
 *     结果装上的是「学习通防暂停 1.0.0」而不是「学习通学伴 0.5.0」，
 *     然后反馈「装上去怎么就那么少」「只有防暂停」。
 *     现在：完整版只含完整应用；小扩展单独一个 zip。
 *
 *  另：打包后必须**读回 zip 条目验证**，不能只看文件大小。
 *     · 关键文件是否在、大小是否非 0
 *     · 危险文件（node_modules/data/settings.json/.log）是否混入
 *     · 完整版里是否还残留 extension-focus-only/
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const REPO = path.join(ROOT, 'repo')
const DIST = path.join(ROOT, 'dist')

const EXCLUDE_DIRS = new Set(['node_modules', 'data', 'runtime', 'browser-profile', '.git', 'pyenv', 'models', '__pycache__'])

/** 递归收集文件，返回 repo 相对路径（正斜杠） */
function walk(dir, rel = '', out = []) {
  let items = []
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    const r = rel ? rel + '/' + it.name : it.name
    if (EXCLUDE_DIRS.has(it.name)) continue
    if (/^_.*\.(mjs|js|txt|cmd)$/.test(it.name)) continue   // 临时脚本
    if (/\.log$/.test(it.name)) continue
    if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(it.name)) continue
    if (it.isDirectory()) walk(path.join(dir, it.name), r, out)
    else out.push(r)
  }
  return out
}

// ── 1. 完整版文件清单 ──
const MAIN_TOP = ['app', 'docs', 'tools']
const MAIN_ROOT_FILES = [
'README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1', '启动学习通学伴.cmd',
'创建快捷方式.cmd',
  'clean-cache.ps1',
]
// ★ 白名单不再手写：自动收录 repo/tools 下所有 .mjs 与指定非脚本文件。
// 历史教训：手动维护名单漏了 3 次（check-all / pack-release / verify-release），
// 每次都是打包后才发现 tools 不全。改为自动扫描，永远不会漏。
const TOOLS_FIXED = ['tools/transcribe.py', 'tools/setup-transcribe.ps1']
const TOOLS_ALLOW = (() => {
  const list = [...TOOLS_FIXED]
  const dir = path.join(ROOT, 'repo', 'tools')
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.mjs')) list.push('tools/' + f)
    }
  }
  return [...new Set(list)].sort()
})()

const allRepoFiles = walk(REPO)
const mainFiles = allRepoFiles.filter((f) => {
  const top = f.split('/')[0]
  // ★ 关键：排除 extension-focus-only（它单独打包，不进完整版）
  if (top === 'extension-focus-only') return false
  if (f.startsWith('tools/')) return TOOLS_ALLOW.includes(f)
  return MAIN_TOP.includes(top) || MAIN_ROOT_FILES.includes(f)
})

console.log('=== 完整版文件清单 ===')
console.log('  文件数:', mainFiles.length)
const groups = {}
for (const f of mainFiles) {
  const t = f.split('/')[0]
  groups[t] = (groups[t] || 0) + 1
}
for (const [k, v] of Object.entries(groups).sort()) console.log(`    ${k.padEnd(16)} ${v} 项`)

// 必须存在的关键文件
const MUST = [
  'app/main.js',
  'app/preload.js',
  'app/package.json',
  'app/renderer/app.js',
  'app/extension/manifest.json',
  'app/extension/content.js',
  'app/extension/focus-mode.js',
  'app/extension/auto-pilot.js',
  'app/extension/pilot-core.js',
  'app/extension/cand-chars.js',
  'app/extension/font-table.js',
  'app/extension/typr-lite.js',
  'app/extension/md5-mini.js',
  'THIRD-PARTY.md',
  'README.md',
  'tools/build-font-table.mjs',
]
console.log('')
console.log('=== 关键文件检查 ===')
let missing = 0
for (const m of MUST) {
  const ok = mainFiles.includes(m)
  if (!ok) missing++
  console.log(`  ${ok ? '✅' : '❌'} ${m}`)
}
if (missing) {
  console.error(`\n❌ 缺 ${missing} 个关键文件，中止打包`)
  process.exit(1)
}

// 危险检查
console.log('')
console.log('=== 危险内容检查 ===')
const DANGER = [
  [/node_modules/, 'node_modules'],
  [/^data\//, 'data/'],
  [/runtime\//, 'runtime'],
  [/browser-profile/, 'browser-profile'],
  [/pyenv|tools\/models/, 'pyenv/models'],
  [/settings\.json/, 'settings.json'],
  [/(^|\/)_[^/]+\.(mjs|js)$/, '临时脚本'],
  [/\.log$/, '日志'],
  [/^extension-focus-only\//, 'extension-focus-only（完整版不应包含）'],
]
let dirty = 0
for (const [re, name] of DANGER) {
  const hit = mainFiles.filter((f) => re.test(f))
  if (hit.length) { dirty++; console.log(`  ❌ ${name}: ${hit.length} 个`); hit.slice(0, 3).forEach((h) => console.log('      ' + h)) }
  else console.log(`  ✅ ${name}: 无`)
}
if (dirty) {
  console.error('\n❌ 有危险内容，中止')
  process.exit(1)
}

// ── 2. 打包函数 ──
function buildZip(files, outName, baseDir, label) {
  // baseDir 可以是单个目录，也可以是「多个候选目录」数组——
  // 离线版需要把 repo/（源码）与 <root>/tools/models（模型）拼在一起。
  const bases = Array.isArray(baseDir) ? baseDir : [baseDir]
  const stage = path.join(ROOT, '__stage_' + Date.now())
  fs.rmSync(stage, { recursive: true, force: true })
  let missing = []
  for (const f of files) {
    const src = bases.map((b) => path.join(b, f)).find((p) => fs.existsSync(p))
    if (!src) { missing.push(f); continue }
    const dst = path.join(stage, f)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  if (missing.length) {
    console.error('❌ 打包缺少文件（在所有候选目录里都没找到）:')
    missing.slice(0, 10).forEach((x) => console.error('   ' + x))
    fs.rmSync(stage, { recursive: true, force: true })
    process.exit(1)
  }

  const zipPath = path.join(DIST, outName)
  try { fs.unlinkSync(zipPath) } catch { /* ignore */ }

  /* ★ 2026-10-27 改：CreateFromDirectory 在 Windows 上写反斜杠条目名，不符合 ZIP 规范，
   *   改用 tools/zip-slash.ps1 显式写正斜杠。 */
  try {
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'zip-slash.ps1'),
      '-Src', stage, '-Dst', zipPath,
    ], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    console.error(`❌ ${label} 打包失败:`, e.message.slice(0, 300))
    process.exit(1)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }

  const buf = fs.readFileSync(zipPath)
  const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
  console.log('')
  console.log(`✅ ${label}`)
  console.log(`   ${zipPath}`)
  console.log(`   大小: ${buf.length} 字节 (${(buf.length / 1024).toFixed(1)}KB)`)
  console.log(`   SHA256: ${sha}`)
  console.log(`   文件数: ${files.length}`)
  return { name: outName, size: buf.length, sha256: sha, files: files.length }
}

// ── 3. 打包 ──
console.log('')
console.log('=== 打包 ===')
const mainMeta = buildZip(mainFiles, 'study-buddy.zip', REPO, '完整版 study-buddy.zip')

// focus-only：从 repo/extension-focus-only 打包，**zip 内不带目录前缀**（解压即扩展目录）
const FOC = path.join(REPO, 'extension-focus-only')
const focFiles = fs.readdirSync(FOC, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
console.log('')
console.log('=== focus-only 文件 ===')
for (const f of focFiles) console.log(`  ${f}  ${fs.statSync(path.join(FOC, f)).size} 字节`)

const focMeta = buildZip(focFiles, 'study-buddy-focus-only.zip', FOC, '小扩展 study-buddy-focus-only.zip')

// ── 4. 读回验证 ──
console.log('')
console.log('=== 读回验证（不能只看大小）===')
function verifyZip(zipName, expect) {
  const zipPath = path.join(DIST, zipName)
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/\//g, '\\')}')`,
    '$z.Entries | ForEach-Object { $_.FullName + "|" + $_.Length }',
    '$z.Dispose()',
  ].join('\n')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const entries = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.lastIndexOf('|')
    return { name: l.slice(0, i).replace(/\\/g, '/'), size: Number(l.slice(i + 1)) }
  })

  console.log('')
  console.log(`--- ${zipName} ---`)
  console.log(`  条目数: ${entries.length}（期望 ${expect.count}）${entries.length === expect.count ? ' ✅' : ' ❌'}`)

  // ═══════════════════════════════════════════════════════════════════
  // ★ 产物级敏感数据闸门（2026-10-25 因用户报「能看到我的 API 配置」而加）
  // 检查的是**最终 zip 产物**，不是 repo 源目录——两者不等价。
  // 命中任何用户数据就直接失败，绝不发布。
  // ═══════════════════════════════════════════════════════════════════
  {
    // ★ 用「任意层级」匹配（/? 而不是 ^），否则 app/data/settings.json、
  //   tools/models/x/model.bin 这类带前缀的会漏掉（上一版实测 11 个用例漏 4 个）。
  const SENSITIVE = [
    [/(^|\/)data\//, 'data 目录（settings/chats/course-logs/app.log）'],
    [/(^|\/)settings\.json$/, '用户设置（含明文 API Key）'],
    [/(^|\/)chats\.json$/, '聊天记录'],
    [/(^|\/)quiz-evidence\.json$/, '答题依据留档'],
    [/(^|\/)app\.log$/, '应用日志（可能含用户提问原文）'],
    [/(^|\/)course-logs\//, '课程文字稿'],
    [/(^|\/)runtime\//, 'Electron userData'],
    [/(^|\/)browser-profile\//, '浏览器登录态'],
    [/(^|\/)node_modules\//, '依赖'],
    [/(^|\/)pyenv\//, 'Python 虚拟环境'],
    // models/ 仅在离线版允许（expect.allowModels）
    ...(expect.allowModels ? [] : [[/(^|\/)models\//, '语音模型']]),
    [/(^|\/)electron-cache\//, 'Electron 缓存'],
    [/(^|\/)npm-cache\//, 'npm 缓存'],
    [/(^|\/)_done\.flag$/, '临时标记文件'],
    [/(^|\/)node-download\.zip$/, '下载的安装包'],
  ]
    console.log('')
    console.log('--- 产物级敏感数据检查（硬闸门）---')
    const hitNames = []
    const ALLOW = expect.allow || []
    for (const e of entries) {
      if (ALLOW.some((re) => re.test(String(e.name || e).replace(/\\/g, '/')))) continue
      const n = String(e.name || e).replace(/\\/g, '/')
      for (const [re] of SENSITIVE) { if (re.test(n)) { hitNames.push(n); break } }
    }
    if (hitNames.length) {
      console.log('  ❌ 混入用户数据/生成物:')
      hitNames.slice(0, 20).forEach((x) => console.log('       ' + x))
      console.log('')
      console.log('  【严重】这会把开发者本机配置（含明文 API Key）泄露给所有下载者。')
      console.log('  请检查收集白名单后重试。')
      process.exit(1)
    }
    // ★ 动态文案：不能硬编码「无 xxx」，否则离线版含 models/ 时也是这句，误导人
    {
      const hasModels = entries.some((e) => /(^|\/)models\//.test(String(e.name || e).replace(/\\/g, '/')))
      console.log('  ✅ 无 data/ settings.json chats.json quiz-evidence.json app.log')
      console.log('  ✅ 无 runtime/ browser-profile/ node_modules/ pyenv/')
      console.log(hasModels
        ? '  ✅ 含 models/（离线版特性，已在 allow 白名单内放行）'
        : '  ✅ 无 models/')
    }
  }


  let ok = entries.length === expect.count
  for (const m of expect.must) {
    const e = entries.find((x) => x.name === m)
    if (!e || e.size === 0) { ok = false; console.log(`  ❌ 缺/空: ${m}`) }
  }
  for (const re of expect.mustNot || []) {
    const hit = entries.filter((e) => re.test(e.name))
    if (hit.length) { ok = false; console.log(`  ❌ 不该有: ${hit.slice(0, 3).map((h) => h.name).join(', ')}`) }
  }
  console.log(ok ? '  ✅ 验证通过' : '  ❌ 验证失败')
  return ok
}

const okMain = verifyZip('study-buddy.zip', {
  count: mainFiles.length,
  must: ['app/extension/manifest.json', 'app/extension/auto-pilot.js', 'app/extension/font-table.js',
    'app/main.js', 'README.md', 'THIRD-PARTY.md'],
  mustNot: [/^extension-focus-only\//, /node_modules/, /^data\//, /settings\.json/],
})

const okFoc = verifyZip('study-buddy-focus-only.zip', {
  count: focFiles.length,
  must: ['manifest.json', 'focus-mode.js'],
  mustNot: [/^extension-focus-only\//],
})

// ── 5. 写元数据 ──
// 元数据改到文件末尾写（因为 offlineMeta 在下面才生成）

// ═══════════════════════════════════════════════════════════════════
// 离线版（模型随包）—— study-buddy-offline.zip
//
// 目的：用户不想/不能联网下载 1.5GB 模型时，直接用这个包。
//
// ★ 只打模型，不打 pyenv：pyvenv.cfg 里硬编码了开发机基础 Python 的绝对路径
//   （home = C:\Users\xxx\...\Python314），换机器解压必然失效。
//   模型是纯数据文件，可以随便搬。
// ═══════════════════════════════════════════════════════════════════
console.log('')
console.log('=== 构建离线版（模型随包）===')

const MODEL_NAME = 'large-v3-turbo'
// 模型在「运行副本」<root>/tools/models 下（repo/ 故意不含模型，避免进 git）
// 若该目录不存在，退回到 repo/tools/models（理论上不会有）
const MODEL_CANDIDATES = [
  path.join(ROOT, 'tools', 'models', MODEL_NAME),
  path.join(REPO, 'tools', 'models', MODEL_NAME),
]
const modelDir = MODEL_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'model.bin'))) ||
  MODEL_CANDIDATES[0]
let offlineMeta = null
let okOffline = true

if (!fs.existsSync(path.join(modelDir, 'model.bin'))) {
  console.log('  ⚠️ 跳过：本机没有 ' + path.join(modelDir, 'model.bin'))
  console.log('     离线版需要开发机先跑过一次转写环境安装。')
} else {
  const modelFiles = fs.readdirSync(modelDir).filter((f) => fs.statSync(path.join(modelDir, f)).isFile())
  let modelBytes = 0
  for (const f of modelFiles) modelBytes += fs.statSync(path.join(modelDir, f)).size
  console.log('  模型 ' + MODEL_NAME + ': ' + modelFiles.length + ' 文件  ' + (modelBytes / 1048576).toFixed(0) + 'MB')

  const offlineFiles = [
    ...mainFiles,
    ...modelFiles.map((f) => 'tools/models/' + MODEL_NAME + '/' + f),
  ]
  console.log('  合计文件: ' + offlineFiles.length)

  // 多数文件来自 repo/，模型来自 <root>/tools/models
  offlineMeta = buildZip(
    offlineFiles,
    'study-buddy-offline.zip',
    [REPO, ROOT],
    '离线版（含模型）'
  )

  // 用同一套 verifyZip，通过 allow 白名单放行 tools/models/
  okOffline = verifyZip('study-buddy-offline.zip', {
    count: offlineFiles.length,
    must: [
      'tools/models/' + MODEL_NAME + '/model.bin',
      'tools/models/' + MODEL_NAME + '/tokenizer.json',
      'tools/transcribe.py',
      'tools/setup-transcribe.ps1',
      '启动学习通学伴.cmd',
    ],
    mustNot: [/^data\//, /pyenv\//, /node_modules\//, /^runtime\//, /browser-profile\//],
    allowModels: true,
    allow: [/(^|\/)models\//],
  })

  if (!okOffline) {
    console.log('')
    console.log('  ❌ 离线版验证失败')
  }
}

// ── 6. 汇总 ──
console.log('')
// ── 写元数据（此时 mainMeta / focMeta / offlineMeta 都已就绪）──
fs.writeFileSync(path.join(DIST, '_release-meta.json'), JSON.stringify({
  mainZip: mainMeta,
  focusZip: focMeta,
  offlineZip: offlineMeta || null,
  builtAt: new Date().toISOString(),
}, null, 2), 'utf8')

console.log('=== 汇总 ===')
console.log(okMain ? '  ✅ study-buddy.zip（无模型版）' : '  ❌ study-buddy.zip 验证失败')
console.log(okFoc ? '  ✅ study-buddy-focus-only.zip（仅防暂停）' : '  ❌ study-buddy-focus-only.zip 验证失败')
if (offlineMeta) {
  console.log(okOffline
    ? '  ✅ study-buddy-offline.zip（模型随包版）'
    : '  ❌ study-buddy-offline.zip 验证失败')
} else {
  console.log('  ⚠️ study-buddy-offline.zip 未生成（本机无模型文件）')
}

const allOk = okMain && okFoc && okOffline
console.log('')
console.log(allOk ? '✅ 全部通过' : '❌ 有问题')
process.exit(allOk ? 0 : 1)
