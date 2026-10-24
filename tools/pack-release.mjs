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
const MAIN_ROOT_FILES = ['README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1', '启动学习通学伴.cmd']
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
  const stage = path.join(ROOT, '__stage_' + Date.now())
  fs.rmSync(stage, { recursive: true, force: true })
  for (const f of files) {
    const dst = path.join(stage, f)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(baseDir, f), dst)
  }

  const zipPath = path.join(DIST, outName)
  try { fs.unlinkSync(zipPath) } catch { /* ignore */ }

  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/\//g, '\\')}', '${zipPath.replace(/\//g, '\\')}', [IO.Compression.CompressionLevel]::Optimal, $false)`,
  ].join('\n')
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', stdio: 'pipe' })
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
fs.writeFileSync(path.join(DIST, '_release-meta.json'), JSON.stringify({
  mainZip: mainMeta,
  focusZip: focMeta,
  builtAt: new Date().toISOString(),
}, null, 2), 'utf8')

console.log('')
console.log('=== 汇总 ===')
console.log(okMain && okFoc ? '✅ 两个包都验证通过' : '❌ 有问题')
process.exit(okMain && okFoc ? 0 : 1)
