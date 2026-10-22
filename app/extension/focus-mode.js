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
      if (!tipEl) {
        tipEl = document.createElement('div')
        tipEl.style.cssText = [
          'position:fixed', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
          'z-index:2147483647', 'padding:6px 12px', 'border-radius:8px',
          'font:12px/1.4 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'box-shadow:0 4px 14px rgba(0,0,0,.28)', 'pointer-events:none',
        ].join(';')
        document.documentElement.appendChild(tipEl)
      }
      tipEl.textContent = text
      tipEl.style.background = color || 'rgba(63,207,127,.94)'
      tipEl.style.color = color ? '#fff' : '#0b2417'
      tipEl.style.display = 'block'
      clearTimeout(tipTimer)
      tipTimer = setTimeout(() => { if (tipEl) tipEl.style.display = 'none' }, 2200)
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

    // ② 静音 play → 稍后恢复声音（浏览器自动播放策略的标准绕法）
    const wasMuted = v.muted
    try {
      v.muted = true
      await v.play()
      resumeCount++
      setTimeout(() => { try { if (!wasMuted) v.muted = false } catch { /* ignore */ } }, 300)
      if (resumeCount <= 3 || resumeCount % 20 === 0) flashTip(`▶ 已续播（第 ${resumeCount} 次，静音启动）`)
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
