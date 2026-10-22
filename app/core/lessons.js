/**
 * 课程日志的读取、索引与复用判断。
 *
 * 每篇日志是 NOTES_DIR 下的一个 .md，头部带元数据、正文是 `[mm:ss] 句子` 的逐句转写：
 *   # 课名
 *   - 来源页面：https://mooc1.chaoxing.com/...&chapterId=705041167&...
 *   - 抓取方式：浏览器插件（无需调试端口）
 *   - 抓取时间：2026/10/22 12:46:33
 *   - 时长：18:42
 *   - 转写段数：334
 *   ---
 *   [00:22] 各位同学大家好
 *
 * 为什么单独抽这个模块（2026-10-22）：
 * ① 页内问答必须按「用户正在看的那节课」的 chapterId 精确找日志，不能拿最近一篇凑；
 * ② 抓取前要先判断「这节课是不是已经抓过了」——抓过就别再下载 34MB + 转写 1 分钟。
 */
const fs = require('fs')
const path = require('path')

/** 从 URL 里取 chapterId（学习通每节课的唯一号） */
function chapterIdOf(url) {
  return (String(url || '').match(/[?&]chapterId=(\d+)/) || [])[1] || ''
}

/** 从 URL 里取 courseId / clazzid（查「课程名」要用） */
function courseIdsOf(url) {
  const u = String(url || '')
  return {
    courseId: (u.match(/[?&]courseId=(\d+)/i) || [])[1] || '',
    clazzid: (u.match(/[?&]clazzid=(\d+)/) || [])[1] || '',
  }
}

/** 课程名缓存文件：courseId → 课程名（一门课的名字是固定的，存一次永久用） */
function courseNamesFile(notesDir) {
  const root = path.dirname(path.resolve(notesDir))
  return path.join(root, 'course-names.json')
}

function readCourseNames(notesDir) {
  try {
    const f = courseNamesFile(notesDir)
    if (!fs.existsSync(f)) return {}
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

function writeCourseName(notesDir, courseId, name) {
  const cid = String(courseId || '').trim()
  const n = String(name || '').trim()
  if (!cid || !n) return false
  try {
    const all = readCourseNames(notesDir)
    if (all[cid] === n) return false
    all[cid] = n
    const f = courseNamesFile(notesDir)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(all, null, 2), 'utf8')
    return true
  } catch { return false }
}

/** 把 "18:42" / "01:02:03" 转成秒 */
function mmssToSec(s) {
  const parts = String(s || '').split(':').map((x) => parseInt(x, 10))
  if (parts.some((n) => Number.isNaN(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/**
 * 读一篇日志的元数据（只读头部 4KB，列表场景够快）。
 * 返回 null 表示不是一个可识别的课程日志。
 */
function readLogMeta(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4096)
    const title = ((head.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file, '.md')).trim()
    const course = ((head.match(/课程：([^\r\n]+)/) || [])[1] || '').trim()
    const src = (head.match(/来源页面：(\S+)/) || [])[1] || ''
    const time = (head.match(/抓取时间：([^\r\n]+)/) || [])[1] || ''
    const duration = (head.match(/时长：(\S+)/) || [])[1] || ''
    const segments = parseInt((head.match(/转写段数：(\d+)/) || [])[1] || '0', 10) || 0
    return {
      file,
      title,
      course,
      src,
      chapterId: chapterIdOf(src),
      duration,
      durationSec: mmssToSec(duration),
      segments,
      time,
      mtime: fs.statSync(file).mtimeMs,
    }
  } catch {
    return null
  }
}

/** 读整篇日志：元数据 + 正文转写 */
function readLog(file) {
  const meta = readLogMeta(file)
  if (!meta) return null
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  const mark = raw.indexOf('\n---\n')
  const transcript = (mark >= 0 ? raw.slice(mark + 5) : raw).trim()
  return { ...meta, transcript, chars: transcript.length }
}

/** 列出全部课程日志，按修改时间倒序 */
function listLogs(notesDir) {
  try {
    return fs.readdirSync(notesDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => readLogMeta(path.join(notesDir, f)))
      .filter((m) => m && m.title)
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

/** 按 chapterId 找这节课的日志；找不到返回 null（绝不退回「最近一篇」） */
function findByChapterId(notesDir, chapterId) {
  const cid = String(chapterId || '')
  if (!cid) return null
  return listLogs(notesDir).find((l) => l.chapterId === cid) || null
}

/** 按页面 URL 找日志 */
function findByUrl(notesDir, url) {
  return findByChapterId(notesDir, chapterIdOf(url))
}

/**
 * 给已有日志补写「- 课程：xxx」。
 * 早期版本没记课程名，用户 2026-10-22 要求下拉框里要能看到总课程名
 * （同一门课的章节名相近，只靠章节名分不清）。重抓命中复用时会顺手补一次，不用重新转写。
 * @returns {boolean} 是否写入
 */
function ensureCourseHeader(file, course) {
  const name = String(course || '').trim()
  if (!file || !name) return false
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return false }
  if (/^- 课程：/m.test(raw.slice(0, 4096))) return false
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => /^#\s+/.test(l))
  if (idx < 0) return false
  lines.splice(idx + 1, 0, '', `- 课程：${name}`)
  try {
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return true
  } catch {
    return false
  }
}

module.exports = {
  chapterIdOf, courseIdsOf, mmssToSec, readLogMeta, readLog, listLogs,
  findByChapterId, findByUrl, ensureCourseHeader,
  readCourseNames, writeCourseName, courseNamesFile,
}
