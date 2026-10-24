/**
 * 第 7 项：危险文件与敏感信息全量扫描。
 * 目标：确保上传到 GitHub 的内容里，绝不含：
 *   用户数据 / 密钥 / 绝对路径 / 日志 / 临时脚本 / 大体积二进制
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'E:/StudyBuddy/repo'

function walk(dir, rel = '', out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (it.name === '.git') continue
    const r = rel ? rel + '/' + it.name : it.name
    if (it.isDirectory()) walk(path.join(dir, it.name), r, out)
    else out.push(r)
  }
  return out
}

const files = walk(REPO)
let pass = 0, fail = 0
const fails = []
function T(name, ok, detail) {
  if (ok) pass++
  else { fail++; fails.push(`${name}  ${detail || ''}`) }
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

console.log(`=== 7. 危险文件扫描（repo/ 共 ${files.length} 个文件）===`)

// ── 7.1 目录/文件类型 ──
console.log('')
console.log('--- 目录与文件类型 ---')
const DIR_RULES = [
  [/^node_modules\//, 'node_modules（依赖，应 npm install 生成）'],
  [/^data\//, 'data/（用户数据）'],
  [/^runtime\//, 'runtime/（运行时缓存）'],
  [/^browser-profile\//, 'browser-profile/（浏览器 profile）'],
  [/^tools\/pyenv\//, 'tools/pyenv/（Python 虚拟环境）'],
  [/^tools\/models\//, 'tools/models/（语音模型 1.6GB）'],
  [/^tools\/python\//, 'tools/python/（便携版 Python）'],
  [/^\.dev-profile/, '.dev-profile（调试 profile）'],
  [/^_data\//, '_data/'],
  [/^dist\//, 'dist/（打包产物）'],
  [/^publish\//, 'publish/（发布脚本，含 node_modules）'],
]
for (const [re, name] of DIR_RULES) {
  const hit = files.filter((f) => re.test(f))
  if (hit.length) {
    T(`无 ${name}`, false, `${hit.length} 个`)
    hit.slice(0, 3).forEach((h) => console.log(`      ${h}`))
  } else {
    console.log(`  ✅ 无 ${name}`)
    pass++
  }
}

// ── 7.2 临时脚本 ──
console.log('')
console.log('--- 临时脚本 ---')
const tempHits = files.filter((f) => /(^|\/)_[^/]+\.(mjs|js|txt|cmd|ps1)$/.test(f))
T('无 _ 开头的临时脚本', tempHits.length === 0, tempHits.join(', '))

// ── 7.3 日志与缓存 ──
console.log('')
console.log('--- 日志与缓存 ---')
for (const [re, name] of [
  [/\.log$/, '日志文件'],
  [/\.tmp$/, '临时文件'],
  [/\.zip$/, 'zip 包'],
  [/\.tar\.gz$/, 'tar.gz'],
  [/\.pyc$/, 'pyc 缓存'],
  [/__pycache__/, '__pycache__'],
  [/\.DS_Store|Thumbs\.db|desktop\.ini/, '系统垃圾文件'],
]) {
  const hit = files.filter((f) => re.test(f))
  T(`无 ${name}`, hit.length === 0, hit.slice(0, 3).join(', '))
}

// ── 7.4 敏感内容（内容扫描）──
console.log('')
console.log('--- 敏感内容（逐文件读内容）---')
const CONTENT_RULES = [
  [/sk-[A-Za-z0-9]{20,}/, 'API Key 形如 sk-xxx'],
  [/(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{16,}['"]/i, '硬编码密钥/密码'],
  [/C:\\\\Users\\\\qq155|C:\/Users\/qq155|Users\\\\qq155/, '绝对用户路径（泄露本机用户名）'],
  [/D:\\\\study-buddy|D:\/study-buddy/, '绝对安装路径'],
  [/ghp_[A-Za-z0-9]{20,}|github_pat_/, 'GitHub Token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Key'],
]
const violations = []
// 几个检查脚本自身必然包含密钥正则字面量（如 ghp_ / AKIA），会自命中 → 排除
const SELF_EXCLUDE = /^tools\/(check-secrets|check-encoding|check-manifest-appsync|check-readme-consistency|check-all|e2e-check|pack-release|build-font-table)\.mjs$/
for (const f of files) {
  // 只扫文本类
  if (!/\.(js|mjs|json|md|cmd|ps1|py|html|css|txt|yml|yaml)$/i.test(f)) continue
  if (SELF_EXCLUDE.test(f)) continue
  const p = path.join(REPO, f)
  let text = ''
  try {
    const buf = fs.readFileSync(p)
    // .cmd 用 GBK 解，其他 UTF-8
    text = f.endsWith('.cmd')
      ? new TextDecoder('gbk').decode(buf)
      : buf.toString('utf8')
  } catch { continue }
  for (const [re, desc] of CONTENT_RULES) {
    const m = re.exec(text)
    if (m) {
      // 排除明显的「示例/说明」上下文
      const around = text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' ')
      violations.push({ file: f, desc, snippet: around.slice(0, 120) })
    }
  }
}
if (violations.length === 0) {
  console.log('  ✅ 未发现敏感内容')
  pass++
} else {
  fail++
  console.log(`  ❌ 发现 ${violations.length} 处可疑内容:`)
  violations.forEach((v) => {
    console.log(`     ${v.file}  [${v.desc}]`)
    console.log(`        ...${v.snippet}...`)
  })
}

// ── 7.5 settings.json 是否存在 ──
console.log('')
console.log('--- 配置文件 ---')
T('无 data/settings.json', !files.includes('data/settings.json'))
T('无 chats.json', !files.some((f) => /chats\.json$/.test(f)))
T('无 quiz-evidence.json', !files.some((f) => /quiz-evidence\.json$/.test(f)))
T('无 course-logs', !files.some((f) => /course-logs\//.test(f)))

// ── 7.6 大文件 ──
console.log('')
console.log('--- 大文件（> 500KB 需确认是否必要）---')
const big = files.map((f) => ({ f, size: fs.statSync(path.join(REPO, f)).size }))
  .filter((x) => x.size > 500 * 1024)
  .sort((a, b) => b.size - a.size)
if (!big.length) {
  console.log('  ✅ 无 > 500KB 的文件')
  pass++
} else {
  for (const b of big) {
    const known = b.f.includes('font-table.js')
    console.log(`  ${known ? 'ℹ️' : '⚠️'} ${b.f}  ${(b.size / 1024).toFixed(0)}KB${known ? '（字形映射表，必要）' : ''}`)
  }
  if (big.every((b) => b.f.includes('font-table.js'))) {
    console.log('  ✅ 仅 font-table.js 是大文件（数据必需）')
    pass++
  }
}

// ── 7.7 文件总数与总大小 ──
console.log('')
console.log('--- 仓库规模 ---')
const totalSize = files.reduce((a, f) => a + fs.statSync(path.join(REPO, f)).size, 0)
console.log(`  文件数: ${files.length}`)
console.log(`  总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
T('总大小 < 3MB（合理）', totalSize < 3 * 1024 * 1024, `${(totalSize / 1024 / 1024).toFixed(2)}MB`)

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
if (fails.length) {
  console.log('')
  console.log('失败项:')
  fails.forEach((x) => console.log('  - ' + x))
}
process.exit(fail === 0 ? 0 : 1)
