/**
 * 学习通学伴 · 渲染层
 *
 * 关键交互（对应 docx 里的要求）：
 *   · 左栏会话列表按「今天 / 昨天 / 7 天内 / 更早」分组，模仿 DeepSeek 网页版
 *   · 新对话默认名「新对话」，首次抓取成功后自动改成课程名
 *   · 输入框下方两个胶囊按钮：「课程日志」（替代深度思考/智能搜索）
 *   · 点「课程日志」先弹浏览器选择，用户自己决定抓哪个
 *   · 抓取过程以「思考过程」形式逐条显示，完成后提示已存本地
 */
const api = window.studyBuddy

/* ───────────── 状态 ───────────── */

const state = {
  chats: [],
  activeId: null,
  settings: null,
  messages: [],
  busy: false,
  captureStage: null,
  selectedBrowser: null,
  browsers: [],
  image: null,
  logIndex: {},   // file → 日志元数据（给历史卡片兜底课程名）
}

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
/** 从学习通页面 URL 里取 chapterId（每节课的唯一号） */
const chapterIdOfUrl = (u) => (String(u || '').match(/[?&]chapterId=(\d+)/) || [])[1] || ''

/**
 * 把模型回答排得好看一点。
 *
 * 用户 2026-10-22 反馈：「AI 的回答不要加那么多标点符号比如 * #，不美观；
 * 每段文字后面有时间戳就换行，不然都堆在一起」。
 * 这里做三件事：① 转义 HTML；② 把 **粗体** / ## 标题 / - 列表 变成真正的排版；
 * ③ 时间戳后面紧跟内容时，在时间戳处断行。
 */
function renderRich(text) {
  let s = String(text == null ? '' : text)
  // 时间戳后直接接内容 → 断开（时间戳留在上一行末尾）
  // 支持三种写法：[07:01]、[07:01]-[08:12]、（[07:01]-[08:12]）
  s = s.replace(/(（?\[\d{1,2}:\d{2}(?::\d{2})?\]\s*[-–~]\s*\[\d{1,2}:\d{2}(?::\d{2})?\]）?|（?\[\d{1,2}:\d{2}(?::\d{2})?\]）?)(?=[^\s，。；、）\]\n\-–~])/g, '$1\n')
  // 先转义，再插标签（顺序不能颠倒）
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/^\s*#{1,6}\s+(.+)$/gm, '<div class="rt-h">$1</div>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  // 行首的项目符号 / 编号统一成一种干净的行：符号本身去掉（用户嫌 • 1. 这些太多），
  // 层级交给 CSS 的缩进体现
  s = s.replace(/^[ \t]*(?:[•·▪◦∙*\-–—]|\d+[.、)])\s+(.+)$/gm, '<div class="rt-li">$1</div>')
  s = s.replace(/^\s*-{3,}\s*$/gm, '')
  // 列表项之间不要空行，正文里的连续空行最多留一个
  s = s.replace(/(<\/div>)\n+(?=<div class="rt-li">)/g, '$1')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

/* ───────────── 左侧列表 ───────────── */

function groupOf(ts) {
  const now = new Date()
  const d = new Date(ts || 0)
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= day0) return '今天'
  if (t >= day0 - 86400000) return '昨天'
  if (t >= day0 - 7 * 86400000) return '7 天内'
  return '更早'
}

function renderChatList() {
  const box = $('#chat-list')
  box.textContent = ''

  const groups = new Map()
  for (const c of state.chats) {
    const g = groupOf(c.updatedAt)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(c)
  }

  const order = ['今天', '昨天', '7 天内', '更早']
  for (const g of order) {
    const items = groups.get(g)
    if (!items || !items.length) continue
    const wrap = el('div', 'chat-group')
    const title = el('div', 'chat-group-title')
    title.appendChild(el('span', null, g))
    wrap.appendChild(title)

    for (const c of items) {
      const row = el('div', 'chat-item' + (c.id === state.activeId ? ' active' : ''))
      row.appendChild(el('span', null, '💬'))
      row.appendChild(el('span', 'name', c.title || '新对话'))
      const del = el('button', 'del', '×')
      del.title = '删除这个对话'
      del.onclick = async (e) => {
        e.stopPropagation()
        await api.chats.delete({ id: c.id })
        if (state.activeId === c.id) {
          state.activeId = null
          state.messages = []
        }
        await refreshChats()
        renderThread()
      }
      row.appendChild(del)
      row.onclick = () => openChat(c.id)
      wrap.appendChild(row)
    }
    box.appendChild(wrap)
  }

  if (!state.chats.length) {
    box.appendChild(el('div', 'chat-group-title', '还没有对话，点上面「开启新对话」'))
  }
}

async function refreshChats() {
  state.chats = await api.chats.list()
  renderChatList()
}

/* ───────────── 对话区 ───────────── */

function renderThread() {
  const thread = $('#thread')
  const hero = $('#hero')
  thread.textContent = ''

  const chat = state.chats.find((c) => c.id === state.activeId)
  $('#top-title').textContent = chat ? (chat.title || '新对话') : '新对话'

  if (!state.messages.length) {
    hero.hidden = false
    return
  }
  hero.hidden = true

  for (const m of state.messages) {
    thread.appendChild(renderMessage(m))
  }
  scrollToBottom()
}

function renderMessage(m) {
  const wrap = el('div', 'msg ' + (m.role === 'assistant' ? 'assistant' : 'user'))

  const who = el('div', 'who')
  who.appendChild(el('span', null, m.role === 'assistant' ? '🐳 学伴' : '🧑 我'))
  if (m.at) who.appendChild(el('span', null, new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })))
  wrap.appendChild(who)

  if (m.kind === 'course-log') {
    wrap.appendChild(renderLogCard(m))
  } else {
    const bubble = el('div', 'bubble', '')
    bubble.innerHTML = renderRich(m.content || '')
    wrap.appendChild(bubble)
    // 这一轮依据了哪几篇课：显示出来，并给一个「打开原稿」的入口
    if (m.role === 'assistant' && Array.isArray(m.context) && m.context.length) {
      const row = el('div', 'ctx-row')
      row.appendChild(el('span', null, '本轮依据'))
      for (const c of m.context) {
        const item = el('span', 'ctx-item')
        item.appendChild(el('span', null, '《' + (c.title || '?') + '》'))
        if (c.file) {
          const btn = el('button', 'ctx-open', '原稿')
          btn.type = 'button'
          btn.title = '打开 ' + c.file
          btn.addEventListener('click', () => api.shell.openPath(c.file))
          item.appendChild(btn)
        }
        row.appendChild(item)
      }
      wrap.appendChild(row)
    }
  }
  return wrap
}

function fmtSize(n) {
  if (!n) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

function fmtDur(sec) {
  const t = Math.max(0, Math.round(sec || 0))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

function renderLogCard(m) {
  const card = el('div', 'log-card')
  const add = (k, v) => {
    const r = el('div', 'row')
    r.appendChild(el('span', 'k', k))
    const vv = el('span', 'v', v)
    vv.title = v
    r.appendChild(vv)
    card.appendChild(r)
  }
  // 历史消息里没有 courseName（早期抓的），用日志索引兜底，补写后立刻能显示
  const fallbackCourse = (!m.courseName && m.file && state.logIndex && state.logIndex[m.file])
    ? state.logIndex[m.file].course : ''
  const courseName = m.courseName || fallbackCourse
  if (courseName) {
    add('课程', courseName)
    add('章节', m.lessonName || '未命名')
  } else {
    add('课程', m.lessonName || '未命名')
  }
  add('时长', fmtDur(m.duration))
  add('转写', `${m.segmentCount || 0} 段 / ${m.chars || 0} 字`)
  add('状态', m.reused ? `♻️ 本地已有，直接复用（原抓于 ${m.capturedAt || '之前'})` : '✅ 本次新抓取')
  add('保存位置', m.file || '')
  if (m.note) add('备注', m.note)

  const open = el('button', 'open', '📂 打开日志文件')
  open.onclick = () => api.shell.openPath(m.file)
  card.appendChild(open)
  return card
}

function scrollToBottom() {
  const s = $('#scroll')
  s.scrollTop = s.scrollHeight
}

/* ───────────── 打开/新建会话 ───────────── */

async function openChat(id) {
  state.activeId = id
  state.chats = await api.chats.list()
  // 从主进程读取完整消息（列表接口只给摘要）
  const detail = await api.chats.get({ id })
  state.messages = detail && detail.messages ? detail.messages : []
  renderChatList()
  renderThread()
}

async function newChat() {
  const c = await api.chats.create({})
  await refreshChats()
  state.activeId = c.id
  state.messages = []
  renderChatList()
  renderThread()
  $('#input').focus()
  return c
}

/* ───────────── 图片（识图答疑） ───────────── */

const MAX_EDGE = 1600                 // 长边压到这个像素以内，省流量也省 token
const MAX_BYTES = 4 * 1024 * 1024     // 超过就重新编码成 jpeg

/** 把 state.image 反映到输入框上方的预览区 */
function renderAttach() {
  const row = $('#attach')
  if (!row) return
  const img = state.image
  if (!img) {
    row.hidden = true
    try { $('#attach-thumb').removeAttribute('src') } catch { /* ignore */ }
    updateSendBtn()
    return
  }
  row.hidden = false
  $('#attach-thumb').src = img.dataUrl
  const kb = Math.round((img.dataUrl.length * 0.75) / 1024)
  $('#attach-name').textContent = `${img.name} · ${kb} KB`
  updateSendBtn()
}

function clearImage() {
  state.image = null
  renderAttach()
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('图片解码失败'))
    im.src = src
  })
}

/** 长边超过 MAX_EDGE 或体积过大时缩图并转 jpeg */
async function shrinkImage(dataUrl) {
  const im = await loadImg(dataUrl)
  const long = Math.max(im.width, im.height)
  if (long <= MAX_EDGE && dataUrl.length <= MAX_BYTES) return dataUrl
  const scale = Math.min(1, MAX_EDGE / long)
  const w = Math.max(1, Math.round(im.width * scale))
  const h = Math.max(1, Math.round(im.height * scale))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#fff'            // 透明 png 转 jpeg 会变黑底，先铺白
  g.fillRect(0, 0, w, h)
  g.drawImage(im, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.86)
}

async function useImageFile(file) {
  if (!file) return
  if (!/^image\//.test(file.type || '')) throw new Error('这不是图片文件')
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
  state.image = { dataUrl: await shrinkImage(dataUrl), name: file.name || '剪贴板图片' }
  renderAttach()
}

function pickImageFile() {
  const inp = $('#file-image')
  if (!inp) return
  inp.value = ''
  inp.click()
}

/* ───────────── 发送消息 ───────────── */

async function sendMessage() {
  const input = $('#input')
  const text = input.value.trim()
  if ((!text && !state.image) || state.busy) return

  if (!state.activeId) await newChat()

  const image = state.image ? state.image.dataUrl : null
  const msg = { role: 'user', content: text || '看看这张图', at: Date.now() }
  if (image) msg.hasImage = true      // 只留标记，图片本身不进 chats.json（太大）
  // 用户在下拉框里指定了课程时一起带上：主进程会只用这一篇，不再自动挑（2026-10-22 新增）
  const forceCourse = $('#course-select')?.value || ''
  state.messages.push(msg)
  await api.chats.append({ id: state.activeId, message: msg })
  input.value = ''
  state.image = null
  renderAttach()
  autoGrow()
  renderThread()

  await askAI(image, forceCourse)
}

/**
 * 刷新「指定课程」下拉框：列出本机所有课程日志（chapterId 为值）。
 * 选定后 ai:chat 只带这一篇，不再自动挑课。
 */
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function refreshCourseOptions() {
  const sel = $('#course-select')
  if (!sel) return
  let logs = []
  try {
    const r = await api.logs.list()
    logs = r.logs || []
  } catch { /* ignore */ }
  // 记住 file → 元数据，历史日志卡片缺课程名时用它兜底
  state.logIndex = {}
  for (const l of logs) if (l.file) state.logIndex[l.file] = l
  const keep = sel.value
  const opts = ['<option value="">自动判断课程</option>']
  for (const l of logs) {
    // 课程名（总标题）在前，章节名在后：同一门课章节多、名字相近时靠它区分
    const label = l.course
      ? `《${l.course}》· ${l.title}${l.duration ? ' · ' + l.duration : ''}`
      : `《${l.title}》${l.duration ? ' · ' + l.duration : ''}`
    opts.push(`<option value="${l.chapterId || ''}">${escapeHtml(label)}</option>`)
  }
  sel.innerHTML = opts.join('')
  if (keep && logs.some((l) => String(l.chapterId) === String(keep))) sel.value = keep
  sel.closest('.course-pick')?.classList.toggle('picked', Boolean(sel.value))
}

/**
 * 请求 AI。
 *
 * 课程上下文不在这里拼了 —— 由主进程 buildCourseContext 统一处理：
 * 它会把「本机所有课程日志的清单」+「最多 2 篇相关正文」一起交给模型，
 * 所以任何对话都能问到所有已抓的课，而不是只认本对话里那一篇（用户 2026-10-22 要求）。
 */
async function askAI(image, forceCourse = '') {
  state.busy = true
  updateSendBtn()

  const payload = []
  for (const m of state.messages) {
    if (m.kind === 'course-log') continue
    payload.push({ role: m.role, content: m.content })
  }

  const holder = el('div', 'msg assistant')
  const who = el('div', 'who')
  who.appendChild(el('span', null, '🐳 学伴'))
  if (image) who.appendChild(el('span', 'who-tag', '识图'))
  holder.appendChild(who)
  const bubble = el('div', 'bubble', '')
  holder.appendChild(bubble)
  if (image) bubble.textContent = '🖼 正在识别图片里的文字，再逐题核对课程内容（大约 30～60 秒）…'
  $('#thread').appendChild(holder)
  scrollToBottom()

  let acc = ''
  const off = api.ai.onEvent((e) => {
    if (e.type === 'delta') {
      acc += e.text
      bubble.innerHTML = renderRich(acc)
      scrollToBottom()
    }
  })

  try {
    const r = await api.ai.chat({ chatId: state.activeId, messages: payload, image: image || undefined, forceCourse: forceCourse || undefined })
    off()
    if (!r.ok) {
      bubble.textContent = `⚠ ${r.error}`
      bubble.style.color = 'var(--err)'
      return
    }
    const final = r.reply || acc
    bubble.innerHTML = renderRich(final)
    const m = { role: 'assistant', content: final, at: Date.now() }
    if (Array.isArray(r.context) && r.context.length) m.context = r.context
    state.messages.push(m)
    await api.chats.append({ id: state.activeId, message: m })
    await refreshChats()
    renderChatList()
    renderThread() // 重建一次，让「本轮依据 / 打开原稿」那行出现
  } catch (e) {
    off()
    bubble.textContent = `⚠ ${e?.message || e}`
    bubble.style.color = 'var(--err)'
  } finally {
    state.busy = false
    updateSendBtn()
  }
}

function updateSendBtn() {
  const btn = $('#btn-send')
  if (!btn) return
  btn.disabled = state.busy || (!$('#input').value.trim() && !state.image)
}

/* ───────────── 课程日志：浏览器/页面选择 ───────────── */

/**
 * 打开选择弹窗。
 * 优先走浏览器扩展：列出扩展看到的课程页，非播放页明确标注「不可抓取」，
 * 但**不关闭弹窗**，用户可以继续换一个（用户明确要求过这一点）。
 */
async function openBrowserPicker() {
  state.selectedBrowser = null
  $('#modal-browser').hidden = false
  $('#browser-list').textContent = '加载中…'
  $('#btn-start-capture').disabled = true
  await loadBrowsers()
}

async function loadBrowsers() {
  const box = $('#browser-list')
  box.textContent = ''

  // ① 先问扩展
  let extState = null
  try { extState = await api.ext.status() } catch { extState = null }

  if (extState && extState.connected) {
    const tabs = extState.tabs || []
    const head = el('div', 'modal-sub', `已连接浏览器插件（端口 ${extState.port}），它能读取你日常 Edge 里的页面。`)
    box.appendChild(head)

    // 已抓过的课：按 chapterId 认，列表里直接标出来，避免重复下载（用户 2026-10-22 要求）
    const captured = {}
    try {
      const lr = await api.logs.list()
      for (const l of (lr?.logs || [])) if (l.chapterId) captured[l.chapterId] = l
    } catch { /* 读不到就当作都没抓过 */ }

    if (!tabs.length) {
      box.appendChild(el('div', 'modal-sub', '插件还没看到学习通页面。请在 Edge 里打开学习通的任意一节视频课，然后点「刷新列表」。'))
    }

    // 记住第一个「可抓取」条目：列表出来后自动选中它。
    // 之前必须手动点一下条目，「开始抓取」才会从禁用变可点；用户直接点按钮没反应，
    // 会以为「抓不到课程内容」（2026-10-22 用户反馈）。
    let firstReady = null

    for (const t of tabs) {
      const isLesson = Boolean(t.looksLesson)
      const row = el('div', 'browser-row' + (isLesson ? '' : ' disabled'))
      row.appendChild(el('span', 'icon', isLesson ? '🎬' : '📄'))

      const meta = el('div', 'meta')
      meta.appendChild(el('div', 'nm', String(t.title || '(无标题)').slice(0, 50)))
      const u = el('div', 'dsc', String(t.url || '').slice(0, 90))
      u.title = t.url || ''
      meta.appendChild(u)
      row.appendChild(meta)

      if (isLesson) {
        const cid = chapterIdOfUrl(t.url)
        const hit = cid ? captured[cid] : null
        if (hit) {
          const tag = el('span', 'tag done', '已抓过')
          tag.title = `《${hit.title}》· ${hit.duration || '?'} · ${hit.segments || '?'} 段\n抓于 ${hit.time || '未知'}\n文件：${hit.file}\n（勾着下面「直接复用」时，点开始抓取不会重新下载）`
          row.appendChild(tag)
        }
        row.appendChild(el('span', 'tag ready', '可抓取'))
        row.onclick = () => {
          state.selectedBrowser = { kind: 'extension', tabId: t.id, label: t.title }
          for (const o of box.querySelectorAll('.browser-row')) o.classList.remove('sel')
          row.classList.add('sel')
          $('#btn-start-capture').disabled = false
          const tip = box.querySelector('.pick-error')
          if (tip) tip.remove()
        }
        if (!firstReady) firstReady = row
      } else {
        row.appendChild(el('span', 'tag notready', '非网课页面'))
        row.onclick = () => {
          // 用户明确要求：非网课页面要给提示、拒绝抓取，但不要关掉选择窗口
          const tip = box.querySelector('.pick-error') || el('div', 'modal-sub pick-error')
          tip.textContent = '这个页面不是网课播放页，抓不到课程内容。请在 Edge 里进入某节课的播放页（视频能播放的那个），再点「刷新列表」。'
          tip.style.color = 'var(--warn)'
          box.appendChild(tip)
          $('#btn-start-capture').disabled = true
          state.selectedBrowser = null
          for (const o of box.querySelectorAll('.browser-row')) o.classList.remove('sel')
        }
      }
      box.appendChild(row)
    }

    box.appendChild(el('div', 'modal-sub', '提示：插件只读取页面结构（视频在哪），课程内容下载与转写都在你本机完成。'))

    // 有可抓取的课程页时自动选中第一个，省掉「必须先点一下条目」这一步。
    if (firstReady && !state.selectedBrowser) firstReady.onclick()

    return
  }

  // ② 扩展没连上时，退回老路（专用浏览器 / 调试端口）
  box.appendChild(el('div', 'modal-sub', '未检测到浏览器插件。你可以先装插件（推荐），或临时用下面的专用浏览器方式。'))

  const r = await api.browsers.list()
  state.browsers = r.browsers || []

  if (!r.ok) {
    box.appendChild(el('div', 'modal-sub', `读取浏览器列表失败：${r.error}`))
    return
  }
  if (!state.browsers.length) {
    box.appendChild(el('div', 'modal-sub', '没有找到可用的浏览器。'))
    return
  }

  for (const b of state.browsers) {
    const row = el('div', 'browser-row' + (b.ready ? '' : ' disabled'))
    row.appendChild(el('span', 'icon', b.dedicated ? '🐳' : '🌐'))

    const meta = el('div', 'meta')
    meta.appendChild(el('div', 'nm', b.label))
    meta.appendChild(el('div', 'dsc', b.detail))
    row.appendChild(meta)

    if (!b.ready) {
      row.appendChild(el('span', 'tag notready', '未启动'))
      if (b.dedicated) {
        const btn = el('button', 'btn', '启动专用浏览器')
        btn.style.flex = 'none'
        btn.style.fontSize = '12px'
        btn.style.padding = '5px 10px'
        btn.onclick = async (e) => {
          e.stopPropagation()
          btn.disabled = true
          btn.textContent = '启动中…'
          const rr = await api.browsers.launch({ browserId: 'edge' })
          btn.disabled = false
          if (!rr.ok) { btn.textContent = '启动专用浏览器'; alert('启动失败：' + rr.error); return }
          await loadBrowsers()
        }
        row.appendChild(btn)
      }
      box.appendChild(row)
      continue
    }

    row.appendChild(el('span', 'tag ready', '可抓取'))
    row.onclick = () => {
      state.selectedBrowser = { kind: 'cdp', id: b.id, label: b.label }
      for (const o of box.querySelectorAll('.browser-row')) o.classList.remove('sel')
      row.classList.add('sel')
      $('#btn-start-capture').disabled = false
    }
    box.appendChild(row)
  }
}

/* ───────────── 课程日志：抓取 ───────────── */

async function startCapture() {
  if (!state.selectedBrowser) return
  $('#modal-browser').hidden = true

  if (!state.activeId) await newChat()
  const chatId = state.activeId

  state.busy = true
  $('#btn-log').disabled = true
  updateSendBtn()

  // 立刻插入一条「思考过程」消息，让用户看到 AI 正在做什么
  const holder = el('div', 'msg assistant')
  const who = el('div', 'who')
  who.appendChild(el('span', null, '🐳 学伴'))
  who.appendChild(el('span', null, '正在分析课程…'))
  holder.appendChild(who)

  const think = el('div', 'thinking')
  holder.appendChild(think)
  const bubble = el('div', 'bubble', '')
  holder.appendChild(bubble)

  $('#hero').hidden = true
  $('#thread').appendChild(holder)
  scrollToBottom()

  // 同一个 key 的步骤只占一行、原地更新（例如转写进度），否则会刷出一长串
  const stepIndex = new Map()
  const addStep = (text, kind, key) => {
    if (key && stepIndex.has(key)) {
      const row = stepIndex.get(key)
      const label = row.lastChild
      if (label) label.textContent = text
      scrollToBottom()
      return
    }
    const step = el('div', 'step')
    step.appendChild(el('span', 'dot' + (kind ? ' ' + kind : '')))
    step.appendChild(el('span', null, text))
    think.appendChild(step)
    if (key) stepIndex.set(key, step)
    scrollToBottom()
  }

  const off = api.capture.onEvent((e) => {
    if (e.type === 'stage') {
      const kind = e.stage === 'error' ? 'err' : (e.stage === 'saved' || e.stage === 'done' ? 'done' : '')
      addStep(e.text, kind, e.stage === 'transcribe' ? 'transcribe' : null)
    }
  })

  try {
    addStep(`已选择：${state.selectedBrowser.label}`, '')
    const payload = { chatId }
    if (state.selectedBrowser.kind === 'extension') {
      payload.tabId = state.selectedBrowser.tabId
      payload.via = 'extension'
      payload.reuse = $('#opt-reuse') ? $('#opt-reuse').checked : true
    } else {
      payload.browserId = state.selectedBrowser.id
      payload.via = 'cdp'
    }
    const r = await api.capture.start(payload)
    off()

    if (!r.ok) {
      addStep(`失败：${r.error}`, 'err')
      bubble.textContent = '这次没有抓到内容。'
      return
    }

    // 把课程日志作为一条特殊消息存进会话
    const logMsg = {
      role: 'assistant',
      kind: 'course-log',
      content: r.reused
        ? `本地已有《${r.lessonName}》：${r.segmentCount} 段 / ${r.chars} 字（直接复用，没有重新下载）`
        : `已抓取《${r.lessonName}》：${r.segmentCount} 段 / ${r.chars} 字`,
      reused: Boolean(r.reused),
      capturedAt: r.capturedAt || '',
      courseName: r.courseName || '',
      lessonName: r.lessonName,
      duration: r.duration,
      segmentCount: r.segmentCount,
      chars: r.chars,
      file: r.file,
      transcript: r.transcript,
      at: Date.now(),
    }
    state.messages.push(logMsg)
    await api.chats.append({ id: chatId, message: logMsg })
    await api.chats.markCapture({ id: chatId, lesson: { lessonName: r.lessonName, file: r.file } })

    await refreshChats()
    state.activeId = chatId
    renderChatList()
    renderThread()
    // 新抓了课 → 让「指定课程」下拉框里立刻能选到它
    await refreshCourseOptions()
    // 注意：renderThread() 会重建整个消息列表，上面那个 bubble 节点已经脱离文档，
    // 所以成功文案必须写进 logMsg.content（见上），不能再往 bubble 里塞。
  } catch (e) {
    off()
    addStep(`异常：${e?.message || e}`, 'err')
  } finally {
    state.busy = false
    $('#btn-log').disabled = false
    updateSendBtn()
  }
}

/* ───────────── 设置 ───────────── */

async function openSettings() {
  $('#modal-settings').hidden = false
  const s = state.settings || {}
  $('#set-base').value = s.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  $('#set-model').value = s.model || 'qwen-plus'
  $('#set-vision-model').value = s.visionModel || 'qwen3-vl-plus'
  $('#set-vision-base').value = s.visionBaseUrl || ''
  $('#set-vision-key').value = s.visionApiKey || ''
  /* ★ 2026-10-25：转码速度 + CPU/GPU 并行开关 */
  try { syncSpeedUI(s) } catch { /* ignore */ }
  /* 打开设置时顺便检测 GPU，决定「硬件加速」相关控件是否可用 */
  setTimeout(() => { try { checkGpuStatus(true) } catch { /* ignore */ } }, 300)
    /* 硬件加速设置（2026-10-25） */
    try { syncAccelUI(s) } catch { /* ignore */ }
  $('#set-key').value = s.apiKey || ''
  const out = $('#test-result')
  if (out) {
    out.className = 'test-result'
    out.textContent = '用上面填的地址 / 模型名 / Key 真实请求一次，不用先保存'
  }
  checkTranscribe()
}

/* ───────────── 转写环境（faster-whisper） ───────────── */

async function checkTranscribe() {
  const el = $('#transcribe-status')
  if (!el) return null
  el.className = 'test-result testing'
  el.textContent = '正在检查本机环境…'
  try {
    const s = await api.transcribe.status()
    if (s.ok) {
      el.className = 'test-result ok'
      el.textContent = `✅ 已就绪 · faster-whisper ${s.version}`
      return s
    }
    const miss = []
    if (!s.py) miss.push('虚拟环境')
    else if (!s.version) miss.push('faster-whisper 库')
    if (!s.model) miss.push('识别模型')
    if (!s.script) miss.push('transcribe.py')
    el.className = 'test-result bad'
    el.textContent = `❌ 还没装好（缺：${miss.join('、') || '未知'}）—— 点左边的按钮一键安装`
    return s
  } catch (e) {
    el.className = 'test-result bad'
    el.textContent = '检查失败：' + (e?.message || e)
    return null
  }
}

function setupLogPush(line) {
  const log = $('#setup-log')
  if (!log) return
  log.textContent += line + '\n'
  log.scrollTop = log.scrollHeight
}

async function runSetupTranscribe() {
  const res = $('#setup-result')
  const btn = $('#btn-setup-transcribe')
  $('#modal-setup').hidden = false
  const log = $('#setup-log')
  if (log) log.textContent = ''
  if (res) { res.className = 'test-result testing'; res.textContent = '正在启动安装…' }
  if (btn) btn.disabled = true
  try {
    const r = await api.transcribe.setup()
    if (r.ok) {
      if (res) { res.className = 'test-result ok'; res.textContent = '✅ 安装完成，已经可以抓取课程了' }
      setupLogPush('\n=== 安装完成 ===')
      await checkTranscribe()
    } else {
      const msg = r.error ? r.error : `脚本退出码 ${r.code}`
      if (res) { res.className = 'test-result bad'; res.textContent = '❌ 安装失败：' + msg }
      setupLogPush(`\n=== 安装失败：${msg} ===`)
    }
  } catch (e) {
    if (res) { res.className = 'test-result bad'; res.textContent = '❌ ' + (e?.message || e) }
  } finally {
    if (btn) btn.disabled = false
  }
}

async function saveSettings() {
  state.settings = await api.settings.save({
    baseUrl: $('#set-base').value.trim(),
    model: $('#set-model').value.trim(),
    visionModel: $('#set-vision-model').value.trim() || 'qwen3-vl-plus',
  visionBaseUrl: $('#set-vision-base').value.trim(),
  visionApiKey: $('#set-vision-key').value.trim(),

    hardwareAccel: (() => { const el = document.getElementById('set-hwaccel'); return !el || el.checked !== false })(),

    transSpeed: (() => { const r = document.querySelector('input[name="transspeed"]:checked'); return r ? r.value : 'balanced' })(),

    hardwareParallel: (() => { const el = document.getElementById('set-parallel'); return !!(el && el.checked) })(),

    accelMode: (() => { const r = document.querySelector('input[name="accelmode"]:checked'); return r ? r.value : 'auto' })() || 'qwen3-vl-plus',
    apiKey: $('#set-key').value.trim(),
  })
  $('#modal-settings').hidden = true
}

/** 用当前输入框里的值真实请求一次模型接口，不落盘也不依赖已保存的配置 */
async function testApi() {
  const btn = $('#btn-test-api')
  const out = $('#test-result')
  const payload = {
    baseUrl: $('#set-base').value.trim(),
    model: $('#set-model').value.trim(),
    apiKey: $('#set-key').value.trim(),
  }
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '测试中…'
  out.className = 'test-result testing'
  out.textContent = `正在请求 ${payload.baseUrl || '(地址未填)'} …`

  try {
    const r = await api.settings.test(payload)
    if (r.ok) {
      out.className = 'test-result ok'
      out.textContent = `✅ 可用 · 模型 ${r.model} · ${r.ms}ms\n模型回复：${r.reply || '(空)'}`
    } else {
      out.className = 'test-result bad'
      out.textContent = `❌ 失败${r.status ? `（HTTP ${r.status}）` : ''} · ${r.ms}ms\n${r.error || '未知错误'}`
    }
  } catch (e) {
    out.className = 'test-result bad'
    out.textContent = `❌ 测试本身出错：${e?.message || e}`
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

/* ───────────── 全局错误捕获：任何异常都写日志，别静默吞掉 ───────────── */

const logErr = (where, e) => {
  const msg = `[${where}] ${e?.stack || e?.message || e}`
  try { console.error(msg) } catch { /* ignore */ }
  try { window.studyBuddy?.log(msg) } catch { /* ignore */ }
}

window.addEventListener('error', (e) => logErr('window.error', e?.error || e?.message))
window.addEventListener('unhandledrejection', (e) => logErr('unhandledrejection', e?.reason))

/**
 * 安全绑定：每个按钮单独 try，
 * 避免「一个绑不上，后面全部失效」这种连锁失败。
 */
function on(selector, event, handler, label) {
  try {
    const el = document.querySelector(selector)
    if (!el) {
      logErr(`bind ${selector}`, new Error('元素不存在'))
      return false
    }
    el.addEventListener(event, async (ev) => {
      try {
        await handler(ev)
      } catch (err) {
        logErr(`click ${selector}`, err)
        alert(`操作失败：${err?.message || err}`)
      }
    })
    return true
  } catch (err) {
    logErr(`bind ${selector}`, err)
    return false
  }
}

/* ───────────── 事件绑定 ───────────── */

function autoGrow() {
  try {
    const t = $('#input')
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 180) + 'px'
    updateSendBtn()
  } catch (e) {
    logErr('autoGrow', e)
  }
}

/* ───────────── 侧边栏收起/展开（模仿 DSH） ───────────── */

const SIDE_KEY = 'sb.side-collapsed'

function setSideCollapsed(collapsed, save = true) {
  const on = !!collapsed
  document.body.classList.toggle('side-collapsed', on)
  const showBtn = $('#btn-side-show')
  if (showBtn) showBtn.hidden = !on
  if (save) {
    try { localStorage.setItem(SIDE_KEY, on ? '1' : '0') } catch { /* 隐私模式忽略 */ }
  }
}

function bind() {
  const results = []
  results.push(on('#btn-new', 'click', () => newChat(), '新对话'))
  results.push(on('#btn-send', 'click', () => sendMessage(), '发送'))
  results.push(on('#btn-log', 'click', () => openBrowserPicker(), '课程日志'))
  results.push(on('#btn-settings', 'click', () => openSettings(), '设置'))
  results.push(on('#btn-open-logs', 'click', async () => {
    const info = await api.info()
    api.shell.openPath(info.notesDir)
  }, '打开日志目录'))
  results.push(on('#btn-side-hide', 'click', () => setSideCollapsed(true), '收起侧边栏'))
  results.push(on('#btn-side-show', 'click', () => setSideCollapsed(false), '展开侧边栏'))
  results.push(on('#btn-cancel-browser', 'click', () => { $('#modal-browser').hidden = true }, '取消浏览器选择'))
  results.push(on('#btn-refresh', 'click', () => loadBrowsers(), '刷新列表'))
  results.push(on('#btn-start-capture', 'click', () => startCapture(), '开始抓取'))
  results.push(on('#btn-cancel-settings', 'click', () => { $('#modal-settings').hidden = true }, '取消设置'))
  results.push(on('#btn-save-settings', 'click', () => saveSettings(), '保存设置'))
  results.push(on('#btn-test-api', 'click', () => testApi(), '测试 API'))
  results.push(on('#btn-setup-transcribe', 'click', () => runSetupTranscribe(), '安装转写环境'))
  results.push(on('#btn-close-setup', 'click', () => { $('#modal-setup').hidden = true }, '关闭安装窗口'))

  // 安装进度实时显示
  try {
    api.transcribe.onLog((line) => setupLogPush(line))
  } catch (e) {
    logErr('bind transcribe log', e)
  }
  results.push(on('#btn-image', 'click', () => pickImageFile(), '选择图片'))
  results.push(on('#btn-attach-del', 'click', () => clearImage(), '移除图片'))
  results.push(on('#course-select', 'change', () => {
    const sel = $('#course-select')
    sel.closest('.course-pick')?.classList.toggle('picked', Boolean(sel.value))
  }, '指定课程'))
  results.push(on('#file-image', 'change', async (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    try { await useImageFile(f) } catch (err) { logErr('pick image', err); alert(err?.message || err) }
  }, '读取图片文件'))

  // Ctrl+V 直接粘贴截图（用户要求：能少一步就少一步）
  document.addEventListener('paste', async (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile()
        if (f) {
          e.preventDefault()
          try { await useImageFile(f) } catch (err) { logErr('paste image', err) }
        }
        return
      }
    }
  })

  // Ctrl+B 收起/展开侧边栏
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'b') {
      e.preventDefault()
      setSideCollapsed(!document.body.classList.contains('side-collapsed'))
    }
  })

  // 输入框：回车发送
  try {
    const input = $('#input')
    if (input) {
      input.addEventListener('input', autoGrow)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          sendMessage().catch((err) => logErr('enter send', err))
        }
      })
    }
  } catch (e) {
    logErr('bind input', e)
  }

  const okCount = results.filter(Boolean).length
  if (okCount < results.length) {
    logErr('bind', new Error(`只有 ${okCount}/${results.length} 个按钮绑定成功`))
  }
  return okCount
}

/* ───────────── 启动 ───────────── */

/**
 * 自动抓日志的进度显示（用户要求，2026-10-24）。
 *
 * 用户原话：「我想让『[transcribe] 模型加载成功…开始转写…』在应用里同步显示，
 * 不然用户会认为这个应用是多余的没用，最好的是把下载的任务提示也给加进应用
 * 和扩展插件相合作一同显示进度」。
 *
 * 背景：扩展点「一键播放答题」时会自动抓课程日志，之前只在后台写 app.log，
 * 界面零提示 —— 用户看到视频在播但应用毫无动静，以为应用没在工作。
 * 现在把 main.js 广播的 autocapture:event 渲染成界面上的实时进度。
 */
function mountAutoCaptureProgress() {
  /* ★ 2026-10-25 停用：用户要求抓取进度只在对话区以智能体消息呈现，
     不要右侧独立浮动卡片。改为由 mountCaptureInThread 负责。
     这里保留 early return，防止任何残留引用再把面板画出来。 */
  return
  // eslint-disable-next-line no-unreachable
  // 一个固定的浮层区域，避免污染会话记录
  let panel = null
  let rows = null
  const seen = new Map()  // stage → row

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel
    panel = el('div', 'autocapture-panel')
    panel.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:84px', 'width:330px', 'max-height:44vh',
      'overflow:auto', 'z-index:9999', 'padding:10px 12px', 'border-radius:10px',
      'background:rgba(24,27,34,.96)', 'border:1px solid rgba(88,166,255,.35)',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'color:#e8eaed',
      'font:12px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';')

    const head = el('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px'
    const title = el('div', null, '📚 正在自动抓取课程日志')
    title.style.cssText = 'flex:1;font-weight:600;color:#8cc4ff'
    const close = el('span', null, '×')
    close.style.cssText = 'cursor:pointer;color:#9aa0a8;font-size:15px;padding:0 4px'
    close.onclick = () => { try { panel.remove() } catch { /* ignore */ } panel = null }
    head.appendChild(title)
    head.appendChild(close)
    panel.appendChild(head)

    rows = el('div')
    panel.appendChild(rows)
    document.body.appendChild(panel)
    return panel
  }

  function addRow(text, kind, key) {
    ensurePanel()
    if (key && seen.has(key)) {
      const row = seen.get(key)
      const label = row.lastChild
      if (label) label.textContent = text
      return
    }
    const row = el('div')
    row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;margin:3px 0'
    const dot = el('span', null, '•')
    dot.style.cssText = 'color:' + (kind === 'done' ? '#63cf7f' : kind === 'err' ? '#ff6b6b' : '#8cc4ff') + ';flex:0 0 auto'
    const label = el('span', null, text)
    label.style.cssText = 'flex:1;word-break:break-word'
    row.appendChild(dot)
    row.appendChild(label)
    rows.appendChild(row)
    if (key) seen.set(key, row)
    try { panel.scrollTop = panel.scrollHeight } catch { /* ignore */ }
  }

  function finish(ok, text) {
    ensurePanel()
    addRow(text, ok ? 'done' : 'err', null)
    const head = panel.querySelector('div')
    if (head && head.firstChild) head.firstChild.textContent = ok ? '✅ 课程日志已就绪' : '❌ 抓取失败'
    // 成功 6 秒后自动收起
    setTimeout(() => {
      try { if (panel) { panel.style.opacity = '0'; setTimeout(() => { try { panel && panel.remove() } catch { /* ignore */ } panel = null }, 300) } } catch { /* ignore */ }
    }, ok ? 6000 : 15000)
  }

  try {
    api.autocapture.onEvent((e) => {
      const type = e && e.type
      if (type === 'start') {
        addRow(e.text || '扩展已触发自动抓取…', '', 'start')
      } else if (type === 'stage') {
        const st = e.stage || 'stage'
        const seg = e.segments ? `（已转写 ${e.segments} 段）` : ''
        // 转写类进度原地更新，避免刷屏
        const key = (st === 'transcribe' || st === 'download') ? st : null
        addRow((e.text || st) + seg, st === 'error' ? 'err' : '', key)
      } else if (type === 'done') {
        finish(true, e.text || `课程日志已就绪：《${e.title || ''}》${e.segments ? `（${e.segments} 段）` : ''}`)
      } else if (type === 'failed') {
        finish(false, e.text || ('抓取失败：' + (e.error || '未知错误')))
      }
    })
  } catch (err) {
    logErr('bind autocapture', err)
  }
}

/**
 * 在对话区渲染「抓取课程日志」的过程与结果（2026-10-25 新增）
 *
 * 动机（用户原话）：
 *   「应用端的展示抓取过程不用单开一个卡片在输入框旁边，
 *    直接按智能体的回答展示出来，并做出图1的卡片风格提示在对话区，
 *    不然用户会认为我们什么都没做会以为我们卡住了」
 *
 * 做法：
 *   · 抓取开始 → 在对话区插入一条 assistant 气泡
 *   · 过程中 → 气泡内逐行追加/更新进度（像智能体在实时汇报）
 *   · 完成 → 气泡内容替换成结构化卡片（与扩展侧的抓取完成卡同款风格）
 */
function mountCaptureInThread() {
  let card = null        // 当前正在更新的气泡容器
  let body = null        // 气泡内的内容区
  const seen = new Map() // stage → 行元素

  function threadEl() {
    return document.getElementById('thread') || document.querySelector('.thread') || document.getElementById('messages')
  }

  function ensureCard() {
    /* ★ 2026-10-25 修：原用 document.body.contains(card) 判断卡片是否还有效，
     *   但该判断在某些情况下为 false（如 document 未就绪、或卡片刚被移除），
     *   导致每次收到事件都重建卡片 → 进度行全部丢失、每行重复出现。
     *   改用更直接的判断：卡片存在 且 仍有 parentNode。 */
    if (card && card.parentNode) return card
    const th = threadEl()
    if (!th) return null

    card = el('div', 'msg assistant')
    const bubble = el('div', 'bubble capture-bubble')
    bubble.style.cssText = 'max-width:min(560px,92%);padding:10px 12px'

    // 标题行
    const head = el('div')
    head.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:6px'
    const ico = el('span', null, '📚')
    ico.style.cssText = 'font-size:14px'
    const title = el('span', null, '正在抓取这一节的课程日志')
    title.style.cssText = 'font-weight:600;color:#8cc4ff;font-size:13px'
    const close = el('span', null, '×')
    close.style.cssText = 'margin-left:auto;cursor:pointer;color:#9aa0a8;font-size:15px;padding:0 4px'
    close.onclick = () => { try { card.remove() } catch { /* ignore */ } card = null }
    head.appendChild(ico); head.appendChild(title); head.appendChild(close)

    body = el('div')
    body.style.cssText = 'font-size:12.5px;line-height:1.65;color:#b8bec6'

    bubble.appendChild(head)
    bubble.appendChild(body)
    card.appendChild(bubble)
    th.appendChild(card)
    try { th.scrollTop = th.scrollHeight } catch { /* ignore */ }
    return card
  }

  function line(text, kind, key) {
    if (!ensureCard()) return
    if (key && seen.has(key)) {
      const row = seen.get(key)
      const lab = row.lastChild
      if (lab) lab.textContent = text
      try {
        const th = threadEl()
        if (th) th.scrollTop = th.scrollHeight
      } catch { /* ignore */ }
      return
    }
    const row = el('div')
    row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;margin:2px 0'
    const dot = el('span', null, '•')
    dot.style.cssText = 'flex:0 0 auto;color:' + (kind === 'done' ? '#63cf7f' : kind === 'err' ? '#ff6b6b' : '#8cc4ff')
    const lab = el('span', null, text)
    lab.style.cssText = 'flex:1;word-break:break-word'
    row.appendChild(dot); row.appendChild(lab)
    body.appendChild(row)
    if (key) seen.set(key, row)
    try {
      const th = threadEl()
      if (th) th.scrollTop = th.scrollHeight
    } catch { /* ignore */ }
  }

  /** 完成时渲染结构化卡片（与用户给的图1 同款信息密度） */
  function showResult(info, ok) {
    if (!ensureCard()) return
    const d = info || {}
    body.textContent = ''
    seen.clear()

    const box = el('div')
    box.style.cssText = [
      'border:1px solid ' + (ok ? 'rgba(99,207,127,.35)' : 'rgba(255,107,107,.4)'),
      'border-radius:8px',
      'padding:9px 11px',
      'background:rgba(255,255,255,.03)',
    ].join(';')

    const rows = [
      ['课程', d.course || '—'],
      ['章节', d.title || '—'],
      ['时长', d.duration || '—'],
      ['转写', d.segments != null ? `${d.segments} 段 / ${d.chars || 0} 字` : '—'],
      ['状态', ok ? (d.reused ? '♻️ 复用已有日志' : '✅ 本次新抓取') : '❌ 抓取失败'],
      ['保存位置', d.file || '—'],
    ]
    for (const [k, v] of rows) {
      const r = el('div')
      r.style.cssText = 'display:flex;gap:10px;margin:2px 0;align-items:flex-start'
      const kk = el('span', null, k)
      kk.style.cssText = 'flex:0 0 62px;color:#8b9199;font-size:12px'
      const vv = el('span', null, String(v))
      vv.style.cssText = 'flex:1;word-break:break-all;font-size:12px;color:' +
        (k === '状态' ? (ok ? '#63cf7f' : '#ff6b6b') : '#dde1e6')
      r.appendChild(kk); r.appendChild(vv)
      box.appendChild(r)
    }

    // 打开日志文件按钮
    if (ok && d.file) {
      const btn = el('button', 'btn', '📂 打开日志文件')
      btn.style.cssText = 'margin-top:8px;font-size:12px;padding:4px 10px'
      btn.onclick = async () => {
        try {
          if (window.studyBuddy && window.studyBuddy.logs && window.studyBuddy.logs.open) {
            await window.studyBuddy.logs.open(d.file)
          } else if (window.studyBuddy && window.studyBuddy.openPath) {
            await window.studyBuddy.openPath(d.file)
          } else {
            alert('保存位置：\n' + d.file)
          }
        } catch (e) { alert('打开失败：' + (e?.message || e)) }
      }
      box.appendChild(btn)
    }

    body.appendChild(box)
    // 更新标题
    const head = card && card.querySelector('div')
    if (head) {
      const t = head.children[1]
      const c = head.children[2]
      if (t) t.textContent = ok ? '课程日志已就绪' : '抓取失败'
      if (c) c.remove()
    }
    try {
      const th = threadEl()
      if (th) th.scrollTop = th.scrollHeight
    } catch { /* ignore */ }
  }

  /** 订阅自动抓取事件 */
  function bind() {
    try {
      if (!window.studyBuddy || !window.studyBuddy.autocapture || !window.studyBuddy.autocapture.onEvent) return
      window.studyBuddy.autocapture.onEvent((ev) => {
        const t = ev && ev.type
        if (t === 'start') {
          card = null; seen.clear()
          ensureCard()
          line('扩展已触发自动抓取，正在准备…', 'info', 'start')
        } else if (t === 'stage') {
          if (!card) ensureCard()
          const stage = String(ev.stage || '')
          const text = String(ev.text || '')
          if (!text) return
          // 转写进度用固定 key，原地更新
          if (stage === 'transcribe') line(text, 'info', 'transcribe')
          else line(text, 'info', stage || null)
        } else if (t === 'done') {
          /* ★ 2026-10-25：原来 reused 写死 false，导致「复用已有日志」永远显示成「本次新抓取」。
             改为透传事件里的 reused（main.js 已补该字段）。 */
          showResult({
            course: ev.course || '',
            title: ev.title || '',
            duration: ev.duration || '',
            segments: ev.segments,
            chars: ev.chars,
            file: ev.file || ev.fullPath || '',
            reused: ev.reused === true,
          }, true)
        } else if (t === 'failed') {
          showResult({ title: ev.title || '', file: '', }, false)
          if (ev.error) line(String(ev.error), 'err', null)
        }
      })
    } catch { /* ignore */ }
  }

  bind()
}


async function boot() {
  bind()
  /* ★ 2026-10-25：抓取进度改为在对话区以「智能体消息」呈现
   *   （用户明确要求：不要右侧独立浮动卡片）。
   *   旧函数 mountAutoCaptureProgress 已停用（保留代码但不再调用，
   *   避免误删引发其它引用问题，且它的 DOM 面板不会再出现）。 */
  try { mountCaptureInThread() } catch { /* ignore */ }
  try { initSettingsTabs() } catch { /* ignore */ }
  try { mountDiskUsage() } catch { /* ignore */ }
  try { setSideCollapsed(localStorage.getItem(SIDE_KEY) === '1', false) } catch { setSideCollapsed(false, false) }
  try { state.settings = await api.settings.load() } catch { state.settings = null }
  await refreshChats()
  await refreshCourseOptions()
  if (state.chats.length) {
    openChat(state.chats[0].id)
  } else {
    renderThread()
  }
  autoGrow()
}

/** 磁盘占用统计（2026-10-25 新增） */
async function mountDiskUsage() {
  const progBox = document.getElementById('disk-prog')
  const cBox = document.getElementById('disk-c')
  const logBox = document.getElementById('disk-clean-log')
  if (!progBox) return

  async function refresh() {
    progBox.textContent = '正在统计…'
    if (cBox) cBox.textContent = ''
    try {
      const d = await window.studyBuddy.disk.usage()
      // 程序目录
      const lines = d.parts.map((p) => `${p.name} <b>${p.text}</b>`).join('　·　')
      progBox.innerHTML = `程序目录 <b>${d.rootTotal.text}</b>　　${lines}`

      // C 盘
      if (cBox) {
        if (!d.cdrive.length) {
          cBox.innerHTML = '✅ <b>C 盘没有本应用的残留</b>'
        } else {
          const cl = d.cdrive.map((p) => `${p.name} <b>${p.text}</b>`).join('　·　')
          cBox.innerHTML = `⚠️ C 盘残留 <b>${d.cdriveTotal.text}</b>　　${cl}`
        }
      }
    } catch (e) {
      progBox.textContent = '统计失败：' + (e && e.message ? e.message : e)
    }
  }

  const btnR = document.getElementById('btn-disk-refresh')
  if (btnR) btnR.addEventListener('click', () => refresh())

  const btnC = document.getElementById('btn-disk-clean')
  if (btnC) {
    btnC.addEventListener('click', async () => {
      if (!confirm('清理 C 盘残留？\n\n只会删：旧版数据目录里的缓存、HuggingFace 缓存、临时文件。\n绝不会动课程日志、聊天记录和 API Key。')) return
      btnC.disabled = true
      btnC.textContent = '清理中…'
      try {
        const r = await window.studyBuddy.disk.cleanCdrive()
        if (logBox) {
          logBox.style.display = 'block'
          logBox.textContent = r.ok
            ? '✅ 完成' + (r.freed ? '，释放 ' + r.freed : '') + '\n\n' + (r.output || '')
            : '❌ 失败：' + (r.error || '')
        }
        await refresh()
      } catch (e) {
        if (logBox) {
          logBox.style.display = 'block'
          logBox.textContent = '❌ 失败：' + (e && e.message ? e.message : e)
        }
      } finally {
        btnC.disabled = false
        btnC.textContent = '🧹 清理 C 盘残留'
      }
    })
  }

  await refresh()
}


boot()


/** 硬件加速 UI 同步（2026-10-25 新增） */
function syncAccelUI(s) {
  const cb = document.getElementById('set-hwaccel')
  const wrap = document.getElementById('set-accel-wrap')
  const hint = document.getElementById('set-accel-hint')
  if (!cb) return
  const on = !(s && s.hardwareAccel === false)
  cb.checked = on
  const mode = (s && s.accelMode) || 'auto'
  const radios = document.querySelectorAll('input[name="accelmode"]')
  radios.forEach((r) => { r.checked = (r.value === mode) })
  if (wrap) wrap.style.display = on ? '' : 'none'
  if (hint) {
    hint.textContent = on
      ? (mode === 'cpu' ? '将只使用 CPU，速度较慢但更稳定。' : '')
      : '已关闭硬件加速，将只使用 CPU。'
  }
  if (!bindHardwareAccel.done) {
    bindHardwareAccel.done = true
    cb.addEventListener('change', () => {
      if (wrap) wrap.style.display = cb.checked ? '' : 'none'
      if (hint) hint.textContent = cb.checked ? '' : '已关闭硬件加速，将只使用 CPU。'
    })
  }
}


/* ══════ 设置页分页 + 识别测试（2026-10-25 新增）══════ */

function initSettingsTabs() {
  const tabs = document.querySelectorAll('#settings-tabs .tab')
  const panes = { api: document.getElementById('pane-api'), other: document.getElementById('pane-other') }
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      const key = t.dataset.tab
      tabs.forEach((x) => x.classList.toggle('active', x === t))
      Object.entries(panes).forEach(([k, el]) => { if (el) el.classList.toggle('active', k === key) })
      // 切到「其他设置」时刷新磁盘占用（可能刚装完东西）
      if (key === 'other') { try { refreshDiskUsageNow() } catch { /* ignore */ } }
    })
  })
}

/** 识图模型测试 */
async function testVisionModel() {
  const btn = document.getElementById('btn-test-vision')
  const out = document.getElementById('vision-test-result')
  if (!btn || !out) return
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = '测试中…'
  out.textContent = '正在发送一张测试图片…'
  out.style.color = '#8b9199'
  try {
    const payload = {
      visionBaseUrl: (document.getElementById('set-vision-base') || {}).value || '',
      visionApiKey: (document.getElementById('set-vision-key') || {}).value || '',
      visionModel: (document.getElementById('set-vision-model') || {}).value || '',
    }
    const r = await window.studyBuddy.settings.visionTest(payload)
    if (r && r.ok) {
      out.style.color = '#63cf7f'
      out.textContent = '✅ 可用（' + r.ms + 'ms）　模型 ' + r.model + ' 回复：' + (r.reply || '(空)')
    } else {
      out.style.color = '#ff6b6b'
      out.textContent = '❌ ' + ((r && r.error) || '未知错误')
    }
  } catch (e) {
    out.style.color = '#ff6b6b'
    out.textContent = '❌ ' + (e && e.message ? e.message : e)
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

try { $('#btn-test-vision').addEventListener('click', testVisionModel) } catch { /* ignore */ }


/* ══════ 转码速度 + GPU 状态（2026-10-25 新增）══════ */

/** 回填转码速度 UI */
function syncSpeedUI(s) {
  const speed = (s && s.transSpeed) || 'balanced'
  document.querySelectorAll('input[name="transspeed"]').forEach((r) => {
    r.checked = (r.value === speed)
  })
  const par = document.getElementById('set-parallel')
  if (par) par.checked = (s && s.hardwareParallel === true)

  // 绑定一次
  if (!syncSpeedUI.bound) {
    syncSpeedUI.bound = true
    document.querySelectorAll('input[name="transspeed"]').forEach((r) => {
      r.addEventListener('change', () => {
        const h = document.getElementById('set-speed-hint')
        if (h) {
          const names = { performance: '性能优先', balanced: '平衡模式', quiet: '静音模式' }
          h.textContent = '当前：' + (names[r.value] || r.value)
        }
      })
    })
    const btnS = document.getElementById('btn-gpu-status')
    if (btnS) btnS.addEventListener('click', checkGpuStatus)
    const btnI = document.getElementById('btn-install-gpu')
    if (btnI) btnI.addEventListener('click', installGpu)
  }
}

/** 检测 GPU 状态，并给不可用的控件变灰 */
async function checkGpuStatus(silent) {
  const hint = document.getElementById('set-gpu-hint')
  const wrap = document.getElementById('set-parallel-wrap')
  const btnI = document.getElementById('btn-install-gpu')
  try {
    const r = await window.studyBuddy.gpu.status()
    if (hint) {
      hint.textContent = r.text || ''
      hint.style.color = r.hasNvidia && r.dllOk ? '#63cf7f' : (r.hasNvidia ? '#ffc857' : '#ff6b6b')
    }

    // ① 没有 N 卡 → 并行开关变灰、下载按钮变灰
    const noNv = !r.hasNvidia
    if (wrap) {
      wrap.classList.toggle('no-nvidia', noNv)
      if (noNv) {
        const cb = document.getElementById('set-parallel')
        if (cb) cb.checked = false
      }
    }
    if (btnI) btnI.disabled = noNv || r.dllOk

    // ② 有 N 卡但缺组件 → 提示下载
    if (r.hasNvidia && !r.dllOk) {
      if (btnI) btnI.disabled = false
      if (btnI) btnI.textContent = '⬇ 下载 GPU 组件（约 1.8GB）'
    } else if (r.dllOk) {
      if (btnI) btnI.textContent = '✅ GPU 组件已就绪'
    }
    if (!silent) {
      // 用户主动点击时也写进日志，方便排查
      try { window.studyBuddy.app.log && window.studyBuddy.app.log('[gpu] ' + (r.text || '')) } catch { /* ignore */ }
    }
    return r
  } catch (e) {
    if (hint) { hint.textContent = '检测失败：' + (e && e.message ? e.message : e); hint.style.color = '#ff6b6b' }
    return null
  }
}

/** 下载 GPU 组件 */
async function installGpu() {
  const btn = document.getElementById('btn-install-gpu')
  const hint = document.getElementById('set-gpu-hint')
  if (!confirm('将下载 GPU 组件（nvidia-cublas + cudnn，约 1.8GB）。\n\n仅 NVIDIA 显卡需要，用于 CPU+GPU 同时转码。要现在下载吗？')) return
  if (btn) { btn.disabled = true; btn.textContent = '下载中…' }
  if (hint) { hint.textContent = '正在下载，请保持网络畅通（可能需要几分钟）…'; hint.style.color = '#8cc4ff' }
  try {
    const off = window.studyBuddy.gpu.onInstallEvent((ev) => {
      if (hint && ev && ev.text) hint.textContent = ev.text
    })
    const r = await window.studyBuddy.gpu.install()
    try { off && off() } catch { /* ignore */ }
    if (r && r.ok) {
      if (hint) { hint.textContent = 'GPU 组件安装成功！可以勾选「CPU+GPU 一起转码」了'; hint.style.color = '#63cf7f' }
      await checkGpuStatus(true)
    } else {
      if (hint) { hint.textContent = '安装失败：' + ((r && r.error) || '未知'); hint.style.color = '#ff6b6b' }
      if (btn) btn.disabled = false
    }
  } catch (e) {
    if (hint) { hint.textContent = '安装失败：' + (e && e.message ? e.message : e); hint.style.color = '#ff6b6b' }
    if (btn) btn.disabled = false
  } finally {
    if (btn) btn.textContent = '⬇ 下载 GPU 组件'
  }
}
