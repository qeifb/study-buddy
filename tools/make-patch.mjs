#!/usr/bin/env node
/**
 * 版本补丁生成器（2026-10-27）
 *
 * 核心原则：补丁 = 两个**已发布的包**之间的差异
 * ─────────────────────────────────────────────
 * 为什么不用「当前工作目录」当源：
 *   发布包是 pack-full.mjs 按白名单挑文件打出来的（app/ + tools/ + 指定根文件），
 *   和工作目录不是一一对应。拿工作目录生成补丁，会把不该进安装目录的文件塞进去，
 *   还会把包里有、目录里没有的文件判成「删除」。
 *   所以两侧都必须是真实的 zip。
 *
 * 两条命令
 * ────────
 *   ① 留基线清单（可选，diff 也可以直接吃两个 zip）
 *      node tools/make-patch.mjs manifest --zip E:/StudyBuddy-Release/study-buddy.zip
 *
 *   ② 生成补丁
 *      node tools/make-patch.mjs diff \
 *          --old-zip E:/StudyBuddy-Release/study-buddy.zip \
 *          --new-zip E:/StudyBuddy-Release/study-buddy-0.6.1.zip
 *
 * 补丁 zip 结构
 * ─────────────
 *   patch.json         版本、条目、旧哈希
 *   files/<相对路径>    要覆盖/新增的文件（只含变化过的）
 *   apply-patch.ps1    应用器
 *   应用补丁.cmd        双击入口
 *   补丁说明.md         给人看的
 *
 * 补丁适用范围：完整版 / 离线版的安装目录（两者代码文件完全一致）。
 *              极简版体积本来就小，直接重下，不发补丁。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { ROOT, OUT_DIR, manifestFromZip, writePatchZip, human, zipEntrySizes } from './patch-lib.mjs'

const argv = process.argv.slice(2)
function arg(name, def = null) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
function flag(name) { return argv.includes('--' + name) || argv.includes('-' + name) }

const MODE = argv[0]

if (!['manifest', 'diff'].includes(MODE)) {
  console.log(`
学习通学伴 · 版本补丁生成器

  留基线清单:  node tools/make-patch.mjs manifest --zip <包.zip> [--out manifest.json]
  生成补丁:    node tools/make-patch.mjs diff --old-zip <旧包.zip> --new-zip <新包.zip>
                                            [--out patch.zip] [--force] [-v]

说明:
  · 两侧都必须是真的发布包（zip），不能拿工作目录顶替
  · 版本号从包内 app/package.json 读，不用手填
  · 只收代码/文本文件；模型、electron、pyenv 这些大件永远进不了补丁
  · 同一个补丁可用于完整版和离线版的安装目录（两者代码文件一致）
`)
  process.exit(1)
}

/* ══════════════════════════ 模式①：生成清单 ══════════════════════════ */
if (MODE === 'manifest') {
  const zip = arg('zip') || arg('from-zip')
  if (!zip || !fs.existsSync(zip)) {
    console.error('❌ 需要 --zip <存在的包>')
    process.exit(1)
  }
  console.log('从包生成清单：' + path.basename(zip))
  const m = manifestFromZip(zip, arg('version') || '')
  const out = arg('out') || path.join(OUT_DIR, `manifest-${m.version || 'unknown'}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(m, null, 2), 'utf8')
  console.log(`✅ ${out}`)
  console.log(`   版本 ${m.version} · ${m.fileCount} 文件 · ${human(m.totalBytes)}`)
  process.exit(0)
}

/* ══════════════════════════ 模式②：生成补丁 ══════════════════════════ */
if (MODE === 'diff') {
  const oldZip = arg('old-zip')
  const oldManifestFile = arg('old-manifest')
  const newZip = arg('new-zip')
  const force = flag('force')

  if (!newZip || !fs.existsSync(newZip)) { console.error('❌ 需要 --new-zip <存在的包>'); process.exit(1) }
  if (!oldManifestFile && (!oldZip || !fs.existsSync(oldZip))) {
    console.error('❌ 需要 --old-zip <上一次发的完整包> 或 --old-manifest <上一次留档的清单 json>')
    process.exit(1)
  }
  if (oldManifestFile && !fs.existsSync(oldManifestFile)) { console.error('❌ 找不到清单 ' + oldManifestFile); process.exit(1) }

  console.log('')
  console.log('═'.repeat(66))
  console.log('  生成版本补丁')
  console.log('═'.repeat(66))
  if (oldManifestFile) {
    console.log('  旧版本清单 ' + path.basename(oldManifestFile) + '  (' + human(fs.statSync(oldManifestFile).size) + ')')
  } else {
    console.log('  旧包 ' + path.basename(oldZip) + '  (' + human(fs.statSync(oldZip).size) + ')')
  }
  console.log('  新包 ' + path.basename(newZip) + '  (' + human(fs.statSync(newZip).size) + ')')
  console.log('')
  console.log('  正在解出代码文件…')

  let oldM
  if (oldManifestFile) {
    oldM = JSON.parse(fs.readFileSync(oldManifestFile, 'utf8'))
  } else {
    oldM = manifestFromZip(oldZip, arg('from') || '')
  }
  const newM = manifestFromZip(newZip, arg('to') || '')
  const fromVersion = oldM.version || ''
  const toVersion = newM.version || ''

  console.log('')
  console.log(`  旧版本 ${fromVersion || '(未知)'} · ${oldM.fileCount} 文件`)
  console.log(`  新版本 ${toVersion || '(未知)'} · ${newM.fileCount} 文件`)

  if (!toVersion) {
    console.error('')
    console.error('❌ 新包里读不到版本号（app/package.json 缺 version）')
    process.exit(1)
  }
  if (fromVersion === toVersion && !force) {
    console.error('')
    console.error(`⚠️  两个包的版本号都是 ${toVersion}，没法区分。`)
    console.error('   补丁靠版本号判断「能不能装到这台机器上」，同号会让用户不知道该不该装。')
    console.error('   请先把 app/package.json 的 version bump 上去重新打包，或加 --force 强行生成。')
    process.exit(2)
  }

  /* ── 比对 ── */
  const oldFiles = oldM.files || {}
  const newFiles = newM.files || {}

  const added = []
  const modified = []
  const entries = []
  for (const rel of Object.keys(newFiles).sort()) {
    const n = newFiles[rel]
    const o = oldFiles[rel]
    if (!o) {
      added.push(rel)
      entries.push({ rel, size: n.size, sha256: n.sha256, oldSha256: null, action: 'add' })
    } else if (o.sha256 !== n.sha256) {
      modified.push(rel)
      entries.push({ rel, size: n.size, sha256: n.sha256, oldSha256: o.sha256, action: 'modify' })
    }
  }
  const deleted = []
  for (const rel of Object.keys(oldFiles).sort()) {
    if (!newFiles[rel]) deleted.push({ rel, oldSha256: oldFiles[rel].sha256, action: 'delete' })
  }

  const bytes = entries.reduce((a, e) => a + e.size, 0)
  console.log('')
  console.log(`  修改 ${modified.length} · 新增 ${added.length} · 删除 ${deleted.length} · 未变 ${Object.keys(newFiles).length - entries.length}`)
  console.log(`  补丁 ${entries.length} 文件 · ${human(bytes)}`)

  if (!entries.length && !deleted.length) {
    console.log('')
    console.log('✅ 两个包没有任何差异，不需要补丁。')
    process.exit(0)
  }

  if (flag('verbose') || argv.includes('-v')) {
    console.log('')
    for (const rel of added) console.log('  + ' + rel)
    for (const rel of modified) console.log('  ~ ' + rel)
    for (const d of deleted) console.log('  - ' + d.rel)
  }

  /* ── 补丁范围外的变化：必须让人知道，不能悄悄漏掉 ── */
  const drift = []
  try {
    if (!oldZip) throw new Error('__skip__')
    const a = zipEntrySizes(oldZip)
    const b = zipEntrySizes(newZip)
    /* 范围 = 两侧清单里出现过的所有可补丁文件（含只在旧包里存在的），
     * 否则「删掉一个可补丁文件」会被重复报成范围外变化 */
    const inScope = new Set([...Object.keys(newFiles), ...Object.keys(oldFiles)])
    for (const [rel, sz] of b) {
      if (inScope.has(rel)) continue
      if (!a.has(rel)) drift.push({ rel, why: '新增' })
      else if (a.get(rel) !== sz) drift.push({ rel, why: '大小变了' })
    }
    for (const rel of a.keys()) {
      if (inScope.has(rel)) continue
      if (!b.has(rel)) drift.push({ rel, why: '删除' })
    }
  } catch (e) {
    if (e.message !== '__skip__') console.log('  （补丁范围外的比对失败，跳过：' + e.message + '）')
  }
  if (drift.length) {
    console.log('')
    console.log(`  ⚠️ 还有 ${drift.length} 个「补丁范围外」的文件也变了：`)
    for (const d of drift.slice(0, 10)) console.log(`     ${d.rel}  ${d.why}`)
    if (drift.length > 10) console.log(`     …还有 ${drift.length - 10} 个`)
    console.log('     这些是大件二进制 / 无扩展名 / 超过 8MB 的文件，补丁**不会**替换它们。')
    console.log('     如果它们的变化影响运行，这个版本请直接发完整包，别用补丁。')
  }

  const big = entries.filter((e) => e.size > 500 * 1024)
  if (big.length) {
    console.log('')
    console.log('  ⚠️ 有较大文件进了补丁（补丁会变大）：')
    for (const e of big) console.log(`     ${e.rel}  ${human(e.size)}`)
  }

  /* ── 组装补丁包 ── */
  const outZip = arg('out') || path.join(OUT_DIR, `patch-${fromVersion || 'old'}-to-${toVersion}.zip`)

  /* 需要重新从新包解出真实文件内容写进补丁 —— manifestFromZip 已清理临时目录，
   * 所以这里再解一次（只解变化过的文件可以更快，但为此要给 patch-lib 加参数；
   * 这点时间不值得，保持简单） */
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-patch-'))
  try {
    const patchJson = {
      kind: 'study-buddy-patch',
      fromVersion,
      toVersion,
      createdAt: new Date().toISOString(),
      target: '完整版 / 离线版的安装目录',
      stats: {
        modified: modified.length,
        added: added.length,
        deleted: deleted.length,
        files: entries.length,
        bytes,
      },
      entries,
      deleted,
    }
    const patchJsonPath = path.join(stage, 'patch.json')
    fs.writeFileSync(patchJsonPath, JSON.stringify(patchJson, null, 2), 'utf8')

    const readmePath = path.join(stage, '补丁说明.md')
    fs.writeFileSync(readmePath, buildPatchReadme(patchJson, path.basename(outZip), added, modified, deleted), 'utf8')

    const applyPs1 = path.join(ROOT, 'tools', 'apply-patch.ps1')
    const applyCmd = path.join(ROOT, 'tools', '应用补丁.cmd')
    for (const p of [applyPs1, applyCmd]) {
      if (!fs.existsSync(p)) { console.error(`❌ 缺少 ${p}`); process.exit(1) }
    }

    /* 从新包中抽出补丁条目对应的文件 */
    const payload = extractFilesFromZip(newZip, entries.map((e) => e.rel), stage)
    console.log('')
    console.log(`  已从新包抽出 ${payload.length} 个文件`)

    const zipEntries = payload.map((p) => ({ rel: 'files/' + p.rel, abs: p.abs }))
    const extras = [
      { rel: 'patch.json', abs: patchJsonPath },
      { rel: 'apply-patch.ps1', abs: applyPs1 },
      { rel: '应用补丁.cmd', abs: applyCmd },
      { rel: '补丁说明.md', abs: readmePath },
    ]

    fs.mkdirSync(path.dirname(outZip), { recursive: true })
    writePatchZip(outZip, zipEntries, extras)

    const size = fs.statSync(outZip).size
    console.log('')
    console.log('✅ ' + outZip)
    console.log(`   ${size} 字节 · ${human(size)}`)

    const mOut = path.join(path.dirname(outZip), `manifest-${toVersion}.json`)
    fs.writeFileSync(mOut, JSON.stringify(newM, null, 2), 'utf8')
    console.log(`   ${mOut}  （留档用）`)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  process.exit(0)
}

/* ────────────────────────── 辅助 ────────────────────────── */

/** 从 zip 里只抽出指定条目，解到 dest/files/<rel>，返回 [{rel, abs}] */
function extractFilesFromZip(zipPath, rels, dest) {
  const wants = JSON.stringify(rels)
  const wantsFile = path.join(dest, '_wants.json')
  fs.writeFileSync(wantsFile, wants, 'utf8')
  const psFile = path.join(dest, '_extract2.ps1')
  const ps = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
    `$wants = Get-Content -Raw -Encoding UTF8 '${wantsFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
    `$dst = '${path.join(dest, 'files').replace(/'/g, "''")}'`,
    'if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }',
    "$set = @{}; foreach ($w in $wants) { $set[($w -replace '\\\\','/')] = $true }",
    'foreach ($e in $z.Entries) {',
    "  $n = $e.FullName -replace '\\\\', '/'",
    '  if (-not $set.ContainsKey($n)) { continue }',
    '  $target = Join-Path $dst $n',
    '  $dir = Split-Path $target -Parent',
    '  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }',
    '  [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)',
    '}',
    '$z.Dispose()',
  ].join('\n')
  const body = Buffer.from(ps.replace(/\r?\n/g, '\r\n'), 'utf8')
  fs.writeFileSync(psFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]))
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
      stdio: 'pipe', windowsHide: true,
    })
  } finally {
    fs.rmSync(wantsFile, { force: true })
    fs.rmSync(psFile, { force: true })
  }

  const out = []
  for (const rel of rels) {
    const abs = path.join(dest, 'files', rel.replace(/\//g, path.sep))
    if (!fs.existsSync(abs)) {
      console.error('❌ 新包里找不到 ' + rel)
      process.exit(1)
    }
    out.push({ rel, abs })
  }
  return out
}

function buildPatchReadme(pj, zipName, added, modified, deleted) {
  const list = (arr, limit = 40) => {
    const shown = arr.slice(0, limit).map((x) => '- `' + (x.rel || x) + '`')
    if (arr.length > limit) shown.push(`- …还有 ${arr.length - limit} 项`)
    return shown.join('\n')
  }
  return `# 学习通学伴 补丁 ${pj.fromVersion} → ${pj.toVersion}

包名：\`${zipName}\`
生成时间：${pj.createdAt}
适用：完整版 / 离线版的安装目录

内容：修改 ${pj.stats.modified} · 新增 ${pj.stats.added} · 删除 ${pj.stats.deleted}

## 怎么用

1. 先**完全退出学习通学伴**（右下角托盘图标 → 右键 → 退出，只关窗口不够）。
2. 把本压缩包解压到**安装目录**——就是能直接看到 \`app\` 文件夹和 \`启动学习通学伴.cmd\` 的那一层。
   解压完会多出一个 \`patch-${pj.fromVersion}-to-${pj.toVersion}\` 文件夹。
3. 进入那个文件夹，双击 **\`应用补丁.cmd\`**。
4. 看到「补丁应用完成」就好了，之后照常双击桌面图标启动。

## 它会自己做的检查

- 核对当前版本是不是 \`${pj.fromVersion}\`，不是就拦下来（避免装出四不像）
- 校验补丁文件在下载/解压中有没有损坏
- 检测文件有没有被占用（应用还在跑就拦下来）
- 如果某个文件你本地改过，会先问你一句再覆盖
- 覆盖前把原文件备份到 \`backup-<时间戳>\` 文件夹
- 写完后复验内容；任何一步失败自动回滚成原样

**补丁不会动**你的课程日志、聊天记录、设置、浏览器配置——只替换程序代码。

## 这次改了什么

### 修改（${pj.stats.modified}）
${modified.length ? list(modified) : '- 无'}

### 新增（${pj.stats.added}）
${added.length ? list(added) : '- 无'}

### 删除（${pj.stats.deleted}）
${deleted.length ? list(deleted) : '- 无'}
`
}
