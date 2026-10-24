/**
 * AI 对话模块。
 *
 * 设计取舍：本应用要能分发给学生，所以不硬编码任何人的密钥。
 * 模型配置存在应用自己的 settings.json 里；首次使用引导填写。
 * 如果本机 DSH 已配好 DEEPSEEK_API_KEY（环境变量），会自动预填，省得重复输入。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 数据目录由 core/paths.js 统一解析（<root>\data），不再按 %LOCALAPPDATA% 探测 */
const { DATA_DIR } = require('./paths')

const SETTINGS = path.join(DATA_DIR, 'settings.json')

// 兼容迁移：旧版把 settings.json 写在 Roaming，这里首次读取时兜底
const LEGACY_SETTINGS = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'study-buddy', 'study-buddy', 'settings.json',
)

const DEFAULTS = {
  provider: 'qwen',
  // 阿里云百炼（DashScope）的 OpenAI 兼容入口，注册即送额度，qwen-plus 便宜够用
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
  /**
   * 识图用的视觉模型。2026-10-22 用本机账号在 DashScope 兼容模式实测：
   * qwen3-vl-plus 可用（能准确读出图里的文字），
   * qwen-vl-max / qwen-vl-plus 返回 404 Model not exist，
   * qwen-vl-max-latest / qwen2.5-vl-* 返回 403 Access denied（未开通）。
   */
  visionModel: 'qwen3-vl-plus',
  apiKey: '',
  /** 系统提示词：约束「不遗漏不虚报不弄虚作假」 */
  systemPrompt: [
    '你是一名课程学习助手，服务对象是在学习通上看网课的学生。',
    '回答必须严格基于提供的课程日志（逐句转写稿），不得虚构老师没讲过的内容。',
    '如果课程日志里没有相关信息，直接说「这一节的记录里没有提到」，不要推测。',
    '引用具体内容时附上时间戳，方便学生回看核对。',
    '语言用简体中文，讲解要具体、可操作，不要空泛。',
  ].join('\n'),
}

/**
 * 读取设置。
 *
 * ★ 2026-10-25 安全修正：旧位置兜底（LEGACY_SETTINGS）改为**受控迁移**。
 *
 * 背景：用户反馈「把 zip 发给别人，别人打开还能看到我的 API 地址配置」。
 * 虽然发布的 zip 里没有任何 settings.json（已验证），但这个兜底逻辑会
 * **凭空去读 %APPDATA%\study-buddy\study-buddy\settings.json** ——
 * 只要那台机器上曾经装过旧版本，就会读到**上一任使用者留下的配置**。
 * 这对「分发 zip 给他人」是很危险的默认行为。
 *
 * 新规则：
 *   ① 新位置有配置 → 直接用它（这是用户自己的，绝不覆盖）
 *   ② 新位置没有，且旧位置存在 → 迁移一次（说明是本机老用户升级），
 *      迁移成功后写一个 .migrated 标记，之后不再检查
 *   ③ 都没有 → 纯默认值（全新用户的正确状态）
 *
 * 这样「全新解压」永远得到干净默认值；「老用户升级」仍能保住配置。
 */
function readSettings() {
  // ① 新位置优先（这是用户自己的配置，绝不覆盖）
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
    return { ...DEFAULTS, ...j }
  } catch { /* 继续看旧位置 */ }

  // ② 旧位置迁移：仅当「没迁移过 且 旧文件真的存在」
  const MIGRATED_FLAG = SETTINGS + '.migrated'
  let migrated = false
  try { migrated = fs.existsSync(MIGRATED_FLAG) } catch { /* ignore */ }
  if (!migrated) {
    try {
      const raw = fs.readFileSync(LEGACY_SETTINGS, 'utf8')
      const j = JSON.parse(raw)
      const merged = { ...DEFAULTS, ...j }
      // 先备份旧文件，再写新位置，最后打标记（任一步失败都不影响可用性）
      try { fs.writeFileSync(SETTINGS + '.from-legacy.bak', raw, 'utf8') } catch { /* ignore */ }
      try { writeSettings(merged) } catch { /* ignore */ }
      try { fs.writeFileSync(MIGRATED_FLAG, new Date().toISOString(), 'utf8') } catch { /* ignore */ }
      return merged
    } catch { /* 旧位置也没有 */ }
  }

  return { ...DEFAULTS }
}

function writeSettings(patch) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
  const next = { ...readSettings(), ...patch }
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function resolveKey() {
  const s = readSettings()
  if (s.apiKey && String(s.apiKey).trim()) return String(s.apiKey).trim()
  const env = process.env.DEEPSEEK_API_KEY
  if (env && env.trim()) return env.trim()
  return ''
}

/**
 * 把课程日志塞进上下文。
 *
 * 2026-10-22 修的一个致命 bug：这里原来第一行就是 `if (m.role === 'system') continue`，
 * 而界面（renderer/app.js:233）和页内答疑（main.js:771）都把课程转写稿放在
 * `role:'system'` 的消息里 —— 于是转写稿被整个丢掉，AI 一个字课程内容都没看到，
 * 表现成「答得笼统」而不是报错。现在把所有 system 内容合并进同一条 system 消息。
 */
const MAX_LOG_CHARS = 60000

function buildContext(messages, settings) {
  const sysParts = [String(settings.systemPrompt || '')]
  const out = []

  for (const m of messages) {
    if (m.role === 'system') {
      let content = String(m.content || '')
      // 兼容：有些消息把转写稿单独放在 transcript 字段里
      if (!content.trim() && m.transcript) content = String(m.transcript)
      if (content.length > MAX_LOG_CHARS) {
        content = content.slice(0, MAX_LOG_CHARS)
          + `\n\n…（课程日志较长，以上为前 ${MAX_LOG_CHARS} 字；如需后面部分请让学生追问具体时间段）`
      }
      if (content.trim()) sysParts.push(content)
      continue
    }

    // 识图消息的 content 是数组（text + image_url），原样透传，不能 String() 掉
    if (Array.isArray(m.content)) {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
      continue
    }

    let content = String(m.content || '')
    // 兼容旧会话：正文只有「已抓取《X》：N 段 / M 字」摘要，全文在 transcript 字段
    if (m.transcript && !content.includes(String(m.transcript).slice(0, 80))) {
      const t = String(m.transcript)
      content += '\n\n' + (t.length > MAX_LOG_CHARS
        ? t.slice(0, MAX_LOG_CHARS) + `\n\n…（以上为前 ${MAX_LOG_CHARS} 字，已截断）`
        : t)
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content })
  }

  const systemContent = sysParts.filter((s) => s && s.trim()).join('\n\n---\n\n')
  return [{ role: 'system', content: systemContent }, ...out]
}

async function chat({ messages, onDelta, model }) {
  const settings = readSettings()
  const key = resolveKey()
  if (!key) {
    throw new Error('还没有配置模型 API Key。请在左下角「设置」里填写。')
  }

  const base = String(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  const modelName = String(model || settings.model || DEFAULTS.model).trim() || DEFAULTS.model
  const body = {
    model: modelName,
    messages: buildContext(messages, settings),
    stream: true,
    temperature: 0.3,
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 400) } catch { /* ignore */ }
    if (res.status === 401) throw new Error(`API Key 无效或已过期（接口：${base}），请在「设置」里更新。`)
    if (res.status === 402) throw new Error('账户余额不足。')
    if (res.status === 403) {
      throw new Error(`接口返回 403：这把 Key 不能使用模型「${modelName}」。可能是该模型没在控制台开通、没实名、或者没余额。`)
    }
    if (res.status === 404) {
      throw new Error(`接口返回 404：${base}/chat/completions。请检查「设置」里的 Base URL，以及模型名「${modelName}」是否存在（识图必须用视觉模型，例如 qwen3-vl-plus）。`)
    }
    throw new Error(`模型接口报错 ${res.status}${detail ? '：' + detail : ''}`)
  }

  // 流式解析 SSE
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const j = JSON.parse(data)
          const delta = j?.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            try { onDelta && onDelta(delta) } catch { /* ignore */ }
          }
        } catch { /* 跳过不完整片段 */ }
      }
    }
  }

  return full
}

/**
 * 一键测试：用界面当前填写的（或已保存的）地址 / 模型 / Key 真实请求一次。
 * 不落盘、不改状态，只回答「这套配置能不能用」。
 * 返回 { ok, ms, status, base, model, reply, error }
 */
async function testConnection({ baseUrl, model, apiKey } = {}) {
  const saved = readSettings()
  const base = String(baseUrl || saved.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '')
  const modelName = String(model || saved.model || DEFAULTS.model).trim()
  const key = String(apiKey || resolveKey() || '').trim()
  const t0 = Date.now()

  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, ms: 0, base, model: modelName, error: 'API 地址要以 http:// 或 https:// 开头' }
  }
  if (!key) {
    return { ok: false, ms: 0, base, model: modelName, error: '还没有填 API Key' }
  }
  if (!modelName) {
    return { ok: false, ms: 0, base, model: modelName, error: '还没有填模型名' }
  }

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: '这是一次连通性测试，只回复两个字：可用' },
          { role: 'user', content: '请回复：可用' },
        ],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    })
    const ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 可能不是 JSON（网关错误页等） */ }

    if (!res.ok) {
      const raw = json?.error?.message || json?.message || json?.error || (text || '').slice(0, 300)
      const msg = typeof raw === 'string' ? raw : JSON.stringify(raw)
      const hint =
        res.status === 401 ? 'API Key 不对或已过期' :
        res.status === 403 ? '这把 Key 没有权限用这个模型' :
        res.status === 404 ? '接口地址不对（检查是否需要以 /v1 结尾，且不要带 /chat/completions）' :
        res.status === 429 ? '请求太频繁或额度用尽' :
        res.status >= 500 ? '服务端临时故障，稍后再试' : ''
      return { ok: false, ms, status: res.status, base, model: modelName, error: hint ? `${hint}｜${msg}` : (msg || `HTTP ${res.status}`) }
    }

    const reply = json?.choices?.[0]?.message?.content ?? ''
    if (!reply && !json?.choices) {
      return { ok: false, ms, status: res.status, base, model: modelName, error: '接口返回了 200，但不是 OpenAI 兼容格式（没有 choices 字段），请检查 Base URL' }
    }
    return { ok: true, ms, status: res.status, base, model: modelName, reply: String(reply).trim() }
  } catch (e) {
    // Node 的 fetch 把底层错误塞在 e.cause 里（DNS/连接被拒/证书都可能只出现在 cause）
    const msg = String(e?.message || e)
    const detail = [e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ')
    const all = detail ? `${msg} ${detail}` : msg
    const friendly = /timeout|abort/i.test(all)
      ? `请求超时（30 秒）：地址可能不通或网络被拦｜${all}`
      : /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)
        ? `域名解析失败：地址可能写错了｜${all}`
        : /ECONNREFUSED/i.test(all)
          ? `连接被拒绝：地址或端口不对｜${all}`
          : /certificate|SSL|TLS/i.test(all)
            ? `证书校验失败（可能被代理拦截）｜${all}`
            : all
    return { ok: false, ms: Date.now() - t0, base, model: modelName, error: friendly }
  }
}

/**
 * 识图第一步：让视觉模型把图片里的文字**逐字抄下来**。
 *
 * 2026-10-22 加这一步的原因：直接把图交给模型答题，它会边看边猜选项字母——
 * 同一张 7 题测验图，第 4 题答成「A、B、D」（正确是 A、C、D），第 7 题把题干主语看反。
 * 拆成「抄字」+「作答」两步后，作答那一步拿到的是纯文字题目，可以走关键词检索，
 * 能把正文里对应段落精准带出来。
 * 返回 { ok, text, ms, error }
 */
async function recognizeImage(imageDataUrl) {
  const s = readSettings()
  const base = String(s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '')
  const model = String(s.visionModel || DEFAULTS.visionModel).trim()
  const key = String(resolveKey() || '').trim()
  if (!key) return { ok: false, text: '', error: '还没有配置模型 API Key。请在左下角「设置」里填写。' }
  if (!imageDataUrl) return { ok: false, text: '', error: '没有拿到图片' }
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: '把这张图片里的所有文字逐字抄下来，保持原来的顺序和换行。不要解释、不要总结、不要补全、不要改错别字。'
                + '如果图里是测验题，把题号、题干、每个选项的字母和内容都抄全，一道题都不要漏。',
            },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
        max_tokens: 2500,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(90000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 可能不是 JSON */ }
    if (!res.ok) {
      const raw = json?.error?.message || json?.message || (text || '').slice(0, 300)
      return { ok: false, text: '', ms: Date.now() - t0, error: `识图失败（HTTP ${res.status}）：${typeof raw === 'string' ? raw : JSON.stringify(raw)}` }
    }
    const out = String(json?.choices?.[0]?.message?.content || '').trim()
    return { ok: Boolean(out), text: out, ms: Date.now() - t0, error: out ? '' : '识图返回空内容' }
  } catch (e) {
    const msg = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ')
    return { ok: false, text: '', ms: Date.now() - t0, error: `识图请求失败：${msg}` }
  }
}

module.exports = { chat, testConnection, recognizeImage, readSettings, writeSettings, DEFAULTS, SETTINGS, buildContext }
