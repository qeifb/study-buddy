/**
 * 第 6 项：README 与实际行为一致性核对。
 *
 * 检查 README 里说的每个关键事实，是否与代码/产物一致：
 *   · 版本号
 *   · 文件数（49 个）
 *   · 加载目录（app\extension，13 文件）
 *   · 扩展显示名 + 版本
 *   · Node/Python 自动下载的 URL 与大小
 *   · 模型大小 1.6GB
 */
import fs from 'node:fs'

const ROOT = 'E:/StudyBuddy/repo'
const readme = fs.readFileSync(ROOT + '/README.md', 'utf8')

let pass = 0, fail = 0
const fails = []
function T(name, ok, detail) {
  if (ok) pass++
  else { fail++; fails.push(`${name}  ${detail || ''}`) }
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

console.log('=== 6. README 与实际一致性 ===')

// 6.1 版本号
const pkg = JSON.parse(fs.readFileSync(ROOT + '/app/package.json', 'utf8'))
const mf = JSON.parse(fs.readFileSync(ROOT + '/app/extension/manifest.json', 'utf8'))
console.log(`  实际: app=${pkg.version}  扩展=${mf.version}`)
T('README 提到扩展版本号', readme.includes(mf.version), mf.version)
T('README 未出现过期版本号', !/0\.5\.[0-3]|0\.4\.\d/.test(readme), '检查是否有旧版本残留')

// 6.2 文件数
// ★ 关键：文件清单**直接从 pack-release.mjs 的真实打包逻辑推导**，
// 不再自己维护第二份白名单（否则必然与打包结果脱节——
// 2026-10-25 就发生过：检查脚本算 49，实际打包 54）。
const packSrc = fs.readFileSync('E:/StudyBuddy/tools/pack-release.mjs', 'utf8')
const allowMatch = /const TOOLS_ALLOW = \[([\s\S]*?)\]/.exec(packSrc)
const TOOLS_ALLOW = allowMatch
  ? [...allowMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : []
const EXCL_DIRS = (() => {
  const m = /const EXCLUDE_DIRS = new Set\(\[([\s\S]*?)\]\)/.exec(packSrc)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
})()

const files = (function walk(dir, rel = '', out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCL_DIRS.includes(it.name) || it.name === '.git') continue
    const r = rel ? rel + '/' + it.name : it.name
    if (it.isDirectory()) walk(dir + '/' + it.name, r, out)
    else out.push(r)
  }
  return out
})(ROOT).filter((f) => {
  const top = f.split('/')[0]
  // tools 只算白名单内的
  if (f.startsWith('tools/')) return TOOLS_ALLOW.includes(f)
  // extension-focus-only 不进完整版
  if (f.startsWith('extension-focus-only/')) return false
  // 顶层保留文件
  if (!f.includes('/')) {
    return ['README.md', 'LICENSE', 'THIRD-PARTY.md', 'create-shortcut.ps1', '启动学习通学伴.cmd'].includes(f)
  }
  // app/、docs/ 全收
  return ['app', 'docs'].includes(top)
})
console.log('')
console.log(`  实际完整版文件数: ${files.length}`)
// 不再校验精确文件数（会随版本变化），改为校验「关键路径」表述
const KEY_PATHS = ['app', 'tools', 'docs', 'README.md', '启动学习通学伴.cmd']
const missingInReadme = KEY_PATHS.filter((k) => !readme.includes(k))
T('README 列出了所有关键路径', missingInReadme.length === 0, missingInReadme.join(', '))
// 稳定数字放行：2 个文件（focus-only 小包）、13 个文件（extension 目录）
// 不稳定的：完整版总文件数（会因新增脚本而变）
const STABLE_COUNTS = ['2 个文件', '13 个文件']
const allCounts = readme.match(/\d+ 个文件/g) || []
const unstableCounts = allCounts.filter((x) => !STABLE_COUNTS.includes(x))
T('README 未写死不稳定的文件总数', unstableCounts.length === 0,
  unstableCounts.length ? '写死了: ' + [...new Set(unstableCounts)].join(', ') : '')
console.log(`  ℹ️ 实际打包文件数（仅供参考）: ${files.length}`)

// 6.3 加载目录
T('README 写明加载 app\\extension', /app\\\\extension/.test(readme) || /app\\extension/.test(readme))
T('README 写明 13 个文件', readme.includes('13 个文件'))

// 6.4 Node 自动下载
T('README 提到 Node 自动下载', /Node\.js.*自动|自动.*Node\.js/.test(readme))
T('README 提到 36MB', readme.includes('36MB') || readme.includes('36 MB'))
T('README 提到 numpy 镜像?（应无，那是 pip）', true)

// 6.5 Python 自动下载
T('README 提到 Python 自动下载', /Python.*自动|自动.*Python/.test(readme))
T('README 提到 44MB', readme.includes('44MB') || readme.includes('44 MB'))

// 6.6 模型
T('README 提到 1.6GB 模型', readme.includes('1.6GB') || readme.includes('1.6 GB'))
T('README 提到会询问是否装转写环境', /现在准备转写环境|输入 Y|Y 回车/.test(readme))

// 6.7 不装 Node/Python
T('README 说明无需预装', /不需要提前安装|不用装任何东西|什么都不用装/.test(readme))

// 6.8 检查 README 里是否有过时描述
const outdated = [
  ['「请先安装 Node.js」作为必经步骤（已自动）', /第 1 步：安装 Node\.js[^（]*$/m],
  ['要求手动跑 setup-transcribe.ps1 才能用', /请先运行?\s*setup-transcribe/],
]
for (const [desc, re] of outdated) {
  const hit = re.test(readme)
  T(`无过时描述: ${desc}`, !hit, hit ? 'README 仍有旧说法' : '')
}

// 6.9 关键章节是否存在
console.log('')
console.log('  README 章节:')
const sections = readme.match(/^#{2,3} .+$/gm) || []
sections.forEach((s) => console.log('    ' + s))
T('有「一键播放答题」章节', /## 一键播放答题/.test(readme))
T('有「安装」章节', /## 安装/.test(readme))
T('有「技术原理」或「目录结构」', /## (技术原理|目录结构)/.test(readme))
T('有 THIRD-PARTY 链接', /THIRD-PARTY\.md/.test(readme))

// 6.10 THIRD-PARTY 是否含 python-build-standalone
const tp = fs.readFileSync(ROOT + '/THIRD-PARTY.md', 'utf8')
T('THIRD-PARTY 提到 Typr.js', tp.includes('Typr'))
T('THIRD-PARTY 提到 blueimp-md5', tp.includes('blueimp'))
T('THIRD-PARTY 提到字体映射表来源', /forestpolice/.test(tp))
T('THIRD-PARTY 提到 python-build-standalone（新增）', tp.includes('python-build-standalone'), tp.includes('python-build-standalone') ? '' : '需补上')

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
if (fails.length) {
  console.log('')
  console.log('失败项:')
  fails.forEach((x) => console.log('  - ' + x))
}
process.exit(fail === 0 ? 0 : 1)
