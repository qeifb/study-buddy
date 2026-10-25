/**
 * 学习通学伴 · 一键播放答题（主流程）
 * ============================================================================
 * 依赖 pilot-core.js（需先加载）与 cand-chars.js（候选字表）。
 *
 * 状态机（严格顺序，不可颠倒 —— 学习通要求看完视频才能答题）：
 *
 *   idle
 *    → checkDone      检查本章任务点状态（jobUnfinishCount / icon_Completed）
 *    → playing        未看完的视频：真实播放（禁止 seek）
 *    → waitFinished   监控 currentTime 推进，卡住则恢复或停止
 *    → ensureLog      视频看完后：确保课程日志就绪（/ext/autoCapture）
 *    → doingQuiz      做章节测验（字体解混淆 → /ext/quizAnswer → 勾选 → 提交）
 *    → nextChapter    本章任务点清零后切下一章
 *
 * 每步都有超时与失败出口。失败一律 flash 提示并停止，不静默。
 */
;(function () {
  'use strict'

  const C = window.__sbPilotCore
  if (!C) { console.error('[学伴·一键] 缺少 pilot-core.js，未执行'); return }
  if (window.__sbPilotRunning) return
  window.__sbPilotRunning = true

  const {
    CFG, isOn, sleep, visible, txt, flash, diag,
    cardsDoc, findVideo, currentAttachTitle, currentChapter,
    attachState, attachTabs, clickAttachByKeyword,
    obfCharset, decodeField, buildCandidates,
    // 确定性字体解码（2026-10-24）：漏了解构会导致 ReferenceError，整脚本崩掉
    buildFontCtx, decodeByFontMap, sbMd5,
    apiPost, apiGet, LOG, LS_SUBMITTED,
  } = C

  /**
   * ★ 启动自检（2026-10-24 新增，因踩坑：漏解构 buildFontCtx 导致整脚本崩溃，
   *   表现是「一键播放答题按钮点不动」，而控制台只有一个莫名其妙的 ReferenceError）。
   *
   * 原则：**依赖缺哪个就明确报哪个**，不要让脚本以半死状态运行。
   * 缺关键依赖时直接提示用户，而不是静默 return 让人以为按钮坏了。
   */
  ;(function selfCheck() {
    const REQUIRED = [
      'CFG', 'isOn', 'sleep', 'visible', 'txt', 'flash', 'diag',
      'cardsDoc', 'findVideo', 'currentAttachTitle', 'currentChapter',
      'attachState', 'attachTabs', 'clickAttachByKeyword',
      'obfCharset', 'decodeField', 'buildCandidates',
      'buildFontCtx', 'decodeByFontMap', 'sbMd5',
      'apiPost', 'apiGet', 'LOG',
    ]
    /**
     * ⚠️ 2026-10-24 修正：原来用 `eval(k)` 检查，结果**全部误报**。
     *    原因：文件顶部有 'use strict'，严格模式下 eval 会创建独立作用域，
     *    访问不到外层解构出来的变量 → 一律抛 ReferenceError → 全判为"缺失"。
     *    正确做法：直接查导出对象 C 上的同名属性。
     */
    const missing = REQUIRED.filter((k) => {
      try { return C[k] == null } catch { return true }
    })
    if (missing.length) {
      const msg = `pilot-core 缺少依赖: ${missing.join(', ')}（扩展可能未正确重载）`
      try { console.error('[学伴·一键] ' + msg) } catch { /* ignore */ }
      try {
        if (typeof flash === 'function') flash(`⚠ ${msg}`, 'err')
      } catch { /* ignore */ }
      return false
    }
    // 确定性解码相关模块（可选，缺失时回退 IoU）
    const optional = []
    try { if (typeof Typr === 'undefined' || !Typr.parse) optional.push('typr-lite.js') } catch { optional.push('typr-lite.js') }
    try { if (typeof sbFontTable !== 'function') optional.push('font-table.js') } catch { optional.push('font-table.js') }
    try { if (typeof globalThis.__sbMd5 !== 'function' && typeof window.md5 !== 'function') optional.push('md5-mini.js') } catch { optional.push('md5-mini.js') }
    if (optional.length) {
      try { console.warn('[学伴·一键] 确定性解码不可用，将回退 canvas 猜测。缺: ' + optional.join(', ')) } catch { /* ignore */ }
    }
    return true
  })()

  /* ───────────────────── 已提交 workId 记账 ───────────────────── */

  function submittedSet() {
    try {
      const raw = localStorage.getItem(LS_SUBMITTED) || '[]'
      const arr = JSON.parse(raw)
      return new Set(Array.isArray(arr) ? arr : [])
    } catch { return new Set() }
  }
  function markSubmitted(workId) {
    if (!workId) return
    try {
      const s = submittedSet()
      s.add(String(workId))
      localStorage.setItem(LS_SUBMITTED, JSON.stringify([...s].slice(-200)))
    } catch { /* ignore */ }
  }

  /* ═══════════════════════ 弹题作答 ═══════════════════════ */

  const quizState = { active: false, startedAt: 0, attempts: 0, tried: [], busy: false }

  function findQuizMask() {
    // 官方容器优先
    const official = document.querySelector('.customMaskDiv')
    if (official && visible(official)) return official
    // 特征嗅探：高 z-index 可见层 + 里面像题目
    try {
      for (const el of document.querySelectorAll('div')) {
        if (!visible(el)) continue
        const z = parseInt(getComputedStyle(el).zIndex, 10) || 0
        if (z < 9000) continue
        const r = el.getBoundingClientRect()
        if (r.width < 200 || r.height < 120) continue
        if (el.querySelector('iframe') || el.querySelectorAll('input[type=radio]').length >= 2) return el
      }
    } catch { /* ignore */ }
    return null
  }

  function quizDoc(mask) {
    if (!mask) return null
    try {
      const pf = mask.querySelector('#popFrameId') || mask.querySelector('iframe')
      if (pf?.contentDocument) return pf.contentDocument
    } catch { /* ignore */ }
    return mask.ownerDocument || document
  }

  function findQuizOptions(doc) {
    const out = []
    try {
      for (const inp of doc.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        if (!visible(inp)) continue
        const holder = inp.closest('label') || inp.parentElement
        out.push({ node: holder || inp, input: inp })
      }
      if (out.length) return out
      const sel = '.answerList li, .answer_list li, .option, .optionItem, .choice, li[class*=option], li[class*=answer], div[class*=option]'
      for (const el of doc.querySelectorAll(sel)) {
        if (!visible(el)) continue
        if (!txt(el, 60)) continue
        out.push({ node: el, input: null })
      }
    } catch { /* ignore */ }
    return out
  }

  /**
   * 找弹题的提交按钮。
   *
   * ⚠️ 不能用「第一个匹配」：页面底部常另有一个主「提交」按钮，
   * DOM 顺序上它可能更靠前，于是点错对象 → 弹题永远不消失。
   * 这里改成：只在**弹题容器范围内**找（mask），并按几何位置取离弹题中心最近的。
   */
  function findQuizSubmit(doc, mask) {
    const CONFIRM = /^(提交|确定|确认|提交答案|submit|confirm|提交答案)$/i

    function collect(scope) {
      const out = []
      try {
        for (const el of scope.querySelectorAll('button, a, div, span, input[type=button], input[type=submit]')) {
          if (!visible(el)) continue
          const t = (txt(el, 20) || el.value || '').trim()
          if (!CONFIRM.test(t)) continue
          let rect = null
          try { rect = el.getBoundingClientRect() } catch { rect = null }
          out.push({ el, text: t, rect })
        }
      } catch { /* ignore */ }
      return out
    }

    // ① 优先只在弹题容器里找（最可靠：不会点到页面底部的按钮）
    let hits = []
    if (mask) {
      try { hits = collect(mask) } catch { hits = [] }
      // 弹题本体若在 iframe 里，也要去找那一层
      if (!hits.length) {
        try {
          const pf = mask.querySelector('#popFrameId') || mask.querySelector('iframe')
          const inner = pf && pf.contentDocument
          if (inner) hits = collect(inner)
        } catch { /* ignore */ }
      }
    }

    // ② 弹题容器里没有 → 退回到整页找，但要按「离弹题中心最近」挑
    if (!hits.length) {
      hits = collect(doc)
    }
    if (!hits.length) return null

    // 按距 mask 中心（或视口中心）最近排序
    let cx = 0, cy = 0
    try {
      const base = mask || doc.body
      const br = base.getBoundingClientRect()
      cx = br.left + br.width / 2
      cy = br.top + br.height / 2
    } catch { /* ignore */ }

    const scored = hits.map((h) => {
      const r = h.rect || { left: 0, top: 1e6, width: 0, height: 0 }
      const x = r.left + (r.width || 0) / 2
      const y = r.top + (r.height || 0) / 2
      // ⚠️ 关键修正（2026-10-24 实测发现）：包裹按钮的容器 div 的 innerText 也是「提交」，
      //    会被一起匹配。容器往往离中心更近，于是选中了「容器」而不是「按钮」，
      //    对容器派发事件不会触发按钮的 onclick → 点了等于没点，弹题永远不消失。
      //    对策：① 优先「本身就是按钮」的标签（a/button/input）；
      //          ② 其次排除面积过大的容器（按钮面积一般 < 20000 px²）；
      //          ③ 同等条件下再比离中心距离。
      const tag = String(h.el.tagName || '').toUpperCase()
      const isButtonTag = tag === 'A' || tag === 'BUTTON' || tag === 'INPUT'
      const area = (r.width || 0) * (r.height || 0)
      const looksLikeButton = area > 0 && area < 20000
      const score = Math.hypot(x - cx, y - cy)
        + (isButtonTag ? 0 : 100000)
        + (looksLikeButton ? 0 : 50000)
      return { ...h, dist: score, rawDist: Math.hypot(x - cx, y - cy), isButtonTag, area }
    }).sort((a, b) => a.dist - b.dist)

    return scored[0].el
  }

  /**
   * 处理视频播放中弹出的选择题。
   * 这类弹题按用户说法「没有错误惩罚机制」，所以可以试错；
   * 但如果有课程日志且能拿到 AI 答案，优先用 AI（更准）。
   */
  async function handlePopupQuiz() {
    const mask = findQuizMask()
    if (!mask) {
      if (quizState.active) {
        quizState.active = false
        quizState.busy = false
        flash('✅ 弹题已通过，视频继续', 'ok')
        diag.quizInfo = 'passed'
      }
      return false
    }

    if (!quizState.active) {
      quizState.active = true
      quizState.startedAt = Date.now()
      quizState.attempts = 0
      quizState.tried = []
      quizState.aiTried = false   // ← 每道新弹题都要重置，否则后续弹题永远不再尝试 AI
      quizState.passed = false
      diag.quizInfo = 'detected'
      flash('📝 检测到视频弹题，开始自动作答', 'info')
    }
    if (Date.now() - quizState.startedAt > CFG.quizTimeoutMs) {
      flash('⚠ 弹题处理超时，请手动处理', 'warn')
      quizState.active = false
      diag.quizInfo = 'timeout'
      return true
    }
    if (quizState.attempts >= CFG.maxQuizAttempts) {
      flash(`⚠ 已尝试 ${CFG.maxQuizAttempts} 次，停止（请手动处理）`, 'warn')
      quizState.active = false
      diag.quizInfo = 'gaveup'
      return true
    }
    if (quizState.busy) return true

    const doc = quizDoc(mask)
    if (!doc) return true
    const options = findQuizOptions(doc)
    if (options.length < 2) return true

    // 尝试用 AI：弹题也可能能从课程日志里找到答案
    if (!quizState.aiTried) {
      quizState.aiTried = true
      const got = await tryAnswerPopupWithAI(doc, options)
      if (got) return true
    }

    // AI 不可用 → 退回穷举（用户说过这类弹题没有错误惩罚）
    let pick = -1
    for (let i = 0; i < options.length; i++) {
      if (!quizState.tried.includes(i)) { pick = i; break }
    }
    if (pick < 0) {
      quizState.tried = []
      pick = Math.floor(Math.random() * options.length)
    }
    quizState.tried.push(pick)
    quizState.attempts++
    diag.quizInfo = `attempt ${quizState.attempts}/${CFG.maxQuizAttempts}`

    const target = options[pick]
    fireClick(target.node, doc)
    if (target.input) {
      try { target.input.checked = true } catch { /* ignore */ }
      try { target.input.dispatchEvent(new Event('change', { bubbles: true })) } catch { /* ignore */ }
    }
    flash(`🖱 第 ${quizState.attempts} 次：选「${txt(target.node, 24) || '选项'}」`, 'info')
    await sleep(CFG.clickGapMs)

    const submit = findQuizSubmit(doc, mask)
    if (submit) {
      quizState.busy = true
      fireClick(submit, doc)
      flash('📤 已提交，等待判分…', 'info')
      await sleep(CFG.submitWaitMs)

      // ⚠️ 关键：必须验证弹题**真的消失了**，不能只看点击动作有没有执行。
      // 与「确认提交弹窗点不掉」是同一类问题：点了不等于生效。
      // 若还在，把本次选择记为失败，下一轮换一个选项重试。
      const stillThere = findQuizMask()
      if (stillThere) {
        diag.quizInfo = `attempt ${quizState.attempts} 未通过，换选项重试`
        LOG(`第 ${quizState.attempts} 次提交后弹题仍在，换选项`)
        flash(`↻ 这次没答对，换一个选项（第 ${quizState.attempts + 1} 次）`, 'warn')
        // 不清空 tried，让下一轮自然选下一个没试过的
      } else {
        diag.quizInfo = `passed at attempt ${quizState.attempts}`
        flash(`✅ 弹题已通过（第 ${quizState.attempts} 次答对）`, 'ok')
        quizState.active = false
        quizState.passed = true
      }
      quizState.busy = false
    } else {
      flash('⚠ 弹题里没找到提交按钮，请手动点', 'warn')
    }
    return true
  }

  /** 尝试用课程日志 + AI 回答弹题 */
  async function tryAnswerPopupWithAI(doc, options) {
    try {
      const body = doc.body ? String(doc.body.innerText || '') : ''
      if (!body.trim()) return false
      // 弹题通常只有一题：取第一个题块
      const stem = body.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' ')
      if (!stem || stem.length < 6) return false
      const qs = [{
        qid: 'popup-1',
        qtype: 2,
        typeText: '单选题',
        stem: { raw: stem, decoded: stem, confidence: 1, lowConfidence: [] },
        options: options.map((o, i) => ({
          key: String.fromCharCode(65 + i),
          text: { raw: txt(o.node, 80), decoded: txt(o.node, 80), confidence: 1, lowConfidence: [] },
        })),
      }]
      const r = await apiPost('/ext/quizAnswer', { url: location.href, questions: qs }, 45000)
      if (!r.body || !r.body.ok || !Array.isArray(r.body.answers) || !r.body.answers.length) return false
      const keys = r.body.answers[0].keys || []
      if (!keys.length) return false
      for (const k of keys) {
        const idx = String(k).toUpperCase().charCodeAt(0) - 65
        if (idx >= 0 && idx < options.length) {
          fireClick(options[idx].node, doc)
          quizState.tried.push(idx)
        }
      }
      quizState.attempts++
      flash(`🤖 用课程日志作答：${keys.join('')}`, 'info')
      await sleep(CFG.clickGapMs)
      const submit = findQuizSubmit(doc, mask)
      if (submit) {
        quizState.busy = true
        fireClick(submit, doc)
        await sleep(CFG.submitWaitMs)
        quizState.busy = false

        // 同样要验证弹题是否真的消失了
        if (findQuizMask()) {
          diag.quizInfo = `AI 作答未通过（第 ${quizState.attempts} 次）`
          LOG('AI 作答后弹题仍在，交给试错逻辑')
          flash('↻ AI 这次没答对，改用试错', 'warn')
          return false   // 让上层继续走穷举
        }
        diag.quizInfo = `AI 作答通过`
        flash('✅ 弹题已通过（AI 依据课程日志）', 'ok')
        quizState.active = false
        quizState.passed = true
      }
      return true
    } catch (e) {
      LOG('弹题 AI 作答失败，退回试错', e?.message)
      return false
    }
  }

  /* ═══════════════════════ 章节测验 ═══════════════════════ */

  /** 进入测验的三层 iframe */
  function quizFrameDoc() {
    const d1 = cardsDoc()
    if (!d1) return null
    try {
      const f2 = d1.querySelector('iframe')
      const d2 = f2?.contentDocument
      if (!d2) return null
      const f3 = d2.getElementById('frame_content') || d2.querySelector('iframe')
      const d3 = f3?.contentDocument
      return d3 || null
    } catch { return null }
  }

  /** 轮询等待测验页就绪（按 iframe 标题匹配，不用固定 sleep） */
  async function waitQuizFrame(timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const d3 = quizFrameDoc()
      if (d3 && d3.querySelectorAll('.TiMu').length > 0) return d3
      await sleep(400)
    }
    return null
  }

  /** 抓取测验页里的全部题目 */
  function grabQuestions(d3, decodeCtx) {
    const out = []
    const timus = Array.from(d3.querySelectorAll('.TiMu'))
    for (const t of timus) {
      // 题型：data 属性 1多选 2单选 3判断
      const qtype = Number(t.getAttribute('data')) || 2
      const typeEl = t.querySelector('.newZy_TItle')
      const typeText = typeEl ? txt(typeEl, 20) : ''

      // 题干：.Zy_TItle 里去掉题号与题型标记
      const titleEl = t.querySelector('.Zy_TItle')
      let stemRaw = ''
      if (titleEl) {
        stemRaw = String(titleEl.innerText || '')
          .replace(/【[^】]*】/g, ' ')
          .replace(/^\s*\d+\s*/, '')
          .replace(/\s+/g, ' ')
          .trim()
      }

      // 选项
      const lis = Array.from(t.querySelectorAll('li[onclick]'))
      const options = []
      let qid = ''
      for (const li of lis) {
        const oc = li.getAttribute('onclick') || ''
        if (!/addChoice|addMultipleChoice/.test(oc)) continue
        qid = qid || (li.getAttribute('qid') || '')
        const keyEl = li.querySelector('span.num_option, span.num_option_dx')
        const key = keyEl ? String(keyEl.getAttribute('data') || '').trim() : ''
        const afterEl = li.querySelector('a.after')
        const text = afterEl ? txt(afterEl, 120) : txt(li, 120)
        if (key) options.push({ key, text, node: li, onclick: oc })
      }
      if (!qid || !options.length) continue

      // 字体解混淆
      const stem = decodeField(stemRaw, decodeCtx)
      for (const o of options) {
        const dec = decodeField(o.text, decodeCtx)
        o.textObj = dec
      }

      out.push({
        qid, qtype, typeText,
        stemObj: stem,
        options: options.map((o) => ({ key: o.key, text: o.textObj })),
        rawOptions: options,
        node: t,
      })
    }
    return out
  }

  /** 勾选答案 */
  /**
   * 安全地「点击」一个元素，绕开 javascript: URL 的 CSP 拦截。
   *
   * 为什么不能用 .click()（2026-10-24 用户实测的错误）：
   *   学习通的选项/提交按钮大量使用 `<a href="javascript:;">` 或
   *   `<a href="javascript:void(0)">`，调用 .click() 会让浏览器去执行 javascript: URL，
   *   而页面 CSP 的 script-src 没给 inline 执行留口子，于是报：
   *     "Running the JavaScript URL violates the following Content Security Policy
   *      directive 'script-src 'self' ...' and the action has been blocked."
   *   结果就是点了没反应 —— 表现成「提交没完成」。
   *
   * 做法（按优先级）：
   *   ① 若有 onclick 属性，解析出函数名，直接调用页面里的全局函数；
   *   ② 若有 addEventListener 绑的 handler 无法直接取，则派发合成事件
   *      （合成事件是「事件」，不是 URI 导航，不会触发 CSP 的 javascript: 限制）；
   *   ③ 最后才退化到 .click()，并且先临时清掉 href 上的 javascript: 前缀。
   */
  /**
   * 安全地「点击」一个元素，绕开 javascript: URL 的 CSP 拦截。
   *
   * 为什么不能用 .click()（2026-10-24 用户实测的错误）：
   *   学习通的选项/提交按钮大量使用 `<a href="javascript:;">` 或
   *   `<a href="javascript:void(0)">`，调用 .click() 会让浏览器去执行 javascript: URL，
   *   而页面 CSP 的 script-src 没给 inline 执行留口子，于是报：
   *     "Running the JavaScript URL violates the following Content Security Policy
   *      directive 'script-src 'self' ...' and the action has been blocked."
   *   结果就是点了没反应 —— 表现成「提交没完成」。
   *
   * ⚠️⚠️ 第二次踩（2026-10-24，堆栈 fireClick:408）：
   *   **派发合成 click 事件同样会触发 javascript: 导航！**
   *   因为合成事件的 defaultPrevented 为 false，`<a>` 收到 click 后会执行默认行为，
   *   也就是去导航到那个 javascript: URL，照样被 CSP 拦。
   *   ⇒ 所以必须在**派发任何事件之前**就把 javascript: 的 href 摘掉，
   *     而不是等到最后的 .click() 兜底才摘。
   *
   * 最终做法（按优先级）：
   *   ⓪ **前置清理**：先把 `<a href="javascript:...">` 的 href 换成 "#"（并记下原值）；
   *   ① 若有 onclick 属性，解析函数名直接调用页面全局函数；
   *   ② 否则派发合成鼠标事件（此时已无 javascript: href，不会触发导航）；
   *   ③ 最后才退化到 .click()。
   */
  function fireClick(el, doc) {
    if (!el) return false
    const view = (doc && doc.defaultView) || window

    // ⓪ 前置清理：把 javascript: 的 href 摘掉，这是最关键的一步。
    //    必须在派发事件之前做，否则合成 click 照样触发 javascript: 导航 → CSP 拦截。
    try {
      const stripJsHref = (node) => {
        if (!node || node.nodeType !== 1) return
        const tag = String(node.tagName || '').toUpperCase()
        if (tag !== 'A' && tag !== 'AREA') return
        let h = ''
        try { h = node.getAttribute('href') || '' } catch { h = '' }
        if (/^\s*javascript:/i.test(h)) {
          try { node.setAttribute('data-sb-orig-href', h) } catch { /* ignore */ }
          try { node.setAttribute('href', '#') } catch { /* ignore */ }
          LOG('fireClick: 已摘除 javascript: href')
        }
      }
      stripJsHref(el)
      // 顺带把元素内部的 <a> 也清了（有些按钮是包着一层 <a>）
      try {
        if (el.querySelectorAll) {
          for (const inner of el.querySelectorAll('a[href^="javascript:"]')) stripJsHref(inner)
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }

    // ① 直接调 onclick 绑定的函数（最干净，完全不走锚点）
    try {
      const oc = el.getAttribute && el.getAttribute('onclick')
      if (oc) {
        // 匹配形如 btnBlueSubmit();  /  addChoice(this);  /  return foo()
        const m = /(?:^|[;\s{])([A-Za-z_$][\w$]*)\s*\(/.exec(String(oc))
        if (m) {
          const fnName = m[1]
          const fn = view[fnName]
          if (typeof fn === 'function') {
            // 带 this 的（如 addChoice(this)）要把元素本身传进去
            if (/\(\s*this\s*\)/.test(String(oc))) fn.call(view, el)
            else if (/\(\s*this\s*,/.test(String(oc))) fn.call(view, el)
            else {
              // 无参函数：先按「this=元素」调一次（很多老代码内部用 this），
              // 失败再按「this=view」调一次，两种都覆盖
              try {
                fn.call(el, el)
              } catch {
                fn.call(view)
              }
            }
            LOG(`fireClick: 直接调用 ${fnName}()`)
            return true
          }
        }
      }
    } catch (e) {
      LOG('fireClick 调函数失败，改派事件', e?.message)
    }

    // ② 派发合成鼠标事件（href 已在 ⓪ 清理，不会触发 javascript: 导航）
    let dispatched = false
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }
      const opts = {
        bubbles: true, cancelable: true, view,
        clientX: r.left + (r.width || 0) / 2,
        clientY: r.top + (r.height || 0) / 2,
      }
      el.dispatchEvent(new view.MouseEvent('mousedown', opts))
      el.dispatchEvent(new view.MouseEvent('mouseup', opts))
      el.dispatchEvent(new view.MouseEvent('click', opts))
      dispatched = true
      LOG('fireClick: 已派发合成 click 事件')
    } catch (e) {
      LOG('fireClick 派发事件失败', e?.message)
    }
    if (dispatched) {
      // 派发成功就到此为止（CSP 安全的路径）
      return true
    }

    // ③ 最后兜底：再确认一次 href 已摘，然后 click
    try {
      if (el.tagName === 'A' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) {
        el.setAttribute('href', '#')
      }
      el.click()
      return true
    } catch (e) {
      LOG('fireClick 兜底 click 失败', e?.message)
      return false
    }
  }

  async function applyAnswers(d3, questions, answers) {
    const byQid = new Map(answers.map((a) => [String(a.qid), a]))
    let applied = 0
    for (const q of questions) {
      const a = byQid.get(String(q.qid))
      if (!a || !Array.isArray(a.keys) || !a.keys.length) continue

      // 先清掉该题已选（避免叠加）
      for (const o of q.rawOptions) {
        try {
          const keyEl = o.node.querySelector('span.num_option, span.num_option_dx')
          const isSel = /choice_select|num_option_select|selected|cur/.test(
            (keyEl?.className || '') + ' ' + (o.node.className || '')
          )
          if (isSel) { fireClick(o.node, d3); await sleep(120) }
        } catch { /* ignore */ }
      }
      await sleep(200)

      for (const k of a.keys) {
        const o = q.rawOptions.find((x) => String(x.key) === String(k))
        if (!o) { LOG('找不到选项', q.qid, k); continue }
        try {
          // 用 fireClick：里面会优先直接调 addChoice/addMultipleChoice，
          // 不会触发 <a href="javascript:"> 导致的 CSP 拦截
          fireClick(o.node, d3)
          applied++
          await sleep(180)
        } catch (e) { LOG('勾选失败', e?.message) }
      }
    }
    return applied
  }

  function findSubmitBtn(d3) {
    try {
      for (const a of d3.querySelectorAll('a, button')) {
        const oc = a.getAttribute('onclick') || ''
        if (/btnBlueSubmit/.test(oc)) return { node: a, kind: 'blue' }
        if (/btnSubmit/.test(a.className || '')) return { node: a, kind: 'cls' }
      }
      for (const a of d3.querySelectorAll('a, button')) {
        if (/^提交$/.test(txt(a, 10))) return { node: a, kind: 'text' }
      }
    } catch { /* ignore */ }
    return null
  }

  /** 完整走一遍章节测验 */
  async function doChapterQuiz(ch) {
    diag.phase = 'doingQuiz'

    // ① 切到「章节测验」附件
    if (!clickAttachByKeyword('测验')) {
      flash('⚠ 这篇没有「章节测验」附件', 'warn')
      return {
        ok: false,
        reason: 'no-quiz-attach',
        detail: `页面上找不到「章节测验」附件（当前附件=${currentAttachTitle() || '未知'}，页面 iframe=${document.querySelectorAll('iframe').length} 个）`,
      }
    }
    // ② 等测验页就绪
    const d3 = await waitQuizFrame(CFG.frameTimeoutMs)
    if (!d3) {
      flash('⚠ 测验页加载超时', 'warn')
      return {
        ok: false,
        reason: 'frame-timeout',
        detail: '测验 iframe 没在时限内加载出来（网络慢，或这一章其实没有测验附件）',
      }
    }

    // ③ 已经是批阅页 → 说明做过了
    const url3 = String(d3.location.href || '')
    if (/selectWorkQuestionYiPiYue/.test(url3)) {
      flash('ℹ 这章测验已完成，跳过', 'info')
      return { ok: true, skipped: true, reason: 'already-done' }
    }
    const bodyText = d3.body ? String(d3.body.innerText || '') : ''
    if (/已完成|本次成绩/.test(bodyText) && !/待完成/.test(bodyText)) {
      flash('ℹ 这章测验已完成，跳过', 'info')
      return { ok: true, skipped: true, reason: 'already-done' }
    }

    // ④ 幂等：同一 workId 不重复提交
    //    但要「以页面真实状态为准」：如果页面明确显示「待完成」，
    //    说明本地记录不可信（历史上可能记错），必须允许重做。
    //    2026-10-24 用户实测：「测验明明未完成，却跳过了」就是这个原因。
    const mWork = /workId=(\w+)/.exec(url3)
    const workId = mWork ? mWork[1] : ''
    const pageSaysTodo = /待完成/.test(bodyText)
    if (workId && submittedSet().has(workId)) {
      if (pageSaysTodo) {
        // 本地记着已提交，但页面说还没做 → 以页面为准，清掉错误记录后继续
        LOG(`workId=${workId} 本地记为已提交，但页面显示待完成，清除记录并重做`)
        flash('ℹ 页面显示这题还没做，重新作答', 'info')
        try {
          const s = submittedSet()
          s.delete(String(workId))
          localStorage.setItem(LS_SUBMITTED, JSON.stringify([...s]))
        } catch { /* ignore */ }
      } else {
        flash('ℹ 这个测验已经提交过，不再重复提交', 'info')
        return { ok: true, skipped: true, reason: 'already-submitted' }
      }
    }

    // ⑤ 抓题 + 解混淆
    const decodeCtx = buildDecodeCtx(d3)
    const questions = grabQuestions(d3, decodeCtx)
    if (!questions.length) {
      flash('⚠ 没抓到题目，请检查页面', 'warn')
return {
        ok: false,
        reason: 'no-questions',
        detail: (() => {
          /* ★ 2026-10-25 修：这里原来用了 quizFrameDoc（那是个**函数**，不是 document），
             调 .body 只会拿到 undefined。正确的变量是本函数的 d3。 */
          try {
            const b = d3.body
            const txt = b ? String(b.innerText || '').replace(/\s+/g, ' ').slice(0, 80) : ''
            const n = d3.querySelectorAll('.TiMu').length
            return `测验页里没解析出题目（.TiMu=${n} 个，正文 ${b ? String(b.innerText || '').length : 0} 字，开头：${txt || '空'}）`
          } catch (e) { return '测验页里没解析出题目（读取页面内容时出错：' + ((e && e.message) || e) + '）' }
        })(),
      }
    }
    diag.quizInfo = `${questions.length} 题`

    // ⑥ 解码失败检测（契约 0.4.3）
    const decodeFail = checkDecodeFail(questions, decodeCtx)
    if (decodeFail) {
      flash(`⚠ ${decodeFail}，本题跳过（不带乱码作答）`, 'warn')
      return { ok: false, reason: 'decode-failed', detail: decodeFail }
    }

    // ⑥.5 解码质量提醒（放行但有低置信字时提示用户，不影响作答）
    const dq = decodeCtx.decodeQuality
    if (dq && dq.warn) {
      flash(`ℹ 本题有 ${dq.lowN}/${dq.obfTotal} 个低置信字，已交 AI 结合上下文判断`, 'info')
    }

    // ⑦ 请求应用作答
    diag.phase = 'askingAI'
    const payload = {
      url: location.href,
      chapterId: ch?.chapterId || '',
      workId,
      // 把解码质量一起送上去，让应用侧 prompt 能提示 AI「本题有低置信字，需结合语境复核」，
      // 并在作答依据里标注可信度。
      decodeQuality: dq || null,
      questions: questions.map((q) => ({
        qid: q.qid, qtype: q.qtype, typeText: q.typeText,
        stem: q.stemObj,
        options: q.options,
      })),
    }
    const r = await apiPost('/ext/quizAnswer', payload, 120000)
    if (!r.body) {
      flash('⚠ 应用无响应，请确认学习通学伴已打开', 'err')
return {
        ok: false,
        reason: 'app-unreachable',
        detail: '连不上学习通学伴应用（请确认应用窗口还开着、没有被关掉）',
      }
    }
    if (!r.body.ok) {
      const err = String(r.body.error || '')
      const msg = String(r.body.message || '')
      if (err === 'no-course-log') flash('⚠ 这节课还没有课程日志，无法作答（请先在应用里抓一次）', 'warn')
      else if (err === 'decode-failed') flash(`⚠ 题目文字无法还原：${msg || '原因未知'}，已跳过`, 'warn')
      else if (err === 'parse-failed') flash('⚠ AI 返回格式异常，本次不提交', 'warn')
      else flash(`⚠ 作答失败：${msg || err}`, 'warn')
      return { ok: false, reason: err || 'answer-failed', detail: msg }
    }
    const answers = r.body.answers || []
    if (!answers.length) {
      flash('⚠ AI 没给出可用答案，本次不提交', 'warn')
return {
        ok: false,
        reason: 'no-answers',
        detail: `AI 没返回任何可用答案（共 ${questions.length} 题）`,
      }
    }

    // ⑦.5 展示作答依据：用户要能确认「答案是 AI 根据课程内容答的」，而不是黑盒。
    //     面板显示：依据哪节课的日志、每题选什么、AI 给出的原文理由（含时间戳）。
    const lesson = r.body.lesson || ''
    const logFile = r.body.logFile || ''
    showAnswerEvidence({
      lesson, logFile, questions, answers,
      chapterId: ch?.chapterId || '',
    })

    // 发给应用界面（如果应用开着），让它也留一份可回看的记录
    try {
      apiPost('/ext/quizSubmitted', {
        chapterId: ch?.chapterId || '',
        workId,
        lesson,
        logFile,
        answers,
      }, 5000).catch(() => {})
    } catch { /* ignore */ }

    // ⑧ 勾选
    diag.phase = 'applying'
    const applied = await applyAnswers(d3, questions, answers)
    flash(`✅ 已勾选 ${applied} 个选项，准备提交`, 'ok')
    await sleep(700)

    // ⑨ 提交
    const btn = findSubmitBtn(d3)
    if (!btn) {
      flash('⚠ 没找到提交按钮，请手动提交', 'warn')
return {
        ok: false,
        reason: 'no-submit',
        detail: '测验页里找不到「提交」按钮（可能页面结构变了，请手动提交）',
      }
    }
    diag.phase = 'submitting'

    // ⚠️ 学习通点「提交」后会再弹一个「提示：确认提交?」的二次确认框。
    // 2026-10-24 用户实测：「答题没问题，但是最后的提交没完成，最后提交弹出来的确认提交没自动点」。
    // 所以必须：拦截确认 → 点确认 → 才算真提交。
    // 用「先注册拦截」的方式最稳：无论它走原生 confirm() 还是自绘弹层，都能接住。
    const autoConfirm = installAutoConfirm()

    try {
      // ⚠️ 关键：**绝对不要用 .click()**。
      // 学习通的按钮是 `<a class="btnSubmit" onclick="btnBlueSubmit();" href="javascript:;">`，
      // 调 .click() 会让浏览器执行那个 javascript: URL，被页面 CSP 拦截：
      //   "Running the JavaScript URL violates the following Content Security Policy
      //    directive 'script-src ...' and the action has been blocked."
      // 2026-10-24 用户实测报出这条错误，这也正是「提交没完成」的真正原因。
      // 正确做法：只调用 onclick 里绑定的函数（绕开锚点导航），或派发合成事件。
      fireClick(btn.node, d3)
    } catch (e) {
      autoConfirm.restore()
      const em = (e && e.message) || String(e || '未知')
      flash('⚠ 提交失败：' + em, 'warn')
      return {
        ok: false,
        reason: 'submit-error',
        detail: '点「提交」时出错：' + em,
      }
    }

    // 等确认框出现并处理它（原生 confirm 已被拦截自动同意；自绘弹层要手动点）
    diag.phase = 'confirming'
    const confirmed = await confirmSubmitDialog()
    autoConfirm.restore()

    // 返回值是对象 {ok, found, clicked, why}，区分三种情况
    if (confirmed.ok) {
      flash('✅ 已点「确认提交」并生效', 'ok')
    } else if (confirmed.found && !confirmed.clicked) {
      flash('⚠ 找到确认框但点不动，请手动提交', 'warn')
      diag.phase = 'submitted-stuck'
    } else if (confirmed.found && confirmed.clicked) {
      flash('⚠ 点了确认但框没消失，请人工核对', 'warn')
      diag.phase = 'submitted-unconfirmed'
    } else {
      // 压根没检测到弹窗：可能是页面直接提交了，也可能弹窗还没出来
      flash('ℹ 未检测到确认框（可能已直接提交），稍后核对结果', 'info')
      diag.phase = 'submitted-unconfirmed'
    }

    // ⚠️ 注意：**不要在这里就 markSubmitted**。
    // 2026-10-24 用户实测：「测验明明未完成，却跳过了」——
    // 根因就是这个幂等记录写得太早：提交还没确认成功就记成已提交，
    // 之后每次进来都判定 already-submitted 直接跳过，于是这一章永远做不掉。
    // 正确做法：**只有真的确认成功（页面出现已完成/成绩）才记账**。

    // ⑩ 等结果页（确认后再等，给服务端处理时间）
    await sleep(3000)
    let after = ''
    try {
      const d3b = quizFrameDoc()
      after = d3b?.body ? String(d3b.body.innerText || '') : ''
    } catch { /* ignore */ }

    // 若还停留在「确认提交?」说明确认没点成功，再试一次
    if (/确认提交|确定提交/.test(after)) {
      flash('⚠ 确认框仍在，再试一次', 'warn')
      const again = await confirmSubmitDialog()
      if (again && again.ok) {
        await sleep(2500)
        try {
          const d3c = quizFrameDoc()
          after = d3c?.body ? String(d3c.body.innerText || '') : ''
        } catch { /* ignore */ }
      }
      // 再失败也不要 continue 硬试，交给上层按结果判定
    }

    // 判定成功的三种迹象
    const success = /已完成|本次成绩|已提交|查看已批阅/.test(after) && !/确认提交/.test(after)
    if (success) {
      markSubmitted(workId)   // 只有确认成功才记账
      flash('✅ 章节测验完成', 'ok')
      return { ok: true, submitted: true }
    }
    if (/确认提交/.test(after)) {
      flash('❌ 提交未完成，确认框未能点掉，请手动提交', 'err')
return {
        ok: false,
        reason: 'confirm-failed',
        detail: '没有点掉「确认提交」弹窗（请手动确认一次）',
      }
    }
    // 既没看到完成、也没看到确认框：可能还在处理中，也可能真没交上。
    // 不记账，让下一轮还能重试（避免「假成功」把章节永久跳过）。
    flash('⚠ 提交结果未能确认，下次会再试一次', 'warn')
return {
        ok: false,
        reason: 'submit-unverified',
        detail: '点了提交但页面没变成「已提交/已批阅」状态，请人工核对这一章',
      }
  }

  /* ═══════════════════════ 作答依据展示 ═══════════════════════ */

  /**
   * 展示「答案是怎么来的」。
   *
   * 用户诉求（2026-10-24）：「我怎么知道这个题目的答案是 AI 根据课程内容
   * 来进行回答的」。所以不能只有结果，必须把依据摆出来：
   *   · 依据哪节课的课程日志（文件名 + 时长）
   *   · 每道题 AI 选了哪个选项、对应的选项文字
   *   · AI 给出的理由（里面通常带 [mm:ss] 时间戳，可去原稿核对）
   * 面板右上角有「原稿」按钮，直接打开对应的 .md 文件。
   */
  let evidenceEl = null
  let evidenceTimer = null

  function showAnswerEvidence({ lesson, logFile, questions, answers, chapterId }) {
    try {
      const byQid = new Map((answers || []).map((a) => [String(a.qid), a]))

      const rows = (questions || []).map((q, i) => {
        const a = byQid.get(String(q.qid))
        const keys = a && Array.isArray(a.keys) ? a.keys : []
        // 把 key 还原成「选项原文」更好核验
        const picked = keys.map((k) => {
          const opt = (q.options || []).find((o) => String(o.key) === String(k))
          const txt = opt && opt.text ? (opt.text.decoded || opt.text.raw || '') : ''
          const shown = String(k) === 'true' ? '对' : String(k) === 'false' ? '错' : String(k)
          return txt ? `${shown}. ${String(txt).slice(0, 24)}` : shown
        }).join('；')
        const stem = q.stem ? String(q.stem.decoded || q.stem.raw || '').slice(0, 40) : ''
        const reason = a ? String(a.reason || '') : ''
        return { n: i + 1, stem, picked, reason }
      })

      // 复用/重建面板
      if (evidenceEl && !document.contains(evidenceEl)) evidenceEl = null
      if (!evidenceEl) {
        evidenceEl = document.createElement('div')
        evidenceEl.id = '__sb_evidence_panel'
        evidenceEl.style.cssText = [
          'position:fixed', 'right:16px', 'top:120px', 'z-index:2147483646',
          'width:340px', 'max-height:56vh', 'overflow:auto',
          'background:rgba(18,20,26,.97)', 'color:#e8eaed',
          'border:1px solid rgba(88,166,255,.35)', 'border-radius:10px',
          'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'padding:10px 12px',
          'font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        ].join(';')
        document.documentElement.appendChild(evidenceEl)
      }

      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px'
      const title = document.createElement('div')
      title.style.cssText = 'flex:1;font-weight:600;color:#8cc4ff'
      title.textContent = '作答依据'
      head.appendChild(title)

      if (logFile) {
        const btn = document.createElement('button')
        btn.textContent = '原稿'
        btn.style.cssText = 'padding:2px 8px;border-radius:6px;cursor:pointer;border:1px solid rgba(88,166,255,.5);background:rgba(88,166,255,.18);color:#8cc4ff;font:inherit;font-size:11px'
        btn.title = '打开课程日志原文核对（' + logFile + '）'
        btn.onclick = (e) => {
          e.stopPropagation()
          try {
            // 通过应用打开；应用没开就提示
            fetch('http://127.0.0.1:39517/app/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              .catch(() => {})
            flash(`日志文件：${logFile}（在应用「课程日志」里可打开）`, 'info')
          } catch { /* ignore */ }
        }
        head.appendChild(btn)
      }

      const close = document.createElement('button')
      close.textContent = '×'
      close.style.cssText = 'padding:0 6px;border-radius:6px;cursor:pointer;border:none;background:transparent;color:#9aa0a8;font:inherit;font-size:14px'
      close.onclick = () => { try { evidenceEl.remove() } catch { /* ignore */ } evidenceEl = null }
      head.appendChild(close)
      evidenceEl.appendChild(head)

      const meta = document.createElement('div')
      meta.style.cssText = 'color:#9aa0a8;margin-bottom:8px;font-size:11.5px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:6px'
      meta.textContent = lesson ? `依据课程日志：《${lesson}》` : '依据课程日志（未返回标题）'
      if (logFile) meta.textContent += `\n文件：${logFile}`
      meta.style.whiteSpace = 'pre-wrap'
      evidenceEl.appendChild(meta)

      for (const r of rows) {
        const box = document.createElement('div')
        box.style.cssText = 'margin:8px 0;padding:7px 8px;border-radius:7px;background:rgba(255,255,255,.045);border-left:2px solid rgba(88,166,255,.55)'

        const line1 = document.createElement('div')
        line1.style.cssText = 'color:#c9d1d9'
        line1.textContent = `第 ${r.n} 题  ${r.stem}`
        box.appendChild(line1)

        const line2 = document.createElement('div')
        line2.style.cssText = 'color:#8ff0bc;margin-top:3px;font-weight:600'
        line2.textContent = r.picked ? `答：${r.picked}` : '答：（AI 未作答，跳过）'
        box.appendChild(line2)

        if (r.reason) {
          const line3 = document.createElement('div')
          line3.style.cssText = 'color:#a9b7ff;margin-top:3px;font-size:11.5px'
          line3.textContent = `依据：${r.reason}`
          box.appendChild(line3)
        } else {
          const line3 = document.createElement('div')
          line3.style.cssText = 'color:#ffb4b4;margin-top:3px;font-size:11.5px'
          line3.textContent = '依据：（AI 未给出，此答案可信度低，建议人工核对）'
          box.appendChild(line3)
        }
        evidenceEl.appendChild(box)
      }

      const foot = document.createElement('div')
      foot.style.cssText = 'color:#9aa0a8;font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08)'
      foot.textContent = '理由里带 [mm:ss] 的可到原稿对应位置核对；无理由的题目建议人工复核'
      evidenceEl.appendChild(foot)

      // 30 秒后自动淡出（可手动关掉；用户想细看时能停住）
      clearTimeout(evidenceTimer)
      evidenceTimer = setTimeout(() => {
        try { if (evidenceEl) { evidenceEl.style.opacity = '0.35' } } catch { /* ignore */ }
      }, 30000)
      evidenceEl.style.opacity = '1'

      diag.evidenceShown = rows.length
      LOG(`已展示 ${rows.length} 题作答依据`)
    } catch (e) {
      LOG('展示作答依据失败', e?.message)
    }
  }

  /* ═══════════════════════ 提交确认框处理 ═══════════════════════ */

  /**
   * 学习通点「提交」后会弹二次确认，必须再点一次「提交」才算真正交卷。
   * 用户实测反馈（2026-10-24）：「答题没问题，但是最后的提交没完成，
   * 最后提交弹出来的确认提交没自动点」。
   *
   * 两种形态都要覆盖：
   *   ① 原生 window.confirm() —— 直接返回 true 放行；
   *   ② 自绘弹层（Ext.Msg.confirm / jQuery dialog / 自定义 div）—— 轮询找按钮去点。
   * 注意：确认框可能出现在**作业 iframe 内**，也可能挂在**顶层文档**，两处都要找。
   */
  function installAutoConfirm() {
    const targets = []
    const patched = []

    // 收集所有可访问的 window（顶层 + 各层 iframe）
    function collect() {
      const list = []
      try { list.push(window) } catch { /* ignore */ }
      try { const d1 = cardsDoc(); if (d1?.defaultView) list.push(d1.defaultView) } catch { /* ignore */ }
      try { const f2 = cardsDoc()?.querySelector('iframe'); if (f2?.contentWindow) list.push(f2.contentWindow) } catch { /* ignore */ }
      try {
        const d3 = quizFrameDoc()
        if (d3?.defaultView) list.push(d3.defaultView)
      } catch { /* ignore */ }
      return list
    }

    for (const w of collect()) {
      try {
        const orig = w.confirm
        if (typeof orig === 'function') {
          w.confirm = function () {
            LOG('拦截到原生 confirm()，自动确认')
            diag.confirmHandled = 'native'
            return true
          }
          patched.push({ w, orig })
        }
      } catch { /* 跨域跳过 */ }
      targets.push(w)
    }

    return {
      restore() {
        for (const p of patched) {
          try { p.w.confirm = p.orig } catch { /* ignore */ }
        }
      },
    }
  }

  /**
   * 找到并点击「确认提交」弹窗里的确认按钮。
   *
   * 2026-10-24 用户实测两次反馈：
   *   · 「最后提交弹出来的确认提交没自动点」→ 曾点到页面底部那个主提交按钮，不是弹窗里的
   *   · 「没找到确认提交弹窗，可能已直接提交」→ 弹窗明明还在，却判定找不到
   * 根因：只靠类名正则识别弹窗，学习通这个「提示/确认提交?」弹层类名不一定命中；
   *      兜底又取「最后一个匹配」，而页面底部恰好也有个「提交」。
   *
   * 现在改成三重定位（依次尝试）：
   *   ① 祖先类名命中 modal/dialog/msg/ext-messagebox 等
   *   ② 祖先 z-index >= 1000（浮层典型特征）
   *   ③ 几何位置：取「离视口中心最近」的候选 —— 弹窗按钮在中央，页面主按钮在底部
   *
   * 并且把「是否检测到弹窗」与「是否点到并生效」分开返回，便于上层区分三种失败。
   *
   * @returns {Promise<{ok:boolean, found:boolean, clicked:boolean, why:string}>}
   */
  async function confirmSubmitDialog() {
    const CONFIRM_RE = /^(提交|确定|确认|确认提交|提交答案|确定提交)$/
    const CANCEL_RE = /^(取消|关闭|返回|再想想)$/

    /**
     * 学习通「确认提交?」弹窗的真实结构（2026-10-24 用 F12 探测拿到，务必保留）：
     *
     *   div#workpop.maskDiv  (z-index: 999, 全屏遮罩)
     *     └ div.popDiv.wid440.Marking   (440×208, 弹窗本体)
     *         ├ p#popcontent.popWord   "确认提交？"
     *         └ div.popBottom
     *             ├ a#popcancel.jb_btn  "取消"
     *             └ a#popok.jb_btn      "提交"   ← 要点的就是这个
     *
     * 关键事实：
     *   1. `a#popok` 的 **onclick 是空的**！学习通是用 jQuery/事件监听绑的，
     *      所以 fireClick 里「解析 onclick 函数名直接调用」这条走不通，
     *      必须靠「派发合成事件」触发它绑定的 handler。
     *   2. 遮罩 z-index **只有 999**（我原先阈值写 1000，差一点就错过）。
     *   3. 类名是 `maskDiv`/`popDiv`/`popBottom`/`popok`，
     *      我原先的正则 `modal|dialog|msg|confirm|mask|...` —— `maskDiv` 里含 "mask" 其实能命中，
     *      但前提是这个祖先链没被跳过（之前因为 z=999 < 1000 而漏了）。
     */
    function inKnownWorkPopup(el) {
      try {
        // 直接按 id / 类名精确命中学习通这套弹窗
        if (el.id === 'popok') return true
        let p = el
        for (let i = 0; i < 10 && p; i++) {
          const cls = String(p.className || '')
          const id = String(p.id || '')
          if (id === 'workpop' || id === 'popcontent') return true
          if (/(^|\s)(maskDiv|popDiv|popBottom|Marking|wid440)(\s|$)/.test(cls)) return true
          p = p.parentElement
        }
      } catch { /* ignore */ }
      return false
    }

    function findIn(doc, opts) {
      if (!doc) return null
      const knownOnly = Boolean(opts && opts.knownOnly)
      try {
        const nodes = doc.querySelectorAll('button, a, div, span, input[type=button], input[type=submit]')
        const hits = []
        for (const el of nodes) {
          if (!visible(el)) continue
          const t = (txt(el, 20) || el.value || '').replace(/\s+/g, '').trim()
          if (!t || t.length > 8) continue
          if (!CONFIRM_RE.test(t)) continue
          if (CANCEL_RE.test(t)) continue
          let rect = null
          try { rect = el.getBoundingClientRect() } catch { rect = null }
          hits.push({ el, text: t, rect })
        }
        if (!hits.length) return null

        // ① 最可靠：命中学习通确认弹窗的已知结构（#popok / #workpop / .maskDiv / .popDiv）
        for (const h of hits) {
          if (inKnownWorkPopup(h.el)) {
            return { doc, el: h.el, text: h.text, inDialog: true, why: 'known-workpop' }
          }
        }
        // 只找已知结构时，到此为止
        if (knownOnly) return null

        // ② 祖先类名命中浮层特征（补充一般情况）
        for (const h of hits) {
          let p = h.el
          for (let i = 0; i < 10 && p; i++) {
            const cls = (p.className || '').toString() + ' ' + (p.id || '')
            if (/modal|dialog|msg|confirm|popup|mask|layer|win|ext-messagebox|alert|tip|popDiv|maskDiv/i.test(cls)) {
              return { doc, el: h.el, text: h.text, inDialog: true, why: 'class:' + cls.slice(0, 40) }
            }
            p = p.parentElement
          }
        }

        // ③ 祖先 z-index 较高（浮层）—— 阈值下调到 900，学习通这套是 999
        for (const h of hits) {
          let p = h.el
          for (let i = 0; i < 10 && p; i++) {
            let z = 0
            try { z = parseInt(getComputedStyle(p).zIndex, 10) || 0 } catch { z = 0 }
            if (z >= 900) {
              return { doc, el: h.el, text: h.text, inDialog: true, why: 'z-index=' + z }
            }
            p = p.parentElement
          }
        }

        // ④ 几何：离视口中心最近的（且优先「本身是 a/button」的，避免选中容器）
        let vw = 1280, vh = 800
        try { vw = doc.defaultView?.innerWidth || vw } catch { /* ignore */ }
        try { vh = doc.defaultView?.innerHeight || vh } catch { /* ignore */ }
        const cx = vw / 2, cy = vh / 2

        const scored = hits.map((h) => {
          const r = h.rect || { left: 0, top: vh, width: 0, height: 0 }
          const x = r.left + (r.width || 0) / 2
          const y = r.top + (r.height || 0) / 2
          const tag = String(h.el.tagName || '').toUpperCase()
          const isBtn = tag === 'A' || tag === 'BUTTON' || tag === 'INPUT'
          const area = (r.width || 0) * (r.height || 0)
          const looksBtn = area > 0 && area < 20000
          const score = Math.hypot(x - cx, y - cy) + (isBtn ? 0 : 100000) + (looksBtn ? 0 : 50000)
          const inView = r.top >= 0 && r.top <= vh && r.left >= 0 && r.left <= vw
          return { ...h, dist: score, inView }
        }).sort((a, b) => a.dist - b.dist)

        const pick = scored.find((s) => s.inView) || scored[0]
        return {
          doc, el: pick.el, text: pick.text, inDialog: false,
          why: `nearest-center inView=${pick.inView}`,
        }
      } catch { return null }
    }

    function searchAll() {
      // ⚠️ 顺序很关键（2026-10-24 F12 实测确认）：
      //   学习通这个「确认提交?」弹窗挂在**顶层 document**（div#workpop.maskDiv > a#popok），
      //   而作业 iframe（doHomeWorkNew）里**也有**一个主「提交」按钮 a.btnSubmit。
      //   旧顺序把作业 iframe 排在前面 → 每次都先命中那个主提交按钮，
      //   于是「点了但弹窗没消失」。
      //   现在改成：① 先在整个顶层 + 所有层里专找「已知确认弹窗结构」；
      //             ② 找不到才按普通顺序找。
      const docs = []
      try { docs.push(document) } catch { /* ignore */ }             // 顶层优先
      try { const d1 = cardsDoc(); if (d1) docs.push(d1) } catch { /* ignore */ }
      try {
        const d1 = cardsDoc()
        const f2 = d1?.querySelector('iframe')
        if (f2?.contentDocument) docs.push(f2.contentDocument)
      } catch { /* ignore */ }
      try { const d = quizFrameDoc(); if (d) docs.push(d) } catch { /* ignore */ }  // 作业 iframe 放最后

      // ① 先只找「已知确认弹窗」：#popok / #workpop / .maskDiv / .popDiv
      for (const doc of docs) {
        const hit = findIn(doc, { knownOnly: true })
        if (hit) return hit
      }
      // ② 再按通用规则找
      for (const doc of docs) {
        const hit = findIn(doc)
        if (hit) return hit
      }
      return null
    }

    const t0 = Date.now()
    let clickedOnce = false
    let everFound = false
    let clickTries = 0

    while (Date.now() - t0 < 15000) {
      await sleep(400)
      const hit = searchAll()

      // 曾经点过：弹窗消失 = 真的生效
      if (clickedOnce && !hit) {
        diag.confirmHandled = 'verified'
        LOG('确认框已消失，确认提交生效')
        return { ok: true, found: true, clicked: true, why: 'dialog-gone' }
      }

      if (hit) {
        everFound = true
        if (CANCEL_RE.test(hit.text)) continue
        clickTries++
        try {
          const ok = fireClick(hit.el, hit.doc)
          diag.confirmHandled = hit.inDialog ? 'dialog' : 'flat'
          LOG(`点击确认按钮「${hit.text}」 why=${hit.why} inDialog=${hit.inDialog} ok=${ok} (第 ${clickTries} 次)`)
          if (ok) {
            clickedOnce = true
            await sleep(900)
            if (!searchAll()) {
              diag.confirmHandled = 'verified'
              LOG('确认框已消失，确认提交生效')
              return { ok: true, found: true, clicked: true, why: 'clicked-then-gone' }
            }
            LOG('点击后确认框仍在，重试下一次定位')
          }
        } catch (e) {
          LOG('点击确认按钮失败', e?.message)
        }
      }
    }

    // 超时：区分「压根没检测到弹窗」和「检测到了但点不掉」
    if (everFound) {
      diag.confirmHandled = 'stuck'
      return { ok: false, found: true, clicked: clickedOnce, why: 'dialog-stuck' }
    }
    return { ok: false, found: false, clicked: false, why: 'no-dialog' }
  }

  /** 构造解码上下文 */
  function buildDecodeCtx(d3) {
    const cs = obfCharset(d3)
    if (!cs) return { charset: null, cmp: null, candVecs: null }

    /**
     * ★ 2026-10-24 新增：优先建「确定性字体上下文」。
     *   有 font 时 decodeField 走「字形 MD5 → 固定映射表」，100% 精确还原，
     *   不再需要 canvas IoU 猜测，也不会有置信度/低置信字。
     *   实测：真实题目字体 31/31 命中。
     *
     *   拿不到 font 时（如字体没内联、Typr 未加载）才回退到 IoU 路径。
     */
    let fontCtx = null
    try {
      fontCtx = buildFontCtx(d3)
    } catch (e) {
      LOG('buildFontCtx 失败:', e?.message)
    }

    if (fontCtx && fontCtx.font) {
      // 确定性路径：不建 canvas 候选表，省 1.4 秒渲染
      return {
        charset: cs,
        font: fontCtx.font,
        cmp: null,
        candVecs: null,
        expandToFull: null,
        mode: 'font-map',
      }
    }

    // ── 回退：canvas IoU 猜测路径 ──
    const cand = buildCandidates(d3)
    if (!cand) return { charset: cs, cmp: null, candVecs: null }
    // ⚠️ 必须把 expandToFull 一起传下去（2026-10-24 修复）。
    //    旧版只传了 cmp / candVecs，导致 decodeField 里
    //    `if (ctx.expandToFull && ...)` **永远是 false** —— 全表兜底从未触发过。
    return {
      charset: cs,
      font: null,
      cmp: cand.cmp,
      candVecs: cand.candVecs,
      expandToFull: typeof cand.expandToFull === 'function' ? cand.expandToFull.bind(cand) : null,
      mode: 'iou',
    }
  }

  /** 契约 0.4.3：判断是否该拒答 */
  function checkDecodeFail(questions, ctx) {
    if (!ctx.charset || !ctx.charset.size) return ''  // 整章无混淆，不算失败

    /**
     * ★ 确定性模式（2026-10-24）：走 font-map 时根本不需要置信度判断。
     *   字形 MD5 查表是精确匹配，命中就是对的、没命中就是表里没这个字，
     *   不存在「猜得像不像」的问题。
     *   实测真实题目字体 31/31 全部命中，直接放行。
     */
    if (ctx.mode === 'font-map' && ctx.font) {
      let obfTotal = 0
      let hit = 0
      for (const q of questions) {
        for (const f of [q.stemObj, ...q.options.map((o) => o.text)]) {
          const raw = f.raw || ''
          for (const ch of raw) if (ctx.charset.set.has(ch)) obfTotal++
          if (f.source === 'font-map' || f.source === 'font-map-partial') {
            hit += (f.fontMapHit != null) ? f.fontMapHit : (f.source === 'font-map' ? 1 : 0)
          }
        }
      }
      if (!obfTotal) return ''
      // 确定性路径下，只有「一个字都没还原」才算真失败
      const anyMapDecoded = questions.some((q) =>
        q.stemObj.source === 'font-map' || q.stemObj.source === 'font-map-partial' ||
        q.options.some((o) => o.text.source === 'font-map' || o.text.source === 'font-map-partial')
      )
      if (!anyMapDecoded) {
        return `字体映射表未命中（${obfTotal} 个混淆字）`
      }
      // 成功：记录质量信息（无低置信概念，全部确定）
      ctx.decodeQuality = {
        mode: 'font-map',
        obfTotal,
        lowN: 0,
        lowRatio: 0,
        avg: 1,
        warn: false,
      }
      return ''
    }

    // ⚠️ 2026-10-24 改进：把「为什么失败」说清楚。
    //    旧版只会返回「检测到文字混淆但无法还原」，用户和我都看不出真因。
    //    实际上最常见的真因是「候选字表没加载/canvas 渲染失败」，而不是字认不出来。
    if (!ctx.cmp || !ctx.candVecs || !ctx.candVecs.length) {
      return '解混淆器不可用（候选字形表未就绪）'
    }

    let obfTotal = 0
    let confSum = 0
    let confN = 0
    let lowN = 0
    for (const q of questions) {
      const fields = [q.stemObj, ...q.options.map((o) => o.text)]
      for (const f of fields) {
        const raw = f.raw || ''
        for (const ch of raw) if (ctx.charset.set.has(ch)) obfTotal++
        if (typeof f.confidence === 'number' && f.confidence > 0) { confSum += f.confidence; confN++ }
        lowN += (f.lowConfidence || []).length
      }
    }
    if (!obfTotal) return ''
    // 有混淆字但完全没解码
    const anyDecoded = questions.some((q) =>
      q.stemObj.decoded !== q.stemObj.raw ||
      q.options.some((o) => o.text.decoded !== o.text.raw)
    )
    if (!anyDecoded) {
      const noCand = questions.some((q) =>
        q.stemObj.decodedReason === 'no-candidates' ||
        q.options.some((o) => o.text.decodedReason === 'no-candidates')
      )
      return noCand
        ? '解混淆器不可用（候选字形表未就绪）'
        : `检测到 ${obfTotal} 个混淆字但一个都没还原`
    }

    /**
     * ⚠️⚠️ 2026-10-24 用户实测：整章被拒答，因为「低置信度字过多（17/42）」
     *        17/42 = 40.5%，**只比 40% 阈值高 0.5 个百分点**，结果一题都不做。
     *
     * 这是设计缺陷：低置信字多 ≠ 完全读不通。
     *   · 40 个混淆字里有 17 个置信度偏低，剩下 23 个是准的，
     *     足以让 AI 结合上下文推断题意；
     *   · 而且**拒答 = 0 分，比带错误答案去作答更差**（用户已明确指出这点）。
     *
     * 新策略分三档，只有「真的完全不可用」才拒答：
     *   · 平均置信度 < 0.35                → 拒答（太低，读不通）
     *   · 低置信占比 > 0.85               → 拒答（几乎全是猜的）
     *   · 其它情况                         → **放行**，但把低置信字清单带进 prompt 让 AI 复核
     *
     * 放行时通过 ctx.decodeQuality 把质量信息传给上层，用于：
     *   ① prompt 里提示「本题有 N 个低置信字，请结合语境判断」；
     *   ② 作答依据面板标注「可信度偏低，建议人工复核」。
     */
    const avg = confN ? confSum / confN : 0
    const lowRatio = obfTotal ? lowN / obfTotal : 0

    // 档 1：置信度低到读不通 → 拒答
    if (avg < 0.35) {
      return `还原置信度过低（${avg.toFixed(2)}，共 ${obfTotal} 个混淆字）`
    }
    // 档 2：几乎全是猜测 → 拒答
    if (lowRatio > 0.85) {
      return `低置信度字占比过高（${lowN}/${obfTotal}，${Math.round(lowRatio * 100)}%）`
    }
    // 档 3：放行，但记录质量（供 prompt 与面板使用）
    ctx.decodeQuality = {
      obfTotal,
      lowN,
      lowRatio: Number(lowRatio.toFixed(3)),
      avg: Number(avg.toFixed(3)),
      warn: lowRatio > 0.3,
    }
    return ''
  }

  /* ═══════════════════════ 视频播放监控 ═══════════════════════ */

  const playMon = { lastTime: -1, stall: 0, stalled: false }

  /**
   * 这张卡片只做「恢复播放」，绝不擅自改音量。
   *
   * ⚠️⚠️ 2026-10-24 用户本机实测报错：
   *   "Unmuting failed and the element was paused instead because the user didn't
   *    interact with the document before."
   *   堆栈指向 auto-pilot.js:1463 —— 就是下面原来那句「300ms 后取消静音」。
   *
   * 原逻辑（错的）：
   *   v.muted = true → await v.play() → 300ms 后 v.muted = false
   *
   * 为什么错：浏览器自动播放策略规定「无用户手势时允许静音播放，
   *   但不允许有声播放」。所以刚 play() 成功，一取消静音就被浏览器**强制暂停**并报错。
   *   更糟的是：视频被暂停 → 主循环判定「没在播」→ 再次 ensurePlaying →
   *   再静音→再播放→再取消静音→再被暂停 ⇒ **无限循环，视频永远播不动**。
   *
   * 现在的策略：
   *   ① 只在「确实无法播放」时才临时静音，用来绕过自动播放拦截；
   *   ② **不再自动取消静音**——静音就一直静音，由用户自己决定要不要开声音；
   *   ③ 若页面已有用户手势（userActivation.isActive），说明是用户点的播放，
   *      直接 play() 即可，根本不需要静音。
   */
  async function ensurePlaying() {
    const v = findVideo()
    if (!v) return false
    if (!v.paused && !v.ended) return true

    // 页面已有用户激活（用户点过页面任意处）→ 浏览器允许有声自动播放，不需要静音
    let hasGesture = false
    try {
      hasGesture = Boolean(navigator.userActivation && navigator.userActivation.isActive)
    } catch { /* ignore */ }

    try {
      if (!hasGesture && !v.muted) {
        // 无手势且当前有声 → 先静音才能播（浏览器策略要求）
        v.muted = true
        LOG('无用户手势，临时静音以允许播放（不会自动取消静音）')
        // 记下是我们静音的，方便下次仍保持静音
        try { v.dataset.sbMutedByUs = '1' } catch { /* ignore */ }
      }
      await v.play()
      return true
    } catch (e) {
      LOG('play 失败', e?.message)
      // 可能是弹题挡着
      if (findQuizMask()) return false
      // 静音也播不了 → 才是真的被拦，提示用户点一下
      flash('浏览器拦截了自动播放，请先点一下页面任意处或播放按钮', 'warn')
      return false
    }
  }

  /** 采样一次播放状态，返回是否在推进 */
  function samplePlay() {
    const v = findVideo()
if (!v) return { ok: false, reason: 'no-video', detail: '当前页面没找到 video 元素（可能不是播放页，或视频还没加载出来）' }
    if (v.ended) return { ok: false, reason: 'ended', ratio: 1 }
    const dur = Number(v.duration) || 0
    const cur = Number(v.currentTime) || 0
    const ratio = dur > 0 ? cur / dur : 0
    const advanced = Math.abs(cur - playMon.lastTime) > 0.2
    playMon.lastTime = cur
    if (advanced && !v.paused) {
      playMon.stall = 0
      playMon.stalled = false
    } else if (!v.paused) {
      playMon.stall++
    }
    if (playMon.stall >= CFG.stallSamples) playMon.stalled = true
    return { ok: true, ratio, paused: v.paused, advanced, stalled: playMon.stalled, cur, dur }
  }

  /* ═══════════════════════ 失败退避 ═══════════════════════ */

  /**
   * 失败记录：防止每 1.2 秒重跑一次 runOneChapter 造成无限重试。
   *
   * 2026-10-24 用户实测反馈：「进入下一节章节测验时会卡住，一直在识别课程日志，
   * 导致进不去下一个任务点，一直在刷新课程日志」。
   * 根因：ensureLog 失败后 tick 只是本次 return，下一轮轮询又从 runOneChapter
   * 重头开始 → 每秒重打一次 /ext/autoCapture → 死循环刷屏。
   */
  const failGuard = {
    key: '',        // 失败发生在哪一章 + 哪个阶段
    reason: '',
    count: 0,       // 同一章同一原因连续失败次数
    until: 0,       // 退避截止时间戳
  }

  const FAIL_GIVEUP = 3        // 连续失败 3 次就放弃该章
  const FAIL_BACKOFF = [0, 15000, 45000, 90000]  // 第 1/2/3 次失败后的等待

  function failKey(chapterId, reason) {
    return `${chapterId || '?'}::${reason || '?'}`
  }

  /** 记录一次失败；返回是否应该放弃该章 */
  function noteFailure(chapterId, reason, msg) {
    const key = failKey(chapterId, reason)
    if (failGuard.key !== key) {
      failGuard.key = key
      failGuard.reason = reason
      failGuard.count = 0
    }
    failGuard.count++
    const idx = Math.min(failGuard.count, FAIL_BACKOFF.length - 1)
    failGuard.until = Date.now() + FAIL_BACKOFF[idx]
    diag.lastError = `${reason}: ${msg || ''}`
    // ★ 2026-10-25：失败详情必须落日志，用户事后能查（原来只 flash 一下就没了）
    try { LOG(`[fail] ${reason}｜${msg || '(无详情)'}`) } catch { /* ignore */ }
    syncGuardDiag()

    if (failGuard.count >= FAIL_GIVEUP) {
      flash(`⚠ 该章连续失败 ${failGuard.count} 次（${reason}），跳过本章`, 'err')
      LOG(`放弃章节 ${chapterId}，原因 ${reason}，已连续失败 ${failGuard.count} 次`)
      return true   // 应放弃
    }
    flash(`⚠ ${msg || reason}（第 ${failGuard.count} 次，${Math.round(FAIL_BACKOFF[idx] / 1000)} 秒后重试）`, 'warn')
    return false
  }

  /** 当前是否处于退避期 */
  function inBackoff() {
    return Date.now() < failGuard.until
  }

  /** 把退避状态同步到 diag，便于验证与排查 */
  function syncGuardDiag() {
    diag.failCount = failGuard.count
    diag.failReason = failGuard.reason || ''
    diag.backoffMs = Math.max(0, failGuard.until - Date.now())
  }

  /** 成功后清空失败记录 */
  function clearFailure() {
    failGuard.key = ''
    failGuard.reason = ''
    failGuard.count = 0
    failGuard.until = 0
    syncGuardDiag()
  }

  /* ═══════════════════════ 日志就绪 ═══════════════════════ */

  /**
   * 取当前内容脚本所在的 tabId。
   *
   * 为什么需要：应用端调 `captureLessonViaExtension` 时会把 tabId 派给扩展任务，
   * 扩展再用 `chrome.scripting.executeScript({ target: { tabId } })` 注入取证脚本。
   * 如果 tabId 是 undefined，会直接报：
   *   "Error in invocation of scripting.executeScript(...):
   *    Error at property 'target': Missing required property 'tabId'."
   * 2026-10-24 用户实测报出这条 —— 根因就是 autoCapture 请求里压根没带 tabId。
   *
   * 内容脚本自己拿不到 tabId，必须问 background。拿不到时返回 null，
   * 让应用走「按 url 匹配标签页」的兜底，而不是传 undefined 下去。
   */
  let cachedTabId = null
  async function currentTabId() {
    if (cachedTabId) return cachedTabId
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await chrome.runtime.sendMessage({ type: 'studybuddy:whoami' })
        if (r && typeof r === 'object' && Number.isInteger(r.tabId) && r.tabId >= 0) {
          cachedTabId = r.tabId
          return cachedTabId
        }
      }
    } catch (e) {
      LOG('取 tabId 失败', e?.message)
    }
    return null
  }

  async function ensureLog(ch) {
    diag.phase = 'ensureLog'
    diag.logStage = 'checking'

    const tabId = await currentTabId()
    const r = await apiPost('/ext/autoCapture', {
      url: location.href,
      chapterId: ch?.chapterId || '',
      tabId: tabId == null ? undefined : tabId,
    }, 20000)

    if (!r.body) {
      const hint = r.netError ? `（网络：${r.netError}）` : ''
      return { ok: false, reason: 'app-unreachable', msg: `应用无响应，请确认学习通学伴已打开${hint}` }
    }
    if (!r.body.ok) {
      const err = r.body.error || ''
      if (err === 'no-extension') return { ok: false, reason: err, msg: '扩展未连接到应用，请确认应用已启动' }
      return { ok: false, reason: err, msg: r.body.message || err }
    }
    if (r.body.reused) {
      diag.logStage = 'reused'
      return { ok: true, file: r.body.file, title: r.body.title, reused: true }
    }

    const jobId = r.body.jobId
    if (!jobId) return { ok: false, reason: 'no-jobid', msg: '应用没有返回抓取任务号' }

    diag.logStage = 'capturing'
    const t0 = Date.now()
    let lastText = ''
    let lastSegCount = 0
    let pollFail = 0        // 连续轮询失败次数
    let lastStage = ''

    while (Date.now() - t0 < CFG.logTimeoutMs) {
      await sleep(1000)
      const s = await apiGet(`/ext/autoCapture/status?jobId=${encodeURIComponent(jobId)}`)

      // ⚠️ 轮询失败要计数（2026-10-24 用户实测「两遍 45 秒等待后 Failed」）：
      // 旧代码对失败一律 `continue`，会一直撑到 200 秒超时，
      // 而且分不清「应用挂了」和「抓取慢」。现在连续失败 8 次就明确报错。
      if (!s.body || !s.body.ok) {
        pollFail++
        const hint = s.netError ? `（${s.netError}）` : (s.status ? `HTTP ${s.status}` : '')
        if (pollFail >= 8) {
          const ageSec = Math.round((Date.now() - t0) / 1000)
          return {
            ok: false,
            reason: 'poll-failed',
            msg: `抓取进度查询连续失败 8 次${hint}（已等 ${ageSec} 秒，最后阶段：${lastStage || '未知'}）`,
          }
        }
        continue
      }
      pollFail = 0   // 成功一次就重置

      const b = s.body
      diag.logStage = `${b.stage || ''} ${b.segments || 0}`
      if (b.stage) lastStage = b.stage
      // ★ 2026-10-25：扩展端「100 段报一次」
      //   原来只要文案变了就 flash，而「已转写 N 段」每 20 段就变一次，
      //   页面角标会频繁闪烁。这里按段数节流：不到 100 段不重复提示。
      if (b.text && b.text !== lastText) {
        const segNow = Number(b.segments || 0)
        const isFirst = !lastText
        const isFinal = b.done === true
        const crossed100 = segNow - lastSegCount >= 100
        if (isFirst || isFinal || crossed100) {
          lastText = b.text
          if (isFinal || crossed100) lastSegCount = segNow
          flash(`📚 ${b.text}`, 'info')
        }
      }
      if (b.done) {
        if (b.error) return { ok: false, reason: 'capture-failed', msg: b.error }
        return { ok: true, file: b.file, title: b.title, segments: b.segments }
      }
    }
    const waited = Math.round((Date.now() - t0) / 1000)
    return {
      ok: false,
      reason: 'log-timeout',
      msg: `抓取课程日志超时（已等 ${waited} 秒，最后阶段：${lastStage || '未知'}）`,
    }
  }

  /* ── 播放期间预抓日志（2026-10-25 新增）──
   *
   * 在视频还没播完时就发起一次 autoCapture，把下载+转写提前做完，
   * 播完后 ensureLog 会因「已有日志」秒返回 reused，立刻进入答题。
   *
   * 设计要点：
   *   · 每章只发一次（preLogState.chapterId 记录），不会每秒重发
   *   · 不 await，绝不阻塞播放
   *   · 失败静默 —— 播完还会正经抓一次，预抓失败不影响正确性
   *   · 复用应用端已有的 findByChapterId 机制，重复调用也只会真正抓一次 */
  const preLogState = { chapterId: '', startedAt: 0, done: false, failedAt: 0, ok: false, skipReason: '' }

  function prefetchLogIfNeeded(ch, ratio) {
    /* ★ 2026-10-25：每个提前 return 都要留下痕迹。
       用户报「又不会边播边下载了」，而旧代码静默 return，日志里什么都看不到，
       完全无法判断是「开关关着」「拿不到 chapterId」还是「进度太早」。 */
    const skip = (why) => {
      preLogState.skipReason = why
      if (diag) diag.prefetch = 'skip:' + why
      return
    }

    if (!CFG.prefetchLog) return skip('开关关闭')
    if (!ch) return skip('当前章节为空')
    if (!ch.chapterId) return skip('章节 ID 为空（onclick 解析失败）')

    const sameChapter = preLogState.chapterId === ch.chapterId

    // 同一章已经成功发起过 → 不再重复
    if (sameChapter && preLogState.ok) return skip('本章已发起过')

    // ★ 同一章失败过：冷却 20 秒再重试
    if (sameChapter && !preLogState.ok && preLogState.failedAt) {
      const age = Date.now() - preLogState.failedAt
      if (age < 20000) return skip('失败冷却中 ' + Math.round(age / 1000) + 's')
    }

    // 比例检查只对「播放中」的调用生效；启动时传 null 表示立刻抓
    if (ratio != null && ratio < CFG.prefetchMinRatio) {
      return skip('进度太早 ' + (ratio * 100).toFixed(1) + '%')
    }

    preLogState.chapterId = ch.chapterId
    preLogState.startedAt = Date.now()
    preLogState.ok = false
    preLogState.failedAt = 0

    ;(async () => {
      try {
        const tabId = await currentTabId()
        const r = await apiPost('/ext/autoCapture', {
          url: location.href,
          chapterId: ch.chapterId,
          tabId: tabId == null ? undefined : tabId,
        }, 20000)
        if (r.body && r.body.ok) {
          preLogState.ok = true
          preLogState.skipReason = ''
          if (r.body.reused) {
            diag.prefetch = 'reused'
            LOG('预抓：本章已有日志，播完可直接答题')
          } else if (r.body.jobId) {
            diag.prefetch = 'started'
            flash('📥 已在后台准备这一节的文字稿（边播边下载，播完可直接答题）', 'info')
            LOG('预抓已发起 jobId=' + r.body.jobId)
          }
        } else {
          preLogState.ok = false
          preLogState.failedAt = Date.now()
          diag.prefetch = 'failed'
          LOG('预抓未成功（20 秒后会重试；不影响播放）', r.body?.error || r.netError)
        }
      } catch (e) {
        preLogState.ok = false
        preLogState.failedAt = Date.now()
        diag.prefetch = 'error'
        LOG('预抓异常（20 秒后会重试；不影响播放）', e?.message)
      } finally {
        preLogState.done = true
      }
    })()
  }

  /* ═══════════════════════ 主状态机 ═══════════════════════ */

  let running = false
  let stopFlag = false

  async function runOneChapter() {
    const ch = currentChapter()
if (!ch) return { ok: false, reason: 'no-chapter', detail: '左侧章节目录没找到当前选中项（请手动点一下要学的那一章）' }
    diag.chapterId = ch.chapterId
    diag.chapterName = ch.name
    diag.unfinish = ch.unfinish

    // ① 检查是否整章已完成
    if (ch.completed && ch.unfinish === 0) {
      return { ok: true, skipped: true }
    }

    // ② 判断是视频没做完还是测验没做完
    //    先切到视频附件，看它的 aria-label
    clickAttachByKeyword('视频')
    await sleep(1500)

    const vState = attachState()
    diag.videoDone = vState.done

    // 视频没完成 → 必须真实播放（禁止 seek）
    if (vState.done !== true) {
      diag.phase = 'playing'
      const started = await ensurePlaying()
      if (!started) {
return {
        ok: false,
        reason: 'cannot-play',
        detail: '视频没能启动播放（浏览器可能拦截了自动播放，请手动点一下播放按钮）',
      }
      }
      /* ★ 2026-10-25：刚开始播放就立刻预抓一次，争取最大并行时间窗。
       * 主循环里还会按比例再次尝试（同一章只发一次，不会重复）。 */
      /* 传 null 而不是 0：0 会被「ratio < prefetchMinRatio」的检查拦掉
         （minRatio=0.02，0 < 0.02 为真 → 直接 return，预抓从未真正发起过）。
         null 表示「不检查播放进度，立刻抓」。 */
      try { prefetchLogIfNeeded(ch, null) } catch { /* ignore */ }
      return { ok: true, playing: true }
    }

    // ③ 视频已完成 → 确保日志 → 做测验
    diag.videoDone = true
    const lg = await ensureLog(ch)
    if (!lg.ok) {
      // 日志拿不到：记录失败（带退避），连续失败则放弃本章继续往下走，
      // 绝不能因为「这一章的日志抓不到」就把整个流程卡死。
      const giveup = noteFailure(ch.chapterId, lg.reason, lg.msg)
      if (giveup) {
        flash(`⏭ 跳过本章《${ch.name}》（日志不可用），继续下一章`, 'warn')
        clearFailure()
        return { ok: true, needNext: true, skippedByError: true }
      }
      return { ok: false, reason: lg.reason }
    }

    const qr = await doChapterQuiz(ch)
    if (!qr.ok && !qr.skipped) {
      // ⚠️ 必须把 qr.detail（真实原因）一起传进提示里。
      //    2026-10-24 用户实测：提示一直只显示 `decode-failed` 这个码名，
      //    看不出到底是「候选字形表没就绪」还是「真的一个都没还原」。
      //    根因就是这里只传了 qr.reason，把 qr.detail 丢了。
      const detailText = qr.detail ? `：${qr.detail}` : ''
      const giveup = noteFailure(ch.chapterId, qr.reason, `章节测验失败${detailText}`)
      if (giveup) {
        flash(`⏭ 跳过本章《${ch.name}》的测验，继续下一章`, 'warn')
        clearFailure()
        return { ok: true, needNext: true, skippedByError: true }
      }
      return { ok: false, reason: qr.reason, detail: qr.detail }
    }

    // 成功：清空失败记录
    clearFailure()

    // ④ 本章结束后检查是否还剩任务点
    const after = currentChapter()
    if (after && after.unfinish === 0) {
      return { ok: true, done: true }
    }
    return { ok: true, needNext: true }
  }

  async function nextChapter() {
    diag.phase = 'nextChapter'
    const ch = currentChapter()
    if (!ch) return false
    const items = Array.from(document.querySelectorAll('.posCatalog_select'))
    const idx = items.indexOf(ch.node)
    // 找下一个有名字的（跳过一级目录标题）
    for (let i = idx + 1; i < items.length; i++) {
      const nameEl = items[i].querySelector('.posCatalog_name')
      if (!nameEl) continue
      try {
        // 用 fireClick：posCatalog_name 带 onclick="getTeacherAjax(...)"，
        // 优先直接调函数，避免任何锚点导航被 CSP 拦
        fireClick(nameEl, nameEl.ownerDocument || document)
        await sleep(2500)
        flash(`⏭ 切到下一章：${(nameEl.getAttribute('title') || txt(nameEl, 30)).trim()}`, 'info')
        return true
      } catch { return false }
    }
    flash('🏁 已经是最后一章了', 'info')
    return false
  }

  /** 安全地取当前章节 id（异常路径用，自身不能再抛） */
  function SafeChapterForFail() {
    try { return currentChapter()?.chapterId || diag.chapterId || '?' } catch { return '?' }
  }

  /** 安全地切下一章（异常路径用） */
  function SafeNextChapter() {
    try { nextChapter() } catch (e) { LOG('切章失败', e?.message) }
  }

  /** 主循环：按状态推进 */
  async function tick() {
    if (!isOn() || stopFlag) { diag.phase = 'off'; return }
    if (running) return
    running = true
    try {
      // 弹题优先：任何时候有弹题都先处理
      if (await handlePopupQuiz()) return

      diag.phase = diag.phase === 'idle' ? 'start' : diag.phase
      diag.steps++

      // ── 关键：播放前先判断这个视频任务点是否已经完成 ──
      // 用户明确要求「播放视频前要检查视频是否已经播放完成，可以直接答题，
      // 防止用户已看完我们插件又重复播放浪费时间」。
      // 判据用 .ans-job-icon 的 aria-label（通用），不能用 ans-job-icon-clear。
      const attach = currentAttachTitle()
      if (/视频/.test(attach)) {
        const stPre = attachState()
        diag.videoDone = stPre.done
        if (stPre.done === true) {
          // 这个视频任务点已完成 → 停止播放，直接去确保日志 + 答题
          const v0 = findVideo()
          if (v0 && !v0.paused) {
            try { v0.pause() } catch { /* ignore */ }
          }
          diag.videoState = '已完成·跳过'

          // 退避期内不要重试（否则会每秒重打一次 autoCapture 卡死在这里）
          if (inBackoff()) {
            diag.videoState = '已完成·等待重试'
            return
          }

          const r0 = await runOneChapter()
          // 注意：整章已完成时 runOneChapter 返回 {ok:true, skipped:true}，
          // 这种情况也必须切下一章，否则会卡在已完成章节上不动。
          if (r0.ok && (r0.done || r0.needNext || r0.skipped)) {
            await nextChapter()
          }
          return
        }
      }

      // 正在播放：监控 + 播完推进
      const v = findVideo()
      if (v && !v.ended) {
        const s = samplePlay()
        if (s.ok) {
          diag.videoState = `播放中 ${Math.round(s.ratio * 100)}%`
          if (s.stalled) {
            diag.videoState = '卡住'
            const ok = await ensurePlaying()
            if (!ok) flash('⚠ 视频卡住了，请手动点播放', 'warn')
            playMon.stall = 0
            playMon.stalled = false
          }
          // 还没到 90% 就继续播放，不进入答题
          if (s.ratio < CFG.doneRatio && !s.ended) {
            if (v.paused) await ensurePlaying()
            /* ★ 2026-10-25：播放期间就预抓日志（边播边下载+转写）。
             * 原来「播完才开始下载」，14 分钟视频还要再等 ~90 秒；
             * 现在并行准备，播完 ensureLog 直接 reused，立刻答题。 */
            try { prefetchLogIfNeeded(currentChapter(), s.ratio) } catch { /* 绝不影响播放 */ }
            return
          }
          // 播放到 90% 以上：再确认任务点是否真的完成了
          // （90% 只是学习通的完成条件，最终以平台记录为准）
          const st2 = attachState()
          if (st2.done !== true) {
            diag.videoState = '等待平台确认'
            flash('⚠ 已播到 90%，但平台还没标记完成，继续播放', 'warn')
            return
          }
        }
        return
      }

      // 没有视频在播 / 已播完 → 推进章节
      // 退避期内不要重试，否则失败会以 tick 频率无限重放
      if (inBackoff()) return
      const r = await runOneChapter()
      if (r.ok && r.playing) return
      // skipped = 整章已完成，同样要切下一章，否则会卡住不动
      if (r.ok && (r.done || r.needNext || r.skipped)) {
        await nextChapter()
        return
      }
      if (!r.ok) {
        diag.lastError = r.reason || ''
        if (r.reason === 'cannot-play' || r.reason === 'no-video') {
          flash('⚠ 当前附件不是可播放视频，尝试切到视频页', 'warn')
          clickAttachByKeyword('视频')
          await sleep(2000)
        }
        // 其他失败：runOneChapter 内部已 noteFailure 记了退避，这里直接返回
        return
      }
    } catch (e) {
      diag.lastError = String(e?.message || e)
      LOG('tick 异常', e)
      // 未预期的异常也要记失败并退避，否则会以 tick 频率无限重放同一个异常
      const ch2 = SafeChapterForFail()
      const giveup = noteFailure(ch2, 'tick-error', String(e?.message || e))
      if (giveup) {
        clearFailure()
        // 放弃当前章，试着往下走，避免整条流程死在这里
        SafeNextChapter()
      }
    } finally {
      running = false
    }
  }

  /* ═══════════════════════ 角标开关 ═══════════════════════ */

  function makeBtn(label, on) {
    const b = document.createElement('button')
    b.type = 'button'
    b.style.cssText = [
      'margin-left:6px', 'padding:4px 10px', 'border-radius:7px', 'cursor:pointer',
      'font:inherit', 'font-size:11.5px', 'border:1px solid',
    ].join(';')
    paintBtn(b, label, on)
    return b
  }

  function paintBtn(b, label, on) {
    b.textContent = label
    b.style.background = on ? 'rgba(63,207,127,.28)' : 'rgba(255,255,255,.08)'
    b.style.color = on ? '#8ff0bc' : '#9aa0a8'
    b.style.borderColor = on ? 'rgba(63,207,127,.55)' : 'rgba(255,255,255,.14)'
  }

  function attachButton() {
    const badge = document.getElementById('__studybuddy_badge')
    if (!badge) return false
    if (badge.querySelector('.__sb_pilot_btn')) return true

    const on = isOn()
    const btn = makeBtn(on ? '⏸ 停止一键答题' : '▶ 一键播放答题', on)
    btn.className = '__sb_pilot_btn'
    btn.title = '自动播放视频 → 看完 → 抓日志 → 自动做章节测验'
    btn.onclick = (e) => {
      e.stopPropagation()
      const next = !isOn()
      C.setOn(next)
      paintBtn(btn, next ? '⏸ 停止一键答题' : '▶ 一键播放答题', next)
      if (next) {
        flash('▶ 一键播放答题已开启', 'ok')
        diag.phase = 'start'
        stopFlag = false
        setTimeout(tick, 300)
      } else {
        stopFlag = true
        diag.phase = 'off'
        flash('⏸ 已停止', 'warn')
      }
    }
    badge.appendChild(btn)
    return true
  }

  let tries = 0
  const badgeTimer = setInterval(() => {
    if (attachButton() || ++tries > 240) clearInterval(badgeTimer)
  }, 500)

  /* SPA 换章后角标会重建 */
  let lastHref = location.href
  const hrefTimer = setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      tries = 0
      const t = setInterval(() => { if (attachButton() || ++tries > 60) clearInterval(t) }, 500)
    }
  }, 2000)

  /* 页面卸载时清理定时器 */
  window.addEventListener('beforeunload', () => {
    clearInterval(hrefTimer)
    clearInterval(badgeTimer)
  })

  /* 主循环 */
  const mainTimer = setInterval(tick, CFG.tickMs)

  LOG('一键播放答题已加载')
  diag.phase = 'idle'
})()
