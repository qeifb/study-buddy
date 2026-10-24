/**
 * 第 2 项：编码与换行全量检查。
 *
 * 规则（本项目血泪总结）：
 *   · .cmd  → 必须 GBK(936) + CRLF，不能有 UTF-8 BOM
 *     原因：cmd.exe 解析 GBK 文件时若行尾只有 LF，会把含中文的行按字节拆断，
 *           碎片被当命令执行 → 刷一片「不是内部或外部命令」。
 *   · .ps1  → 必须 UTF-8 BOM + CRLF（PowerShell 靠 BOM 判编码，无 BOM 会按 ANSI 读 → 中文乱）
 *     且 .ps1 若改 [Console]::OutputEncoding，必须保存并恢复（否则调用方 .cmd 后续中文乱码）。
 *   · .js/.mjs/.json/.md → UTF-8（BOM 可选，但 .js 最好不带 BOM，避免某些解析器出错）
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'E:/StudyBuddy/repo'

function walk(dir, rel = '', out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'runtime', 'browser-profile', 'pyenv', 'models'].includes(it.name)) continue
    const r = rel ? rel + '/' + it.name : it.name
    if (it.isDirectory()) walk(path.join(dir, it.name), r, out)
    else out.push(r)
  }
  return out
}

const files = walk(REPO)
let pass = 0
let fail = 0
const failList = []

function T(name, ok, detail) {
  if (ok) pass++
  else { fail++; failList.push(`${name}  ${detail || ''}`) }
  if (!ok) console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

console.log('=== 编码与换行全量检查（repo/ 共', files.length, '个文件）===')

// ── .cmd ──
console.log('')
console.log('--- .cmd 文件（要求 GBK + CRLF + 无 BOM）---')
const cmds = files.filter((f) => f.endsWith('.cmd'))
if (!cmds.length) console.log('  （无）')
for (const f of cmds) {
  const buf = fs.readFileSync(path.join(REPO, f))
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
  // 用 GBK 解码检查换行
  const gbkText = new TextDecoder('gbk').decode(buf)
  const crlf = (gbkText.match(/\r\n/g) || []).length
  const loneLF = (gbkText.match(/(?<!\r)\n/g) || []).length
  const isUtf8 = Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
  // 中文是否可读（GBK 解码后应有大量汉字）
  const cjk = (gbkText.match(/[\u4e00-\u9fa5]/g) || []).length

  console.log(`  ${f}`)
  T(`${f} 无 BOM`, !hasBom, hasBom ? 'UTF-8 BOM' : '')
  T(`${f} 非 UTF-8（应 GBK）`, !isUtf8, isUtf8 ? '检测为合法 UTF-8' : '')
  T(`${f} 全 CRLF`, loneLF === 0 && crlf > 0, `CRLF=${crlf} 单独LF=${loneLF}`)
  T(`${f} 中文可读`, cjk > 20, `GBK 解码汉字=${cjk}`)
  console.log(`      CRLF=${crlf} LF=${loneLF} 汉字=${cjk} 大小=${buf.length}B`)
}

// ── .ps1 ──
console.log('')
console.log('--- .ps1 文件（要求 UTF-8 BOM + CRLF）---')
const ps1s = files.filter((f) => f.endsWith('.ps1'))
if (!ps1s.length) console.log('  （无）')
for (const f of ps1s) {
  const buf = fs.readFileSync(path.join(REPO, f))
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
  const text = new TextDecoder('utf8').decode(buf).replace(/^\uFEFF/, '')
  const crlf = (text.match(/\r\n/g) || []).length
  const loneLF = (text.match(/(?<!\r)\n/g) || []).length
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length

  console.log(`  ${f}`)
  T(`${f} 有 BOM`, hasBom, hasBom ? '' : '缺 UTF-8 BOM（PowerShell 会按 ANSI 读）')
  T(`${f} 全 CRLF`, loneLF === 0, `CRLF=${crlf} 单独LF=${loneLF}`)
  T(`${f} 中文可读`, cjk > 20, `汉字=${cjk}`)
  // 若改了 OutputEncoding，必须有恢复
  const setsEncoding = /\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8/.test(text)
  if (setsEncoding) {
    const hasRestore = /Restore-ConsoleEncoding/.test(text) || /OldOutEnc/.test(text)
    T(`${f} 改了编码且有恢复`, hasRestore, hasRestore ? '' : '会污染调用方 .cmd 的 GBK 中文！')
  }
  console.log(`      CRLF=${crlf} LF=${loneLF} 汉字=${cjk} 大小=${buf.length}B`)
}

// ── .js / .mjs（应 UTF-8，最好无 BOM）──
console.log('')
console.log('--- .js / .mjs（要求 UTF-8）---')
const jss = files.filter((f) => /\.(js|mjs)$/.test(f))
let jsBom = 0
let jsBad = 0
for (const f of jss) {
  const buf = fs.readFileSync(path.join(REPO, f))
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
  if (hasBom) { jsBom++; console.log(`  ⚠️ ${f} 带 UTF-8 BOM`) }
  // 检查是否合法 UTF-8
  const ok = Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
  if (!ok) { jsBad++; console.log(`  ❌ ${f} 不是合法 UTF-8`) }
}
T('所有 js/mjs 是合法 UTF-8', jsBad === 0, jsBad ? `${jsBad} 个非法` : '')
if (jsBom) console.log(`  ℹ️ ${jsBom} 个 js 带 BOM（浏览器一般能处理，但不推荐）`)
console.log(`  共 ${jss.length} 个 js/mjs`)

// ── .json ──
console.log('')
console.log('--- .json ---')
const jsons = files.filter((f) => f.endsWith('.json'))
for (const f of jsons) {
  const buf = fs.readFileSync(path.join(REPO, f))
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
  let ok = false
  try { JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); ok = true } catch { ok = false }
  T(`${f} 可解析`, ok, ok ? '' : 'JSON 语法错误')
  if (hasBom) console.log(`  ⚠️ ${f} 带 BOM（JSON.parse 会失败，需去掉）`)
}

// ── .md ──
console.log('')
console.log('--- .md ---')
const mds = files.filter((f) => f.endsWith('.md'))
for (const f of mds) {
  const buf = fs.readFileSync(path.join(REPO, f))
  const text = new TextDecoder('utf8').decode(buf)
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const ok = Buffer.from(buf.toString('utf8'), 'utf8').equals(buf) || buf[0] === 0xEF
  T(`${f} 合法 UTF-8`, ok, ok ? '' : '编码异常')
  if (cjk > 10) console.log(`      ${f}: ${cjk} 汉字, ${text.split('\n').length} 行`)
}

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
if (failList.length) {
  console.log('')
  console.log('失败项:')
  failList.forEach((x) => console.log('  - ' + x))
}
process.exit(fail === 0 ? 0 : 1)
