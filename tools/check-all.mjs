/**
 * 全项目文件可用性体检（发布前必跑）。
 *
 * 检查项：
 *   A. .cmd 文件：GBK 编码 + CRLF 换行（cmd.exe 的硬要求）
 *   B. .ps1 文件：UTF-8 BOM 或 GBK + CRLF（PowerShell 能读）
 *   C. 所有 .js/.mjs：node --check 语法
 *   D. JSON：可解析
 *   E. 扩展 manifest：引用的文件全部存在、文件名无下划线开头、加载顺序
 *   F. app/ 与 repo/ 双目录逐文件一致
 *   G. 危险文件/目录不入库
 *   H. 必需文件齐全
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const ROOT = 'E:/StudyBuddy'
const REPO = ROOT + '/repo'
const APP = ROOT + '/app'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}
function warn(name, detail) {
  results.push({ name, ok: true, warn: true, detail })
  console.log(`  ⚠️ ${name}${detail ? '  ' + detail : ''}`)
}

function walk(dir, rel = '', out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + it.name : it.name
    if (['node_modules', '.git', 'data', 'runtime', 'browser-profile', 'pyenv', 'models'].includes(it.name)) continue
    if (it.isDirectory()) walk(dir + '/' + it.name, r, out)
    else out.push(r)
  }
  return out
}

const repoFiles = walk(REPO)
console.log('=== 扫描范围 ===')
console.log('  repo 文件总数:', repoFiles.length)

// ── A. .cmd 文件编码与换行 ──
console.log('')
console.log('=== A. .cmd 文件（硬要求：GBK + CRLF）===')
const cmds = repoFiles.filter((f) => f.endsWith('.cmd'))
if (!cmds.length) warn('.cmd 文件', '未找到')
for (const f of cmds) {
  const p = REPO + '/' + f
  const buf = fs.readFileSync(p)
  const text = new TextDecoder('gbk').decode(buf)
  const crlf = (text.match(/\r\n/g) || []).length
  const loneLF = (text.match(/(?<!\r)\n/g) || []).length
  const isUtf8 = Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF

  check(`${f} 换行`, loneLF === 0 && crlf > 0, `CRLF=${crlf} 单独LF=${loneLF}`)
  check(`${f} 编码`, !isUtf8 && !hasBom, isUtf8 ? 'UTF-8（应为 GBK）' : hasBom ? 'UTF-8 BOM' : 'GBK ✅')
}

// ── B. .ps1 ──
console.log('')
console.log('=== B. .ps1 文件 ===')
const ps1s = repoFiles.filter((f) => f.endsWith('.ps1'))
for (const f of ps1s) {
  const buf = fs.readFileSync(REPO + '/' + f)
  const text = new TextDecoder('gbk').decode(buf)
  const crlf = (text.match(/\r\n/g) || []).length
  const loneLF = (text.match(/(?<!\r)\n/g) || []).length
  if (loneLF > 0 && crlf === 0) warn(`${f} 换行`, '全是 LF（PowerShell 一般能读，但建议 CRLF）')
  else check(`${f} 换行`, true, `CRLF=${crlf} LF=${loneLF}`)
}

// ── C. JS 语法 ──
console.log('')
console.log('=== C. JS/MJS 语法（node --check）===')
const jsFiles = repoFiles.filter((f) => /\.(js|mjs)$/.test(f))
let jsFail = 0
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', REPO + '/' + f], { stdio: 'pipe', timeout: 30000 })
  } catch {
    jsFail++
    check(`${f} 语法`, false)
  }
}
check(`全部 ${jsFiles.length} 个 JS/MJS 语法`, jsFail === 0, jsFail ? `${jsFail} 个失败` : '')

// ── D. JSON ──
console.log('')
console.log('=== D. JSON 可解析 ===')
const jsonFiles = repoFiles.filter((f) => f.endsWith('.json') && !f.includes('package-lock'))
let jsonFail = 0
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(REPO + '/' + f, 'utf8'))
  } catch {
    jsonFail++
    check(`${f}`, false)
  }
}
check(`全部 ${jsonFiles.length} 个 JSON`, jsonFail === 0, jsonFail ? `${jsonFail} 个失败` : '')

// ── E. 扩展 manifest ──
console.log('')
console.log('=== E. 扩展 manifest 完整性 ===')
const EXT = REPO + '/app/extension'
const mf = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'))
check('manifest.name', Boolean(mf.name), mf.name)
check('manifest.version', Boolean(mf.version), mf.version)

const refs = []
if (mf.background?.service_worker) refs.push(['background', mf.background.service_worker])
for (const cs of (mf.content_scripts || [])) for (const j of (cs.js || [])) refs.push(['content_scripts', j])
if (mf.action?.default_popup) refs.push(['action', mf.action.default_popup])
let refMissing = 0
for (const [where, f] of refs) {
  const ok = fs.existsSync(EXT + '/' + f)
  if (!ok) { refMissing++; check(`  ${f}（${where} 引用）`, false, '文件不存在') }
}
check(`manifest 引用的 ${refs.length} 个文件全部存在`, refMissing === 0)

// 文件名下划线
const badNames = fs.readdirSync(EXT).filter((f) => f.startsWith('_'))
check('无下划线开头的文件名（Edge 会拒绝整包）', badNames.length === 0, badNames.join(','))

// 加载顺序
const g2 = (mf.content_scripts || []).find((cs) => cs.all_frames === false)
if (g2) {
  const js = g2.js
  const idx = (n) => js.indexOf(n)
  const orderOk =
    idx('md5-mini.js') >= 0 && idx('typr-lite.js') > idx('md5-mini.js') &&
    idx('font-table.js') > idx('typr-lite.js') && idx('pilot-core.js') > idx('font-table.js') &&
    idx('auto-pilot.js') > idx('pilot-core.js')
  check('扩展加载顺序（依赖在前）', orderOk, js.join(' → '))
}

// ── F. app/ 与 repo/ 一致性 ──
console.log('')
console.log('=== F. app/ 与 repo/ 双目录一致性 ===')
function listFlat(base, sub) {
  const dir = base + '/' + sub
  if (!fs.existsSync(dir)) return null
  return fs.readdirSync(dir).filter((f) => fs.statSync(dir + '/' + f).isFile()).sort()
}
for (const sub of ['extension', 'core', 'renderer']) {
  const la = listFlat(APP, sub)
  const lr = listFlat(REPO + '/app', sub)
  if (!la || !lr) { warn(`app/${sub}`, '一侧不存在'); continue }
  let diff = 0
  const all = new Set([...la, ...lr])
  for (const f of all) {
    const pa = APP + '/' + sub + '/' + f
    const pr = REPO + '/app/' + sub + '/' + f
    const sa = fs.existsSync(pa) ? fs.statSync(pa).size : -1
    const sr = fs.existsSync(pr) ? fs.statSync(pr).size : -1
    if (sa !== sr) { diff++; console.log(`      ⚠️ ${f}: app=${sa} repo=${sr}`) }
  }
  check(`app/${sub} 与 repo 一致（${all.size} 文件）`, diff === 0, diff ? `${diff} 个大小不同` : '')
}
for (const f of ['main.js', 'preload.js', 'close-dialog.js', 'package.json']) {
  const pa = APP + '/' + f
  const pr = REPO + '/app/' + f
  if (!fs.existsSync(pa) || !fs.existsSync(pr)) { warn(`app/${f}`, '一侧不存在'); continue }
  const sa = fs.statSync(pa).size
  const sr = fs.statSync(pr).size
  check(`app/${f} 一致`, sa === sr, sa === sr ? '' : `app=${sa} repo=${sr}`)
}

// ── G. 危险文件 ──
console.log('')
console.log('=== G. 危险文件（不应入库）===')
const DANGER = [
  [/node_modules/, 'node_modules'],
  [/^data\//, 'data/'],
  [/runtime\//, 'runtime'],
  [/browser-profile/, 'browser-profile'],
  [/pyenv|tools\/models/, 'pyenv/models'],
  [/(^|\/)_[^/]+\.(mjs|js|txt|cmd)$/, '临时脚本'],
  [/\.log$/, '日志'],
  [/settings\.json/, 'settings.json'],
]
for (const [re, name] of DANGER) {
  const hit = repoFiles.filter((f) => re.test(f))
  check(`无 ${name}`, hit.length === 0, hit.length ? hit.slice(0, 3).join(', ') : '')
}

// ── H. 必需文件 ──
console.log('')
console.log('=== H. 必需文件 ===')
const MUST = [
  'README.md', 'LICENSE', 'THIRD-PARTY.md', '启动学习通学伴.cmd',
  'app/main.js', 'app/preload.js', 'app/package.json',
  'app/extension/manifest.json', 'app/extension/content.js', 'app/extension/background.js',
  'app/extension/focus-mode.js', 'app/extension/popup.html',
  'app/extension/auto-pilot.js', 'app/extension/pilot-core.js', 'app/extension/cand-chars.js',
  'app/extension/typr-lite.js', 'app/extension/md5-mini.js', 'app/extension/font-table.js',
  'tools/pack-release.mjs', 'tools/build-font-table.mjs', 'tools/transcribe.py', 'tools/setup-transcribe.ps1',
]
let mustMissing = 0
for (const m of MUST) {
  if (!fs.existsSync(REPO + '/' + m)) { mustMissing++; check(m, false, '缺失') }
}
check(`必需文件 ${MUST.length} 项全部存在`, mustMissing === 0)

// ── 汇总 ──
console.log('')
const fail = results.filter((r) => !r.ok)
const warns = results.filter((r) => r.warn)
console.log('=== 汇总 ===')
console.log(`  检查项: ${results.length}  失败: ${fail.length}  警告: ${warns.length}`)
if (fail.length) {
  console.log('')
  console.log('❌ 失败项：')
  fail.forEach((r) => console.log(`  - ${r.name}  ${r.detail || ''}`))
}
process.exit(fail.length ? 1 : 0)
