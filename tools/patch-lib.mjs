/**
 * 补丁机制的公共库（2026-10-27）
 *
 * 设计要点
 * ────────
 * 1. 补丁只覆盖「代码/文本」文件，永不包含 electron/dist、pyenv、models。
 *    这些大块二进制一旦变化就重新发完整包，不靠补丁。
 * 2. 因此同一个补丁可以应用到「完整版 / 离线版 / 极简版」任意一种安装上，
 *    因为它们的代码文件集合是一致的。
 * 3. 版本号唯一来源 = app/package.json 的 version。
 * 4. 清单（manifest）记录每个补丁范围内文件的 sha256，用来：
 *    - 生成补丁时判断哪些文件变了
 *    - 应用补丁时校验解压出来的文件没坏
 *    - 应用补丁时发现「用户本地改过这个文件」
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const ROOT = 'E:/StudyBuddy'
export const OUT_DIR = 'E:/StudyBuddy-Release'

/* ── 补丁范围 ──
 * 命名上宁可保守：漏掉一个文件只是让用户重下完整包，
 * 误收一个大文件会让补丁变成几十兆，失去意义。 */

/* 这些目录段出现在任意层级都拒绝（不放进补丁） */
const DENY_SEG = new Set([
  'node_modules', 'pyenv', 'models', 'dist', 'data', 'runtime',
  'browser-profile', 'cache', 'repo', 'archive', 'publish', 'docs',
  '__pycache__', '.git', '.agent-teams', '.dsh-meow', '.vscode',
])

/* 允许的扩展名 */
const ALLOW_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.py',
  '.ps1', '.cmd', '.svg', '.png', '.ico', '.txt', '.yml', '.yaml',
])

/* 单文件上限：超过就不进补丁（宁可让用户重下） */
export const MAX_FILE = 8 * 1024 * 1024

/* 垃圾文件 */
const JUNK_RE = /(\.log$|\/Thumbs\.db$|\/desktop\.ini$|\.pyc$|\.tmp$|~$)/

export function isPatchable(rel) {
  const segs = rel.split('/')
  if (segs.some((s) => DENY_SEG.has(s))) return false
  const base = segs[segs.length - 1]
  if (base.startsWith('_')) return false            /* 临时脚本 */
  if (JUNK_RE.test('/' + rel)) return false
  const ext = path.extname(base).toLowerCase()
  if (!ALLOW_EXT.has(ext)) return false
  return true
}

export function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/* 递归走目录，返回补丁范围内所有文件（rel 用正斜杠） */
export function walkPatchable(root, rel = '', out = []) {
  let items = []
  try { items = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    const r = rel ? rel + '/' + it.name : it.name
    const abs = path.join(root, r)
    if (it.isDirectory()) {
      if (DENY_SEG.has(it.name)) continue
      walkPatchable(root, r, out)
    } else if (it.isFile()) {
      if (!isPatchable(r)) continue
      let st
      try { st = fs.statSync(abs) } catch { continue }
      if (st.size > MAX_FILE) continue
      out.push({ rel: r, abs, size: st.size, sha256: sha256File(abs) })
    }
  }
  return out
}

export function readAppVersion(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8'))
    return String(j.version || '')
  } catch { return '' }
}

/* 从清单文件读 {version, files:{rel:{size,sha256}}} */
export function loadManifest(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!j || !j.files) throw new Error(`清单格式不对：${file}`)
  return j
}

export function buildManifest(root, version) {
  const files = walkPatchable(root)
  const map = {}
  let bytes = 0
  for (const f of files) {
    map[f.rel] = { size: f.size, sha256: f.sha256 }
    bytes += f.size
  }
  return {
    kind: 'study-buddy-manifest',
    version,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: bytes,
    files: map,
  }
}

/* ── 从 zip 里取出补丁范围内的文件，生成清单 ──
 * 为什么需要：已发布的包才是「用户机器上真实存在的东西」，
 * 用当前工作目录生成基线会混进打包后又改过的文件。 */
export function manifestFromZip(zipPath, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-manifest-'))
  try {
    /* 让 PowerShell 只解出补丁范围内的条目（按扩展名粗筛，再交给 Node 精确判定） */
    const ps = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
      `$dst = '${tmp.replace(/'/g, "''")}'`,
      "foreach ($e in $z.Entries) {",
      "  $n = $e.FullName -replace '\\\\', '/'",
      "  if ($n.EndsWith('/')) { continue }",
      "  if ($n -notmatch '\\.(js|mjs|cjs|json|html|css|md|py|ps1|cmd|svg|png|ico|txt|yml|yaml)$') { continue }",
      "  if ($n -match '(^|/)(node_modules|pyenv|models|dist|data|runtime|browser-profile|cache|repo|archive|publish|docs|__pycache__)/') { continue }",
      "  $target = Join-Path $dst $n",
      "  $dir = Split-Path $target -Parent",
      "  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
      '  [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)',
      '}',
      '$z.Dispose()',
    ].join('\n')
    const psFile = path.join(tmp, '_extract.ps1')
    /* .ps1 必须是 UTF-8 BOM，否则 powershell -File 按 ANSI 读，中文会崩 */
    const body = Buffer.from(ps.replace(/\r?\n/g, '\r\n'), 'utf8')
    fs.writeFileSync(psFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]))
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
      stdio: 'pipe', windowsHide: true,
    })
    fs.rmSync(psFile, { force: true })

    const files = walkPatchable(tmp)
    const map = {}
    let bytes = 0
    for (const f of files) {
      map[f.rel] = { size: f.size, sha256: f.sha256 }
      bytes += f.size
    }
    /* 版本号直接从包内的 app/package.json 读，避免手填错 */
    const realVer = version || readAppVersion(tmp)
    return {
      kind: 'study-buddy-manifest',
      version: realVer,
      createdAt: new Date().toISOString(),
      source: path.basename(zipPath),
      fileCount: files.length,
      totalBytes: bytes,
      files: map,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/* ── 用 PowerShell 打补丁 zip（条目名用正斜杠，符合 ZIP 规范）──
 * 不用 Compress-Archive：它在 Windows PowerShell 5.1 里对条目分隔符不可控。 */
export function writePatchZip(zipPath, entries, extraFiles) {
  const listFile = path.join(os.tmpdir(), `sb-zip-${Date.now()}.json`)
  const psFile = listFile.replace(/\.json$/, '.ps1')
  const all = [
    ...entries.map((e) => ({ name: e.rel.replace(/\\/g, '/'), abs: e.abs })),
    ...extraFiles.map((e) => ({ name: e.rel.replace(/\\/g, '/'), abs: e.abs })),
  ]
  fs.writeFileSync(listFile, JSON.stringify(all), 'utf8')

  const ps = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$items = Get-Content -Raw -Encoding UTF8 '${listFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
    `$out = '${zipPath.replace(/'/g, "''")}'`,
    "if (Test-Path $out) { Remove-Item $out -Force }",
    "$zip = [IO.Compression.ZipFile]::Open($out, 'Create')",
    'try {',
    '  foreach ($it in $items) {',
    '    $entry = $zip.CreateEntry([string]$it.name, [IO.Compression.CompressionLevel]::Optimal)',
    '    $os = $entry.Open()',
    '    $fs = [IO.File]::OpenRead([string]$it.abs)',
    '    try { $fs.CopyTo($os) } finally { $fs.Dispose(); $os.Dispose() }',
    '  }',
    '} finally { $zip.Dispose() }',
  ].join('\n')
  const body = Buffer.from(ps.replace(/\r?\n/g, '\r\n'), 'utf8')
  fs.writeFileSync(psFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]))
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
      stdio: 'pipe', windowsHide: true,
    })
  } finally {
    fs.rmSync(listFile, { force: true })
    fs.rmSync(psFile, { force: true })
  }
}

/* ── 读出 zip 里「所有条目 → 未压缩大小」──
 * 不实体化，直接读 zip 中央目录，很快。
 * 用途：补丁只收代码/文本；如果大件（exe/dll/模型）也变了，
 * 必须明确告诉人「这个版本没法用补丁，得重发完整包」，
 * 绝不能悄悄漏掉导致用户装完补丁还是坏的。 */
export function zipEntrySizes(zipPath) {
  const ps = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
    'foreach ($e in $z.Entries) { if ($e.FullName.EndsWith("/")) { continue }; Write-Output ($e.FullName + "`t" + $e.Length) }',
    '$z.Dispose()',
  ].join('\n')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })
  const map = new Map()
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    const i = line.lastIndexOf('\t')
    if (i < 0) continue
    const name = line.slice(0, i).replace(/\\/g, '/')
    const size = Number(line.slice(i + 1))
    map.set(name, Number.isFinite(size) ? size : -1)
  }
  return map
}

export function human(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}
