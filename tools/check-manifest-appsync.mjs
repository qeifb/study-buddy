/**
 * 第 4 + 5 项：
 *   4. 扩展 manifest 完整性（引用文件存在 / 文件名合法 / 加载顺序）
 *   5. app/ 与 repo/ 双目录一致性
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = 'E:/StudyBuddy'
const REPO = ROOT + '/repo'
const APP = ROOT + '/app'
const EXT = REPO + '/app/extension'

let pass = 0
let fail = 0
const fails = []
function T(name, ok, detail) {
  if (ok) pass++
  else { fail++; fails.push(`${name}  ${detail || ''}`) }
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

console.log('=== 第 4 项：扩展 manifest 完整性 ===')
const mf = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'))
console.log(`  name=${mf.name}  version=${mf.version}  mv=${mf.manifest_version}`)
T('manifest_version 是 3', mf.manifest_version === 3)
T('name 存在', Boolean(mf.name), mf.name)
T('version 格式合法', /^\d+\.\d+\.\d+$/.test(mf.version), mf.version)

// 4.1 引用的文件都存在
const refs = []
if (mf.background?.service_worker) refs.push(['background', mf.background.service_worker])
for (const cs of (mf.content_scripts || [])) for (const j of (cs.js || [])) refs.push(['content_scripts', j])
for (const cs of (mf.content_scripts || [])) for (const c of (cs.css || [])) refs.push(['content_scripts-css', c])
if (mf.action?.default_popup) refs.push(['action.popup', mf.action.default_popup])
for (const r of (mf.web_accessible_resources || [])) for (const res of (r.resources || [])) refs.push(['war', res])

console.log('')
console.log('  引用的文件:')
let refOk = true
for (const [where, f] of refs) {
  const exists = fs.existsSync(path.join(EXT, f))
  if (!exists) refOk = false
  console.log(`    ${exists ? '✅' : '❌'} ${f.padEnd(24)} (${where})`)
}
T(`引用的 ${refs.length} 个文件全部存在`, refOk)

// 4.2 文件名合法性（下划线开头会被 Edge 拒绝加载整包）
console.log('')
const allFiles = fs.readdirSync(EXT)
const badNames = allFiles.filter((f) => f.startsWith('_'))
T('无下划线开头的文件名', badNames.length === 0, badNames.join(','))

// 4.3 空文件
const emptyFiles = allFiles.filter((f) => {
  const p = path.join(EXT, f)
  return fs.statSync(p).isFile() && fs.statSync(p).size === 0
})
T('无空文件', emptyFiles.length === 0, emptyFiles.join(','))

// 4.4 加载顺序：依赖库必须在 pilot-core 之前，pilot-core 在 auto-pilot 之前
console.log('')
const g2 = (mf.content_scripts || []).find((cs) => cs.all_frames === false)
if (g2) {
  const js = g2.js
  console.log('  group2 加载顺序:', js.join(' → '))
  const idx = (n) => js.indexOf(n)
  const okOrder =
    idx('md5-mini.js') >= 0 &&
    idx('typr-lite.js') > idx('md5-mini.js') &&
    idx('font-table.js') > idx('typr-lite.js') &&
    idx('cand-chars.js') > idx('font-table.js') &&
    idx('pilot-core.js') > idx('cand-chars.js') &&
    idx('auto-pilot.js') > idx('pilot-core.js')
  T('加载顺序正确（md5→typr→table→cand→core→pilot）', okOrder)
} else {
  T('存在 all_frames=false 的 group2', false)
}

// 4.5 group1 不应包含 ask-panel（已停用）
const g1 = (mf.content_scripts || []).find((cs) => cs.all_frames === true)
if (g1) {
  console.log('  group1 加载:', g1.js.join(', '))
  T('group1 不含 ask-panel.js（已停用）', !g1.js.includes('ask-panel.js'))
}

// 4.6 文件清单
console.log('')
console.log('  app/extension 下共', allFiles.length, '个文件:')
allFiles.sort().forEach((f) => {
  const sz = fs.statSync(path.join(EXT, f)).size
  console.log(`    ${f.padEnd(22)} ${(sz / 1024).toFixed(1)}KB`)
})

// ══════════ 第 5 项 ══════════
console.log('')
console.log('=== 第 5 项：app/ 与 repo/ 双目录一致性 ===')

function hash(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

const PAIRS = [
  ['main.js', APP + '/main.js', REPO + '/app/main.js'],
  ['preload.js', APP + '/preload.js', REPO + '/app/preload.js'],
  ['close-dialog.js', APP + '/close-dialog.js', REPO + '/app/close-dialog.js'],
  ['package.json', APP + '/package.json', REPO + '/app/package.json'],
]
for (const [label, a, r] of PAIRS) {
  if (!fs.existsSync(a) || !fs.existsSync(r)) { T(`app/${label}`, false, '一侧不存在'); continue }
  T(`app/${label} 一致`, hash(a) === hash(r), hash(a) === hash(r) ? '' : '内容不同')
}

for (const sub of ['extension', 'core', 'renderer', 'assets']) {
  const da = APP + '/' + sub
  const dr = REPO + '/app/' + sub
  if (!fs.existsSync(da) || !fs.existsSync(dr)) { T(`app/${sub}`, false, '一侧不存在'); continue }
  const fa = fs.readdirSync(da).filter((f) => fs.statSync(path.join(da, f)).isFile()).sort()
  const fr = fs.readdirSync(dr).filter((f) => fs.statSync(path.join(dr, f)).isFile()).sort()
  const all = new Set([...fa, ...fr])
  let diff = []
  for (const f of all) {
    const pa = da + '/' + f
    const pr = dr + '/' + f
    if (!fs.existsSync(pa)) { diff.push(`${f}(缺于app)`); continue }
    if (!fs.existsSync(pr)) { diff.push(`${f}(缺于repo)`); continue }
    if (hash(pa) !== hash(pr)) diff.push(`${f}(内容不同)`)
  }
  T(`app/${sub} 一致（${all.size} 文件）`, diff.length === 0, diff.slice(0, 5).join(', '))
}

// tools 只在 repo（app 没有 tools 是对的）
console.log('')
const toolsApp = fs.existsSync(APP + '/tools')
const toolsRepo = fs.existsSync(REPO + '/tools')
T('tools 只在 repo（运行时用 %~dp0tools）', !toolsApp && toolsRepo, toolsApp ? 'app/tools 意外存在' : '')

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
if (fails.length) {
  console.log('失败项:')
  fails.forEach((x) => console.log('  - ' + x))
}
process.exit(fail === 0 ? 0 : 1)
