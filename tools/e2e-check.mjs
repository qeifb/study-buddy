/**
 * 第 9 项：端到端实测。
 *
 * 从 dist/study-buddy.zip 解压，模拟「全新电脑」：
 *   · PATH 里没有 node（模拟未装 Node.js）
 *   · 没有 tools/pyenv（模拟未装转写环境）
 *   · 没有 runtime/
 *
 * 测三个关键点：
 *   1. 自动装 Node → 启动应用
 *   2. 转写环境询问出现（跳过路径）
 *   3. 转写环境询问出现（Y 路径，用假 ps1 避免真下 1.6GB）
 *   4. ★ 结束后 .cmd 中文不乱码（这是用户报的 bug）
 */
import fs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

const ZIP = 'E:/StudyBuddy/dist/study-buddy.zip'
const BASE = 'E:/StudyBuddy/__e2e_sys'

function fresh(label, opts = {}) {
  const T = `${BASE}_${label}`
  fs.rmSync(T, { recursive: true, force: true })
  fs.mkdirSync(T, { recursive: true })
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${ZIP.replace(/\//g, '\\')}', '${T.replace(/\//g, '\\')}')`
  ], { encoding: 'utf8' })

  // 造假的 electron.exe（跳过 230MB 下载，那步已单独验证过多次）
  fs.mkdirSync(T + '/app/node_modules/electron/dist', { recursive: true })
  fs.writeFileSync(T + '/app/node_modules/electron/dist/electron.exe', 'fake', 'utf8')

  // 把 start 换成 echo，避免真拉起 Electron（本项目无关测试）
  const pkg = JSON.parse(fs.readFileSync(T + '/app/package.json', 'utf8'))
  pkg.scripts = pkg.scripts || {}
  pkg.scripts.start = 'node -e "console.log(String.fromCharCode(91,84,69,83,84,93)+String.fromCharCode(32)+String.fromCharCode(97,112,112,45,108,97,117,110,99,104,101,100))"'
  fs.writeFileSync(T + '/app/package.json', JSON.stringify(pkg, null, 2), 'utf8')

  if (opts.fakeTranscribe) {
    fs.writeFileSync(T + '/tools/setup-transcribe.ps1',
      '\uFEFFWrite-Output "[FAKE-TRANSCRIBE] called"\nexit 0\n', 'utf8')
  }
  return T
}

async function run(T, answer, timeoutMs = 300000) {
  const sysPath = 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\;C:\\Windows\\System32\\OpenSSH\\'
  const outFile = T + '/_out.txt'

  const child = spawn('cmd.exe', ['/c', T + '\\启动学习通学伴.cmd'], {
    cwd: T,
    env: { ...process.env, PATH: sysPath, SystemRoot: 'C:\\Windows', TEMP: process.env.TEMP, TMP: process.env.TMP },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let out = ''
  child.stdout.on('data', (d) => { out += new TextDecoder('gbk').decode(d) })
  child.stderr.on('data', (d) => { out += new TextDecoder('gbk').decode(d) })

  let answered = false
  const iv = setInterval(() => {
    if (!answered && /现在准备转写环境吗/.test(out)) {
      try { child.stdin.write(answer + '\r\n') } catch { /* ignore */ }
      answered = true
    }
  }, 400)

  const res = await new Promise((resolve) => {
    const tm = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve({ timeout: true }) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(tm); resolve({ code }) })
  })
  clearInterval(iv)
  try { child.stdin.write('\r\n\r\n') ; child.stdin.end() } catch { /* ignore */ }
  return { out, ...res }
}

let pass = 0, fail = 0
function T2(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

// ══════════ 场景 A：全新环境，转写环境选「跳过」 ══════════
console.log('=== A. 全新电脑（无 Node 无 Python），跳过转写环境 ===')
{
  const T = fresh('a', {})
  const r = await run(T, '', 360000)
  console.log(`  退出码: ${r.code}${r.timeout ? ' (超时)' : ''}`)
  console.log('  --- 输出 ---')
  r.out.split('\n').map((l) => l.trimEnd()).filter(Boolean).forEach((l) => console.log('    ' + l))
  console.log('  --- 结束 ---')

  T2('自动检测未装 Node', /未检测到 Node\.js/.test(r.out))
  T2('便携版 Node 装好', fs.existsSync(T + '/runtime/node/node.exe'), fs.existsSync(T + '/runtime/node/node.exe') ? (fs.statSync(T + '/runtime/node/node.exe').size / 1048576).toFixed(0) + 'MB' : '')
  T2('询问转写环境', /现在准备转写环境吗/.test(r.out))
  T2('跳过转写环境', /已跳过|正在启动学习通学伴/.test(r.out))
  T2('应用启动', /\[TEST\] app-launched/.test(r.out))
  T2('★ 无乱码（用户报的 bug）', !/[\ufffd]{2,}/.test(r.out) && !/锟斤拷/.test(r.out))
  T2('无「不是内部或外部命令」', !/不是内部或外部命令/.test(r.out))
  fs.rmSync(T, { recursive: true, force: true })
}

// ══════════ 场景 B：选 Y 装转写环境（假 ps1）══════════
console.log('')
console.log('=== B. 全新电脑，选 Y 走转写环境安装（用假 ps1 跳过 1.6GB）===')
{
  const T = fresh('b', { fakeTranscribe: true })
  const r = await run(T, 'Y', 360000)
  console.log(`  退出码: ${r.code}${r.timeout ? ' (超时)' : ''}`)
  console.log('  --- 关键输出 ---')
  r.out.split('\n').map((l) => l.trimEnd()).filter(Boolean)
    .filter((l) => /转写|FAKE|准备|启动|TEST/.test(l))
    .forEach((l) => console.log('    ' + l))
  console.log('  --- 结束 ---')

  T2('询问出现', /现在准备转写环境吗/.test(r.out))
  T2('调用了 setup-transcribe', /FAKE-TRANSCRIBE/.test(r.out))
  T2('应用启动', /\[TEST\] app-launched/.test(r.out))
  T2('★ 无乱码（ps1 退出后）', !/[\ufffd]{2,}/.test(r.out) && !/锟斤拷/.test(r.out))

  // 关键：检查 .cmd 在 ps1 之后的中文
  const afterPs = r.out.split('[FAKE-TRANSCRIBE]')[1] || ''
  T2('★ ps1 之后 .cmd 中文正常', /正在启动学习通学伴/.test(afterPs) || /正在启动/.test(afterPs),
    afterPs.includes('锟') ? '仍乱码' : '')
  fs.rmSync(T, { recursive: true, force: true })
}

// ══════════ 场景 C：已有 pyenv，应跳过询问 ══════════
console.log('')
console.log('=== C. 已有转写环境，应直接跳过询问 ===')
{
  const T = fresh('c', {})
  fs.mkdirSync(T + '/tools/pyenv/Scripts', { recursive: true })
  fs.writeFileSync(T + '/tools/pyenv/Scripts/python.exe', 'fake-py', 'utf8')
  const r = await run(T, 'Y', 360000)
  console.log(`  退出码: ${r.code}`)
  T2('未询问转写环境', !/现在准备转写环境吗/.test(r.out))
  T2('应用启动', /\[TEST\] app-launched/.test(r.out))
  T2('无乱码', !/[\ufffd]{2,}/.test(r.out))
  fs.rmSync(T, { recursive: true, force: true })
}

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}  失败 ${fail}`)
console.log(fail === 0 ? '  ✅ 端到端全部通过' : '  ❌ 有问题')
process.exit(fail === 0 ? 0 : 1)
