/**
 * 从指定浏览器抓取当前打开的网课内容。
 *
 * 用户的硬要求（docx 原话）：
 *   「日志内容一定要围绕着老师讲课的内容做分析，不遗漏不虚报不弄虚作假」
 * ⇒ 这里只负责「原样取回老师讲了什么」，任何加工都留给 AI，且必须标注来源与时间戳。
 */
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { chapterIdOf, courseIdsOf, findByChapterId, readLog, ensureCourseHeader, readCourseNames, writeCourseName } = require('./lessons')

/* ───────────── 极简 CDP 客户端（零依赖） ───────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.waiters = new Map()
    this.closed = false
    ws.onmessage = (ev) => { try { this._onMessage(ev) } catch { /* ignore */ } }
    ws.onerror = () => { /* 由 onclose 统一收尾 */ }
    ws.onclose = () => this._failAll('CDP 连接已关闭')
  }

  _failAll(reason) {
    if (this.closed) { this.waiters.clear(); return }
    this.closed = true
    const pending = [...this.waiters.values()]
    this.waiters.clear()
    for (const w of pending) { try { w.reject(new Error(reason)) } catch { /* ignore */ } }
  }

  _onMessage(ev) {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
    if (msg.id == null) return
    const w = this.waiters.get(msg.id)
    if (!w) return
    this.waiters.delete(msg.id)
    if (msg.error) w.reject(new Error(String(msg.error.message || 'CDP error')))
    else w.resolve(msg.result)
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) {
      const dead = Promise.reject(new Error(`CDP 已关闭：${method}`))
      dead.catch(() => {})
      return dead
    }
    const id = ++this.seq
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.waiters.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        clearTimeout(timer); this.waiters.delete(id); reject(e)
      }
    })
    p.catch(() => {})
    return p
  }

  close() { try { this.closed = true; this.ws.close() } catch { /* ignore */ } }
}

function openWs(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(url) } catch (e) { return reject(e) }
    const timer = setTimeout(() => { try { ws.close() } catch { /* ignore */ } reject(new Error('连接调试端口超时')) }, timeoutMs)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连接调试端口失败')) }
  })
}

/** 挑一个看着像网课页面的标签 */
async function pickLessonTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })
  const tabs = await res.json()
  const pages = (Array.isArray(tabs) ? tabs : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const scored = pages.map((t) => {
    const u = String(t.url || '')
    let score = 0
    if (/chaoxing|mooc1|mooc2|ananas|fanya/i.test(u)) score += 10
    if (/studentstudy|knowledge\/cards|video/i.test(u)) score += 5
    if (/^(about|chrome|devtools|edge|javascript)/i.test(u)) score -= 20
    return { tab: t, score }
  }).sort((a, b) => b.score - a.score)
  return { best: scored[0]?.tab || null, all: scored.map((s) => s.tab) }
}

/* ───────────── 页面内探针 ───────────── */

function pageProbe() {
  const clean = (s) => (s || '').replace(/\u200b/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  // 递归穿同源 iframe 找 video 与 objectid
  const seen = []
  const walk = (win, depth) => {
    if (!win || depth > 5) return
    let doc
    try { doc = win.document } catch { return }
    if (!doc) return
    const vids = Array.from(doc.querySelectorAll('video')).map((v) => ({
      src: v.currentSrc || v.src || '',
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      paused: v.paused,
    }))
    const objs = Array.from(doc.querySelectorAll('[objectid]')).map((e) => ({
      objectid: e.getAttribute('objectid'),
      cls: String(e.className || '').slice(0, 80),
    }))
    const tracks = Array.from(doc.querySelectorAll('track')).map((t) => ({ kind: t.kind, label: t.label, src: t.src }))
    if (vids.length || objs.length || tracks.length) {
      let u = ''
      try { u = win.location.href } catch { u = '' }
      seen.push({ depth, url: u, vids, objs, tracks })
    }
    for (const f of doc.querySelectorAll('iframe')) {
      try { walk(f.contentWindow, depth + 1) } catch { /* 跨域跳过 */ }
    }
  }
  walk(window, 0)

  const withVideo = seen.find((s) => s.vids.some((v) => v.src))
  const anyObj = seen.find((s) => s.objs.length)

  // 页面标题（优先用章节目录的 title）
  let chapterTitle = ''
  try {
    const el = document.querySelector('.chapter_item[title]')
    if (el) chapterTitle = el.getAttribute('title') || ''
  } catch { /* ignore */ }
  if (!chapterTitle) {
    const m = /<(title|h1)[^>]*>([^<]+)</i.exec(document.documentElement?.outerHTML || '')
    if (m) chapterTitle = m[2].trim()
  }

  return {
    url: location.href,
    title: document.title,
    chapterTitle: clean(chapterTitle).slice(0, 120),
    video: withVideo ? (withVideo.vids.find((v) => v.src) || null) : null,
    objectid: anyObj ? anyObj.objs[0].objectid : null,
    tracks: seen.flatMap((s) => s.tracks),
    bodyText: clean(document.body ? document.body.innerText : '').slice(0, 6000),
    layers: seen.map((s) => ({ depth: s.depth, url: (s.url || '').slice(0, 120) })),
  }
}

/* ───────────── 主流程 ───────────── */

function slug(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || '未命名'
}

function mmss(sec) {
  const t = Math.max(0, Math.round(sec || 0))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** 带 Referer 下载（学习通 CDN 必须） */
async function downloadVideo(url, destPath, referer) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const res = await fetch(url, {
    headers: {
      Referer: referer || 'https://mooc1.chaoxing.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(20 * 60 * 1000),
  })
  if (!res.ok) throw new Error(`视频下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(destPath, buf)
  return buf.length
}

/**
 * 转写：调用本机已装好的 faster-whisper 环境（DSH 插件那套）。
 * 找不到就明确报错，不假装成功。
 */

/* ───────────── 正在转码的计数（2026-10-27） ─────────────
 * 用途：性能测试与自己抢 CPU/GPU，转码中测出来的数字是错的，所以要能被拦住。
 * 用计数而不是布尔：自动抓取允许并发，可能同时有好几个 transcribe 在跑。
 * 只在本模块内维护，通过 exported 的 isTranscribing() 对外暴露。 */
let _transcribingCount = 0
function beginTranscribing() { _transcribingCount++ }
function endTranscribing() { _transcribingCount = Math.max(0, _transcribingCount - 1) }
function isTranscribing() { return _transcribingCount > 0 }

async function transcribe(mediaPath, { outPath, onLog }) {
  // 转写环境与模型 2026-10-22 起随应用一起放在 <root>\tools（原 %LOCALAPPDATA%\dsh-study-companion）
  const { TOOLS_DIR } = require('./paths')
  const pyenv = path.join(TOOLS_DIR, 'pyenv', 'Scripts', 'python.exe')
  const script = path.join(TOOLS_DIR, 'transcribe.py')

  // 允许用户已把转录脚本放在那；否则用插件目录里的
  const fallbacks = [
    script,
    path.join(process.env.USERPROFILE || '', 'Documents', 'deepseek-harness', 'default-workspace', 'chaoxing-companion', 'lib', 'transcribe.py'),
  ]
  const scriptPath = fallbacks.find((p) => { try { return fs.existsSync(p) } catch { return false } })
  if (!fs.existsSync(pyenv)) throw new Error(`找不到转写环境：${pyenv}\n请先安装学习通学伴的转写组件。`)
  if (!scriptPath) throw new Error('找不到转写脚本 transcribe.py')

  const modelDir = path.join(TOOLS_DIR, 'models', 'large-v3-turbo')

  const { spawn } = require('node:child_process')
  return new Promise((resolve, reject) => {
    const args = [scriptPath, mediaPath, '--out', outPath, '--language', 'zh']
    if (fs.existsSync(modelDir)) { args.push('--model-dir', modelDir) }

    /* ★ 2026-10-26：accelMode 是硬件加速的唯一开关（hardwareAccel 已删除）
     *   cpu  → --device cpu（强制 CPU）
     *   gpu  → --device cuda（强制 GPU，失败报错）
     *   auto → --device auto（有 NVIDIA 就 GPU，失败自动退 CPU）+ 并行 */
    try {
      const { readSettings } = require('./ai')
      const st = readSettings() || {}
      const mode = String(st.accelMode || 'auto').toLowerCase()
      let dev = 'cpu'
      let wantParallel = false
      if (mode === 'cpu') {
        dev = 'cpu'
        wantParallel = false
      } else if (mode === 'gpu') {
        dev = 'cuda'
        wantParallel = false
      } else {
        dev = 'auto'
        wantParallel = true
      }
      args.push('--device', dev)

      /* ★ 2026-10-25：转码速度（控制 CPU 占用）
       *   performance = 占用空闲 CPU 的 80%
       *   balanced    = 60%（默认）
       *   quiet       = 40%
       *   具体线程数由 transcribe.py 按「当前系统占用」实时反算。 */
      const spd = ['performance', 'balanced', 'quiet'].includes(String(st.transSpeed || ''))
        ? String(st.transSpeed) : 'balanced'
      args.push('--speed', spd)
      /* wantParallel 由上面的 accelMode 决定（auto = 开并行） */
      args.push('--parallel', wantParallel ? '1' : '0')
    } catch {
      /* 读设置失败就用 auto，保证功能不因此不可用 */
      args.push('--device', 'auto')
      args.push('--speed', 'balanced')
      args.push('--parallel', '0')
    }
    const env = { ...process.env, HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' }
    const child = spawn(pyenv, args, { env, windowsHide: true })
    /* ★ 2026-10-27：登记「正在转码」，供性能测试等功能判断是否该让路。
     * 用计数而不是布尔：自动抓取允许并发，可能同时有几个 transcribe 在跑。
     * 无论成功、失败、启动失败，都必须在收尾时减回去。 */
    beginTranscribing()
    let ended = false
    const endOnce = () => { if (!ended) { ended = true; endTranscribing() } }
    let stderr = ''
    child.stderr.on('data', (d) => {
      const s = String(d)
      stderr += s
      const line = s.trim()
      if (line && onLog) onLog(line)
    })
    child.on('error', (e) => { endOnce(); reject(new Error(`无法启动转写进程：${e.message}`)) })
    child.on('close', (code) => {
      endOnce()
      try {
        if (fs.existsSync(outPath)) return resolve(JSON.parse(fs.readFileSync(outPath, 'utf8')))
      } catch { /* 落到下面 */ }
      reject(new Error(`转写进程退出 code=${code}\n${stderr.slice(-800)}`))
    })
  })
}

/**
 * 通过浏览器扩展抓取一节网课（推荐路径，不需要调试端口）。
 *
 * 与 captureLesson 的区别：页面取证由扩展完成，应用只负责下载、转写、落盘。
 * @param {object} opts
 * @param {{enqueue:(type:string,o:object)=>string}} opts.ext 扩展任务通道
 * @param {number} opts.tabId 目标标签页
 * @param {string} opts.notesDir 日志目录
 * @param {(stage:string,text:string)=>void} opts.onStage 进度回调
 */
async function captureLessonViaExtension({ ext, tabId, notesDir, onStage, reuse = true }) {
  const say = (stage, text) => { try { onStage && onStage(stage, text) } catch { /* ignore */ } }

  say('scan', '页面读取｜进行中')

  // 扩展每次领到任务都会**先上报一次 running**（background.js:594），跑完才报 done/failed。
  // 早期这里只要收到一次回调就当结果结算，于是任务刚派发就被判成「扩展没能读到页面」——
  // 1.3 秒必失败，这就是 2026-10-22 用户报「应用抓不到课程内容」的真实根因。
  // 现在只认 done / failed，其余状态（running / pending）一律忽略。
  const waitJob = (type, { timeoutMs = 25000, args } = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${type} 超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs + 1500)
      const id = ext.enqueue(type, {
        tabId,
        args,
        timeoutMs,
        onUpdate: (job) => {
          if (!job || job.status === 'running' || job.status === 'pending') return
          clearTimeout(timer)
          if (job.status === 'done') resolve(job.result || {})
          else reject(new Error(job.error || `扩展没能完成：${type}`))
        },
      })
      if (!id) { clearTimeout(timer); reject(new Error('任务入队失败（扩展没连上）')) }
    })

  // 1) 让扩展在页面（含所有 iframe）里找视频
  const found = await waitJob('findVideo')

  say('probe', `页面读取｜${found.title || '(无标题)'} · ${found.frames || 0} 层框架`)
  if (found.chapterTitle) say('probe', `章节｜${found.chapterTitle}`)

  // 1.2) 课程名（总标题）不在播放页 DOM 里（2026-10-22 用 dumpChapterDom 证实），
  //      但用户开着的「课程目录页」（mooc2-ans/mycourse/stu）标题就是课程名。
  //      取法顺序：本地缓存 → 已打开标签页的标题 → 让扩展扫课程页 → 手动填。
  if (!found.courseTitle) {
    const ids = courseIdsOf(found.url)
    const GENERIC = /^(学生学习页面|视频|课程|课程门户首页|课程首页|用户登录|登录|超星|学习通|新标签页|首页|扩展)$/
    if (ids.courseId) {
      // a) 本地缓存（一次拿到永久用）
      try {
        const cached = readCourseNames(notesDir)[ids.courseId]
        if (cached) {
          found.courseTitle = cached
          say('probe', `课程｜${found.courseTitle}（本地记录）`)
        }
      } catch { /* ignore */ }

      // b) 已打开的标签页里有同 courseId 的课程目录页 → 它的 title 就是课程名
      if (!found.courseTitle) {
        try {
          const tabs = (ext.state && ext.state()?.lastHello?.tabs) || []
          const re = new RegExp(`[?&]course_?id=${ids.courseId}(?:&|$)`, 'i')
          for (const t of tabs) {
            if (!re.test(String(t.url || ''))) continue
            const title = String(t.title || '').trim()
            if (!title || title.length < 2 || title.length > 60 || GENERIC.test(title)) continue
            found.courseTitle = title
            writeCourseName(notesDir, ids.courseId, title)
            say('probe', `课程｜${title}（来自当前课程页）`)
            break
          }
        } catch { /* ignore */ }
      }

      // c) 让扩展去扫所有学习通标签页（含课程目录页），抓左上角课程名
      if (!found.courseTitle) {
        try {
          say('probe', '课程名｜查询中')
          const r = await waitJob('courseTitleAnyTab', { timeoutMs: 15000 })
          const list = (r && r.tabs) || []
          const re = new RegExp(`[?&]course_?id=${ids.courseId}(?:&|$)`, 'i')
          for (const t of list) {
            if (!re.test(String(t.url || ''))) continue
            const cands = (t.found || []).map((x) => String(x.text || '').trim())
            const good = cands.find((x) => x && x.length >= 2 && x.length <= 60 && !GENERIC.test(x))
            if (good) {
              found.courseTitle = good
              writeCourseName(notesDir, ids.courseId, good)
              say('probe', `课程｜${good}`)
              break
            }
            const byTitle = String(t.title || '').trim()
            if (byTitle && !GENERIC.test(byTitle) && byTitle.length <= 60) {
              found.courseTitle = byTitle
              writeCourseName(notesDir, ids.courseId, byTitle)
              say('probe', `课程｜${byTitle}`)
              break
            }
          }
          if (!found.courseTitle) say('probe', `课程名缺失｜courseId=${ids.courseId}`)
        } catch (e) {
          say('probe', `课程名查询失败｜${e.message}`)
        }
      }
    }
  }
  let src = found.video?.src || ''
  let duration = found.video?.duration || 0

  // 1.5) 这节课以前抓过 → 直接用本地日志，不再下载 34MB + 转写 1 分钟。
  //      用户 2026-10-22 的要求：「抓过一次，过段时间又重复询问就不用重复抓了，
  //      只要课程 ID 保存过在本地，就直接调用本地日志」。
  //      注意：判断用页面 URL 的 chapterId，不依赖视频有没有加载出来。
  const chapterId = chapterIdOf(found.url)
  if (reuse && chapterId) {
    const hit = findByChapterId(notesDir, chapterId)
    const log = hit ? readLog(hit.file) : null
    if (log && log.transcript) {
      // 早期日志没记课程名 → 顺手补上（不用重新下载转写）
      if (!log.course && found.courseTitle) {
        try { ensureCourseHeader(log.file, found.courseTitle) } catch { /* ignore */ }
      }
      say('reused', `文字稿｜本地已有《${log.title}》· ${log.segments} 段 · 抓于 ${log.time || '未知'} · 直接复用`)
      return {
        file: log.file,
        lessonName: log.title,
        courseName: log.course || found.courseTitle || '',
        duration: log.durationSec || duration,
        segmentCount: log.segments,
        chars: log.chars,
        transcript: log.transcript,
        url: log.src || found.url || '',
        via: 'extension',
        reused: true,
        capturedAt: log.time,
      }
    }
  }

  // 2) 没找到视频时，尝试点开「视频」任务点后再找一次
  if (!src) {
    say('probe', '视频元素｜未出现 · 尝试展开任务点')
    try {
      await waitJob('clickVideoTab', { timeoutMs: 12000 })
      await sleep(3000)
      const again = await waitJob('findVideo')
      src = again.video?.src || ''
      duration = again.video?.duration || duration
      if (again.chapterTitle) found.chapterTitle = again.chapterTitle
    } catch (e) {
      say('probe', `展开任务点失败｜${e.message}`)
    }
  }

  if (!src) {
    throw new Error('这个页面里没找到视频。请确认已经打开某节课的播放页（视频能播放）。')
  }

  // 3) 下载 + 转写 + 落盘
  //
  // ⚠️ 2026-10-24 修复：整段包进 try/finally，**保证无论成功失败都清掉 .tmp**。
  //
  // 原实现把 `rmSync(.tmp)` 放在成功路径末尾（原第 426 行），
  // 而它前面有 3 处 throw（找不到视频 / 转写失败 / 转写结果为空）。
  // 一旦命中任一条，视频 mp4（20~50MB）就留在 .tmp 里，且文件名用 Date.now()，
  // 下次抓取不会覆盖 ⇒ **多次失败会持续累积占用磁盘**（实测两次失败残留 55MB）。
  let mediaPath = null
  let jsonPath = null
  try {
    mediaPath = path.join(notesDir, '.tmp', `${Date.now()}-lecture.mp4`)
    jsonPath = path.join(notesDir, '.tmp', `${Date.now()}-transcript.json`)

    say('download', `媒体下载｜进行中 · ${safeHost(src)}`)
    const bytes = await downloadVideo(src, mediaPath, found.url || found.videoFrameUrl || '')
    say('download', `媒体下载｜完成 ${(bytes / 1048576).toFixed(1)} MB · 转写启动`)

    const r = await transcribe(mediaPath, { outPath: jsonPath, onLog: (l) => say('transcribe', l) })
    if (!r.ok) throw new Error(r.error || '转写失败')

    const segments = r.segments || []
    duration = r.duration || duration
    const transcriptText = segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n')
    say('transcribe', `转写完成｜${segments.length} 段 · ${transcriptText.length} 字`)

    if (!transcriptText) throw new Error('转写结果为空')

    // 4) 落盘
    const lessonName = found.chapterTitle || found.title || '未命名课时'
    const cid = chapterIdOf(found.url)
    // 同一节课重抓时沿用原文件，避免留下两份同章节日志
    const existing = findByChapterId(notesDir, cid)
    const file = existing ? existing.file : path.join(notesDir, `${cid ? cid + '-' : ''}${slug(lessonName)}.md`)
    const header = [
      `# ${lessonName}`,
      '',
      ...(found.courseTitle ? [`- 课程：${found.courseTitle}`] : []),
      `- 来源页面：${found.url || ''}`,
      `- 抓取方式：浏览器插件（无需调试端口）`,
      `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
      `- 时长：${mmss(duration)}`,
      `- 转写段数：${segments.length}`,
      '',
      '---',
      '',
    ].filter((l) => l !== '').join('\n')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${header}\n${transcriptText}\n`, 'utf8')

    say('saved', `文字稿已落盘｜${file}`)

    return {
      file,
      lessonName,
      courseName: found.courseTitle || '',
      courseCandidates: found.courseCandidates || {},
      duration,
      segmentCount: segments.length,
      chars: transcriptText.length,
      transcript: transcriptText,
      url: found.url || '',
      via: 'extension',
    }
  } finally {
    // ★ 无论成功、失败还是抛错，都清掉 .tmp（20~50MB 的视频与转写中间文件）
    try { fs.rmSync(path.join(notesDir, '.tmp'), { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function safeHost(u) {
  try { return new URL(u).host } catch { return '未知来源' }
}

/**
 * @param {object} opts
 * @param {{port:number}} opts.conn
 * @param {string} opts.notesDir
 * @param {(stage:string, text:string)=>void} opts.onStage
 */
async function captureLesson({ conn, notesDir, onStage }) {
  const say = (stage, text) => { try { onStage && onStage(stage, text) } catch { /* ignore */ } }

  say('scan', '页面扫描｜进行中')
  const { best, all } = await pickLessonTab(conn.port)
  if (!best) throw new Error('这个浏览器里没找到网课页面。请先在学习通里打开一节视频课。')

  const url = String(best.url || '')
  say('connect', `页面就绪｜${best.title || url}`)

  const ws = await openWs(best.webSocketDebuggerUrl)
  const cdp = new Cdp(ws)
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    say('probe', '定位中｜视频 · 章节')
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(${pageProbe.toString()})()`,
      returnByValue: true,
      awaitPromise: true,
    }, 20000)
    const info = probe?.result?.value || {}

    if (info.video && !info.video.src) {
      // 有的章节默认停在「学习目标」，需要点视频任务点
      say('probe', '视频元素｜未就绪 · 尝试展开任务点')
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const els = [...document.querySelectorAll('[onclick]')].filter(e => /changeDisplayContent/.test(e.getAttribute('onclick')||'') && /视频|音频/.test(e.textContent||''))
          if (els.length) { els[0].click(); return 'clicked' }
          return 'none'
        })()`,
        returnByValue: true,
      }, 10000)
      await sleep(3000)
    }

    const mediaPath = path.join(notesDir, '.tmp', `${Date.now()}-lecture.mp4`)
    const jsonPath = path.join(notesDir, '.tmp', `${Date.now()}-transcript.json`)

    let transcriptText = ''
    let segments = []
    let duration = info.video?.duration || 0
    let note = ''

    if (info.video?.src) {
      say('download', `媒体下载｜进行中 · ${new URL(info.video.src).host}`)
      const bytes = await downloadVideo(info.video.src, mediaPath, info.url)
      say('download', `媒体下载｜完成 ${(bytes / 1048576).toFixed(1)} MB · 转写启动`)

      const r = await transcribe(mediaPath, { outPath: jsonPath, onLog: (l) => say('transcribe', l) })
      if (!r.ok) throw new Error(r.error || '转写失败')
      segments = r.segments || []
      duration = r.duration || duration
      transcriptText = segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n')
      say('transcribe', `转写完成：${segments.length} 段 / ${transcriptText.length} 字`)
    } else {
      note = '页面里没有找到视频直链，改为记录页面正文。'
      transcriptText = info.bodyText || ''
      say('probe', note)
    }

    if (!transcriptText) throw new Error('没有抓到任何课程内容')

    const lessonName = info.chapterTitle || info.title || '未命名课时'
    const cid = chapterIdOf(info.url || url)
    const existing = findByChapterId(notesDir, cid)
    const file = existing ? existing.file : path.join(notesDir, `${cid ? cid + '-' : ''}${slug(lessonName)}.md`)
    const header = [
      `# ${lessonName}`,
      '',
      `- 来源页面：${info.url}`,
      `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
      `- 时长：${mmss(duration)}`,
      `- 转写段数：${segments.length}`,
      note ? `- 备注：${note}` : '',
      '',
      '---',
      '',
    ].filter((l) => l !== '').join('\n')
    fs.writeFileSync(file, `${header}\n${transcriptText}\n`, 'utf8')

    // 清理临时文件
    // ⚠️ 2026-10-24：不再在这里删，统一移到末尾的 finally，
    //    否则上面的 throw（转写失败 / 没有抓到内容）会跳过清理，留下 20~50MB 视频。

    say('saved', `课程日志已保存：${file}`)

    return {
      file,
      lessonName,
      duration,
      segmentCount: segments.length,
      chars: transcriptText.length,
      transcript: transcriptText,
      url: info.url,
      tabs: all.map((t) => ({ title: t.title, url: t.url })),
    }
  } finally {
    try { cdp.close() } catch { /* ignore */ }
    // ★ 无论成功、失败还是抛错，都清掉 .tmp
    try { fs.rmSync(path.join(notesDir, '.tmp'), { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

module.exports = { captureLesson, captureLessonViaExtension, isTranscribing }
