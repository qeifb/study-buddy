/**
 * StudyBuddy 静态自检工具（2026-10-26 固化）
 *
 * 存在理由：本会话中反复手写一次性扫描脚本，每次都有误报
 *   （模板串 ${} 未处理、正则未识别、注释未剥离、闭包内同名误判）
 * → 把已验证可靠的实现固化到这里，以后只跑这一个。
 *
 * 用法：node tools/check-static.mjs
 * 退出码：0 = 全通过，1 = 有问题
 */
import fs from 'node:fs'
import path from 'node:path'

const R = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..')
const ROOT = fs.existsSync(path.join(R, 'app')) ? R : 'E:/StudyBuddy'

/* ══════ 词法层：把注释/字符串/模板串/正则全部抹成空格，保留结构 ══════ */

/**
 * 返回 { code, depths }
 * code: 与原文等长、行结构一致的「纯代码骨架」（注释与字面量替换为空格）
 * depths: 每行行首的 { } 深度
 */
function lexJs(text) {
  const out = []
  let depth = 0
  const depths = []
  let i = 0
  const n = text.length
  let curLine = 0
  let atLineStart = true

  const push = (ch, isCode) => {
    if (atLineStart) { depths[curLine] = depth; atLineStart = false }
    if (ch === '\n') { out.push('\n'); curLine++; atLineStart = true; return }
    out.push(ch)
  }
  const blank = (count, keepNewline) => {
    for (let k = 0; k < count; k++) {
      const c = text[i]
      if (c === undefined) break
      if (c === '\n') { push('\n'); i++; continue }
      push(' ', false); i++
    }
  }

  while (i < n) {
    const ch = text[i]

    /* 行注释 */
    if (ch === '/' && text[i + 1] === '/') {
      push(' '); push(' '); i += 2
      while (i < n && text[i] !== '\n') { push(' '); i++ }
      continue
    }
    /* 块注释 */
    if (ch === '/' && text[i + 1] === '*') {
      push(' '); push(' '); i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') push('\n')
        else push(' ')
        i++
      }
      if (i < n) { push(' '); push(' '); i += 2 }
      continue
    }
    /* 单/双引号字符串 */
    if (ch === "'" || ch === '"') {
      const q = ch
      push(' '); i++
      while (i < n) {
        if (text[i] === '\\') { push(' '); push(' '); i += 2; continue }
        if (text[i] === '\n') { push('\n'); i++; break }
        if (text[i] === q) { push(' '); i++; break }
        push(' '); i++
      }
      continue
    }
    /* 模板字符串：字面部分抹掉，${ } 内部递归当代码 */
    if (ch === '`') {
      push(' '); i++
      while (i < n) {
        if (text[i] === '\\') { push(' '); push(' '); i += 2; continue }
        if (text[i] === '\n') { push('\n'); i++; continue }
        if (text[i] === '`') { push(' '); i++; break }
        if (text[i] === '$' && text[i + 1] === '{') {
          push('$'); push('{'); i += 2
          /* 用递归处理里层的表达式（可能含嵌套模板串） */
          let d = 1
          while (i < n && d > 0) {
            const c2 = text[i]
            if (c2 === '{') { d++; push('{'); i++; continue }
            if (c2 === '}') { d--; push('}'); i++; continue }
            if (c2 === '`' || c2 === "'" || c2 === '"') {
              /* 递归剥一层字面量 */
              const q2 = c2
              push(' '); i++
              while (i < n) {
                if (text[i] === '\\') { push(' '); push(' '); i += 2; continue }
                if (text[i] === '\n') { push('\n'); i++; break }
                if (text[i] === q2) { push(' '); i++; break }
                push(' '); i++
              }
              continue
            }
            if (c2 === '\n') { push('\n'); i++; continue }
            push(c2); i++
          }
          continue
        }
        push(' '); i++
      }
      continue
    }
    /* 正则字面量 */
    if (ch === '/') {
      let j = i - 1
      while (j >= 0 && /[ \t]/.test(text[j])) j--
      const prev = j >= 0 ? text[j] : ''
      if (!/[a-zA-Z0-9_$)\]}]/.test(prev)) {
        push(' '); i++
        let closed = false
        while (i < n) {
          if (text[i] === '\\') { push(' '); push(' '); i += 2; continue }
          if (text[i] === '\n') break
          if (text[i] === '/') { push(' '); i++; closed = true; break }
          push(' '); i++
        }
        if (closed) { while (i < n && /[gimsuy]/.test(text[i])) { push(' '); i++ } }
        continue
      }
    }

    if (ch === '{') depth++
    else if (ch === '}') depth--
    push(ch)
    i++
  }

  while (depths.length < curLine + 1) depths.push(depth)
  return { code: out.join(''), depths }
}

/* ══════ 收集文件 ══════ */
function collectJs() {
  const out = []
  for (const p of ['app/main.js', 'app/preload.js', 'app/renderer/app.js']) {
    if (fs.existsSync(path.join(ROOT, p))) out.push(p)
  }
  for (const d of ['app/core', 'app/extension']) {
    const dir = path.join(ROOT, d)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) out.push(d + '/' + f)
  }
  return out
}

const FILES = collectJs()
let problems = 0
const add = (msg) => { console.log('  ❌ ' + msg); problems++ }

console.log(`StudyBuddy 静态自检（${FILES.length} 个 JS 文件）`)
console.log('='.repeat(64))

/* ══════ 1. UTF-8 严格合法 + 编码 ══════ */
console.log('')
console.log('【1】编码')
for (const f of FILES) {
  const buf = fs.readFileSync(path.join(ROOT, f))
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { add(`${f} 不是合法 UTF-8`) }
  const s = buf.toString('utf8')
  if (/\uFFFD/.test(s)) add(`${f} 含 U+FFFD 替换字符（乱码）`)
}
if (!problems) console.log('  ✅ 全部严格 UTF-8，无乱码')

/* ══════ 2. 真代码 token 里的全角标点 ══════ */
console.log('')
console.log('【2】全角标点混入代码')
const FW = /[，。；：（）【】「」｛｝＝＋－＊／＜＞！？、]/
let fwProblems = 0
for (const f of FILES) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8')
  const { code } = lexJs(raw)
  const cl = code.split('\n')
  const rl = raw.split('\n')
  cl.forEach((l, i) => {
    if (!l.trim()) return
    /* 只剩代码骨架后仍有全角 → 真问题（注释/字符串/模板/正则都已抹掉） */
    if (FW.test(l)) {
      add(`${f}:${i + 1} 代码含全角标点\n      骨架: ${l.trim().slice(0, 90)}\n      原文: ${(rl[i] || '').trim().slice(0, 90)}`)
      fwProblems++
    }
  })
}
if (!fwProblems) console.log('  ✅ 代码骨架内无全角标点')

/* ══════ 3. 顶层重复函数声明 ══════ */
console.log('')
console.log('【3】顶层重复 function 声明')
let dupProblems = 0
for (const f of FILES) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8')
  const { depths } = lexJs(raw)
  const lines = raw.split('\n')
  const seen = new Map()
  lines.forEach((l, i) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(l)
    if (!m) return
    if (depths[i] !== 0) return
    if (!seen.has(m[1])) seen.set(m[1], [])
    seen.get(m[1]).push(i + 1)
  })
  for (const [name, ls] of seen) {
    if (ls.length > 1) { add(`${f} 顶层重复声明 ${name} 行 ${ls.join(', ')}`); dupProblems++ }
  }
}
if (!dupProblems) console.log('  ✅ 无顶层重复 function')

/* ══════ 4. 关键要素必须处在执行路径上 ══════ */
console.log('')
console.log('【4】关键要素的「执行可达性」')
const CRITICAL = [
  { file: 'app/main.js', re: /^\s*function\s+getMachineNames\s*\(/, name: 'getMachineNames' },
  { file: 'app/main.js', re: /^\s*function\s+broadcastPerfEvent\s*\(/, name: 'broadcastPerfEvent' },
  { file: 'app/main.js', re: /^\s*async\s+function\s+runPerfBenchInternal\s*\(/, name: 'runPerfBenchInternal' },
  { file: 'app/main.js', re: /^\s*function\s+dirUsage\s*\(/, name: 'dirUsage' },
  { file: 'app/main.js', re: /^\s*let\s+perfRunnerImpl/, name: 'let perfRunnerImpl' },
  { file: 'app/main.js', re: /^\s*perfRunnerImpl\s*=\s*\{/, name: 'perfRunnerImpl = {' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+perfEl\s*\(/, name: 'perfEl' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+openPerfModal\s*\(/, name: 'openPerfModal' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+closePerfModal\s*\(/, name: 'closePerfModal' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+runPerfBench\s*\(/, name: 'runPerfBench' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+renderPerfResult\s*\(/, name: 'renderPerfResult' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+applyPerfMode\s*\(/, name: 'applyPerfMode' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+renderPerfResultTable\s*\(/, name: 'renderPerfResultTable' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+syncPerfTestBtn\s*\(/, name: 'syncPerfTestBtn' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+refreshPerfStatus\s*\(/, name: 'refreshPerfStatus' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+ensurePerfTested\s*\(/, name: 'ensurePerfTested' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+mountPerfBench\s*\(/, name: 'mountPerfBench' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+mountPerfNotifier\s*\(/, name: 'mountPerfNotifier' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+mountDiskUsage\s*\(/, name: 'mountDiskUsage' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+diskRow\s*\(/, name: 'diskRow' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+renderDiskTree\s*\(/, name: 'renderDiskTree' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+renderCDrive\s*\(/, name: 'renderCDrive' },
  { file: 'app/renderer/app.js', re: /^\s*function\s+syncAccelUI\s*\(/, name: 'syncAccelUI' },
  { file: 'app/renderer/app.js', re: /^\s*async\s+function\s+boot\s*\(/, name: 'boot' },
]
let reachProblems = 0
for (const c of CRITICAL) {
  const raw = fs.readFileSync(path.join(ROOT, c.file), 'utf8')
  const { depths } = lexJs(raw)
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => c.re.test(l))
  if (idx < 0) { add(`${c.file} 找不到 ${c.name}`); reachProblems++; continue }
  if (depths[idx] !== 0) {
    add(`${c.file}:${idx + 1} ${c.name} 深度 ${depths[idx]}（应为 0，被包进别的块）`)
    reachProblems++
  }
}
if (!reachProblems) console.log(`  ✅ ${CRITICAL.length} 个关键要素全部在顶层（深度 0）`)

/* ══════ 5. IPC 通道双侧 ══════ */
console.log('')
console.log('【5】IPC 通道')
const mainSrc = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8')
const preSrc = fs.readFileSync(path.join(ROOT, 'app/preload.js'), 'utf8')
const reg = new Set([...mainSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)].map((m) => m[1]))
const inv = new Set([...preSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)].map((m) => m[1]))
const notReg = [...inv].filter((c) => !reg.has(c))
if (notReg.length) notReg.forEach((c) => add(`preload 调用但 main 未注册: ${c}`))
else console.log(`  ✅ preload 的 ${inv.size} 个通道全部已注册（main 共 ${reg.size} 个）`)

/* ══════ 6. HTTP 路由双侧 ══════ */
console.log('')
console.log('【6】HTTP /ext 路由')
const esSrc = fs.readFileSync(path.join(ROOT, 'app/core/extserver.js'), 'utf8')
const routes = new Set([...esSrc.matchAll(/'(\/ext\/[a-zA-Z/]+)'/g)].map((m) => m[1].replace(/\/$/, '')))
const clients = new Set()
for (const f of ['app/extension/auto-pilot.js', 'app/extension/pilot-core.js', 'app/extension/background.js']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8')
  for (const m of s.matchAll(/['"`](\/ext\/[a-zA-Z/]+)(?:\?[^'"`]*)?['"`]/g)) clients.add(m[1].replace(/\/$/, ''))
}
const notRouted = [...clients].filter((p) => !routes.has(p))
if (notRouted.length) notRouted.forEach((p) => add(`客户端请求但无路由: ${p}`))
else console.log(`  ✅ 客户端 ${clients.size} 个路径全部有路由（服务端共 ${routes.size} 个）`)

/* ══════ 7. pilot-core 导出 ←→ auto-pilot 解构 ══════ */
console.log('')
console.log('【7】pilot-core 导出 ↔ auto-pilot 解构')
const coreSrc = fs.readFileSync(path.join(ROOT, 'app/extension/pilot-core.js'), 'utf8')
const extSrc = fs.readFileSync(path.join(ROOT, 'app/extension/auto-pilot.js'), 'utf8')
const exportIdx = coreSrc.indexOf('window.__sbPilotCore')
const exported = new Set()
if (exportIdx >= 0) {
  const open = coreSrc.indexOf('{', exportIdx)
  let d = 0, end = open
  for (let k = open; k < coreSrc.length; k++) {
    if (coreSrc[k] === '{') d++
    else if (coreSrc[k] === '}') { d--; if (d === 0) { end = k; break } }
  }
  for (const m of coreSrc.slice(open, end).matchAll(/([A-Za-z_$][\w$]*)/g)) exported.add(m[1])
}
const dm = /const\s*\{([\s\S]{0,3000}?)\}\s*=\s*(?:window\.)?[A-Za-z_$.]+/.exec(extSrc)
const destructured = new Set()
if (dm) {
  for (const raw of dm[1].split(',')) {
    const s = raw.trim()
    if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue
    const n = s.split(':')[0].split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(n)) destructured.add(n)
  }
}
const missExport = [...destructured].filter((k) => !exported.has(k))
if (missExport.length) missExport.forEach((k) => add(`解构了但未导出: ${k}`))
else console.log(`  ✅ 解构的 ${destructured.size} 个键全部在导出（${exported.size} 个）里`)

/* ══════ 8. 主进程同步子进程调用 ══════ */
console.log('')
console.log('【8】主进程同步子进程调用')
const mainLex = lexJs(mainSrc).code
const syncCalls = [...mainLex.matchAll(/\b(execFileSync|execSync|spawnSync)\s*\(/g)]
if (syncCalls.length) {
  syncCalls.forEach((m) => {
    const line = mainLex.slice(0, m.index).split('\n').length
    add(`app/main.js:${line} 使用了 ${m[1]}（会阻塞主进程）`)
  })
} else {
  console.log('  ✅ 无 execFileSync / execSync / spawnSync')
}

/* ══════ 9. 模块导出 ↔ require 解构 ══════ */
console.log('')
console.log('【9】模块契约（core 模块 exports ↔ require 解构）')

function exportsOfModule(src) {
  const out = new Set()
  const i = src.indexOf('module.exports')
  if (i < 0) return out
  const open = src.indexOf('{', i)
  if (open < 0) return out
  let d = 0, end = open
  let inS = false, sc = ''
  for (let k = open; k < src.length; k++) {
    const ch = src[k]
    if (inS) { if (ch === '\\') { k++; continue } if (ch === sc) inS = false; continue }
    if (ch === "'" || ch === '"' || ch === '`') { inS = true; sc = ch; continue }
    if (ch === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (ch === '/' && src[k + 1] === '*') { k += 2; while (k < src.length && !(src[k] === '*' && src[k + 1] === '/')) k++; k++; continue }
    if (ch === '{') d++
    else if (ch === '}') { d--; if (d === 0) { end = k; break } }
  }
  for (const part of src.slice(open + 1, end).split(',')) {
    const s = part.trim()
    if (!s) continue
    const n = s.split(':')[0].split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n)
  }
  return out
}

const modFiles = ['app/main.js', 'app/preload.js']
for (const f of fs.readdirSync(path.join(ROOT, 'app/core'))) if (f.endsWith('.js')) modFiles.push('app/core/' + f)

let modProblems = 0
for (const f of modFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]{0,3000})\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const from = m[2]
    let target = path.join(ROOT, path.dirname(f), from)
    if (!target.endsWith('.js')) target += '.js'
    if (!fs.existsSync(target)) { add(`${f}: require('${from}') 目标不存在`); modProblems++; continue }
    const ex = exportsOfModule(fs.readFileSync(target, 'utf8'))
    const keys = []
    for (const raw of m[1].split(',')) {
      const s = raw.trim()
      if (!s || s.includes('...')) continue
      const n = s.split(':')[0].split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) keys.push(n)
    }
    const missing = keys.filter((k) => !ex.has(k))
    if (missing.length) {
      add(`${f} 从 '${from}' 解构了不存在的键: ${missing.join(', ')}`)
      modProblems++
    }
  }
}
if (!modProblems) console.log('  ✅ 所有 require 解构的键都在目标模块导出里')

/* ══════ 10. 扩展 manifest 完整性 ══════ */
console.log('')
console.log('【10】扩展 manifest 完整性')
const manPath = path.join(ROOT, 'app/extension/manifest.json')
if (!fs.existsSync(manPath)) {
  add('app/extension/manifest.json 不存在')
} else {
  let man = null
  try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')) }
  catch (e) { add('manifest.json 不是合法 JSON: ' + e.message) }

  if (man) {
    const refs = new Set()
    if (man.background?.service_worker) refs.add(man.background.service_worker)
    if (man.background?.scripts) man.background.scripts.forEach((s) => refs.add(s))
    if (man.action?.default_popup) refs.add(man.action.default_popup)
    if (man.action?.default_icon) Object.values(man.action.default_icon).forEach((s) => refs.add(s))
    if (man.icons) Object.values(man.icons).forEach((s) => refs.add(s));
    (man.content_scripts || []).forEach((cs) => (cs.js || []).forEach((s) => refs.add(s)));
    (man.web_accessible_resources || []).forEach((r) => (r.resources || []).forEach((s) => {
      if (!s.includes('*')) refs.add(s)
    }))

    let manProblems = 0
    for (const r of refs) {
      if (!fs.existsSync(path.join(ROOT, 'app/extension', r))) {
        add(`manifest 引用了不存在的文件: ${r}`); manProblems++
      }
    }
    /* 下划线开头的文件名（Edge/Chrome 保留） */
    for (const f of fs.readdirSync(path.join(ROOT, 'app/extension'))) {
      if (f.startsWith('_')) { add(`扩展目录有下划线开头文件（会被拒绝加载）: ${f}`); manProblems++ }
    }
    /* content_scripts 依赖顺序：pilot-core 必须在 auto-pilot 之前 */
    const allJs = (man.content_scripts || []).flatMap((cs) => cs.js || [])
    const iPilot = allJs.indexOf('pilot-core.js')
    const iAuto = allJs.indexOf('auto-pilot.js')
    if (iPilot >= 0 && iAuto >= 0 && iPilot > iAuto) {
      add('content_scripts 顺序错误：pilot-core.js 必须在 auto-pilot.js 之前'); manProblems++
    }
    if (!manProblems) console.log(`  ✅ ${refs.size} 个引用文件全部存在，加载顺序正确，无下划线文件名`)
  }
}

/* ══════ 汇总 ══════ */
console.log('')
console.log('='.repeat(64))
if (problems === 0) {
  console.log('✅ 静态自检全部通过')
  process.exit(0)
} else {
  console.log(`❌ 静态自检发现 ${problems} 个问题`)
  process.exit(1)
}
