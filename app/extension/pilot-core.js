/**
 * 学习通学伴 · 一键播放答题
 * ============================================================================
 * 依据 2026-10-24 CDP 实测的真实 DOM（详见 docs/course-log-index.md 与
 * docs/quiz-api-contract.md），核心事实：
 *
 * 【页面层级】
 *   top
 *    └ iframe#iframe           (knowledge/cards)
 *       ├ iframe.ans-insertvideo-online (ananas/modules/video/index.html)
 *       │   └ video#video_html5_api.vjs-tech        ← video.js 7.2.2
 *       └ iframe                  (ananas/modules/work/index.html)
 *           └ iframe#frame_content
 *               └ doHomeWorkNew（待完成）/ selectWorkQuestionYiPiYue（已批阅）
 *
 * 【任务点判据】（我在这上面错过两次，最终结论）
 *   · 章节级：.posCatalog_select 内 input.jobUnfinishCount 的 value = 未完成数
 *            不存在该 input = 整章完成；span.icon_Completed 存在 = 整章完成
 *   · 附件级：.ans-job-icon 的 aria-label（唯一通用判据）
 *            ⚠️ ans-job-icon-clear 只对视频附件可靠，测验附件即使完成也没有 clear
 *   · ❌ 不要用 .ans-job-finished（已完成/未完成章节都有）
 *
 * 【致命陷阱：字体混淆】
 *   章节测验的题干/选项 DOM 文本被 font-cxsecret 字体混淆，是乱码。
 *   「懚懖与懚懖之懘」实际渲染为「框架与框架之间」。必须解码后再交给 AI，
 *   否则 AI 基于乱码作答 → 答案随机 → 自动提交污染用户成绩。
 *
 * 【硬约束】
 *   · 禁止 seek / 设置 video.currentTime（学习通会拦截，且可能导致任务点不计数）
 *   · 完成阈值 90%（不是 100%）
 *   · 必须真实播放，离开页面/最小化会导致不计时
 *   · 禁止开新标签页（会触发学习通限制报错）
 */
;(function () {
  'use strict'

  /* ───────────────────── 常量与配置 ───────────────────── */

  const CFG = {
    /* 主循环周期 */
    tickMs: 1200,
    /* 播放监控采样周期 */
    monitorMs: 2000,
    /* 连续多少次采样 currentTime 不推进判定为卡住 */
    stallSamples: 3,
    /* 判定「观看完成」的阈值（学习通要求 ≥90%） */
    doneRatio: 0.9,
    /* 弹题最多尝试次数（防止死循环） */
    maxQuizAttempts: 6,
    /* 单个弹题最长处理时间 */
    quizTimeoutMs: 150000,
    /* 点击间隔 */
    clickGapMs: 700,
    /* 提交后等待判分 */
    submitWaitMs: 1600,
    /* 等待 iframe 加载的超时 */
    frameTimeoutMs: 25000,
    /* 抓日志最长等待
     * 2026-10-24 实测数据：模型加载 ~30s + 下载 45MB ~2s + 转写 425 段 ~87s ≈ 2 分钟，
     * 长视频（30 分钟课 600+ 段）可能要 3-4 分钟。原 200 秒偏紧，放宽到 6 分钟。 */
    logTimeoutMs: 360000,
    /* 应用接口地址 */
    apiBase: 'http://127.0.0.1:39517',
  }

  const LS_ON = '__sb_pilot_on'          // 一键播放答题总开关
  const LS_SUBMITTED = '__sb_submitted'  // 已提交的 workId 记录

  const LOG = (...a) => { try { console.log('[学伴·一键]', ...a) } catch { /* ignore */ } }

  function isOn() { try { return localStorage.getItem(LS_ON) === '1' } catch { return false } }
  function setOn(v) { try { localStorage.setItem(LS_ON, v ? '1' : '0') } catch { /* ignore */ } }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function visible(el) {
    try {
      if (!el || el.nodeType !== 1) return false
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
    } catch { return false }
  }

  function txt(el, n) {
    try { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, n || 100) } catch { return '' }
  }

  /* ───────────────────── 提示条 ───────────────────── */

  let tipEl = null, tipTimer = null
  function flash(text, kind) {
    try {
      if (!tipEl) {
        tipEl = document.createElement('div')
        tipEl.style.cssText = [
          'position:fixed', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
          'z-index:2147483647', 'padding:8px 14px', 'border-radius:9px',
          'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'box-shadow:0 5px 18px rgba(0,0,0,.32)', 'pointer-events:none', 'max-width:72vw',
          'transition:opacity .2s',
        ].join(';')
        document.documentElement.appendChild(tipEl)
      }
      const palette = {
        ok: ['rgba(63,207,127,.95)', '#0b2417'],
        info: ['rgba(88,166,255,.95)', '#06131f'],
        warn: ['rgba(255,200,87,.96)', '#2b2b2b'],
        err: ['rgba(255,107,107,.95)', '#2b0000'],
      }
      const [bg, fg] = palette[kind] || palette.info
      tipEl.textContent = text
      tipEl.style.background = bg
      tipEl.style.color = fg
      tipEl.style.display = 'block'
      tipEl.style.opacity = '1'
      clearTimeout(tipTimer)
      tipTimer = setTimeout(() => {
        if (tipEl) { tipEl.style.opacity = '0'; setTimeout(() => { if (tipEl) tipEl.style.display = 'none' }, 220) }
      }, 3200)
      LOG(text)
    } catch { /* ignore */ }
  }

  /* ───────────────────── 诊断 ───────────────────── */

  const diag = {
    phase: 'idle',
    chapterId: '',
    chapterName: '',
    unfinish: null,
    videoDone: null,
    videoState: '',
    logStage: '',
    quizInfo: '',
    lastError: '',
    steps: 0,
    newTabGuard: 0,
  }
  window.__sbPilotDiag = diag

  /* 禁止新开标签页：产品约束，正常恒为 0 */
  ;(function guardNewTab() {
    try {
      const raw = window.open
      window.open = function () {
        diag.newTabGuard++
        LOG('拦截了一次 window.open —— 本扩展禁止开新标签页')
        return null
      }
    } catch { /* ignore */ }
  })()

  /* ───────────────────── 基础取数 ───────────────────── */

  /** 顶层 → cards iframe */
  function cardsDoc() {
    try { return document.getElementById('iframe')?.contentDocument || null } catch { return null }
  }

  /** cards → 视频 iframe */
  function videoDoc() {
    const d1 = cardsDoc()
    if (!d1) return null
    try {
      return d1.querySelector('iframe.ans-insertvideo-online')?.contentDocument || null
    } catch { return null }
  }

  function findVideo() {
    try { return videoDoc()?.querySelector('video') || null } catch { return null }
  }

  /** 当前 cards 里显示的是哪个附件（用 title 判断，比类名稳） */
  function currentAttachTitle() {
    const d1 = cardsDoc()
    if (!d1) return ''
    return String(d1.title || '').trim()
  }

  /* ───────────────────── 任务点判据 ───────────────────── */

  /** 章节列表里当前激活项的章节信息 */
  function currentChapter() {
    try {
      const items = Array.from(document.querySelectorAll('.posCatalog_select'))
      const active = items.find((e) => /posCatalog_active/.test(e.className || ''))
      if (!active) return null
      const nameEl = active.querySelector('.posCatalog_name')
      const onclick = nameEl?.getAttribute('onclick') || ''
      const m = /getTeacherAjax\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(onclick)
      const unf = active.querySelector('input.jobUnfinishCount')
      const name = (nameEl?.getAttribute('title') || txt(nameEl, 60)).trim()
      return {
        node: active,
        nameEl,
        name,
        chapterId: m ? m[3] : '',
        courseId: m ? m[1] : '',
        clazzId: m ? m[2] : '',
        unfinish: unf ? Number(unf.value) : 0,
        completed: Boolean(active.querySelector('.icon_Completed')),
        hasPointsYi: Boolean(active.querySelector('.catalog_points_yi')),
      }
    } catch { return null }
  }

  /** 附件级完成状态（通用判据：aria-label） */
  function attachState(cards) {
    const d1 = cards || cardsDoc()
    if (!d1) return { done: null, aria: '', clear: false }
    try {
      const icon = d1.querySelector('.ans-job-icon')
      if (!icon) return { done: null, aria: '', clear: false }
      const aria = (icon.getAttribute('aria-label') || '').trim()
      const clear = /ans-job-icon-clear/.test(icon.className || '')
      let done = null
      if (aria) done = /已完成/.test(aria) && !/未完成/.test(aria)
      return { done, aria, clear }
    } catch { return { done: null, aria: '', clear: false } }
  }

  /** 顶层附件标签（1学习目标 / 2视频 / 3章节测验 ...） */
  function attachTabs() {
    try {
      const ul = document.querySelector('.prev_ul')
      if (!ul) return []
      return Array.from(ul.querySelectorAll('li')).map((li, i) => ({
        index: i, node: li, text: txt(li, 20),
      }))
    } catch { return [] }
  }

  /**
   * 点某个附件标签（1学习目标 / 2视频 / 3章节测验）。
   *
   * ⚠️ 2026-10-24 实测：`.click()` **有时不生效**（点了之后 cards title 仍是「视频」）。
   *    学习通这套标签是 `onclick="changeDisplayContent(序号, 类型, chapterId, courseId, clazzId, '')"`，
   *    直接 `.click()` 依赖它自己绑定的 handler，在某些时序下会失败。
   *    实测对比：click() → title 仍「视频」；直接调 `changeDisplayContent(...)` 带全参数 → 「章节测验」。
   *    所以这里改成「先试 click，再校验标题，不行就调函数带参数」。
   *
   * @returns {boolean} 是否点击动作发出（不保证生效，调用方应校验标题）
   */
  function clickAttachByKeyword(kw) {
    const tabs = attachTabs()
    const t = tabs.find((x) => new RegExp(kw).test(x.text))
    if (!t) return false

    // ① 先试原生 click
    try { t.node.click() } catch { /* ignore */ }

    // ② 再补一次：解析 onclick 里的 changeDisplayContent 并带完整参数调用
    //    这样两种机制都覆盖，避免某些时序下 click 静默失效。
    try {
      const oc = t.node.getAttribute ? (t.node.getAttribute('onclick') || '') : ''
      const m = /([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(oc)
      if (m && m[1] === 'changeDisplayContent' && typeof window[m[1]] === 'function') {
        const args = m[2].split(',').map((s) => {
          s = s.trim()
          if (/^['"]/.test(s)) return s.slice(1, -1)
          if (/^\d+$/.test(s)) return Number(s)
          return s
        })
        window[m[1]].apply(window, args)
        LOG(`clickAttachByKeyword: 已补调 ${m[1]}(${args.join(',')})`)
      }
    } catch (e) {
      LOG('clickAttachByKeyword 补调失败', e?.message)
    }
    return true
  }

  /* ───────────────────── 字体解混淆 ───────────────────── */

  /* ═══════════ 确定性解码（2026-10-24 落地，31/31 实测验证） ═══════════
   *
   * 背景：之前用 canvas 字形 IoU 相似度「猜」，永远有低置信字、偶尔猜错
   *      （「节俭」→「节但」、「绿色」→「绎色」），怎么调阈值都不够。
   *
   * 新方案（社区成熟做法，非猜测）：
   *   glyphIndex = Typr.U.codeToGlyph(font, code)
   *   path       = Typr.U.glyphToPath(font, glyphIndex)   // 字形轮廓
   *   hash       = md5(JSON.stringify(path)).slice(24)    // 取后 8 位！
   *   真实字     = table[hash]                            // 固定映射表
   *
   * 为什么确定性：学习通字体是思源黑体子集，**同一个字的字形轮廓永远相同**，
   *              MD5 必然相同 → 一张表 100% 查准，不存在「置信度」概念。
   *
   * 实测（真实题目字体 font-cxsecret，11676 字节，32 字形）：
   *   · slice(24) 命中  31/31 = 100%
   *   · slice(0,8) 命中  0/31（前 8 位是错的，必须用后 8 位）
   *   还原样例：哵→在 哶→量 哷→转 哸→个 哹→汉 唈→能 唅→真 涥→的
   */

  /** 从 @font-face 提取 base64 字体串（顶层 + 递归 iframe） */
  function extractFontBase64(doc, depth) {
    if (!doc || (depth || 0) > 6) return null
    try {
      // ① styleSheets 里的 @font-face
      for (const sh of doc.styleSheets) {
        let rs = null
        try { rs = sh.cssRules } catch { continue }
        for (const r of rs) {
          const t = r.cssText || ''
          if (t.includes('font-cxsecret') && t.includes('base64,')) {
            const m = /base64,([A-Za-z0-9+/=\s]+?)['"]/.exec(t)
            if (m && m[1]) {
              const clean = m[1].replace(/\s+/g, '')
              if (clean.length > 500) return clean
            }
          }
        }
      }
    } catch { /* ignore */ }
    // ② <style> 标签兜底
    try {
      for (const st of doc.querySelectorAll('style')) {
        const t = st.textContent || ''
        if (t.includes('font-cxsecret') && t.includes('base64,')) {
          const m = /base64,([A-Za-z0-9+/=\s]+?)['"]/.exec(t)
          if (m && m[1]) {
            const clean = m[1].replace(/\s+/g, '')
            if (clean.length > 500) return clean
          }
        }
      }
    } catch { /* ignore */ }
    // ③ 钻 iframe
    try {
      for (const f of doc.querySelectorAll('iframe')) {
        let sub = null
        try { sub = f.contentDocument } catch { sub = null }
        if (!sub) continue
        const r = extractFontBase64(sub, (depth || 0) + 1)
        if (r) return r
      }
    } catch { /* ignore */ }
    return null
  }

  /** base64 → Uint8Array */
  function b64ToBytes(b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  /** UTF-8 字符串 → MD5 十六进制（Node 环境用 crypto，扩展里用纯实现） */
  function md5Hex(str) {
    // 扩展里没有 require，优先用页面自带或自己算
    try {
      // 有些页面有 md5（初学者用）
      if (typeof window !== 'undefined' && typeof window.md5 === 'function') {
        return window.md5(str)
      }
    } catch { /* ignore */ }
    return sbMd5(str)
  }

  /**
   * 纯 JS MD5 实现（RFC 1321），返回 32 位小写十六进制。
   * 扩展环境无 require，必须自带。
   */
  /**
   * MD5（2026-10-24 改用 blueimp-md5 成熟实现，不再自己写）。
   *
   * 之前自实现版本对照标准 MD5 只通过 1/6，会导致 hash 全错、映射表全不命中。
   * blueimp-md5 是学习通字体解码脚本同款实现，保证 hash 与社区映射表严格一致。
   * 已实测：6/6 与 node:crypto 标准 MD5 完全一致。
   */
  function sbMd5(str) {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.__sbMd5 === 'function') {
        return globalThis.__sbMd5(String(str))
      }
      if (typeof window !== 'undefined' && typeof window.__sbMd5 === 'function') {
        return window.__sbMd5(String(str))
      }
    } catch { /* ignore */ }
    return ''
  }


  /**
   * 用确定性方法解码整段文本。
   * @returns {{decoded:string, hit:number, total:number, map:Object}}
   */
  function decodeByFontMap(text, fontCtx) {
    const src = String(text || '')
    if (!src) return { decoded: '', hit: 0, total: 0, map: {} }
    if (!fontCtx || !fontCtx.font || !fontCtx.charset || !fontCtx.charset.size) {
      return { decoded: src, hit: 0, total: 0, map: {} }
    }

    const { font, charset } = fontCtx
    const table = (typeof sbFontTable === 'function') ? sbFontTable() : null
    if (!table) return { decoded: src, hit: 0, total: 0, map: {} }

    let hit = 0
    let total = 0
    const mapUsed = {}
    const out = []

    for (const ch of src) {
      if (!charset.set.has(ch)) { out.push(ch); continue }
      total++
      // 缓存：同字只算一次
      if (mapUsed[ch] !== undefined) {
        out.push(mapUsed[ch] || ch)
        if (mapUsed[ch]) hit++
        continue
      }
      let real = null
      try {
        const code = ch.charCodeAt(0)
        const gi = Typr.U.codeToGlyph(font, code)
        if (gi > 0) {
          const path = Typr.U.glyphToPath(font, gi)
          if (path) {
            const h = md5Hex(JSON.stringify(path)).slice(24)
            const cc = table.get(h)
            if (cc) real = String.fromCharCode(cc)
          }
        }
      } catch { /* ignore */ }
      mapUsed[ch] = real
      if (real) { hit++; out.push(real) } else out.push(ch)
    }

    return { decoded: out.join(''), hit, total, map: mapUsed }
  }

  /** 解析字体并建上下文（按 document 缓存，避免跨章重复解析 ~10ms） */
  const fontCtxByDoc = new WeakMap()
  function buildFontCtx(doc) {
    if (!doc) return null
    const cached = fontCtxByDoc.get(doc)
    if (cached && cached.font) return cached

    const b64 = extractFontBase64(doc, 0)
    if (!b64) return null
    try {
      const bytes = b64ToBytes(b64)
      if (typeof Typr === 'undefined' || !Typr.parse) return null
      const font = Typr.parse(bytes)[0]
      if (!font) return null

      // 读字体覆盖的码位集合（哪些「字」是被混淆过的）
      const codes = new Set()
      for (let c = 0x4e00; c <= 0x9fff; c++) {
        try { if (Typr.U.codeToGlyph(font, c) > 0) codes.add(c) } catch { /* ignore */ }
      }
      for (const [lo, hi] of [[0x20, 0x7e], [0x3000, 0x303f], [0xff00, 0xffef]]) {
        for (let c = lo; c <= hi; c++) {
          try { if (Typr.U.codeToGlyph(font, c) > 0) codes.add(c) } catch { /* ignore */ }
        }
      }
      const set = new Set([...codes].map((c) => String.fromCharCode(c)))

      const ctx = { font, charset: { set, size: set.size }, fontB64Len: b64.length }
      fontCtxByDoc.set(doc, ctx)
      LOG(`确定性字体上下文就绪：${set.size} 个混淆码位，字体 ${Math.round(bytes.length / 1024)}KB`)
      return ctx
    } catch (e) {
      LOG('构建确定性字体上下文失败:', e?.message)
      return null
    }
  }

  /**
   * 从内联 @font-face 解析 base64 TTF 的 cmap，得到被混淆的码位集合。
   * 这是确定性的，不靠猜：cmap 里出现哪些码位，哪些字就是被混淆的。
   */
  function obfCharset(doc) {
    try {
      let face = ''
      for (const sh of doc.styleSheets) {
        let rs = null
        try { rs = sh.cssRules } catch { continue }
        for (const r of rs) {
          const t = r.cssText || ''
          if (/@font-face/.test(t) && /font-cxsecret/.test(t)) { face = t; break }
        }
        if (face) break
      }
      if (!face) {
        // 从 style 标签里直接正则（cssRules 拿不到时的兜底）
        for (const st of doc.querySelectorAll('style')) {
          const t = st.textContent || ''
          if (/@font-face/.test(t) && /font-cxsecret/.test(t)) { face = t; break }
        }
      }
      if (!face) return null

      const m = face.match(/base64,([A-Za-z0-9+/=]+)/)
      if (!m) return null
      const bin = atob(m[1])
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      if (bytes.length < 12) return null

      const dv = new DataView(bytes.buffer)
      const numTables = dv.getUint16(4)
      let cmapOff = 0
      for (let i = 0; i < numTables; i++) {
        const o = 12 + i * 16
        if (o + 16 > bytes.length) break
        const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
        if (tag === 'cmap') { cmapOff = dv.getUint32(o + 8); break }
      }
      if (!cmapOff || cmapOff + 4 > bytes.length) return null

      const nSub = dv.getUint16(cmapOff + 2)
      const subs = []
      for (let i = 0; i < nSub; i++) {
        const o = cmapOff + 4 + i * 8
        if (o + 8 > bytes.length) break
        subs.push(cmapOff + dv.getUint32(o + 4))
      }
      const codes = new Set()
      for (const sub of subs) {
        if (sub + 4 > bytes.length) continue
        const fmt = dv.getUint16(sub)
        if (fmt === 4) {
          const segX2 = dv.getUint16(sub + 6), seg = segX2 / 2
          if (!seg) continue
          const endO = sub + 14
          const startO = endO + segX2 + 2
          for (let i = 0; i < seg; i++) {
            if (endO + i * 2 + 2 > bytes.length || startO + i * 2 + 2 > bytes.length) break
            const end = dv.getUint16(endO + i * 2)
            const start = dv.getUint16(startO + i * 2)
            for (let c = start; c <= end && c !== 0xFFFF; c++) codes.add(c)
          }
        } else if (fmt === 12) {
          if (sub + 16 > bytes.length) continue
          const nGroups = dv.getUint32(sub + 12)
          for (let i = 0; i < nGroups; i++) {
            const o = sub + 16 + i * 12
            if (o + 12 > bytes.length) break
            const s = dv.getUint32(o), e = dv.getUint32(o + 4)
            for (let c = s; c <= e; c++) codes.add(c)
          }
        }
      }
      if (!codes.size) return null
      return { set: new Set([...codes].map((c) => String.fromCharCode(c))), size: codes.size }
    } catch (e) {
      LOG('解析字体失败', e?.message)
      return null
    }
  }

  /** 字形归一化：渲染 → 裁 bbox → 缩放到 48×48 二值 */
  function makeGlyphCmp(doc) {
    const SZ = 96, W = SZ + 40, H = SZ + 40, OUT = 48
    const cv = doc.createElement('canvas'); cv.width = W; cv.height = H
    const cx = cv.getContext('2d', { willReadFrequently: true })
    const cv2 = doc.createElement('canvas'); cv2.width = OUT; cv2.height = OUT
    const cx2 = cv2.getContext('2d', { willReadFrequently: true })

    function norm(ch, font) {
      try {
        cx.clearRect(0, 0, W, H)
        cx.font = SZ + 'px ' + font
        cx.textBaseline = 'alphabetic'
        cx.fillStyle = '#000'
        cx.fillText(ch, 20, SZ)
        const d = cx.getImageData(0, 0, W, H).data
        let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (d[(y * W + x) * 4 + 3] > 100) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxX < 0) return null
        cx2.clearRect(0, 0, OUT, OUT)
        cx2.drawImage(cv, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, OUT, OUT)
        const d2 = cx2.getImageData(0, 0, OUT, OUT).data
        const v = new Uint8Array(OUT * OUT)
        for (let i = 0; i < OUT * OUT; i++) if (d2[i * 4 + 3] > 100) v[i] = 1
        return v
      } catch { return null }
    }

    return { norm, OUT }
  }

  /**
   * 解混淆一个字段。
   * @returns {{raw, decoded, confidence, lowConfidence}}
   */
  function decodeField(rawText, ctx) {
    const raw = String(rawText || '')
    if (!raw) return { raw: '', decoded: '', confidence: 1, lowConfidence: [] }
    if (!ctx || !ctx.charset || !ctx.charset.set || !ctx.charset.size) {
      // 没有字体混淆信息 → 说明这章没混淆，confidence 记 1
      return { raw, decoded: raw, confidence: 1, lowConfidence: [] }
    }

    /**
     * ★★★ 优先走确定性解码（2026-10-24 落地）★★★
     *
     * 用「字形轮廓 MD5 → 固定映射表」把每个混淆字 100% 精确还原，不做相似度猜测。
     * 实测真实题目字体（11676 字节 / 32 字形）：31/31 全部命中，逐字对照无差异。
     *
     * 只有确定性路径不可用（Typr 未加载 / 字体解析失败 / 表里查不到）时，
     * 才回退到下面基于 canvas IoU 的猜测路径。
     */
    if (ctx.font) {
      try {
        const r = decodeByFontMap(raw, { font: ctx.font, charset: ctx.charset })
        if (r.total > 0 && r.hit === r.total) {
          // 全部命中 → 完全确定
          return { raw, decoded: r.decoded, confidence: 1, lowConfidence: [], source: 'font-map' }
        }
        if (r.hit > 0) {
          // 部分命中：命中的是确定的，未命中的保留原字并标记
          const low = []
          for (const obf of Object.keys(r.map)) {
            if (!r.map[obf]) low.push({ from: obf, to: null, score: 0, kept: true })
          }
          return {
            raw,
            decoded: r.decoded,
            confidence: r.total ? Number((r.hit / r.total).toFixed(3)) : 1,
            lowConfidence: low,
            source: 'font-map-partial',
            fontMapHit: r.hit,
            fontMapTotal: r.total,
          }
        }
        // 一个字都没命中 → 映射表与这个字体版本不匹配，回退 IoU
        LOG('确定性解码 0 命中（映射表与字体版本不匹配），回退 canvas 猜测')
      } catch (e) {
        LOG('确定性解码异常，回退 canvas 猜测:', e?.message)
      }
    }

    // ⚠️ 关键保护（2026-10-24）：buildCandidates 可能失败（cand-chars.js 没加载 /
    //    canvas 渲染不出字形），此时 ctx.cmp 为 null。
    //    旧代码在这里会抛 TypeError（cmp.norm 读 null），让整个抓题流程崩掉，
    //    上层只能看到一个莫名其妙的失败。
    //    现在明确标记 decodedReason='no-candidates'，让 checkDecodeFail 能说出真实原因。
    if (!ctx.cmp || !ctx.candVecs || !ctx.candVecs.length) {
      return {
        raw,
        decoded: raw,
        confidence: 0,
        lowConfidence: [],
        decodedReason: 'no-candidates',
      }
    }

    const { charset, cmp, candVecs } = ctx
    const chars = [...raw]
    let hitCount = 0
    const scores = []
    const low = []

    /**
     * 内部解码器：用当前候选表解一遍，返回 {out, hitCount, scores, low}
     * 抽出来是为了支持「高频表解不好 → 扩全表重解」这个兜底流程。
     */
    function decodeWith(vecs) {
      let hits = 0
      const sc = []
      const lw = []
      const result = chars.map((ch, idx) => {
        if (!charset.set.has(ch)) return ch
        hits++
        const a = cmp.norm(ch, 'font-cxsecret')
        if (!a) { sc.push(0); return ch }
        let best = null
        for (const b of vecs) {
          let inter = 0, uni = 0
          for (let i = 0; i < a.length; i++) {
            const xv = a[i], yv = b.v[i]
            if (xv && yv) inter++
            if (xv || yv) uni++
          }
          const iou = uni ? inter / uni : 0
          if (!best || iou > best.iou) best = { c: b.c, iou }
        }
        if (!best) { sc.push(0); return ch }
        sc.push(best.iou)
        // 阈值保护（2026-10-24 调整）：
        // 原阈值 0.45 太低 —— 实测把「节俭」解成「节但」、「绿」解成「绎」，
        // 都是 IoU 恰好 0.45~0.55 的误判，而它们会作为"正确答案"混进去。
        // 现在分三档：
        //   ≥0.62          → 直接替换（实测正确字多在 0.66~0.85）
        //   0.45~0.62      → 替换但标记为 lowConfidence，让 AI 结合上下文复核
        //   <0.45          → 保留原字并标记 kept，不给错误答案
        if (best.iou < 0.45) {
          lw.push({ index: idx, from: ch, to: best.c, score: Number(best.iou.toFixed(2)), kept: true })
          return ch
        }
        if (best.iou < 0.62) {
          lw.push({ index: idx, from: ch, to: best.c, score: Number(best.iou.toFixed(2)) })
        }
        return best.c
      })
      return { out: result, hitCount: hits, scores: sc, low: lw }
    }

    // 第一轮：用当前候选表（高频 1200 字）解
    let r1 = decodeWith(candVecs)

    // 兜底：如果「命中混淆字但一个都没替换成功」，或者平均分低于 0.55，
    // 说明目标字可能在高频表之外 → 扩到全表再解一次。
    const replacedRatio = r1.scores.length
      ? r1.scores.filter((s) => s >= 0.45).length / r1.scores.length
      : 0
    const avg1 = r1.scores.length ? r1.scores.reduce((a, b) => a + b, 0) / r1.scores.length : 0

    if (ctx.expandToFull && r1.hitCount > 0 && (replacedRatio < 0.6 || avg1 < 0.55)) {
      try {
        LOG(`解混淆质量偏低（替换率 ${replacedRatio.toFixed(2)}, avg ${avg1.toFixed(2)}）→ 扩展候选到全表重试`)
        const fullVecs = ctx.expandToFull()
        if (fullVecs && fullVecs.length > candVecs.length) {
          r1 = decodeWith(fullVecs)
        }
      } catch (e) {
        LOG('扩展全表失败', e?.message)
      }
    }

    hitCount = r1.hitCount
    scores.push(...r1.scores)
    low.push(...r1.low)
    const out = r1.out

    if (!hitCount) return { raw, decoded: raw, confidence: 1, lowConfidence: [] }

    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    return {
      raw,
      decoded: out.join(''),
      confidence: Number(avg.toFixed(3)),
      lowConfidence: low,
    }
  }

  /** 构造候选字形向量表（惰性；但必须绑定到「当前有效」的 document） */
  /**
   * 构造候选字形向量表。
   *
   * ⚠️⚠️ 2026-10-24 用户报「第一遍能解，第二遍就全部解不出（检测到 64 个混淆字但一个都没还原）」，
   *      并准确怀疑「解码代码重复运行时罢工」。**用户是对的**，根因如下：
   *
   *   `makeGlyphCmp(doc)` 里的 canvas 是 `doc.createElement('canvas')` —— **绑定在特定 document 上**。
   *   而 `candCache` 是模块级全局变量，测验完成后 d3 的 iframe 会被卸载重建、旧 document 被销毁，
   *   但缓存仍然指回**已销毁的 document**。第二次进入测验时，
   *   `if (candCache && candCache.cmp) return candCache` 直接返回旧缓存，
   *   于是 canvas 渲染拿不到像素 → `norm()` 全部返回 null → 所有字都解不出。
   *
   *   我之前的调试一直没复现，是因为每次 CDP 都是**全新注入脚本**，candCache 恒为 null。
   *   用户连续跑第二遍才暴露。
   *
   * 修复：缓存的 key 必须包含「document 身份」，document 变了就重建。
   *   用 WeakMap<Document, cache> 天然解决：document 被销毁时缓存自动可回收，且不会跨文档复用。
   */
  const candCacheByDoc = new WeakMap()
  function buildCandidates(doc) {
    if (!doc) return null

    // ① 同一个 document 复用（真正的性能优化点）
    const cached = candCacheByDoc.get(doc)
    if (cached && cached.cmp) return cached

    const chars = (typeof SB_CAND_CHARS === 'string' && SB_CAND_CHARS) ? SB_CAND_CHARS : ''
    if (!chars) {
      LOG('⚠ 候选字表缺失（cand-chars.js 未加载或加载顺序不对）→ 无法解混淆')
      return null
    }

    // ② 校验 document 是否还活着：被卸载的 iframe document 建 canvas 会失效
    try {
      if (!doc.body) {
        LOG('⚠ 目标 document 不可用（无 body），跳过构建候选表')
        return null
      }
      const probe = doc.createElement('canvas')
      if (!probe || !probe.getContext) {
        LOG('⚠ 目标 document 无法创建 canvas，跳过构建候选表')
        return null
      }
    } catch (e) {
      LOG('⚠ 目标 document 已失效（可能被卸载）:', e?.message)
      return null
    }

    const cmp = makeGlyphCmp(doc)
    if (!cmp) {
      LOG('⚠ 建立字形比对器失败（canvas 不可用）→ 无法解混淆')
      return null
    }

    /**
     * 2026-10-24 性能实测与优化：
     *   · 单字单字体渲染 ≈ 0.34ms
     *   · 6766 字 × 3 字体 = 20298 次 ≈ **8.7 秒**（一次性，可接受但不是最优）
     *
     * 优化：**先只渲染高频 1200 字**（约 1.2 秒），不够时再扩到全表。
     * 绝大多数课程用字都在高频区，全表只是兜底。
     * 这样常见情况快 7 倍，且候选集完整性不受影响。
     */
    const FAMS = ['SimHei', 'Microsoft YaHei', 'SimSun']
    const charList = [...new Set([...chars])]
    const HEAD_N = 1200
    const vecs = []
    let renderedCount = 0

    function renderRange(from, to) {
      for (let i = from; i < to && i < charList.length; i++) {
        const c = charList[i]
        for (const fam of FAMS) {
          const v = cmp.norm(c, fam)
          if (v) vecs.push({ c, v })
        }
      }
      renderedCount = to
    }

    // 首次：只渲高频段
    const t0 = Date.now()
    renderRange(0, Math.min(HEAD_N, charList.length))

    if (!vecs.length) {
      LOG('⚠ 候选字形全部渲染失败（canvas 无效或 document 已卸载）→ 本次不缓存，下次重试')
      return null
    }

    LOG(`候选字形（高频 ${renderedCount} 字）就绪：${vecs.length} 向量，用时 ${Date.now() - t0}ms`)

    const built = {
      cmp,
      candVecs: vecs,
      charList,
      /** 把候选扩到全表（兜底，约 8 秒，只在高频段解不出时调用） */
      expandToFull() {
        if (renderedCount >= charList.length) return vecs
        const t1 = Date.now()
        renderRange(renderedCount, charList.length)
        LOG(`候选字形扩展到全表 ${charList.length} 字：${vecs.length} 向量，追加用时 ${Date.now() - t1}ms`)
        return vecs
      },
      get totalChars() { return charList.length },
      get renderedChars() { return renderedCount },
    }
    candCacheByDoc.set(doc, built)
    return built
  }

  /* ───────────────────── 接口调用 ───────────────────── */

  /**
   * 调本机应用接口。
   *
   * ⚠️⚠️ 关键（2026-10-24 用户报「找不到本地学习通学伴」的真正原因）：
   * 内容脚本住在学习通页面里（mooc1.chaoxing.com），直接 fetch 127.0.0.1:39517
   * 属于**跨源请求，会被 CORS 拦掉**，表现为瞬间 `Failed to fetch`（不是超时）。
   * 即使应用好好开着、Node 直连能通，页面里也一定失败。
   *
   * 正确做法（沿用 ask-panel.js 已验证的方案）：
   *   ① 首选让 **background service worker 代发** —— 它有 host_permissions
   *     （manifest 里声明了 http://127.0.0.1/*），不受 CORS 限制；
   *   ② 直连仅作为兜底（有些环境允许）。
   * 这正是「扩展插件和本地应用绑定」的实际含义：靠 background 做桥梁。
   *
   * 另一条同样重要：**异常不外抛**，一律转成 { status:0, body:null, netError }。
   * 因为 fetch 失败会抛 TypeError，它会从 ensureLog 一路冒泡到 tick 的 catch，
   * 导致 noteFailure 根本不执行、退避永不生效 → 每秒重试刷屏。
   */
  async function apiPost(pathname, payload, timeoutMs = 60000) {
    const url = CFG.apiBase + pathname

    // ① 首选：background 代发（不受 CORS 限制）
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await Promise.race([
          chrome.runtime.sendMessage({
            type: 'studybuddy:fetch',
            url,
            method: 'POST',
            body: payload,
            timeoutMs,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('background 代理超时')), timeoutMs + 3000)),
        ])
        if (r && typeof r === 'object') {
          // background 失败时返回 { ok:false, error }，统一包装成 netError
          if (r.ok === false && !r.error) {
            return { status: 0, body: null, netError: 'background 代发失败' }
          }
          if (r.error && r.ok === false) {
            return { status: 0, body: null, netError: String(r.error) }
          }
          return { status: 200, body: r, viaBackground: true }
        }
      }
    } catch (e) {
      // 落到 ② 直连兜底
      LOG('background 代发失败，尝试直连：', e?.message)
    }

    // ② 兜底：直连（跨源时大概率被 CORS 拦，属预期）
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
      let j = null
      try { j = await r.json() } catch { j = null }
      return { status: r.status, body: j }
    } catch (e) {
      return { status: 0, body: null, netError: String(e?.message || e) }
    }
  }

  async function apiGet(pathname, timeoutMs = 15000) {
    const url = CFG.apiBase + pathname

    // ① 首选：background 代发
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await Promise.race([
          chrome.runtime.sendMessage({
            type: 'studybuddy:fetch',
            url,
            method: 'GET',
            timeoutMs,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('background 代理超时')), timeoutMs + 3000)),
        ])
        if (r && typeof r === 'object') {
          if (r.error && r.ok === false) {
            return { status: 0, body: null, netError: String(r.error) }
          }
          return { status: 200, body: r, viaBackground: true }
        }
      }
    } catch (e) {
      LOG('background 代发失败，尝试直连：', e?.message)
    }

    // ② 兜底：直连
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      let j = null
      try { j = await r.json() } catch { j = null }
      return { status: r.status, body: j }
    } catch (e) {
      return { status: 0, body: null, netError: String(e?.message || e) }
    }
  }

  /* 导出给后续模块 */
  window.__sbPilotCore = {
    CFG, isOn, setOn, sleep, visible, txt, flash, diag,
    cardsDoc, videoDoc, findVideo, currentAttachTitle,
    currentChapter, attachState, attachTabs, clickAttachByKeyword,
    obfCharset, decodeField, buildCandidates, makeGlyphCmp,
    // 确定性解码（2026-10-24）：字体字形 MD5 → 固定映射表，100% 确定
    extractFontBase64, b64ToBytes, sbMd5, decodeByFontMap, buildFontCtx,
    apiPost, apiGet, LOG, LS_SUBMITTED,
  }
  LOG('核心模块已加载')
})()
