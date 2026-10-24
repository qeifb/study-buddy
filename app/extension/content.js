/**
 * 学习通学伴 · 内容脚本
 *
 * 跑在学习通页面里，负责：
 *   1. 在页面右下角显示一个小提示，让用户知道学伴在这
 *   2. 接收后台指令，把视频直链等页面信息报上去
 *
 * 注意：内容脚本不直接抓转写，只做「页面内取证」——真正的下载/转写由应用做。
 */

;(function () {
  if (window.__studyBuddyContent) return
  window.__studyBuddyContent = true

  /** 只在顶层文档显示角标，避免 iframe 里重复出现 */
  const isTop = window === window.top

  const WATCH = /studentstudy|knowledge\/cards|ananas\/modules|mooc2-ans\/mycourse/i

  function looksLikeLesson() {
    return WATCH.test(location.href) || document.querySelector('video') !== null
  }

  /* ───────── 页面角标（可拖动） ───────── */

  const LS_BADGE_POS = '__sb_badge_pos'   // 记住用户拖到的位置

  function mountBadge() {
    if (!isTop || !looksLikeLesson()) return
    if (document.getElementById('__studybuddy_badge')) return

    const box = document.createElement('div')
    box.id = '__studybuddy_badge'
    // 位置：默认右上角；用户拖过后沿用其保存的位置。
    // 2026-10-24 用户反馈：「这张卡片挡住了一些内容不好移开查看」→ 改为可拖动。
    box.style.cssText = [
      'position:fixed', 'right:16px', 'top:76px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px',
      'padding:8px 12px', 'border-radius:10px',
      'background:rgba(20,22,26,.92)', 'color:#e8eaed',
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 22px rgba(0,0,0,.35)', 'cursor:move',
      'border:1px solid rgba(255,255,255,.10)',
      'user-select:none', 'touch-action:none',
      'max-width:calc(100vw - 340px)',
      'transition:box-shadow .15s',
    ].join(';')
    box.innerHTML = '<span style="font-size:14px">📚</span><span style="white-space:nowrap">学伴已就绪</span>'

    const close = document.createElement('span')
    close.textContent = '×'
    close.style.cssText = 'margin-left:6px;cursor:pointer;color:#9aa0a8;font-size:14px;padding:0 2px'
    close.title = '关闭（刷新后重新出现）'
    close.onclick = (e) => { e.stopPropagation(); box.remove() }

    // ── 拖动实现 ──
    // 用 left/top 定位（拖动态），不用 transform，避免与页面内其他样式冲突。
    function applySavedPos() {
      let saved = null
      try { saved = JSON.parse(localStorage.getItem(LS_BADGE_POS) || 'null') } catch { /* ignore */ }
      if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return false
      // 夹到可视区域内，避免拖太远后看不到
      const maxL = Math.max(0, window.innerWidth - 80)
      const maxT = Math.max(0, window.innerHeight - 40)
      box.style.left = Math.min(Math.max(0, saved.left), maxL) + 'px'
      box.style.top = Math.min(Math.max(0, saved.top), maxT) + 'px'
      box.style.right = 'auto'
      return true
    }

    let dragging = false
    let startX = 0
    let startY = 0
    let origLeft = 0
    let origTop = 0
    let moved = false
    const DRAG_THRESHOLD = 6   // 超过这个像素才算拖动（原来 3 太松，手抖就触发）

    /**
     * ⚠️⚠️ 2026-10-24 用户实测：「一键播放答题按钮点不了，是不是长按拖动判断太松，
     *       每次点按钮都被当成拖动卡片」—— **用户猜对了**。
     *
     * 原实现两个致命错误：
     *   ① `pointerdown` 里无条件 `e.preventDefault()`。
     *      preventDefault 在 pointerdown 上会**阻止后续 click 事件的产生**
     *      ⇒ 这个容器里所有按钮（一键播放答题）永远收不到 click。
     *   ② `setPointerCapture(e.pointerId)` 在按下瞬间就抢占指针，
     *      按钮的点击流程被打断。
     *
     * 修复原则：**「想拖」和「想点」必须区分开**。
     *   · pointerdown：只记录起点，**绝不 preventDefault、绝不 capture**
     *   · pointermove：位移超过阈值才真正进入拖动（此时才 capture + preventDefault）
     *   · 没超过阈值 → 什么都不做，让浏览器正常派发 click 给内部按钮
     */
    box.addEventListener('pointerdown', (e) => {
      if (e.target === close) return
      // 只记录起点，不做任何会干扰点击的事
      dragging = false          // 先不认为在拖
      moved = false
      startX = e.clientX
      startY = e.clientY
      const r = box.getBoundingClientRect()
      origLeft = r.left
      origTop = r.top
    })

    box.addEventListener('pointermove', (e) => {
      if (startX === 0 && startY === 0) return   // 没按下过
      const dx = e.clientX - startX
      const dy = e.clientY - startY

      // 位移未超过阈值 → 仍视为「点击」，不动 DOM、不阻止默认行为
      if (!dragging) {
        if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return
        // 超过阈值：现在才真正进入拖动
        dragging = true
        moved = true
        box.style.left = origLeft + 'px'
        box.style.top = origTop + 'px'
        box.style.right = 'auto'
        box.style.boxShadow = '0 10px 30px rgba(0,0,0,.5)'
        try { box.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      }

      e.preventDefault()
      const maxL = Math.max(0, window.innerWidth - box.offsetWidth)
      const maxT = Math.max(0, window.innerHeight - box.offsetHeight)
      box.style.left = Math.min(Math.max(0, origLeft + dx), maxL) + 'px'
      box.style.top = Math.min(Math.max(0, origTop + dy), maxT) + 'px'
    })

    function endDrag(e) {
      const wasDragging = dragging
      dragging = false
      if (wasDragging) {
        box.style.boxShadow = '0 6px 22px rgba(0,0,0,.35)'
        try { box.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
        if (moved) {
          const r = box.getBoundingClientRect()
          try {
            localStorage.setItem(LS_BADGE_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }))
          } catch { /* ignore */ }
        }
      }
      // 复位起点，避免 pointermove 在未按下时误判
      startX = 0
      startY = 0
    }
    box.addEventListener('pointerup', endDrag)
    box.addEventListener('pointercancel', endDrag)

    // 双击复位到右上角
    box.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      try { localStorage.removeItem(LS_BADGE_POS) } catch { /* ignore */ }
      box.style.left = 'auto'
      box.style.right = '16px'
      box.style.top = '76px'
    })
    box.title = '拖动可移动位置；双击复位'

    box.appendChild(close)

    // 先挂上去才能量尺寸，再应用保存的位置
    document.documentElement.appendChild(box)
    applySavedPos()

    // 窗口尺寸变化时避免跑到外面
    window.addEventListener('resize', () => {
      if (!box.isConnected) return
      const r = box.getBoundingClientRect()
      if (r.right > window.innerWidth || r.bottom > window.innerHeight) {
        const maxL = Math.max(0, window.innerWidth - box.offsetWidth)
        const maxT = Math.max(0, window.innerHeight - box.offsetHeight)
        box.style.left = Math.min(Math.max(0, r.left), maxL) + 'px'
        box.style.top = Math.min(Math.max(0, r.top), maxT) + 'px'
        box.style.right = 'auto'
      }
    })
  }

  /* ───────── 视频直链查找（含跨 iframe 同源递归） ───────── */

  function findVideoIn(doc, depth) {
    if (!doc || depth > 5) return null
    const v = doc.querySelector('video')
    if (v && (v.currentSrc || v.src)) {
      return {
        src: v.currentSrc || v.src,
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        paused: v.paused,
        frameUrl: (() => { try { return doc.location.href } catch { return '' } })(),
      }
    }
    for (const f of doc.querySelectorAll('iframe')) {
      let sub = null
      try { sub = f.contentDocument } catch { sub = null }
      if (!sub) continue
      const r = findVideoIn(sub, depth + 1)
      if (r) return r
    }
    return null
  }

  /** 响应后台的取证请求 */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'studybuddy:probe') {
      const video = findVideoIn(document, 0)
      let chapterTitle = ''
      try {
        const el = document.querySelector('.chapter_item[title]')
        if (el) chapterTitle = el.getAttribute('title') || ''
        if (!chapterTitle) {
          const h = document.querySelector('.prev_ul .active, .posCatalog_select.active, h1')
          if (h) chapterTitle = (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        }
      } catch { /* ignore */ }

      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        chapterTitle,
        video,
        isTop,
      })
      return true
    }

    if (msg?.type === 'studybuddy:ping') {
      sendResponse({ ok: true, url: location.href, looksLikeLesson: looksLikeLesson() })
      return true
    }
    return false
  })

  /* ───────── 播放看门狗：暂停时提示，但不自动续播 ───────── */

  const PORT = 39517
  let lastPaused = null

  function reportPlayState() {
    try {
      const v = document.querySelector('video')
      if (!v || !isTop) return
      const paused = v.paused
      if (paused === lastPaused) return
      lastPaused = paused
      fetch(`http://127.0.0.1:${PORT}/ext/playstate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paused,
          currentTime: Math.round(v.currentTime),
          url: location.href,
          hasFocus: document.hasFocus(),
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => { /* 应用没开就忽略 */ })

      // 只有「从播放变成暂停」才提示；而且只提示，不替他续播
      if (paused && lastPausedWasPlaying) {
        showPauseTip()
      }
      lastPausedWasPlaying = !paused
    } catch { /* ignore */ }
  }

  let lastPausedWasPlaying = false
  let tipShown = false

  function showPauseTip() {
    if (tipShown) return
    tipShown = true
    const tip = document.createElement('div')
    tip.style.cssText = [
      'position:fixed', 'left:50%', 'top:18px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:9px 14px', 'border-radius:10px',
      'background:rgba(255,200,87,.95)', 'color:#2b2b2b',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.3)', 'cursor:pointer',
      'max-width:80vw',
    ].join(';')
    tip.textContent = '⏸ 视频暂停了。点「▶」继续播放（学伴不会自动替你续播）'
    tip.onclick = () => tip.remove()
    document.documentElement.appendChild(tip)
    setTimeout(() => { try { tip.remove() } catch { /* ignore */ } tipShown = false }, 6000)
  }

  // 每 1.5 秒看一眼播放状态，变化时才上报
  setInterval(reportPlayState, 1500)

  /* ───────── 启动 ───────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBadge, { once: true })
  } else {
    mountBadge()
  }

  // SPA 切换章节时重新挂
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      mountBadge()
    }
  }, 2500)
})()
