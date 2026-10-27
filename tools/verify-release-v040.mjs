/**
 * 发布回验（针对三个附件，含 1.4GB 离线版的轻量校验策略）。
 *
 * 策略：
 *   · study-buddy.zip（689KB）→ 完整下载 + SHA256 + 解压结构验证
 *   · focus-only（5.2KB）→ 完整下载 + SHA256
 *   · offline（1.4GB）→ 不下载（太慢），校验：
 *       ① API 报告的 size 与本地 meta 完全一致
 *       ② 附件 state=uploaded
 *       ③ 用 Range 请求取头尾若干字节，做「部分哈希」与本地文件对照
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const env = { ...process.env, GH_TOKEN: token }
const REPO = 'qeifb/study-buddy'
const TAG = 'v0.4.0'
const DL = 'E:/StudyBuddy/__rel40'
fs.rmSync(DL, { recursive: true, force: true })
fs.mkdirSync(DL, { recursive: true })

let pass = 0, fail = 0
function T(n, ok, d) {
  if (ok) pass++
  else { fail++; }
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`)
}

const meta = JSON.parse(fs.readFileSync('E:/StudyBuddy/dist/_release-meta.json', 'utf8'))

console.log('=== 1. Release 元数据 ===')
const rel = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/releases/tags/${TAG}`], { encoding: 'utf8', env }))
console.log(`  tag=${rel.tag_name}  draft=${rel.draft}  prerelease=${rel.prerelease}  正文行数=${rel.body.split('\n').length}`)
T('非 draft', rel.draft === false)
T('非 prerelease', rel.prerelease === false)
T('正文 > 100 行', rel.body.split('\n').length > 100, `${rel.body.split('\n').length}`)
T('三个附件', rel.assets.length === 3, `${rel.assets.length}`)

console.log('')
console.log('=== 2. 三个附件的大小与本地 meta 对照 ===')
const pairs = [
  ['study-buddy.zip', meta.mainZip],
  ['study-buddy-focus-only.zip', meta.focusZip],
  ['study-buddy-offline.zip', meta.offlineZip],
]
for (const [name, m] of pairs) {
  const a = rel.assets.find((x) => x.name === name)
  if (!a) { T(`${name} 存在`, false, '附件缺失'); continue }
  console.log(`  ${name}`)
  T(`  state=uploaded`, a.state === 'uploaded', a.state)
  T(`  size 与本地一致`, a.size === m.size, `API=${a.size} 本地=${m.size}`)
}

console.log('')
console.log('=== 3. 下载小包完整校验 ===')
for (const [name, m] of [['study-buddy.zip', meta.mainZip], ['study-buddy-focus-only.zip', meta.focusZip]]) {
  execFileSync('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', name, '--dir', DL, '--clobber'], { encoding: 'utf8', env })
  const buf = fs.readFileSync(DL + '/' + name)
  const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
  T(`${name} SHA256 一致`, sha === m.sha256, sha.slice(0, 16))
}

console.log('')
console.log('=== 4. 离线版：Range 部分哈希校验（不下载 1.4GB）===')
const off = rel.assets.find((x) => x.name === 'study-buddy-offline.zip')
const offUrl = off.browser_download_url
const localPath = 'E:/StudyBuddy/dist/study-buddy-offline.zip'
const localSize = fs.statSync(localPath).size

// 取 3 段：头部 64KB、中间 64KB、尾部 64KB
const CHUNK = 64 * 1024
const ranges = [
  [0, CHUNK - 1],
  [Math.floor(localSize / 2), Math.floor(localSize / 2) + CHUNK - 1],
  [localSize - CHUNK, localSize - 1],
]

console.log(`  本地大小: ${localSize} 字节`)
let allMatch = true
for (const [start, end] of ranges) {
  const r = await fetch(offUrl, {
    headers: { Range: `bytes=${start}-${end}` },
    redirect: 'follow',
  })
  if (r.status !== 206) {
    console.log(`  ⚠️ Range 请求返回 ${r.status}（可能需要重定向）`)
    allMatch = false
    continue
  }
  const remote = Buffer.from(await r.arrayBuffer())

  // 读本地同区间
  const fd = fs.openSync(localPath, 'r')
  const local = Buffer.alloc(remote.length)
  fs.readSync(fd, local, 0, remote.length, start)
  fs.closeSync(fd)

  const rh = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12)
  const lh = crypto.createHash('sha256').update(local).digest('hex').slice(0, 12)
  const ok = rh === lh
  if (!ok) allMatch = false
  console.log(`  [${start}..${end}] 远端=${rh} 本地=${lh} ${ok ? '✅' : '❌'}`)
}
T('离线版三段抽样哈希与本地一致', allMatch)

console.log('')
console.log('=== 5. 小包解压结构核对 ===')
const EX = DL + '/x'
fs.mkdirSync(EX, { recursive: true })
execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${(DL + '/study-buddy.zip').replace(/\//g, '\\')}', '${EX.replace(/\//g, '\\')}')`
], { encoding: 'utf8' })

T('有 app/', fs.existsSync(EX + '/app'))
T('有 tools/', fs.existsSync(EX + '/tools'))
T('有 docs/', fs.existsSync(EX + '/docs'))
T('有 启动学习通学伴.cmd', fs.existsSync(EX + '/启动学习通学伴.cmd'))
T('无 data/', !fs.existsSync(EX + '/data'))
T('无 tools/models（这是无模型版）', !fs.existsSync(EX + '/tools/models'))
T('无 pyenv/', !fs.existsSync(EX + '/tools/pyenv'))

const mf = JSON.parse(fs.readFileSync(EX + '/app/extension/manifest.json', 'utf8'))
T('manifest 版本 0.6.5', mf.version === '0.6.5', mf.version)
T('app/extension 13 文件', fs.readdirSync(EX + '/app/extension').filter((f) => fs.statSync(EX + '/app/extension/' + f).isFile()).length === 13)

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
console.log(fail === 0 ? '  ✅ v0.4.0 发布物全部合格' : '  ❌ 有问题')
fs.rmSync(DL, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
