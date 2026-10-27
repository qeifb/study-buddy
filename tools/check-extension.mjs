/**
 * 扩展目录合规自检：模拟 Chrome/Edge 加载解压扩展时的合法性约束。
 * 只读检查，不修改任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'

const EXT = 'E:/StudyBuddy/app/extension'
const problems = []
const warnings = []

// 1. manifest 必须存在且合法
const mf = path.join(EXT, 'manifest.json')
if (!fs.existsSync(mf)) {
  problems.push('缺少 manifest.json')
  process.exit(1)
}
let m = null
try {
  m = JSON.parse(fs.readFileSync(mf, 'utf8'))
} catch (e) {
  problems.push('manifest.json 不是合法 JSON: ' + e.message)
  process.exit(1)
}

// 2. 文件名不得以下划线开头（Edge/Chrome 保留给系统）
const files = fs.readdirSync(EXT, { withFileTypes: true })
for (const f of files) {
  if (f.isDirectory()) continue
  if (f.name.startsWith('_')) {
    problems.push(`文件名以下划线开头（Chrome/Edge 保留）: ${f.name}`)
  }
}

// 3. manifest 引用的每个文件都必须真实存在
function checkRef(rel, where) {
  if (!rel) return
  const p = path.join(EXT, rel)
  if (!fs.existsSync(p)) {
    problems.push(`${where} 引用的文件不存在: ${rel}`)
  }
}

// background
checkRef(m.background?.service_worker, 'background.service_worker')
for (const s of m.background?.scripts || []) checkRef(s, 'background.scripts')

// content scripts
for (const cs of m.content_scripts || []) {
  for (const j of cs.js || []) checkRef(j, 'content_scripts.js')
  for (const c of cs.css || []) checkRef(c, 'content_scripts.css')
}

// action popup
checkRef(m.action?.default_popup, 'action.default_popup')
// options
checkRef(m.options_page, 'options_page')
checkRef(m.options_ui?.page, 'options_ui.page')
// web_accessible_resources
for (const war of m.web_accessible_resources || []) {
  for (const r of war.resources || []) {
    if (r.includes('*')) continue
    checkRef(r, 'web_accessible_resources')
  }
}

// 4. content script 里引用的全局变量，检查加载顺序是否合理
const order = (m.content_scripts?.[1]?.js) || []
if (order.length) {
  const idxCand = order.findIndex((f) => /cand-chars/.test(f))
  const idxCore = order.findIndex((f) => /pilot-core/.test(f))
  const idxPilot = order.findIndex((f) => /auto-pilot/.test(f))
  if (idxCand > idxCore) warnings.push('cand-chars.js 应排在 pilot-core.js 之前（虽然惰性求值不致命，但更稳）')
  if (idxCore > idxPilot) warnings.push('pilot-core.js 必须排在 auto-pilot.js 之前（auto-pilot 依赖 __sbPilotCore）')
  if (idxCore === -1 || idxPilot === -1) problems.push('content_scripts[1] 缺少 pilot-core.js 或 auto-pilot.js')
}

// 5. 检查关键文件里的语法（用 node --check 会在外部做，这里只查大小）
for (const f of files.filter((x) => x.isFile() && x.name.endsWith('.js'))) {
  const p = path.join(EXT, f.name)
  const sz = fs.statSync(p).size
  if (sz === 0) problems.push(`空文件: ${f.name}`)
}

// 6. 检查是否残留旧文件
if (fs.existsSync(path.join(EXT, 'auto-quiz.js'))) {
  warnings.push('残留旧文件 auto-quiz.js（已被 auto-pilot.js 取代，建议删除）')
}

// 输出
console.log('=== 扩展合规自检 ===')
console.log('目录:', EXT)
console.log('文件数:', files.filter((x) => x.isFile()).length)
console.log('manifest 版本:', m.version)
console.log('')
console.log('--- 引用的文件 ---')
for (const cs of m.content_scripts || []) {
  console.log('  content_scripts:', JSON.stringify(cs.js), 'all_frames=' + cs.all_frames)
}
console.log('  background:', m.background?.service_worker)
console.log('  popup:', m.action?.default_popup)
console.log('')
if (problems.length) {
  console.log('--- ❌ 问题 (' + problems.length + ') ---')
  problems.forEach((p) => console.log('  ' + p))
} else {
  console.log('--- ✅ 没有阻断性问题 ---')
}
if (warnings.length) {
  console.log('--- ⚠️ 提醒 (' + warnings.length + ') ---')
  warnings.forEach((w) => console.log('  ' + w))
}
process.exit(problems.length ? 1 : 0)
