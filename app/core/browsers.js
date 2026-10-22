/**
 * 浏览器发现与选择。
 *
 * 用户选了「另建专用浏览器」方案，所以这里的原则变了：
 *   · 列表 = 【专用浏览器】+【你自己开着的、碰巧开了调试端口的浏览器】
 *   · 不枚举、不推荐、绝不关闭用户的日常浏览器
 *
 * 用户仍可自己选：如果他确实想让应用抓日常那个（前提是他自己已经用调试模式开的），也支持。
 */
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  dedicatedProfileDir,
  listDedicatedProcesses,
  dedicatedLoginState,
} = require('./launcher')

const DEDICATED_PORT = 9222

function psPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

function psJson(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(psPath(), ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const s = String(stdout || '').trim()
        if (!s) return resolve([])
        try { const j = JSON.parse(s); return resolve(Array.isArray(j) ? j : [j]) } catch { return resolve([]) }
      })
  })
}

async function probePort(port) {
  if (!port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 列出所有带 --remote-debugging-port 的浏览器进程（用户自己开的也算） */
async function listDebugPortProcesses() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe' OR Name='chromium.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match '--remote-debugging-port=(\\d+)' } |
  Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress
`
  return psJson(script)
}

function portOf(commandLine) {
  const m = /--remote-debugging-port=(\d+)/i.exec(String(commandLine || ''))
  return m ? Number(m[1]) : null
}

function profileDirOf(commandLine) {
  const m = /--user-data-dir=(?:"([^"]+)"|([^\s]+))/i.exec(String(commandLine || ''))
  if (!m) return null
  return (m[1] || m[2] || '').replace(/^["']|["']$/g, '')
}

/**
 * 给界面用的浏览器列表。
 * 第一项永远是「专用浏览器」（可一键启动），其余是碰巧开了调试端口的其它浏览器。
 */
async function listBrowsers() {
  const out = []

  // ── 1) 专用浏览器（推荐入口） ──
  const dedicatedDir = dedicatedProfileDir('edge')
  const dedicatedRunning = await listDedicatedProcesses('edge')
  const dedicatedVer = dedicatedRunning.length ? await probePort(DEDICATED_PORT) : null

  let login = { loggedIn: false, tabs: [] }
  if (dedicatedVer) {
    try { login = await dedicatedLoginState(DEDICATED_PORT) } catch { /* ignore */ }
  }

  out.push({
    id: `cdp:${DEDICATED_PORT}`,
    label: '学伴专用浏览器',
    detail: dedicatedVer
      ? (login.loggedIn
        ? `运行中 · 已打开 ${login.tabs.length} 个页面`
        : '运行中 · 还没登录学习通')
      : '未启动（首次使用需要登录一次学习通）',
    ready: Boolean(dedicatedVer),
    dedicated: true,
    port: DEDICATED_PORT,
    profileDir: dedicatedDir,
    needsLogin: Boolean(dedicatedVer) && !login.loggedIn,
    tabs: login.tabs,
  })

  // ── 2) 其它开了调试端口的浏览器（用户自己开的） ──
  const procs = await listDebugPortProcesses()
  const seen = new Set([DEDICATED_PORT])
  for (const p of procs) {
    const port = portOf(p.CommandLine)
    if (!port || seen.has(port)) continue
    const dir = profileDirOf(p.CommandLine)
    // 跳过我们自己的专用 profile（已在上面列出）
    if (dir && path.normalize(dir).toLowerCase() === path.normalize(dedicatedDir).toLowerCase()) continue
    const ver = await probePort(port)
    if (!ver) continue
    seen.add(port)
    out.push({
      id: `cdp:${port}`,
      label: `${String(p.Name).replace('.exe', '')}（调试端口 ${port}）`,
      detail: ver.Browser || '',
      ready: true,
      dedicated: false,
      port,
      profileDir: dir || '',
      tabs: [],
    })
  }

  return out
}

/** 连接到指定浏览器 */
async function attachToBrowser(browserId) {
  const m = /^cdp:(\d+)$/.exec(String(browserId || ''))
  if (!m) throw new Error('这个浏览器没有开启调试端口，无法抓取。')
  const port = Number(m[1])
  const ver = await probePort(port)
  if (!ver) throw new Error(`连不上端口 ${port}，浏览器可能已关闭。`)
  return { port, wsUrl: ver.webSocketDebuggerUrl, browser: ver.Browser || '' }
}

module.exports = { listBrowsers, attachToBrowser, DEDICATED_PORT }
