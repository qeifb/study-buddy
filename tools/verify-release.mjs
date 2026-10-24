/**
 * 第 10 项：从 GitHub Release 实际下载，验证发布产物。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const env = { ...process.env, GH_TOKEN: token }
const REPO = 'qeifb/study-buddy'
// TAG 不再写死（曾因写死 v0.3.2 导致发布 v0.3.3 后仍验证旧包）
const TAG = process.argv[2] || (() => {
  try {
    const meta = JSON.parse(fs.readFileSync('E:/StudyBuddy/dist/_release-meta.json', 'utf8'))
    return meta.tag || meta.version || 'latest'
  } catch { return 'latest' }
})()
const DL = 'E:/StudyBuddy/__rel'
fs.rmSync(DL, { recursive: true, force: true })
fs.mkdirSync(DL, { recursive: true })

let pass = 0, fail = 0
const fails = []
function T(n, ok, d) {
  if (ok) pass++
  else { fail++; fails.push(`${n} ${d || ''}`) }
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`)
}

console.log('=== 1. Release 元数据（tag=' + TAG + '）===')
const rel = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/releases/tags/${TAG}`], { encoding: 'utf8', env }))
console.log(`  tag=${rel.tag_name}  draft=${rel.draft}  prerelease=${rel.prerelease}`)
console.log(`  正文行数=${rel.body.split('\n').length}`)
T('不是 draft', rel.draft === false)
T('不是 prerelease', rel.prerelease === false)
T('正文 > 100 行', rel.body.split('\n').length > 100, `${rel.body.split('\n').length}`)
T('有两个附件', rel.assets.length === 2, `${rel.assets.length}`)
for (const a of rel.assets) console.log(`   - ${a.name}  ${a.size} 字节  ${(a.size / 1024).toFixed(1)}KB`)

console.log('')
console.log('=== 2. 下载并校验 SHA256 ===')
execFileSync('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', 'study-buddy.zip', '--dir', DL, '--clobber'], { encoding: 'utf8', env })
const zipPath = DL + '/study-buddy.zip'
const buf = fs.readFileSync(zipPath)
const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
const local = JSON.parse(fs.readFileSync('E:/StudyBuddy/dist/_release-meta.json', 'utf8')).mainZip.sha256
const apiAsset = rel.assets.find((a) => a.name === 'study-buddy.zip')
T('下载大小与 API 一致', buf.length === apiAsset.size, `${buf.length} vs ${apiAsset.size}`)
T('SHA256 与本地打包一致', sha === local, sha.slice(0, 16))

console.log('')
console.log('=== 3. 解压核对结构 ===')
const EX = DL + '/x'
fs.mkdirSync(EX, { recursive: true })
execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/\//g, '\\')}', '${EX.replace(/\//g, '\\')}')`
], { encoding: 'utf8' })

const tops = fs.readdirSync(EX, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
console.log('  顶层内容:')
for (const d of tops) {
  if (d.isDirectory()) {
    const cnt = fs.readdirSync(EX + '/' + d.name, { recursive: true }).length
    console.log(`    📁 ${d.name.padEnd(14)} (${cnt} 项)`)
  } else {
    const sz = fs.statSync(EX + '/' + d.name).size
    console.log(`    📄 ${d.name}  ${(sz / 1024).toFixed(1)}KB`)
  }
}
T('有 app/', fs.existsSync(EX + '/app'))
T('有 tools/', fs.existsSync(EX + '/tools'))
T('有 docs/', fs.existsSync(EX + '/docs'))
T('有 README.md', fs.existsSync(EX + '/README.md'))
T('有 LICENSE', fs.existsSync(EX + '/LICENSE'))
T('有 THIRD-PARTY.md', fs.existsSync(EX + '/THIRD-PARTY.md'))
T('有 启动学习通学伴.cmd', fs.existsSync(EX + '/启动学习通学伴.cmd'))
T('无 extension-focus-only/', !fs.existsSync(EX + '/extension-focus-only'))
T('无 node_modules/', !fs.existsSync(EX + '/app/node_modules'))
T('无 pyenv/', !fs.existsSync(EX + '/tools/pyenv'))
T('无 models/', !fs.existsSync(EX + '/tools/models'))
T('无 python/', !fs.existsSync(EX + '/tools/python'))
T('无 runtime/', !fs.existsSync(EX + '/runtime'))

console.log('')
console.log('=== 4. 扩展 ===')
const EXT = EX + '/app/extension'
const extFiles = fs.readdirSync(EXT).filter((f) => fs.statSync(EXT + '/' + f).isFile())
const mf = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'))
T('app/extension 13 文件', extFiles.length === 13, `${extFiles.length}`)
// 版本号不写死，从本地 repo 的 manifest 读期望值（否则每次发版都要改这里）
const expectVer = (() => {
  try { return JSON.parse(fs.readFileSync('E:/StudyBuddy/repo/app/extension/manifest.json', 'utf8')).version }
  catch { return null }
})()
T('manifest 版本与本地一致', !expectVer || mf.version === expectVer, 'release=' + mf.version + ' local=' + expectVer)
T('manifest 名称正确', mf.name === '学习通学伴', mf.name)
T('无 _ 开头文件名', !extFiles.some((f) => f.startsWith('_')))
T('含 font-table.js', extFiles.includes('font-table.js'))

console.log('')
console.log('=== 5. 关键脚本编码 ===')
const cbuf = fs.readFileSync(EX + '/启动学习通学伴.cmd')
const ctext = new TextDecoder('gbk').decode(cbuf)
const cjk = (ctext.match(/[\u4e00-\u9fa5]/g) || []).length
const loneLF = (ctext.match(/(?<!\r)\n/g) || []).length
T('.cmd 无单独 LF', loneLF === 0, `LF=${loneLF}`)
T('.cmd 非 UTF-8（GBK）', !Buffer.from(cbuf.toString('utf8'), 'utf8').equals(cbuf))
T('.cmd 无 BOM', !(cbuf[0] === 0xEF))
T('.cmd 中文可读', cjk > 500, `${cjk} 汉字`)
T('.cmd 含 Node 三档检测', /where node >nul 2>&1/.test(ctext) && /:download_node/.test(ctext))
T('.cmd 含 Python/转写检查', /现在准备转写环境吗/.test(ctext))

const pbuf = fs.readFileSync(EX + '/tools/setup-transcribe.ps1')
const ptext = new TextDecoder('utf8').decode(pbuf).replace(/^\uFEFF/, '')
T('.ps1 有 BOM', pbuf[0] === 0xEF)
T('.ps1 全 CRLF', (ptext.match(/(?<!\r)\n/g) || []).length === 0)
T('.ps1 含编码恢复', /Restore-ConsoleEncoding/.test(ptext))
T('.ps1 含多镜像重试', /foreach \(\$round in 1\.\.2\)/.test(ptext))
T('.ps1 含便携版 Python', /python-build-standalone/.test(ptext))

console.log('')
console.log('=== 6. tools 目录 ===')
const tools = fs.readdirSync(EX + '/tools').sort()
tools.forEach((f) => console.log(`    ${f}  ${(fs.statSync(EX + '/tools/' + f).size / 1024).toFixed(1)}KB`))
T('tools 含 transcribe.py', tools.includes('transcribe.py'))
T('tools 含 setup-transcribe.ps1', tools.includes('setup-transcribe.ps1'))
T('无临时脚本（_ 开头）', !tools.some((f) => f.startsWith('_')))
// 关键：所有自检脚本都应随包分发，让用户能自己复核
const MUST_TOOLS = ['check-all.mjs', 'check-encoding.mjs', 'check-manifest-appsync.mjs',
  'check-readme-consistency.mjs', 'check-secrets.mjs', 'e2e-check.mjs']
const missingTools = MUST_TOOLS.filter((f) => !tools.includes(f))
T(`tools 含全部 ${MUST_TOOLS.length} 个自检脚本`, missingTools.length === 0, missingTools.join(', '))

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
if (fails.length) { console.log('失败项:'); fails.forEach((x) => console.log('  - ' + x)) }
console.log(fail === 0 ? '  ✅ Release 产物完全合格' : '  ❌ 有问题')

fs.rmSync(DL, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
