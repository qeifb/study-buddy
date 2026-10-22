/**
 * 浏览器启动器：为应用单独维护一个「专用浏览器」。
 *
 * 用户明确选择了「另建一个专用浏览器，不碰日常那个」——
 * 所以这里的原则是：**永远不关闭用户的日常浏览器**，
 * 只用应用自己的 profile 目录，用户在里面登录一次学习通，之后长期复用。
 */
const { spawn, execFile } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 专用 profile 根目录（与用户日常浏览器完全隔离），统一放在 <root>\browser-profile */
const { BROWSER_PROFILE_DIR } = require('./paths')
const DEDICATED_ROOT = BROWSER_PROFILE_DIR

const EXE_CANDIDATES = {
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
}

const EXE_NAME = { edge: 'msedge.exe', chrome: 'chrome.exe' }

function resolveExe(browserId) {
  for (const p of EXE_CANDIDATES[browserId] || []) {
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

function psPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

function psJson(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(psPath(), ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const s = String(stdout || '').trim()
        if (!s) return resolve([])
        try {
          const j = JSON.parse(s)
          return resolve(Array.isArray(j) ? j : [j])
        } catch { return resolve([]) }
      })
  })
}

/** 专用 profile 目录 */
function dedicatedProfileDir(browserId = 'edge') {
  return path.join(DEDICATED_ROOT, browserId)
}

/** 专用浏览器是否已经在跑（只查我们自己的 profile，绝不看用户日常那个） */
async function listDedicatedProcesses(browserId = 'edge') {
  const exeName = EXE_NAME[browserId] || 'msedge.exe'
  const needle = dedicatedProfileDir(browserId).toLowerCase().replace(/'/g, "''")
  const script = `
$ErrorActionPreference='SilentlyContinue'
$needle = '${needle}'
Get-CimInstance Win32_Process -Filter "Name='${exeName}'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } |
  Select-Object ProcessId | ConvertTo-Json -Compress
`
  return psJson(script)
}

/** 只关专用浏览器（不碰日常那个） */
async function closeDedicated(browserId = 'edge') {
  const procs = await listDedicatedProcesses(browserId)
  for (const p of procs) {
    try { execFile('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true }, () => {}) } catch { /* ignore */ }
  }
  const dir = dedicatedProfileDir(browserId)
  for (let i = 0; i < 20; i++) {
    if (!fs.existsSync(path.join(dir, 'lockfile'))) break
    await sleep(300)
  }
  return { ok: true, closed: procs.length }
}

/**
 * 找一个可用的本地端口（从 base 往上试）。
 * 为什么需要：多个浏览器/多个应用实例可能都想用 9222，固定端口必然打架。
 */
function findFreePort(base = 9222, tries = 40) {
  const net = require('node:net')
  const tryPort = (p) => new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(p, '127.0.0.1')
  })
  return (async () => {
    for (let i = 0; i < tries; i++) {
      const p = base + i
      // eslint-disable-next-line no-await-in-loop
      if (await tryPort(p)) return p
    }
    throw new Error(`找不到可用端口（试了 ${base} 到 ${base + tries - 1}）`)
  })()
}

/**
 * 启动（或复用）专用浏览器。
 * @param {{browserId?:string, port?:number, url?:string, fresh?:boolean}} opts
 * @returns {Promise<{ok:true, port:number, browser:string, reused:boolean}>}
 */
async function launchDedicated({ browserId = 'edge', port, url, fresh = false }) {
  const exe = resolveExe(browserId)
  if (!exe) throw new Error('这台电脑上没找到 Edge 或 Chrome，无法启动专用浏览器。')

  const dir = dedicatedProfileDir(browserId)
  fs.mkdirSync(dir, { recursive: true })

  // 已经在跑就直接复用；如果给了 url，额外开一个标签页过去
  if (!fresh) {
    const running = await listDedicatedProcesses(browserId)
    if (running.length > 0) {
      // 复用时要先知道它实际用的端口：优先读 DevToolsActivePort 文件
      const activePort = readActivePort(dir) || port
      if (activePort) {
        try {
          const r = await fetch(`http://127.0.0.1:${activePort}/json/version`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) {
            const j = await r.json()
            if (url) {
              try {
                await fetch(`http://127.0.0.1:${activePort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) })
              } catch { /* 开标签失败不致命 */ }
            }
            return { ok: true, port: activePort, browser: j.Browser || '', reused: true }
          }
        } catch { /* 端口没起，往下走重开 */ }
      }
      await closeDedicated(browserId)
    }
  }

  try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }) } catch { /* ignore */ }

  // 端口自动避让：不再死磕 9222
  const chosenPort = port || await findFreePort(9222)

  const args = [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${chosenPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msImplicitSignin,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1360,900',
    url || 'about:blank',
  ]

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${chosenPort}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) {
        const j = await r.json()
        return { ok: true, port: chosenPort, browser: j.Browser || '', reused: false }
      }
    } catch { /* 继续等 */ }
    await sleep(400)
  }
  throw new Error(`专用浏览器已启动，但调试端口 ${chosenPort} 没起来。可能被安全软件拦，或端口被占。`)
}

/** 读 Chromium 写下的实际调试端口 */
function readActivePort(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8')
    const n = Number(String(txt).split(/\r?\n/)[0])
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** 专用浏览器里已登录的站点检查（判断用户是否需要登录学习通） */
async function dedicatedLoginState(port = 9222) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
    const tabs = await res.json()
    const pages = (Array.isArray(tabs) ? tabs : []).filter((t) => t.type === 'page')
    const loginTab = pages.find((t) => /passport2\.chaoxing|passport\.chaoxing/.test(String(t.url || '')))
    return { loggedIn: !loginTab, tabs: pages.map((t) => ({ title: t.title, url: t.url })) }
  } catch {
    return { loggedIn: false, tabs: [] }
  }
}

module.exports = {
  launchDedicated,
  closeDedicated,
  listDedicatedProcesses,
  dedicatedProfileDir,
  dedicatedLoginState,
  findFreePort,
  readActivePort,
  DEDICATED_ROOT,
  resolveExe,
}
