/**
 * 学习通学伴 · 专注模式（默认开启，无需开关）
 *
 * 场景：人坐在电脑前看课，只是鼠标跑去点应用了。
 * 学习通把「鼠标离开播放框」误判成「人离开」，于是暂停视频。
 *
 * 设计（2026-10-21 简化重写）：
 *   之前用「开关 + 跨 frame 状态同步」太脆弱——开关在主框架、播放器在子 frame，
 *   iframe 一重建状态就丢，还要广播、还要点按钮。
 *   现在改成：**在播放页就一直工作**，不依赖任何持久化状态。
 *   唯一要做的是：每 500ms 看一眼有没有 video，暂停了就 play() 起来。
 *
 * 这个脚本注入到所有 frame，但真正干活的是「能找到 video 的那一帧」。
 * 主框架同源可以穿透 iframe 找到子框架的 video，所以主框架也能干活。
 *
 * 用户随时可关：点角标上的「暂停守护」按钮（关掉后本页不再续播）。
 */
;(function () {
  /* ★ 2026-10-25 修「出现多个专注模式卡片」的 bug
   *
   * 原因：window.__studyBuddyFocusMode 只能防「同一个扩展的同一上下文」重复注入。
   *   如果页面里同时存在完整版扩展和仅专注模式扩展（或同版本装了两份），
   *   它们各有独立的 JS 上下文，window 变量互不可见 → 各插一个按钮 → 多个卡片。
   *
   * 修法：DOM 是共享的，所以用一个 DOM 元素当全局锁：
   *   如果页面里已经存在带 data-sb-focus-lock 的元素，说明别的实例已在工作，直接退出。
   */
  try {
    if (document.querySelector('[data-sb-focus-lock]')) return
  } catch { /* ignore */ }
  const lockEl = document.createElement('meta')
  lockEl.setAttribute('data-sb-focus-lock', '1')
  try { (document.head || document.documentElement).appendChild(lockEl) } catch { /* ignore */ }

  if (window.__studyBuddyFocusMode) return
  window.__studyBuddyFocusMode = true

  /** 用户手动关闭标记 —— 必须是跨帧、且刷新后仍有效的，用 localStorage */
  const OFF_KEY = '__studybuddy_focus_off'
  let userDisabled = false
  let resumeCount = 0
  let lastResumeAt = 0
  let lastPlayedAt = 0

  /**
   * 读「关闭」状态。
   * 之前用纯内存变量，导致：主框架点了按钮，子框架（真正续播的那个）不知道，
   * 于是「关不掉、一直反复重启播放」。改成 localStorage 后所有同源帧共享，
   * 且刷新/重载后仍然有效。
   */
  function isOff() {
    try { return localStorage.getItem(OFF_KEY) === '1' } catch { return userDisabled }
  }

  function setOff(next) {
    userDisabled = next
    try { localStorage.setItem(OFF_KEY, next ? '1' : '0') } catch { /* ignore */ }
  }

  /**
   * 递归找 video：同源 iframe 也能穿透。
   * 学习通的播放器在 ananas/modules/video iframe 里，
   * 而内容脚本对那个动态 iframe 的注入不一定成功，
   * 所以主框架这里必须能自己穿进去拿。
   */
  function findVideoDeep(doc, depth) {
    if (!doc || depth > 6) return null
    try {
      const v = doc.querySelector('video')
      if (v && v.readyState >= 1) return v
      for (const f of doc.querySelectorAll('iframe')) {
        let sub = null
        try { sub = f.contentDocument } catch { sub = null }
        if (!sub) continue
        const found = findVideoDeep(sub, depth + 1)
        if (found) return found
      }
    } catch { /* 跨域跳过 */ }
    return null
  }

  function findVideo() {
    return findVideoDeep(document, 0)
  }

  /* ───────── 提示条 ───────── */

  let tipEl = null
  let tipTimer = null

  function flashTip(text, color) {
    try {
      if (isOff()) return

      /* ★ 2026-10-25 修复「页面上出现两个提示」
       *
       * 原来 focus-mode 和 pilot-core **各建一套提示 DOM**，互不感知，
       * 于是同一时刻能看到两个不同的提示条（用户截图确认）。
       *
       * 现在：
       *   ① 优先复用页面上的统一提示条（id=__sb_tip，由 pilot-core 创建/更新）
       *   ② 没有时才自己建，但同样用 __sb_tip 这个 id，保证全页唯一
       *   ③ 同样顶部居中 + 常驻（不自动消失），与主提示行为一致
       */
      let el = document.getElementById('__sb_tip')

      if (typeof window.__sbFlash === 'function') {
        // pilot-core 已就绪：直接委托，颜色交给它按 kind 决定
        window.__sbFlash(text, color ? 'ok' : 'info')
        return
      }

      if (!el) {
        el = document.createElement('div')
        el.id = '__sb_tip'
        el.style.cssText = [
          'position:fixed', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
          'z-index:2147483647', 'padding:7px 12px', 'border-radius:9px',
          'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'box-shadow:0 5px 18px rgba(0,0,0,.32)', 'pointer-events:none',
          'max-width:min(72vw,560px)', 'opacity:.95',
        ].join(';')
        document.documentElement.appendChild(el)
      }
      el.textContent = text
      el.style.background = color || 'rgba(63,207,127,.96)'
      el.style.color = color ? '#fff' : '#0b2417'
      el.style.display = 'block'
      tipEl = el
      // 不再 setTimeout 隐藏 —— 常驻，让用户知道守护一直在工作
    } catch { /* ignore */ }
  }

  /* ───────── 核心：尝试续播 ───────── */

  async function tryResume(v, reason) {
    const now = Date.now()
    if (now - lastResumeAt < 800) return   // 防抖，别和页面死磕
    lastResumeAt = now

    // ① 直接 play
    try {
      await v.play()
      resumeCount++
      if (resumeCount <= 3 || resumeCount % 20 === 0) flashTip(`▶ 已续播（第 ${resumeCount} 次）`)
      return
    } catch { /* 落到 ② */ }

    // ② 静音 play —— 但**绝不再自动取消静音**
    //
    // ⚠️⚠️ 2026-10-24 用户本机实测报错：
    //   "Unmuting failed and the element was paused instead because the user
    //    didn't interact with the document before."
    //
    // 原逻辑（错的）：静音 play 成功后，300ms 后把 muted 设回 false。
    // 浏览器自动播放策略：无用户手势时允许**静音**播放，一旦有声就**强制暂停**并抛这个错。
    // 而本扩展每隔一段时间轮询「有没有暂停」，于是形成死循环：
    //   播 → 取消静音被暂停 → 检测到暂停 → 再播 → 再取消静音…
    // 结果**视频永远播不动**，浏览器错误页堆满红色报错。
    //
    // 现在的策略：无手势时静音就保持静音，声音交给用户自己在播放器上开。
    //   宁可静音播完（学习通按观看时长算进度，不要求有声），也不要被反复暂停。
    const wasMuted = v.muted
    let hasGesture = false
    try { hasGesture = Boolean(navigator.userActivation && navigator.userActivation.isActive) } catch { /* ignore */ }

    try {
      if (!hasGesture) v.muted = true
      await v.play()
      resumeCount++
      if (resumeCount <= 3 || resumeCount % 20 === 0) {
        flashTip(hasGesture ? `▶ 已续播（第 ${resumeCount} 次）` : `▶ 已续播（第 ${resumeCount} 次，静音）`)
      }
      return
    } catch (e) {
      try { v.muted = wasMuted } catch { /* ignore */ }
      flashTip('浏览器拦了自动播放，点这里继续', 'rgba(255,200,87,.95)')
      if (tipEl) {
        tipEl.style.pointerEvents = 'auto'
        tipEl.style.cursor = 'pointer'
        tipEl.onclick = () => { try { v.play() } catch { /* ignore */ } ; tipEl.style.display = 'none' }
      }
    }
  }

  /* ───────── 主循环 ───────── */

  function tick() {
    if (isOff()) return
    let v = null
    try { v = findVideo() } catch { return }
    if (!v) return
    if (v.ended) return          // 播完不管
    if (!v.paused) { lastPlayedAt = Date.now(); return }
    // 已经停在暂停状态超过 600ms 才介入，避免刚暂停就被拉起
    if (Date.now() - lastPlayedAt < 600) return
    tryResume(v, 'tick')
  }

  // 500ms 一次：够快，也不费
  setInterval(tick, 500)

  // 事件驱动：pause 事件立刻响应（比轮询快）
  document.addEventListener('pause', (e) => {
    if (isOff()) return
    if (e.target && e.target.tagName === 'VIDEO') {
      setTimeout(tick, 150)
    }
  }, true)

  /* ───────── 角标开关（可关掉守护） ───────── */

  function attachKillSwitch() {
    /* ★ 2026-10-25：再加一道「全页唯一」保险——
       原来只检查 badge 内是否有按钮，若另一份扩展把按钮插到了别处就会重复。 */
    try { if (document.querySelectorAll('.__sb_focus_btn').length > 0) return } catch { /* ignore */ }
    const badge = document.getElementById('__studybuddy_badge')
    if (!badge || badge.querySelector('.__sb_focus_btn')) return

    const btn = document.createElement('button')
    btn.className = '__sb_focus_btn'
    btn.style.cssText = [
      'margin-left:8px', 'padding:3px 9px', 'border-radius:7px', 'cursor:pointer',
      'border:1px solid rgba(63,207,127,.5)', 'background:rgba(63,207,127,.22)',
      'color:#8ff0bc', 'font:inherit', 'font-size:11.5px',
    ].join(';')
    btn.textContent = isOff() ? '已关闭' : '守护中'
    btn.title = '点一下可关闭「暂停自动续播」'
    btn.style.background = isOff() ? 'rgba(255,255,255,.08)' : 'rgba(63,207,127,.22)'
    btn.style.color = isOff() ? '#9aa0a8' : '#8ff0bc'
    btn.style.borderColor = isOff() ? 'rgba(255,255,255,.14)' : 'rgba(63,207,127,.5)'

    btn.onclick = (e) => {
      e.stopPropagation()
      const next = !isOff()
      setOff(next)
      btn.textContent = next ? '已关闭' : '守护中'
      btn.style.background = next ? 'rgba(255,255,255,.08)' : 'rgba(63,207,127,.22)'
      btn.style.color = next ? '#9aa0a8' : '#8ff0bc'
      btn.style.borderColor = next ? 'rgba(255,255,255,.14)' : 'rgba(63,207,127,.5)'
      if (next) flashTip('已关闭自动续播', 'rgba(255,255,255,.9)')
    }
    badge.appendChild(btn)
  }

  let tries = 0
  const t = setInterval(() => {
    attachKillSwitch()
    if (++tries > 120) clearInterval(t)
  }, 500)

  // 暴露给诊断
  window.__sbFocusDiag = {
    get state() {
      const v = findVideo()
      return {
        userDisabled: isOff(),
        resumeCount,
        hasVideo: Boolean(v),
        paused: v ? v.paused : null,
        readyState: v ? v.readyState : null,
        currentTime: v ? Math.round(v.currentTime) : null,
        lastPlayedAgo: lastPlayedAt ? Date.now() - lastPlayedAt : null,
      }
    },
  }
})()
