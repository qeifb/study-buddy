/**
 * 学习通学伴 · 页内问答面板
 *
 * 由 content.js 动态注入（不自带 manifest，保持主脚本可读）。
 * 目的：让学生不用切到应用窗口就能提问，避免 Edge 失焦导致视频暂停。
 */

;(function () {
  // 面板只挂在顶层页面。
  // manifest 里是 all_frames:true（为了 focus-mode 能钻进播放器 iframe），
  // 于是每个 iframe 都会执行本文件；而 __studyBuddyAskPanel 是每个 frame 各自的，
  // 拦不住兄弟 frame ⇒ 页面上出现两个「学伴答疑」（2026-10-22 用户报告）。
  if (window.top !== window) return
  if (window.__studyBuddyAskPanel) return
  window.__studyBuddyAskPanel = true

  const PORT = 39517
  const BASE = `http://127.0.0.1:${PORT}`

  let root = null
  let listEl = null
  let inputEl = null
  let btnEl = null
  let open = false
  let busy = false
  const history = []

  function el(tag, css, text) {
    const n = document.createElement(tag)
    if (css) n.style.cssText = css
    if (text != null) n.textContent = text
    return n
  }

  function build() {
    root = el('div', [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483646',
      'width:340px', 'display:flex', 'flex-direction:column',
      'border-radius:12px', 'overflow:hidden',
      'background:rgba(24,26,32,.96)', 'color:#e8eaed',
      'border:1px solid rgba(255,255,255,.12)',
      'box-shadow:0 10px 34px rgba(0,0,0,.45)',
      'font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';'))
    // mount() 靠这个 id 判重，原来 build() 从不设 id ⇒ 判重永远落空
    root.id = '__studybuddy_ask'

    // 头部
    const head = el('div', 'display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;user-select:none;border-bottom:1px solid rgba(255,255,255,.08)')
    head.appendChild(el('span', 'font-size:14px', '📚'))
    head.appendChild(el('span', 'font-weight:600;flex:1', '学伴答疑'))
    const toggle = el('span', 'color:#9aa0a8;font-size:15px;padding:0 4px', '▲')
    head.appendChild(toggle)
    head.onclick = () => setOpen(!open)
    root.appendChild(head)

    // 消息区
    listEl = el('div', 'max-height:260px;overflow-y:auto;padding:10px 12px;display:none;flex-direction:column;gap:8px')
    root.appendChild(listEl)

    // 输入区
    const foot = el('div', 'display:none;padding:8px 10px 10px;border-top:1px solid rgba(255,255,255,.08);gap:8px')
    inputEl = el('textarea', [
      'width:100%', 'box-sizing:border-box', 'min-height:38px', 'max-height:100px',
      'resize:none', 'border-radius:8px', 'padding:7px 9px',
      'border:1px solid rgba(255,255,255,.14)', 'background:#2a2c31', 'color:#e8eaed',
      'font:inherit', 'outline:none',
    ].join(';'))
    inputEl.placeholder = '问这节里的任何内容…（Enter 发送，Shift+Enter 换行）'
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        ask()
      }
    }
    foot.appendChild(inputEl)

    btnEl = el('button', [
      'margin-top:6px', 'width:100%', 'padding:7px', 'border-radius:8px', 'cursor:pointer',
      'border:1px solid #3b4d9e', 'background:rgba(77,107,254,.16)', 'color:#b9c8ff',
      'font:inherit', 'font-size:12.5px',
    ].join(';'), '发送')
    btnEl.onclick = ask
    foot.appendChild(btnEl)
    root.appendChild(foot)

    root.__foot = foot
    root.__list = listEl
    root.__toggle = toggle

    document.documentElement.appendChild(root)
    // 默认收起，不挡视频
    setOpen(false)
  }

  function setOpen(next) {
    open = next
    if (!root) return
    root.__list.style.display = open ? 'flex' : 'none'
    root.__foot.style.display = open ? 'block' : 'none'
    root.__toggle.textContent = open ? '▼' : '▲'
    if (open) {
      if (!history.length) {
        addMsg('system', '我是学伴。看课的时候可以直接在这里问我，不用切到应用窗口——这样视频不会因为你切窗口而暂停。')
        addMsg('system', '每次提问我都会先认出「你现在看的是哪节课」，只用这节课的课程日志回答；还没抓过日志的课，我会直接告诉你，不会拿别的课的内容凑答案。')
      }
      inputEl.focus()
    }
  }

  /**
   * 把回答里的 Markdown 符号清掉、在时间戳处断行。
   *
   * 用户 2026-10-22 反馈：「不要加那么多标点符号比如 * #，不美观；
   * 每段文字如果后面有时间戳就在标明时间戳的时候换行，不然都堆在一起」。
   * 面板只有纯文本，所以这里直接做「去符号 + 断行」，不做 HTML 排版。
   */
  function pretty(text) {
    let s = String(text == null ? '' : text)
    // 支持三种写法：[07:01]、[07:01]-[08:12]、（[07:01]-[08:12]）
    s = s.replace(/(（?\[\d{1,2}:\d{2}(?::\d{2})?\]\s*[-–~]\s*\[\d{1,2}:\d{2}(?::\d{2})?\]）?|（?\[\d{1,2}:\d{2}(?::\d{2})?\]）?)(?=[^\s，。；、）\]\n\-–~])/g, '$1\n')
    s = s.replace(/^\s*#{1,6}\s+/gm, '')
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
    s = s.replace(/^[ \t]*(?:[•·▪◦∙*\-–—]|\d+[.、)])\s+/gm, '')
    s = s.replace(/^\s*-{3,}\s*$/gm, '')
    s = s.replace(/`([^`\n]+)`/g, '$1')
    s = s.replace(/\n{3,}/g, '\n\n')
    return s
  }

  function addMsg(kind, text) {
    if (!listEl) return
    const box = el('div', 'padding:7px 9px;border-radius:8px;font-size:12.5px;white-space:pre-wrap;word-break:break-word')
    if (kind === 'user') {
      box.style.cssText += ';background:rgba(77,107,254,.18);color:#dfe6ff;align-self:flex-end;max-width:92%'
    } else if (kind === 'system') {
      box.style.cssText += ';background:rgba(255,255,255,.05);color:#9aa0a8'
    } else if (kind === 'error') {
      box.style.cssText += ';background:rgba(255,123,114,.12);color:#ff9b9b'
    } else {
      box.style.cssText += ';background:#26282c;color:#e8eaed'
    }
    box.textContent = pretty(text)
    listEl.appendChild(box)
    listEl.scrollTop = listEl.scrollHeight
  }

  /**
   * 通过 background 代理请求应用。
   *
   * 为什么不能直接 fetch：
   *   内容脚本里的 fetch 走的是**页面**的源（mooc1.chaoxing.com），
   *   请求 127.0.0.1:39517 属于跨源，会被 CORS 拦掉，报 `Failed to fetch`。
   *   而 background service worker 有 host_permissions，不受 CORS 限制，
   *   所以统一让 background 代发请求。
   */
  async function callApp(pathname, body, timeoutMs) {
    // ① 首选：让 background 代发（不受 CORS 限制）
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'studybuddy:fetch',
        url: `${BASE}${pathname}`,
        method: 'POST',
        body,
        timeoutMs,
      })
      if (r && typeof r === 'object') {
        if (r.ok === false || r.error) return { ok: false, error: r.error || '未知错误' }
        return r
      }
    } catch (e) {
      // 落到 ②
      console.warn('[学伴] background 代理失败，尝试直连：', e?.message || e)
    }

    // ② 兜底：直连（某些浏览器允许扩展在页面里跨源，或应用于本机白名单）
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return await res.json()
  }

  /**
   * 思考过程气泡。
   *
   * 2026-10-22 用户要求：「你没做网页端的[AI正在思考]，搞得我以为程序卡住了」。
   * 所以提问后立刻出现一个可逐行更新的过程块，并且每秒刷新已等待秒数——
   * 秒数在涨就说明程序活着。
   */
  function addThinking(text) {
    const box = el('div', [
      'padding:7px 9px', 'border-radius:8px', 'font-size:12px', 'white-space:pre-wrap',
      'word-break:break-word', 'background:rgba(77,107,254,.10)', 'color:#a9b7ff',
      'border:1px solid rgba(77,107,254,.25)',
    ].join(';'))
    box.textContent = text
    listEl.appendChild(box)
    listEl.scrollTop = listEl.scrollHeight
    return {
      set(t) { box.textContent = t; listEl.scrollTop = listEl.scrollHeight },
      remove() { box.remove() },
    }
  }

  function chapterLabel() {
    try {
      const cid = new URL(location.href).searchParams.get('chapterId')
      return cid ? `chapterId=${cid}` : '当前页面'
    } catch {
      return '当前页面'
    }
  }

  async function ask() {
    if (busy) return
    const q = (inputEl.value || '').trim()
    if (!q) return

    busy = true
    btnEl.disabled = true
    btnEl.textContent = '思考中…'
    inputEl.value = ''
    addMsg('user', q)
    history.push({ role: 'user', content: q })

    // 思考过程：先把「识别当前课程」这一步亮出来（用户 2026-10-22 要求）
    const think = addThinking('🔍 正在识别当前课程…')
    const t0 = Date.now()
    let ticker = null
    let head = ''

    try {
      // ① 先确认「现在看的是哪节课」，并把结论显示出来
      const info = await callApp('/ext/course', { url: location.href }, 10000)
      if (!info || info.ok === false) {
        think.remove()
        addMsg('error', explainError(info?.error) || '应用没有响应')
        return
      }
      if (!info.matched) {
        think.remove()
        addMsg('error', `这节课（${chapterLabel()}）还没有课程日志，我不拿别的课的内容凑答案。\n\n请回到「学习通学伴」应用，点「📝 课程日志」把这一节抓一次（大约 1～2 分钟），抓完再问我。`)
        return
      }

      head = `📚 当前课程：《${info.lessonName}》${info.duration ? ' · 时长 ' + info.duration : ''}\n🤔 正在读这节课的内容并组织回答…`
      think.set(head)
      ticker = setInterval(() => {
        think.set(head + `\n⏳ 已等待 ${Math.round((Date.now() - t0) / 1000)} 秒，应用还在跑`)
      }, 1000)

      // ② 再带着「当前页面」去提问
      const j = await callApp('/ext/ask', { question: q, url: location.href }, 130000)
      if (!j || j.ok === false) {
        think.remove()
        addMsg('error', explainError(j?.error))
      } else {
        think.remove()
        addMsg('assistant', `【依据课程日志《${info.lessonName}》】\n\n${j.reply || '(空回答)'}`)
        history.push({ role: 'assistant', content: j.reply || '' })
      }
    } catch (e) {
      think.remove()
      addMsg('error', `连不上应用（${e?.message || e}）。请确认「学习通学伴」应用正在运行。`)
    } finally {
      if (ticker) clearInterval(ticker)
      busy = false
      btnEl.disabled = false
      btnEl.textContent = '发送'
    }
  }

  function explainError(msg) {
    const s = String(msg || '')
    if (s.includes('API Key') || s.includes('还没配置')) {
      return '还没配置模型 API Key。请在「学习通学伴」应用的左下角「⚙ 设置」里填一个 DeepSeek API Key，之后这里就能直接问答了。'
    }
    if (s.includes('askHandler')) {
      return '应用还没准备好回答，请重启「学习通学伴」应用后再试。'
    }
    return s
  }

  function mount() {
    if (document.getElementById('__studybuddy_ask')) return
    if (!document.body) return
    build()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
