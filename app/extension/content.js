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

  /* ───────── 页面角标 ───────── */

  function mountBadge() {
    if (!isTop || !looksLikeLesson()) return
    if (document.getElementById('__studybuddy_badge')) return

    const box = document.createElement('div')
    box.id = '__studybuddy_badge'
    // 位置：右上角。右上留给状态条，右下留给答疑面板——两者不再重叠。
    box.style.cssText = [
      'position:fixed', 'right:16px', 'top:76px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px',
      'padding:8px 12px', 'border-radius:10px',
      'background:rgba(20,22,26,.92)', 'color:#e8eaed',
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 22px rgba(0,0,0,.35)', 'cursor:default',
      'border:1px solid rgba(255,255,255,.10)',
      'max-width:calc(100vw - 380px)',
    ].join(';')
    box.innerHTML = '<span style="font-size:14px">📚</span><span style="white-space:nowrap">学伴已就绪</span>'

    const close = document.createElement('span')
    close.textContent = '×'
    close.style.cssText = 'margin-left:6px;cursor:pointer;color:#9aa0a8;font-size:14px'
    close.onclick = () => box.remove()
    box.appendChild(close)

    document.documentElement.appendChild(box)
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
