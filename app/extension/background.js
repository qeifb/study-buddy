/**
 * 学习通学伴 · 扩展后台（MV3 Service Worker）
 *
 * 职责：
 *   1. 轮询本机应用（http://127.0.0.1:<port>），领任务、报状态
 *   2. 收到「抓取」任务时，把指令下发给对应标签页的内容脚本
 *   3. 把结果回传给应用
 *
 * 为什么是轮询而不是 WebSocket：MV3 后台会休眠、Node 无内置 WS 服务端，
 * 轮询最简单可靠。间隔 2 秒，对 CPU 几乎无感。
 */

/** 应用默认监听的端口（可被 popup 改写） */
const DEFAULT_PORT = 39517

let busy = false
let lastError = ''

async function getPort() {
  const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT })
  return port
}

async function appBase() {
  const port = await getPort()
  return `http://127.0.0.1:${port}`
}

/** 通知应用：我装好了/我还在 */
async function heartbeat(info = {}) {
  try {
    const tabs = await listCourseTabs()
    await fetch(`${await appBase()}/ext/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        at: Date.now(),
        tabs,
        ...info,
      }),
    })
    lastError = ''
    return true
  } catch (e) {
    lastError = String(e?.message || e)
    return false
  }
}

/** 找出当前打开的学习通标签页 */
async function listCourseTabs() {
  const tabs = await chrome.tabs.query({})
  const out = []
  for (const t of tabs) {
    const u = String(t.url || '')
    if (!/chaoxing\.com|xuexitong\.com/i.test(u)) continue
    if (/^edge:|^chrome:|^about:/i.test(u)) continue
    out.push({
      id: t.id,
      title: t.title || '',
      url: u,
      active: Boolean(t.active),
      windowId: t.windowId,
      /** 粗判：是不是视频播放页 */
      looksLesson: /studentstudy|knowledge\/cards|ananas\/modules/i.test(u),
    })
  }
  return out
}

/**
 * 让某个标签页执行抓取探测，拿回页面信息。
 *
 * 关键：学习通的视频藏在两层同源 iframe 里
 *   studentstudy → #iframe(knowledge/cards) → ananas/modules/video/index.html
 * 所以必须 allFrames: true 拿到**所有框架**的结果，再取第一个有 video 的。
 */
async function probeTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeInPage,
  })
  const frames = results
    .map((r) => r?.result)
    .filter(Boolean)
  // 优先挑有视频的那一帧
  const withVideo = frames.find((f) => (f.videos || []).some((v) => v.src))
  const top = frames.find((f) => f.isTop)
  return {
    frames: frames.length,
    video: withVideo ? withVideo.videos.find((v) => v.src) : null,
    videoFrameUrl: withVideo ? withVideo.url : '',
    tracks: frames.flatMap((f) => f.tracks || []),
    // 章节名只能取**主框架**的：子框架是播放器，它的标题是「视频」，取了就错
    chapterTitle: (top && top.chapterTitle) || '',
    // 课程总标题（如《人工智能，语言与伦理》），同样只取主框架
    courseTitle: (top && top.courseTitle) || '',
    courseCandidates: (top && top.courseCandidates) || {},
    title: (top && top.title) || '',
    url: (top && top.url) || '',
    bodyLen: (top && top.bodyLen) || 0,
    allVideos: frames.flatMap((f) => f.videos || []),
    // 便于排查：把各帧的标题也带出来，但不参与选名
    frameTitles: frames.map((f) => ({ top: f.isTop, title: f.title, chapter: f.chapterTitle })),
  }
}

/** 注入到页面里执行的探测函数（必须自包含，不能引用闭包） */
function probeInPage() {
  const clean = (s) => (s || '').replace(/\u200b/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  const vids = Array.from(document.querySelectorAll('video')).map((v) => ({
    src: v.currentSrc || v.src || '',
    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    paused: v.paused,
  }))
  const objs = Array.from(document.querySelectorAll('[objectid]')).map((e) => e.getAttribute('objectid'))
  const tracks = Array.from(document.querySelectorAll('track')).map((t) => ({ kind: t.kind, label: t.label, src: t.src }))

  // 章节标题：2026-10-21 实探 DOM 后的正确取法
  //   ✅ .prev_title[title]                → "人工智能的历史"（章节名，最准）
  //   ✅ .posCatalog_select.posCatalog_active → "1.1 人工智能的历史 2"（当前选中章节，需清洗）
  //   ❌ .prev_ul .active[title]           → "视频"（这是**任务点类型**，不是章节名，取到就错）
  //   ❌ document.title / 子框架 title      → "学生学习页面" / "视频"，都不对
  let chapterTitle = ''
  try {
    const t1 = document.querySelector('.prev_title[title]')
    if (t1) chapterTitle = t1.getAttribute('title') || ''
    if (!chapterTitle) {
      const t1b = document.querySelector('.prev_title')
      if (t1b) chapterTitle = clean(t1b.innerText || t1b.textContent || '')
    }
    if (!chapterTitle) {
      const active = document.querySelector('.posCatalog_select.posCatalog_active')
      if (active) {
        // 形如 "1.1 人工智能的历史 2"，掐掉前面的编号和末尾的任务点数
        let s = clean(active.innerText || active.textContent || '')
        s = s.replace(/^\d+(?:\.\d+)?\s*/, '').replace(/\s+\d+$/, '').trim()
        chapterTitle = s
      }
    }
  } catch { /* ignore */ }
  chapterTitle = String(chapterTitle || '').slice(0, 120)

  // 课程名（总标题，如《人工智能，语言与伦理》）：
  //   学习通不同版本位置不一样，按候选依次试，全部记录到 candidates 方便诊断
  let courseTitle = ''
  const courseCandidates = {}
  try {
    const cands = [
      '#courseName', '#course_name', '.courseName', '.course-name', '.course_name', '.coursename',
      '.courseNameTitle', '.courseTitle', '.course-title',
      '.prev_course', '.prev_course .prev_title',
      '.navigation .courseName', '.nav .courseName', '.nav-bar .courseName',
      '.crumbs', '.breadcrumb', '.location', 'h1',
    ]
    for (const s of cands) {
      try {
        const el = document.querySelector(s)
        if (!el) continue
        const txt = clean(el.getAttribute && el.getAttribute('title') ? el.getAttribute('title') : (el.innerText || el.textContent || '')).slice(0, 120)
        if (txt) courseCandidates[s] = txt
      } catch { /* ignore */ }
    }
    // 优先用语义明确的几个
    const order = ['#courseName', '#course_name', '.courseName', '.course-name', '.course_name', '.coursename', '.courseNameTitle', '.courseTitle', '.course-title', '.navigation .courseName', '.nav .courseName', '.nav-bar .courseName', '.prev_course']
    for (const k of order) {
      if (courseCandidates[k]) { courseTitle = courseCandidates[k]; break }
    }
    // 兜底：页面里的全局变量（部分学习通模板会写 window.courseName）
    if (!courseTitle) {
      for (const k of ['courseName', 'COURSE_NAME', 'courseTitle']) {
        const v = window[k]
        if (typeof v === 'string' && v.trim()) { courseTitle = v.trim(); break }
      }
    }
  } catch { /* ignore */ }

  // 只报「有没有」，不抓全文（全文由应用侧决定要不要）
  return {
    url: location.href,
    title: document.title,
    chapterTitle: clean(chapterTitle).slice(0, 120),
    courseTitle: clean(courseTitle).slice(0, 120),
    courseCandidates,
    videos: vids,
    objectids: objs.slice(0, 5),
    tracks,
    bodyLen: clean(document.body ? document.body.innerText : '').length,
    isTop: window === window.top,
  }
}

/** 注入到页面里：深挖「鼠标离开就暂停」的真实机制 —— 重点找监听器与检测实现 */
function deepProbePauseInPage() {
  const out = { url: location.href, isTop: window === window.top, gap: [] }

  try {
    // ① 抓 addEventListener 注册的监听器：临时替换原型方法记下调用栈
    const reg = []
    try {
      const origAdd = EventTarget.prototype.addEventListener
      // 只记录一次（标记避免重复包装）
      if (!window.__sbPatched) {
        window.__sbPatched = true
        window.__sbReg = reg
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
          try {
            if (typeof type === 'string' && /mouse|focus|blur|visib|leave|idle|pointer/i.test(type)) {
              const stack = (new Error().stack || '').split('\n').slice(2, 6).join(' | ')
              reg.push({ type, target: (this && this.constructor && this.constructor.name) || 'unknown', stack: stack.slice(0, 300) })
            }
          } catch { /* ignore */ }
          return origAdd.call(this, type, fn, opts)
        }
      } else if (window.__sbReg) {
        reg.push(...window.__sbReg.slice(-20))
      }
    } catch { /* ignore */ }

    // ② 找 video 元素与关键状态
    const v = document.querySelector('video')
    if (v) {
      out.video = {
        paused: v.paused,
        currentTime: Math.round(v.currentTime * 10) / 10,
        readyState: v.readyState,
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
        // 有没有被绑定 onmouseleave 之类的内联处理
        inlineHandlers: Array.from(v.attributes || []).map((a) => a.name).filter((n) => n.startsWith('on')),
      }
    }

    // ③ 是否存在「周期性检测鼠标位置」的定时器 —— 抠定时器 ID 不好做，
    //    改为检查常见反挂机库的特征
    const marks = []
    for (const k of Object.keys(window)) {
      if (/cheat|anti|guard|monitor|idle|away|detect|watch|supervis|activity/i.test(k)) {
        try { marks.push({ key: k, type: typeof window[k] }) } catch { /* ignore */ }
      }
    }

    // ④ 检查页面里可见的「提示语」——学习通暂停时常给文案
    const bodyText = (document.body?.innerText || '').slice(0, 3000)
    const hints = bodyText.match(/[^\n]{0,20}(暂停|离开|请勿|不要|保持|继续播放|检测)[^\n]{0,40}/g)

    out.gap = {
      listeners: reg.slice(-15),
      suspiciousGlobals: marks.slice(0, 15),
      pageHints: (hints || []).slice(0, 8),
      bodySample: bodyText.replace(/\s+/g, ' ').slice(0, 400),
    }
  } catch (e) {
    out.error = String(e)
  }
  return out
}

/**
 * 注入到页面里：全面挂钩 <video> 的所有「停」手段，找出学习通到底怎么暂停的。
 * 2026-10-21 发现：paused=true 但 pause() 从未被调用 ⇒ 说明它用了别的招。
 */
function armPauseHookInPage() {
  try {
    if (window.__sbPauseHook) return { armed: true, already: true }
    window.__sbPauseHook = true

    const v = document.querySelector('video')
    if (!v) return { armed: false, reason: '页面里没有 video 元素' }

    window.__sbPauseStacks = []
    window.__sbMouseEvents = []

    const record = (kind, detail) => {
      try {
        const stack = (new Error().stack || '').split('\n').slice(2, 14).map((s) => s.trim()).join(' <- ')
        window.__sbPauseStacks.push({
          kind,
          detail,
          at: Date.now(),
          stack: stack.slice(0, 1500),
          currentTime: Math.round((v.currentTime || 0) * 10) / 10,
          paused: v.paused,
          hasFocus: document.hasFocus(),
          visibility: document.visibilityState,
        })
        if (window.__sbPauseStacks.length > 20) window.__sbPauseStacks.shift()
      } catch { /* ignore */ }
    }

    // ① pause()
    const origPause = HTMLMediaElement.prototype.pause
    if (!origPause.__sbWrapped) {
      const wrapped = function () { record('pause()', null); return origPause.apply(this, arguments) }
      wrapped.__sbWrapped = true
      HTMLMediaElement.prototype.pause = wrapped
    }

    // ② play() 也记（便于看它是否被重新拉起）
    const origPlay = HTMLMediaElement.prototype.play
    if (!origPlay.__sbWrapped) {
      const wrapped = function () { record('play()', null); return origPlay.apply(this, arguments) }
      wrapped.__sbWrapped = true
      HTMLMediaElement.prototype.play = wrapped
    }

    // ③ 直接改 paused / currentTime / src / playbackRate 这些属性
    //    paused 是只读的（内部会走 pause），但 currentTime 和 src 可写
    for (const prop of ['currentTime', 'src', 'playbackRate', 'muted', 'volume']) {
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop)
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(v), prop)
        if (!desc || !desc.set || desc.set.__sbWrapped) continue
        const origSet = desc.set
        const wrappedSet = function (val) {
          record(`set ${prop}`, String(val).slice(0, 80))
          return origSet.call(this, val)
        }
        wrappedSet.__sbWrapped = true
        Object.defineProperty(HTMLMediaElement.prototype, prop, { ...desc, set: wrappedSet })
      } catch { /* ignore */ }
    }

    // ④ 监听 video 上的 pause 事件（不管谁触发的，事件一定会派发）
    try {
      v.addEventListener('pause', () => record('pause-event', null), true)
      v.addEventListener('ended', () => record('ended-event', null), true)
    } catch { /* ignore */ }

    // ⑤ 鼠标/焦点/可见性事件
    for (const t of ['mouseleave', 'mouseout', 'mouseenter', 'mousemove', 'blur', 'focus', 'visibilitychange', 'pagehide']) {
      try {
        document.addEventListener(t, (e) => {
          // mousemove 太频繁，只记计数
          if (t === 'mousemove') {
            window.__sbMouseMoveCount = (window.__sbMouseMoveCount || 0) + 1
            return
          }
          window.__sbMouseEvents.push({
            type: t,
            at: Date.now(),
            hasFocus: document.hasFocus(),
            target: (e.target && (e.target.className || e.target.tagName)) || '',
          })
          if (window.__sbMouseEvents.length > 40) window.__sbMouseEvents.shift()
        }, true)
      } catch { /* ignore */ }
    }

    return { armed: true, video: true, url: location.href, hooked: ['pause', 'play', 'currentTime', 'src', 'playbackRate', 'pause-event'] }
  } catch (e) {
    return { armed: false, error: String(e) }
  }
}

/** 注入到页面里：读取挂钩记录到的暂停调用栈 */
function readPauseHookInPage() {
  try {
    return {
      armed: Boolean(window.__sbPauseHook),
      pauseStacks: (window.__sbPauseStacks || []).slice(-8),
      mouseEvents: (window.__sbMouseEvents || []).slice(-16),
      mouseMoveCount: window.__sbMouseMoveCount || 0,
      videoState: (() => {
        const v = document.querySelector('video')
        return v
          ? { paused: v.paused, currentTime: Math.round(v.currentTime * 10) / 10, src: String(v.currentSrc || v.src).slice(0, 70) }
          : null
      })(),
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
    }
  } catch (e) {
    return { error: String(e) }
  }
}

/** 注入到页面里：读专注模式状态（兼容新旧两版） */
function focusStateInPage() {
  try {
    const v = document.querySelector('video')
    const newDiag = window.__sbFocusDiag ? window.__sbFocusDiag.state : null
    return {
      focusScriptLoaded: Boolean(window.__studyBuddyFocusMode),
      hasVideo: Boolean(v),
      paused: v ? v.paused : null,
      readyState: v ? v.readyState : null,
      currentTime: v ? Math.round(v.currentTime) : null,
      muted: v ? v.muted : null,
      diag: newDiag,
      badgeExists: Boolean(document.getElementById('__studybuddy_badge')),
      badgePos: (() => {
        const b = document.getElementById('__studybuddy_badge')
        if (!b) return null
        const s = getComputedStyle(b)
        return { top: s.top, bottom: s.bottom, right: s.right }
      })(),
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      url: location.href,
    }
  } catch (e) {
    return { error: String(e) }
  }
}

/**
 * 注入到页面里：实测 play() 会报什么错。
 * 这是判断「为什么自动续播不生效」的唯一可靠办法——不能靠猜。
 */
async function testPlayInPage() {
  const out = { steps: [] }
  const v = document.querySelector('video')
  if (!v) return { ok: false, error: '没有 video 元素' }

  const snap = (label) => {
    out.steps.push({
      label,
      paused: v.paused,
      muted: v.muted,
      readyState: v.readyState,
      currentTime: Math.round(v.currentTime),
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
    })
  }

  snap('初始')

  // 1) 先暂停
  try { v.pause(); out.pauseOk = true } catch (e) { out.pauseError = String(e) }
  await new Promise((r) => setTimeout(r, 300))
  snap('已暂停')

  // 2) 直接 play()
  try {
    const p = v.play()
    await p
    out.playNormal = 'success'
  } catch (e) {
    out.playNormal = `${e?.name || 'Error'}: ${e?.message || e}`
  }
  await new Promise((r) => setTimeout(r, 300))
  snap('play() 之后')

  // 3) 静音 play()
  if (v.paused) {
    try {
      v.muted = true
      await v.play()
      out.playMuted = 'success'
    } catch (e) {
      out.playMuted = `${e?.name || 'Error'}: ${e?.message || e}`
    }
    await new Promise((r) => setTimeout(r, 400))
    snap('静音 play() 之后')
  } else {
    out.playMuted = 'skipped (已经在播)'
  }

  // 4) 检查关键 API 是否存在
  out.apis = {
    canPlayType: typeof v.canPlayType,
    play: typeof v.play,
    pause: typeof v.pause,
    autoPlayAttr: v.autoplay,
    // 学习通可能用了 videojs，检查它的 play 是否被改过
    playIsNative: String(v.play).includes('[native code]'),
    pauseIsNative: String(HTMLMediaElement.prototype.pause).includes('[native code]'),
  }

  out.ok = true
  return out
}

/** 注入到页面里：点开「视频」任务点（自包含） */
function clickVideoTabInPage() {
  try {
    const els = Array.from(document.querySelectorAll('[onclick]')).filter((e) => {
      const oc = e.getAttribute('onclick') || ''
      return /changeDisplayContent\s*\(/.test(oc) && /视频|音频/.test(e.textContent || '')
    })
    if (!els.length) return { clicked: false, reason: '没有找到视频任务点入口' }
    const el = els[0]
    const onclick = el.getAttribute('onclick') || ''
    el.click()
    return { clicked: true, text: (el.textContent || '').replace(/\s+/g, ' ').trim(), onclick }
  } catch (e) {
    return { clicked: false, reason: String(e) }
  }
}

/** 注入到页面里：读播放状态（用于验证焦点/可见性对暂停的影响） */
function readPlayStateInPage() {
  try {
    const v = document.querySelector('video')
    if (!v) return { hasVideo: false, isTop: window === window.top, url: location.href }
    return {
      hasVideo: true,
      isTop: window === window.top,
      paused: v.paused,
      currentTime: Math.round(v.currentTime * 10) / 10,
      readyState: v.readyState,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      hidden: document.hidden,
    }
  } catch (e) {
    return { error: String(e) }
  }
}

/** 注入到页面里：探查「鼠标离开就暂停」的检测机制 */
function probePauseMechanismInPage() {
  const out = {
    url: location.href,
    isTop: window === window.top,
    listeners: [],
    videoState: null,
    // 学习通播放器常见的防挂机检测字段
    globals: {},
  }

  try {
    const v = document.querySelector('video')
    if (v) {
      out.videoState = {
        paused: v.paused,
        currentTime: Math.round(v.currentTime),
        readyState: v.readyState,
        hasPlay: typeof v.play === 'function',
      }
      // 抓 play/pause 事件的绑定情况
      out.videoEvents = {
        onplay: typeof v.onplay,
        onpause: typeof v.onpause,
        onmouseleave: typeof v.onmouseleave,
      }
    }

    // 检测常见「鼠标离开检测」实现
    const probe = {}
    probe.hasMouseLeaveOnDoc = typeof document.onmouseleave
    probe.hasVisibilityHandler = typeof document.onvisibilitychange
    // 学习通常把检测挂在 window 上
    probe.windowListeners = []
    for (const k of ['onblur', 'onfocus', 'onmouseleave', 'onmouseout', 'onmousemove']) {
      probe.windowListeners.push({ key: k, type: typeof window[k] })
    }
    // 找播放器容器的类
    const player = document.querySelector('.video-js, .vjs-tech, #video_html5_api')
    if (player) {
      probe.playerCls = String(player.className || '').slice(0, 80)
      probe.playerTag = player.tagName
    }
    // 有没有「鼠标移出」相关的自定义属性/事件
    probe.candidates = Array.from(document.querySelectorAll('[onmouseleave],[onmouseout],[onblur]'))
      .slice(0, 5)
      .map((e) => ({
        tag: e.tagName,
        cls: String(e.className || '').slice(0, 50),
        attr: e.getAttributeNames().filter((n) => /mouse|blur|leave/i.test(n)),
      }))
    out.globals = probe
  } catch (e) {
    out.error = String(e)
  }
  return out
}

/** 注入到页面里：dump 章节目录的 DOM 结构，用于找出可靠选择器（临时调试用） */
function dumpChapterDomInPage() {  const out = { url: location.href, title: document.title, found: [] }
  try {
    // 找出所有可能承载「当前章节名」的元素
    const sels = [
      '.chapter_item.active', '.chapter_item.cur', '.chapter_item[title]',
      '.posCatalog_select', '.prev_ul .active', '.chapter_title', '.prev_title',
      '.chapterName', '.knowledge-title', '.catalog_name', '.newCatalog_name',
      'h1', '.prev_huodong', '.chapter_h2', '.px10',
    ]
    for (const s of sels) {
      const els = document.querySelectorAll(s)
      if (!els.length) continue
      out.found.push({
        sel: s,
        count: els.length,
        samples: Array.from(els).slice(0, 4).map((e) => ({
          text: (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          title: e.getAttribute('title') || '',
          cls: String(e.className || '').slice(0, 60),
        })),
      })
    }
    // 页面里所有带 title 属性的元素
    out.titledAttributes = Array.from(document.querySelectorAll('[title]'))
      .slice(0, 20)
      .map((e) => ({ tag: e.tagName, cls: String(e.className || '').slice(0, 40), title: e.getAttribute('title') || '' }))
  } catch (e) {
    out.error = String(e)
  }
  return out
}

/**
 * 注入到课程页（mooc2-ans/mycourse/stu 这类目录页）里：抓左上角的课程名。
 * 2026-10-22 用户在课程目录页截图确认：左上角封面下方就是《人工智能，语言与伦理》。
 */
function courseTitleInPage() {
  const clean = (s) => String(s || '').replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim()
  const out = { url: location.href, title: document.title, found: [], leftTop: '' }
  try { out.leftTop = clean((document.body ? document.body.innerText : '').slice(0, 200)) } catch { /* ignore */ }
  const sels = [
    '.courseName', '.course-name', '.course_name', '.couName', '#courseName',
    '.center-cour-title', '.course-title', '.courseTitle', '.cou-title',
    '.mark_title', '.markTitle', '.m25', '.tit', 'h1', 'h2',
    '[class*="courseName"]', '[class*="course-name"]', '[class*="course_title"]',
  ]
  for (const s of sels) {
    try {
      for (const e of Array.from(document.querySelectorAll(s)).slice(0, 4)) {
        const t = clean(e.textContent).slice(0, 80)
        if (t && t.length >= 2) out.found.push({ sel: s, text: t, cls: String(e.className || '').slice(0, 50) })
      }
    } catch { /* ignore */ }
  }
  // 左上角区域专用：很多版本把课程名放在侧栏顶部第一个大字号元素里
  try {
    const box = document.querySelector('.left, .leftBox, .courseLeft, .chapter_left, #chapterList') || null
    if (box) {
      const big = Array.from(box.querySelectorAll('*')).find((e) => {
        const t = clean(e.textContent)
        return t.length >= 4 && t.length <= 40 && Number(getComputedStyle(e).fontSize.replace('px', '')) >= 15
      })
      if (big) out.found.push({ sel: '(left-big)', text: clean(big.textContent).slice(0, 80), cls: String(big.className || '').slice(0, 50) })
    }
  } catch { /* ignore */ }
  return out
}

/**
 * 注入到页面里：查「课程名（总标题）」。
 * 为什么不在 DOM 里找：2026-10-22 用 dumpChapterDom 实测，学习通 studentstudy 页面
 * 只有章节名（`.prev_title` / `.posCatalog_name`）和章标题，**没有任何课程名元素**。
 * 课程名只出现在课程主页，所以这里带登录态去课程页取（同源 fetch，自动带 cookie）。
 */
async function courseNameInPage(courseId, clazzid) {
  const out = { courseId, clazzid, tried: [] }
  const urls = []
  if (courseId && clazzid) urls.push(`/mycourse/studentcourse?courseId=${courseId}&clazzid=${clazzid}`)
  if (courseId) urls.push(`/course/${courseId}.html`, `/visit/interaction?courseId=${courseId}&clazzid=${clazzid || 0}`)
  if (!urls.length) return { ...out, error: '没有 courseId' }

  // 这些是页面 <title> 里出现的通用词，不是课程名
  const GENERIC = /^(课程|课程门户首页|课程首页|学生学习页面|视频|超星|学习通|用户登录|登录|首页)$/

  for (const u of urls) {
    try {
      const r = await fetch(u, { credentials: 'include', redirect: 'follow' })
      const t = await r.text()
      const title = ((t.match(/<title>([^<]{2,80})<\/title>/i) || [])[1] || '').trim()

      // 去 script/style 后的纯文本，取前 600 字用于人工判断课程名在哪
      const plain = t
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      const candidates = []
      const patterns = [
        /class="[^"]*(?:courseName|course_name|course-title|courseTitle|coursename)[^"]*"[^>]*>([^<]{2,60})</gi,
        /<h1[^>]*>([^<]{2,60})<\/h1>/gi,
        /<h2[^>]*>([^<]{2,60})<\/h2>/gi,
        /<meta\s+name="(?:courseName|course_name)"\s+content="([^"]{2,60})"/gi,
        /var\s+(?:courseName|course_name)\s*=\s*["']([^"']{2,60})["']/gi,
        /["'](?:courseName|course_name)["']\s*:\s*["']([^"']{2,60})["']/gi,
      ]
      for (const re of patterns) {
        for (const m of t.matchAll(re)) {
          const v = String(m[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          if (v && v.length >= 2 && v.length <= 60 && !GENERIC.test(v) && !candidates.includes(v)) candidates.push(v)
        }
      }

      // 诊断用：所有 h1~h3 文本 + 含「课程名/人工智能」的片段
      const heads = []
      for (const re of [/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/gi, /<h2[^>]*>([\s\S]{0,120}?)<\/h2>/gi, /<h3[^>]*>([\s\S]{0,120}?)<\/h3>/gi]) {
        for (const m of t.matchAll(re)) {
          const v = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          if (v && v.length <= 80 && !heads.includes(v)) heads.push(v)
        }
      }
      const hits = []
      for (const m of t.matchAll(/.{0,50}(?:courseName|course_name|课程名|课程名称).{0,50}/gi)) {
        const v = m[0].replace(/\s+/g, ' ').trim()
        if (v && !hits.includes(v)) hits.push(v)
        if (hits.length >= 8) break
      }

      const loginPage = /passport2\.chaoxing\.com|用户登录/.test(t.slice(0, 2000)) || /登录/.test(title)
      out.tried.push({
        url: u, status: r.status, title, candidates, len: t.length, loginPage,
        heads: heads.slice(0, 12), hits, plain: plain.slice(0, 600),
      })

      // 优先级：候选选择器 > 非通用 title > h1 文本
      if (!out.courseTitle && candidates.length) out.courseTitle = candidates[0]
      if (!out.courseTitle && title && title.length <= 40 && !GENERIC.test(title) && !loginPage) out.courseTitle = title
      if (!out.courseTitle && heads.length) {
        const good = heads.find((h) => h.length >= 4 && h.length <= 40 && !GENERIC.test(h))
        if (good) out.courseTitle = good
      }
    } catch (e) {
      out.tried.push({ url: u, error: String(e && e.message ? e.message : e) })
    }
  }

  // 兜底：学习通「我学的课」列表是 XHR 拉的，HTML 骨架里根本没有课程名。
  // 直接打课程列表接口，按 courseId 找到课程卡片，再从卡片 HTML 里抽名字。
  if (courseId) {
    try {
      const r = await fetch('/visit/courselistdata', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'courseType=1&courseFolderId=0&courseFolderSize=0&baseEducation=0&isGjkc=0',
      })
      const t = await r.text()
      const near = []
      for (const m of t.matchAll(new RegExp(`.{0,400}${courseId}.{0,400}`, 'g'))) {
        near.push(m[0].replace(/\s+/g, ' '))
        if (near.length >= 3) break
      }
      const aiHits = []
      for (const m of t.matchAll(/.{0,80}(?:人工智能|伦理).{0,80}/g)) {
        aiHits.push(m[0].replace(/\s+/g, ' '))
        if (aiHits.length >= 6) break
      }
      let name = ''
      for (const seg of near) {
        for (const re of [
          /class="[^"]*(?:courseName|course_name|course-name)[^"]*"[^>]*>([^<]{2,60})</i,
          /<span[^>]*>([^<]{4,40})<\/span>/i,
          /title="([^"]{2,60})"/i,
        ]) {
          const m = seg.match(re)
          if (m) {
            const v = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            if (v && v.length >= 2 && v.length <= 60 && !GENERIC.test(v)) { name = v; break }
          }
        }
        if (name) break
      }
      out.tried.push({
        url: '/visit/courselistdata', status: r.status, len: t.length,
        nearCount: near.length, nearHits: near.slice(0, 2), aiHits, name,
      })
      if (!out.courseTitle && name) out.courseTitle = name
    } catch (e) {
      out.tried.push({ url: '/visit/courselistdata', error: String(e && e.message ? e.message : e) })
    }
  }

  return out
}

/** 处理一个任务 */
async function handleJob(job) {
  const { id, type, tabId } = job
  const report = async (patch) => {
    try {
      await fetch(`${await appBase()}/ext/job/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      })
    } catch (e) { lastError = String(e?.message || e) }
  }

  try {
    if (type === 'probe') {      await report({ status: 'running', note: '正在读取页面结构' })
      const info = await probeTab(tabId)
      await report({ status: 'done', result: info })
      return
    }

    if (type === 'listTabs') {
      await report({ status: 'done', result: { tabs: await listCourseTabs() } })
      return
    }
    // 抓视频直链：让页面告诉我们视频在哪
    if (type === 'findVideo') {
      await report({ status: 'running', note: '正在定位视频' })
      const info = await probeTab(tabId)
      await report({
        status: 'done',
        result: {
          found: Boolean(info && info.video),
          video: info?.video || null,
          url: info?.url || '',
          title: info?.title || '',
          chapterTitle: info?.chapterTitle || '',
          frames: info?.frames || 0,
          videoFrameUrl: info?.videoFrameUrl || '',
          allVideos: info?.allVideos || [],
        },
      })
      return
    }
    // 点开「视频」任务点（有的章节默认停在「学习目标」，视频还没加载）
    if (type === 'clickVideoTab') {
      await report({ status: 'running', note: '尝试点开视频任务点' })
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: clickVideoTabInPage,
      })
      const clicked = results.map((r) => r?.result).find((x) => x && x.clicked)
      await report({ status: 'done', result: clicked || { clicked: false } })
      return
    }

    /**
     * 兜底方案：由 background 直接往播放器那个 frame 注入续播逻辑。
     * 场景：如果 content_scripts 没覆盖到动态创建的 iframe，
     *      或者那帧里的 focus-mode.js 没跑起来（实测可能是这样），
     *      就由后台用 executeScript 主动注入一次。
     */
    if (type === 'injectFocusToVideoFrame') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const v = document.querySelector('video')
          return v ? { hasVideo: true, url: location.href, hasFocusScript: Boolean(window.__studyBuddyFocusMode) } : { hasVideo: false }
        },
      })
      const frames = results.map((r) => r?.result).filter((x) => x && x.hasVideo)
      await report({ status: 'done', result: { videoFrames: frames.length, frames } })
      return
    }

    /**
     * 脚本化点击「专注模式」按钮 —— 省得靠猜坐标点。
     * 同时可直接设定开关（on=true/false）。
     */
    if (type === 'clickFocusBtn') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn = document.querySelector('.__sb_focus_btn')
          if (!btn) {
            // 按钮没渲染出来，退而直接设置状态
            return { clicked: false, reason: '页面上没有专注模式按钮（脚本可能未生效）' }
          }
          const before = btn.textContent
          btn.click()
          return { clicked: true, before, after: btn.textContent }
        },
      })
      await report({ status: 'done', result: results[0]?.result || null })
      return
    }

    if (type === 'focusState') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: focusStateInPage,
      })
      const all = results.map((r) => r?.result).filter(Boolean)
      // 只报「有 video 或者有专注脚本」的帧，减少噪音
      await report({ status: 'done', result: all.filter((x) => x.hasVideo || x.focusScriptLoaded || x.diag) })
      return
    }

    if (type === 'testPlay') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: testPlayInPage,
      })
      const all = results.map((r) => r?.result).filter((x) => x && x.ok)
      await report({ status: 'done', result: all[0] || null })
      return
    }

    if (type === 'armPauseHook') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: armPauseHookInPage,
      })
      await report({ status: 'done', result: results.map((r) => r?.result).filter(Boolean) })
      return
    }

    if (type === 'readPauseHook') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: readPauseHookInPage,
      })
      await report({ status: 'done', result: results.map((r) => r?.result).filter((x) => x && (x.armed || x.error)) })
      return
    }

    if (type === 'readPlayState') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: readPlayStateInPage,
      })
      const all = results.map((r) => r?.result).filter(Boolean)
      await report({ status: 'done', result: all.filter((x) => x.hasVideo) })
      return
    }

    if (type === 'deepProbePause') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: deepProbePauseInPage,
      })
      await report({ status: 'done', result: results.map((r) => r?.result).filter(Boolean) })
      return
    }

    if (type === 'probePauseMechanism') {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: probePauseMechanismInPage,
      })
      await report({ status: 'done', result: results.map((r) => r?.result).filter(Boolean) })
      return
    }

    if (type === 'dumpChapterDom') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: dumpChapterDomInPage,
      })
      await report({ status: 'done', result: results[0]?.result || null })
      return
    }

    // 从「任意一个已打开的学习通课程页」抓课程名。
    // 场景：视频播放页（studentstudy）与课程目录页（mooc2-ans/mycourse/stu）是两个页面，
    // 课程名只在目录页左上角。只要用户开着目录页，就能从那儿读出来。
    if (type === 'courseTitleAnyTab') {
      const tabs = await chrome.tabs.query({ url: ['*://*.chaoxing.com/*', '*://*.xuexitong.com/*'] })
      const targets = (tabs || []).filter(
        (t) => t.url && (/mycourse\/stu|courseid=\d+/i.test(t.url) || /courseid=/i.test(t.url)) && t.id !== tabId ? true : false,
      )
      // 也把当前 tab 算进去（播放页上可能也有课程名，虽然实测没有）
      const list = (tabs || []).filter((t) => t.url && /courseid=/i.test(t.url))
      const out = []
      for (const t of list) {
        try {
          const r = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: courseTitleInPage })
          out.push({ tabId: t.id, url: t.url, ...(r[0]?.result || {}) })
        } catch (e) {
          out.push({ tabId: t.id, url: t.url, error: String((e && e.message) || e) })
        }
      }
      await report({ status: 'done', result: { tabs: out, extra: targets.length } })
      return
    }

    // 找「课程名（总标题）」：播放页 DOM 里没有，只能带登录态去课程页取。
    if (type === 'courseName') {
      const args = job.args || {}
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: courseNameInPage,
        args: [args.courseId || '', args.clazzid || ''],
      })
      await report({ status: 'done', result: results[0]?.result || null })
      return
    }

    await report({ status: 'failed', error: `未知任务类型 ${type}` })
  } catch (e) {
    await report({ status: 'failed', error: String(e?.message || e) })
  }
}

/** 轮询应用：有没有任务 */
async function poll() {
  if (busy) return
  busy = true
  try {
    const res = await fetch(`${await appBase()}/ext/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: Date.now() }),
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      const data = await res.json()
      if (data && data.job) {
        await handleJob(data.job)
      }
    }
  } catch { /* 应用没开就静默 */ } finally {
    busy = false
  }
}

/* ───────── 定时器：心跳 + 轮询 ───────── */

let timer = null

function kick() {
  if (timer) return
  timer = setInterval(() => {
    heartbeat().then(() => poll())
  }, 2000)
}

chrome.runtime.onInstalled.addListener(() => {
  kick()
  heartbeat({ installed: true })
})

chrome.runtime.onStartup.addListener(() => kick())

// Service Worker 每次唤醒都重新 kick
kick()
heartbeat({ woke: true })

// popup / 内容脚本可以主动请求一次
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  /**
   * 告诉内容脚本它自己所在的 tabId。
   *
   * 内容脚本拿不到自己的 tabId，而应用端调 executeScript 时必须要有它，
   * 否则报 "Missing required property 'tabId'"（2026-10-24 用户实测）。
   * sender.tab.id 就是最可靠的来源。
   */
  if (msg?.type === 'studybuddy:whoami') {
    try {
      const tabId = _sender && _sender.tab && Number.isInteger(_sender.tab.id) ? _sender.tab.id : null
      sendResponse({ ok: tabId != null, tabId })
    } catch (e) {
      sendResponse({ ok: false, tabId: null, error: String(e?.message || e) })
    }
    return true
  }

  if (msg?.type === 'ping') {
    heartbeat().then((ok) => sendResponse({ ok, lastError, port: null }))
    return true
  }
  if (msg?.type === 'poll-now') {
    poll().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg?.type === 'set-port') {
    chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT }).then(() => {
      heartbeat().then((ok) => sendResponse({ ok }))
    })
    return true
  }

  /**
   * 代理请求：内容脚本在页面里发同级跨源请求会被 CORS 拦（Failed to fetch），
   * background 有 host_permissions 不受限制，所以统一由这里代发。
   */
  if (msg?.type === 'studybuddy:fetch') {
    ;(async () => {
      try {
        const url = String(msg.url || '')
        // 只允许转发到本机应用，防止被利用当开放代理
        if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) {
          return sendResponse({ ok: false, error: '拒绝转发非本机地址' })
        }
        const timeoutMs = Math.min(Number(msg.timeoutMs) || 30000, 180000)
        const res = await fetch(url, {
          method: msg.method || 'GET',
          headers: { 'content-type': 'application/json' },
          body: msg.body === undefined ? undefined : JSON.stringify(msg.body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await res.text()
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = { ok: false, error: `应用返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } }
        sendResponse(parsed)
      } catch (e) {
        sendResponse({ ok: false, error: `转发请求失败：${e?.name || ''} ${e?.message || e}` })
      }
    })()
    return true
  }

  return false
})

// 标签页变化时顺手更新一次心跳，让应用看到最新列表
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url) heartbeat()
})
chrome.tabs.onRemoved.addListener(() => heartbeat())
chrome.tabs.onCreated.addListener(() => heartbeat())
