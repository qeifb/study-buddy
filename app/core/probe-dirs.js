/**
 * 启动自检：确认 <root> 下每个目录都能真正写入。
 *
 * 结果打到 stdout（不要写文件，因为写文件本身就是问题）。
 * 目录布局见 core/paths.js。
 */
const fs = require('node:fs')
const path = require('node:path')

function probeDirs() {
  const { ROOT, DATA_DIR, RUNTIME_DIR, BROWSER_PROFILE_DIR, TOOLS_DIR } = require('./paths')

  const candidates = [
    ROOT,
    DATA_DIR,
    path.join(DATA_DIR, 'course-logs'),
    RUNTIME_DIR,
    BROWSER_PROFILE_DIR,
    TOOLS_DIR,
  ]

  const out = []
  for (const dir of candidates) {
    const rec = { dir, mkdir: null, write: null, rename: null, error: null }
    try {
      fs.mkdirSync(dir, { recursive: true })
      rec.mkdir = 'ok'
    } catch (e) {
      rec.mkdir = 'fail'
      rec.error = String(e?.code || e)
    }
    if (rec.mkdir === 'ok') {
      const tmp = path.join(dir, `.probe-${process.pid}.tmp`)
      const final = path.join(dir, `.probe-${process.pid}.txt`)
      try {
        fs.writeFileSync(tmp, 'x')
        rec.write = 'ok'
      } catch (e) {
        rec.write = 'fail'
        rec.error = String(e?.code || e)
      }
      if (rec.write === 'ok') {
        try {
          fs.renameSync(tmp, final)
          rec.rename = 'ok'
          try { fs.rmSync(final, { force: true }) } catch { /* ignore */ }
        } catch (e) {
          rec.rename = 'fail'
          rec.error = String(e?.code || e)
        }
      }
    }
    out.push(rec)
  }
  return out
}

module.exports = { probeDirs }
