/**
 * 学习通学伴 · 独立应用主进程
 *
 * 结构：
 *   main.js       —— Electron 主进程（窗口、IPC、抓取与 AI 编排）
 *   preload.js    —— 受限桥接（只暴露必要的 IPC 方法）
 *   renderer/     —— 界面（DeepSeek 风格对话）
 *   core/         —— 与 DSH 插件共用的能力（浏览器发现、抓取、转写）
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')

const { listBrowsers, attachToBrowser } = require('./core/browsers')
const { launchDedicated, closeDedicated } = require('./core/launcher')
const { createExtServer, DEFAULT_PORT: EXT_DEFAULT_PORT } = require('./core/extserver')
const { captureLesson, captureLessonViaExtension } = require('./core/capture')
const { store } = require('./core/store')
const { chat, readSettings, writeSettings, testConnection, recognizeImage } = require('./core/ai')
const lessons = require('./core/lessons')

const APP_DIR = __dirname

/**
 * 数据目录：放 %LOCALAPPDATA% 而不是 Electron 默认的 %APPDATA%(Roaming)。
 *
 * 原因（2026-10-21 实测）：放 Roaming 时 Chromium 子进程写缓存会被拒
 * （`Failed to create network context data directory ... 拒绝访问 (0x5)`），
 * 且 Roaming 在域环境会被同步，把几百 MB 缓存一起同步出去。
 *
 * 迁移：首次运行若检测到旧位置有数据，自动搬过来（只搬一次）。
 */
/** 旧位置（Roaming），仅用于首次迁移 */
const LEGACY_DIR = path.join(app.getPath('appData'), 'study-buddy', 'study-buddy')

/**
 * 路径统一由 core/paths.js 解析：<root>\runtime、<root>\data、<root>\tools、<root>\browser-profile。
 *
 * 2026-10-22 把整个应用从 C 盘迁到数据盘。根目录取 app 目录的上一级，
 * 所以整个文件夹搬到任何盘都不用改代码。
 *
 * Chromium 的 userData 与用户数据仍然**分开放** —— 放同一层会让 Chromium 报
 *   `Lock file can not be created: 拒绝访问 (0x5)`
 *   `Failed to create directory: ...\Code Cache\js`
 */
const { RUNTIME_DIR, DATA_DIR, NOTES_DIR, TOOLS_DIR } = require('./core/paths')

/**
 * 关键流程写一份滚动日志到 <data>\app.log。
 *
 * 动机（2026-10-22）：用户报「抓不到课程内容」，但界面上只在气泡里闪一下，
 * 应用是 explorer 拉起来的，stdout 抓不到，事后完全无法复盘他到底点了什么、
 * 走了哪条分支、失败在哪一步。日志只记抓取相关，单个文件不超过 1MB。
 */
const APP_LOG = path.join(DATA_DIR, 'app.log')
function appendAppLog(line) {
  try {
    try {
      if (fs.statSync(APP_LOG).size > 1024 * 1024) fs.renameSync(APP_LOG, APP_LOG + '.1')
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(APP_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* 日志失败不影响主流程 */ }
}

// 启动时把运行参数记一笔，方便区分是哪次启动、哪个 Electron 版本
appendAppLog(`[boot] app=${APP_DIR} data=${DATA_DIR} electron=${process.versions.electron} argv=${process.argv.slice(1).join(' ')}`)

/**
 * 注意：`app.setPath('userData')` 必须**在 whenReady 之前**调用，
 * 但目录又必须先建出来（否则 Chromium 报 `Lock file can not be created: 0x3`）。
 * 所以在模块顶层同步建目录，随后立刻 setPath。
 */
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  app.setPath('userData', RUNTIME_DIR)
} catch (e) {
  console.error('[study-buddy] 设置 userData 失败：', e?.message || e)
}

// 关掉 Chromium 的 network service 沙箱（本应用只访问本地与固定域名）
try {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
} catch { /* ignore */ }

/** 一次性迁移：把旧 Roaming 目录里的用户数据搬到新位置 */
function migrateLegacyData() {
  try {
    if (!fs.existsSync(LEGACY_DIR)) return
    // 新目录已有数据就不重复搬
    const already = fs.existsSync(path.join(DATA_DIR, 'chats.json')) || fs.existsSync(NOTES_DIR)
    if (already) return
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const items = fs.readdirSync(LEGACY_DIR)
    let moved = 0
    for (const name of items) {
      // 跳过 Chromium 的缓存/状态目录，只搬我们自己的数据
      if (/^(Code Cache|GPUCache|Network|Cache|DawnGraphiteCache|DawnWebGPUCache|ShaderCache|GrShaderCache|Local Storage|Session Storage|IndexedDB|blob_storage|Service Worker|Crashpad|BrowserMetrics)/i.test(name)) continue
      try {
        fs.cpSync(path.join(LEGACY_DIR, name), path.join(DATA_DIR, name), { recursive: true, force: false })
        moved++
      } catch { /* 单个失败不影响整体 */ }
    }
    if (moved > 0) console.log(`[study-buddy] 已从旧目录迁移 ${moved} 项到 ${DATA_DIR}`)
  } catch (e) {
    console.error('[study-buddy] 迁移旧数据失败：', e?.message || e)
  }
}

let win = null
let currentCapture = null
let ext = null
let extPort = EXT_DEFAULT_PORT
let tray = null
/** 关闭行为：'tray'（最小化到托盘）或 'quit'（退出程序） */
let closeAction = 'tray'/**
 * 单实例判据：**端口占用**，而不是锁文件。
 *
 * 为什么不用文件锁：
 *   本机 `%LOCALAPPDATA%\study-buddy-app` 上 Electron 进程写任何文件都被拒
 *   （`拒绝访问 (0x5)` / `系统找不到指定的路径 (0x3)`），锁文件根本就建不出来。
 *   实测 pwsh 手工能建、Electron 里不行 —— 是 Chromium 进程侧限制，不是 ACL。
 *
 * 为什么端口可行：
 *   TCP 绑定是内核级互斥，不经过文件系统，不受上述限制影响。
 *   我们本来就要在 39517 上起 HTTP 服务给扩展用，正好复用它做单实例判据。
 *
 * 流程：启动时先试着绑定 DEFAULT_PORT。
 *   · 绑定成功 → 我是主实例，把这个 server 直接交给 extServer 用
 *   · 绑定失败（EADDRINUSE）→ 已有实例在跑，提示用户后退出
 */
async function tryClaimPort(port) {
  const net = require('node:net')
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (e) => resolve({ ok: false, code: e?.code }))
    probe.once('listening', () => resolve({ ok: true, server: probe }))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * 是否已勾选「保存设置，不再提醒」
 *
 * ⚠️ 2026-10-24 用户报：「点击保存不再提醒这个没用啊，每次关闭还会提示这个出来」。
 *    根因：这个开关和 closeAction 都只是**内存变量**（let），程序退出就丢了。
 *    用户勾了「不再提醒」→ 关掉应用 → 下次启动 closeRemember 又是 false → 又弹窗。
 *
 *    修复：持久化到 settings.json，启动时读回来。
 *    （用现有的 readSettings/writeSettings，避免再引入一套存储逻辑）
 */
let closeRemember = false

/** 从 settings.json 恢复关闭行为（启动时调用一次） */
function restoreCloseBehavior() {
  try {
    const s = readSettings() || {}
    if (typeof s.closeAction === 'string' && (s.closeAction === 'tray' || s.closeAction === 'quit')) {
      closeAction = s.closeAction
    }
    closeRemember = Boolean(s.closeRemember)
    if (closeRemember) {
      appendAppLog?.(`[close] 已恢复关闭行为: action=${closeAction} remember=${closeRemember}`)
    }
  } catch { /* ignore */ }
}

/** 把关闭行为写回 settings.json */
function persistCloseBehavior() {
  try {
    writeSettings({ closeAction, closeRemember: Boolean(closeRemember) })
  } catch { /* ignore */ }
}

/** 托盘提示只弹一次 */
let trayTipShown = false

function ensureDirs() {
  for (const d of [DATA_DIR, NOTES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  }
}

/**
 * 课程日志索引与「当前页面 → 哪篇日志」的匹配。
 *
 * 2026-10-22 用户报：「我在看《人工智能的历史》，问这节课讲什么，
 * 它却拿《顺便聊聊五代计算机泡沫》的内容回答」。
 * 根因：页内问答一直取「最近修改的那篇 md」——我测试时抓了别的课，就把那篇当成了当前课。
 * 现在改成按当前页面 URL 里的 chapterId 精确匹配；匹配不到就明确告诉用户「这节课还没抓取」，
 * 绝不拿另一节课的内容凑答案（宁可拒答）。
 */
function readLogMeta(file) {
  return lessons.readLogMeta(file)
}

function listCourseLogs() {
  return lessons.listLogs(NOTES_DIR)
}

/** 按页面 URL 找这节课的日志；找不到返回 null（不退回「最近一篇」） */
function findCourseLogForUrl(url) {
  return lessons.findByUrl(NOTES_DIR, url)
}

/** 回答格式要求：应用内对话与页内答疑共用，保证两边输出观感一致 */
const ANSWER_FORMAT = [
  '【回答格式（必须遵守）】',
  '【第一条：每句话都要有依据】',
  '- 你只能使用下面【课程正文】里出现过的内容。正文里没出现过的人名、书名、年份、概念、结论，一律不许写，也不许用你自己的常识补（2026-10-22 实测：模型凭空写出「马文·明斯基在 [05:28] 被提及」，而正文里根本没有「明斯基」三个字）。',
  '- 引用时间戳时，必须和正文里那一行的时间戳完全一致。你自己推算出来的时间不要标，宁可写「这一段的具体位置我没对上」。',
  '- 如果正文里确实没有相关内容，直接说「这节课的转写里没有讲到这个」，不要编，也不要拿别的课的内容顶。',
  '- 不要写「注意」「但需要说明」「这里要谨慎」「不过要注意」这类自我推敲的过程，也不要中途改答案。一次定论。',
  '【第二条：排版】',
  '- 不要使用 Markdown 符号：不要出现 **、#、*、---、``` 这些字符；也不要用 •、1. 2. 这种项目符号或编号。',
  '- 用自然语言分段；每段只说一个意思，宁短勿长。总结一节课的内容时通常要分 8～12 段，不要把好几个要点合并成一大段（学生反馈过「分细一点」）。',
  '- 每段用一句话开头点明这段讲什么，可酌情用「第一」「第二」「另外」衔接。',
  '- 每段末尾标一个时间戳，格式「[mm:ss]」；标完后另起一行写下一段，不要和后面的内容挤在同一行。',
  '【第三条：问测验题时】',
  '- 先写题号和答案（例如「第一题选 A」），再用一句话说明理由并标时间戳。',
  '- **写答案时字母后面必须用括号补上该选项的原文**，例如「第四题选 A（输入层）、C（中间处理层）、D（输出层）」。图片里的选项字母最容易看错，补上原文才能让字母和内容对得上。',
  '- 作答前逐个核对每个选项字母对应的文字，不要凭印象把内容套到字母上。',
  '- 不要逐项分析每个选项，不要写「虽然…但是…」的长篇推理。答案只能有一个。',
  '- 找依据的方法：拿题目里的关键词在正文里扫一遍，特别注意「新出现」「新的研究方向」「更近一步」「一个分支」「一个发展」这类表述前后的专有名词——题目问的选项往往就藏在那半句里。问「新出现的研究方向/最新进展」的题，先在正文里搜「新的研究方向」「新出现」「还有一个」，答案通常紧跟在那句话后面的英文术语或音译词上。',
  '- 转写是机器听写的，专有名词经常写错：「类脑」会被写成「内脑」、「麦卡锡」写成「McCartney」、「桓灵二帝」写成「环陵二帝」。题目里的术语在正文里搜不到时，先按读音相近或字形相近去找同类词，不要因为字面不一致就判定「正文没有」。',
  '- 一条回答只标一个时间戳，不要连续列多个 [mm:ss]。',
  '- 正文里找不到依据的题，明确说「这题在转写里找不到依据，我不确定」，不要猜。',
  '- 学生若要求「看原稿 / 全文 / 老师原话」，告诉他原稿就是本机保存的转写文件（文件名是「课名.md」），在应用左下角「打开课程日志文件夹」里能打开，也可以直接在对话的课程日志卡片上点「打开日志文件」；不要回答「没有原稿」。',
].join('\n')

/* ══════════════════════════════════════════════════════════════════════════
 * 章节测验自动作答（契约见 docs/quiz-api-contract.md A 节）
 *
 * 与页内问答的区别：问答只要一段话，这里要**机器可执行的结构化答案**，
 * 所以必须强制 AI 输出严格 JSON，并由我们自己校验、兜底、纠错。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 测验作答专用提示词：约束输出格式为严格 JSON */
const QUIZ_FORMAT = [
  '【输出格式（必须严格遵守）】',
  '- 只输出一个 JSON 对象，不要输出任何解释、说明、Markdown 代码围栏（不要 ```json）、注释或多余文字。',
  '- 第一个字符必须是 {，最后一个字符必须是 }。',
  '- JSON 结构：{"answers":[{"qid":"题目标识","keys":["选项key"],"reason":"不超过80字的中文理由"}]}',
  '- qid 必须原样使用题目里给出的 qid，是字符串，不要加引号以外的修饰。',
  '- keys 是字符串数组，元素必须是该题 options 里给出的 key 之一（原样照抄，区分大小写）。',
  '- 多选题可以给多个 key；单选题只能给 1 个 key；判断题只能给 "true" 或 "false"。',
  '- 判断题**不要**返回「对」「错」「A」「B」「正确」「错误」——只允许字符串 "true" 或 "false"。',
  '- reason 里不要出现 Markdown 符号、不要出现换行。',
  '- 数字与布尔值一律用字符串形式（qid 是字符串）。',
  '',
  '【作答纪律（极重要，务必遵守）】',
  '- **每道题都必须给出 keys，绝对不能留空数组。** 空着不答 = 这道题 0 分，和答错完全一样，',
  '  而作答至少还有蒙对的机会。所以宁可推测也必须作答。',
  '- 优先级：①课程正文里有明确依据 → 按依据作答；②正文里有相关内容可推断 → 按最合理的推断作答；',
  '  ③正文完全没提到 → 依据题型、常识、学术背景与上下文，选最可能的选项作答。',
  '- 无论哪种情况，keys 都必须是非空的合法 key。',
  '- 若你的答案主要靠推测而非正文依据，请在 reason 末尾加「（推测）」二字，便于人工复核。',
  '- 例外：只有当题目本身残缺、选项 key 缺失、或题干完全无法理解（例如仍是未解混淆的乱码）时，',
  '  才允许 keys 给空数组，并在 reason 里说明原因。',
].join('\n')

/**
 * 从 AI 输出里抠出 JSON 对象。
 *
 * 实测模型常犯的毛病：包一层 ```json 围栏、前面加「好的，以下是答案：」、
 * 末尾加解释。所以按「直接 parse → 去围栏 → 取首{到末}」三级降级。
 * @returns {object|null}
 */
function extractJson(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim()
  if (!text) return null

  // ① 直接 parse
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object') return v
  } catch { /* 下一级 */ }

  // ② 去掉 Markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      const v = JSON.parse(fence[1].trim())
      if (v && typeof v === 'object') return v
    } catch { /* 下一级 */ }
  }

  // ③ 取第一个 { 到最后一个 }（贪心，容忍中间有换行）
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1))
      if (v && typeof v === 'object') return v
    } catch { /* 失败 */ }
  }

  return null
}

/** 判断题答案归一化：把「对/错/A/B/true/false」统一成 true/false 字符串 */
function normalizeJudgeKey(k) {
  const s = String(k == null ? '' : k).trim().toLowerCase()
  if (!s) return ''
  if (['true', 't', 'a', '对', '正确', '是', '√', 'yes', 'y', '1'].includes(s)) return 'true'
  if (['false', 'f', 'b', '错', '错误', '否', '×', 'x', 'no', 'n', '0'].includes(s)) return 'false'
  return ''
}

/**
 * 校验并收敛 AI 给出的答案。
 *
 * 这里是「宁可少答，不可错答」的落点：任何不合法的 key 一律丢弃；
 * 收敛后为空的题不进 answers，只在 warnings 里记一笔。
 *
 * @param {object} parsed  AI 返回的已解析对象
 * @param {Array} questions 请求里的题目
 * @returns {{answers:Array, warnings:string[]}}
 */
function validateQuizAnswers(parsed, questions) {
  const warnings = []
  const byQid = new Map()
  for (const q of questions) byQid.set(String(q.qid), q)

  const list = Array.isArray(parsed?.answers) ? parsed.answers : []
  const got = new Map()
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const qid = String(a.qid == null ? '' : a.qid).trim()
    if (!qid || !byQid.has(qid)) {
      if (qid) warnings.push(`AI 给出了不存在的 qid=${qid}，已忽略`)
      continue
    }
    if (got.has(qid)) continue // 同一题重复，保留第一条
    got.set(qid, a)
  }

  const answers = []
  for (const q of questions) {
    const qid = String(q.qid)
    const a = got.get(qid)

    const qtype = Number(q.qtype)
    const opts = Array.isArray(q.options) ? q.options : []
    const validKeys = new Set(opts.map((o) => String(o.key)))
    const firstKey = opts.length ? String(opts[0].key) : ''

    /**
     * 兜底作答（2026-10-24 用户指出：留空不答 = 0 分，和答错一样）。
     * 任何「拿不到合法 key」的情况都不能 skip 掉整道题，必须给一个兜底答案。
     * 兜底策略按题型：
     *   判断题 → "true"（若合法，否则取第一个合法项）
     *   单选   → 第一个合法 key
     *   多选   → 第一个合法 key（宁可少选也别空着）
     * 兜底答案会在 reason 里标「（兜底）」便于人工复核。
     */
    function fallbackKey() {
      if (qtype === 3) {
        for (const cand of ['true', 'false']) if (validKeys.has(cand)) return cand
      }
      return firstKey || ''
    }

    if (!a) {
      // AI 完全没返回这道题 → 兜底作答，绝不跳过
      const fb = fallbackKey()
      if (fb) {
        warnings.push(`题目 ${qid} AI 未返回答案，已按兜底作答（${fb}）`)
        answers.push({ qid, keys: [fb], reason: '（兜底）AI 未返回该题答案，按默认选项作答' })
      } else {
        warnings.push(`题目 ${qid} AI 未返回答案且无可选选项，无法作答`)
      }
      continue
    }

    let keys = Array.isArray(a.keys) ? a.keys.map((k) => String(k)) : []

    // 判断题：先归一化，再校验必须落在合法集合里
    if (qtype === 3) {
      const norm = keys.map(normalizeJudgeKey).filter(Boolean)
      keys = norm
      // 归一化后仍不在该题 options 里（例如题目 key 不是 true/false）→ 退回原值再过滤
      if (!keys.length) {
        keys = Array.isArray(a.keys) ? a.keys.map((k) => String(k)) : []
      }
      keys = keys.filter((k) => validKeys.has(k)).slice(0, 1)
      if (!keys.length) {
        const fb = fallbackKey()
        if (fb) {
          warnings.push(`判断题 ${qid} 未给出可用的 true/false，已兜底作答（${fb}）`)
          keys = [fb]
        } else {
          warnings.push(`判断题 ${qid} 无可选 true/false 选项，无法作答`)
          continue
        }
      }
    } else if (qtype === 2) {
      // 单选：只保留合法 key，取第一个
      keys = keys.filter((k) => validKeys.has(k)).slice(0, 1)
      if (!keys.length) {
        const fb = fallbackKey()
        if (fb) {
          warnings.push(`单选题 ${qid} 未给出合法选项，已兜底作答（${fb}）`)
          keys = [fb]
        } else {
          warnings.push(`单选题 ${qid} 无可选选项，无法作答`)
          continue
        }
      }
    } else {
      // 多选：去重 + 按字母序 + 保留合法项
      const seen = new Set()
      keys = keys.filter((k) => {
        if (!validKeys.has(k) || seen.has(k)) return false
        seen.add(k)
        return true
      }).sort()
      if (!keys.length) {
        const fb = fallbackKey()
        if (fb) {
          warnings.push(`多选题 ${qid} 未给出合法选项，已兜底作答（${fb}）`)
          keys = [fb]
        } else {
          warnings.push(`多选题 ${qid} 无可选选项，无法作答`)
          continue
        }
      }
    }

    const reason = String(a.reason == null ? '' : a.reason)
      .replace(/[*#`\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)

    answers.push({ qid, keys, reason })
  }

  return { answers, warnings }
}

/**
 * 组装测验作答的 prompt。
 *
 * 题干与选项按契约 0.4.1 可能是结构化对象 {raw, decoded, confidence, lowConfidence}，
 * 这里统一渲染成文本，并把 raw/decoded 两份都交给模型（契约 0.4.2 要求双参考）。
 */
function renderQuizField(field) {
  if (field == null) return { text: '', extra: '' }
  if (typeof field === 'string') {
    // 兼容旧调用：只有原始文本，此时视为「未解码」
    return { text: field, extra: '' }
  }
  const raw = String(field.raw == null ? '' : field.raw)
  const decoded = String(field.decoded == null ? '' : field.decoded)
  const conf = Number(field.confidence)
  const low = Array.isArray(field.lowConfidence) ? field.lowConfidence : []

  // 解码成功且与原文不同 → 两份都给
  if (decoded && decoded !== raw) {
    let extra = `\n    [raw] ${raw}\n    [decoded] ${decoded}`
    if (Number.isFinite(conf)) extra += `\n    [confidence] ${conf.toFixed(2)}`
    if (low.length) {
      const marks = low.slice(0, 20).map((x) => `${x.from}→${x.to}(${Number(x.score).toFixed(2)})`).join('、')
      extra += `\n    [低置信字] ${marks}`
    }
    return { text: decoded, extra }
  }

  // 未解码或与原文相同 → 只给一份，但若置信度低要标出来
  let extra = ''
  if (Number.isFinite(conf) && conf > 0 && conf < 0.7) extra = `\n    [confidence] ${conf.toFixed(2)}（还原把握不大，请结合课程正文判断）`
  return { text: decoded || raw, extra }
}

/**
 * 把题目列表渲染成给模型看的文本块。
 */
function renderQuestionsForPrompt(questions) {
  const lines = []
  questions.forEach((q, i) => {
    const qtype = Number(q.qtype)
    const typeName = q.typeText
      || (qtype === 1 ? '多选题' : qtype === 2 ? '单选题' : qtype === 3 ? '判断题' : '题目')
    const stem = renderQuizField(q.stem)
    lines.push(`【第 ${i + 1} 题】qid=${String(q.qid)}　题型=${typeName}（qtype=${qtype}）`)
    lines.push(`  题干: ${stem.text}${stem.extra}`)
    for (const o of (q.options || [])) {
      const t = renderQuizField(o.text)
      lines.push(`    选项 key=${String(o.key)}: ${t.text}${t.extra}`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

/**
 * 章节测验作答处理器（由 ext.setQuizAnswerHandler 注入 extserver）。
 *
 * 契约要求（docs/quiz-api-contract.md）：
 *  · R2 绝不跨课：只用 findCourseLogForUrl 精确匹配 chapterId，找不到就拒答
 *  · 严格 JSON：解析失败重试恰好一次，仍失败返回 parse-failed
 *  · 非法 key 过滤；判断题强制 true/false
 */
async function handleQuizAnswer({ body }) {
  const url = String(body?.url || '')
  const chapterIdFromBody = String(body?.chapterId || '').trim()
  const workId = String(body?.workId || '').trim()
  const questions = Array.isArray(body?.questions) ? body.questions : []
  // 扩展侧传入的解码质量（2026-10-24 新增）：{obfTotal, lowN, lowRatio, avg, warn}
  const dq = body?.decodeQuality && typeof body.decodeQuality === 'object' ? body.decodeQuality : null

  // ① 定位课程日志（章节级精确匹配；绝不退回「最近一篇」）
  const hit = findCourseLogForUrl(url) || (chapterIdFromBody ? lessons.findByChapterId(NOTES_DIR, chapterIdFromBody) : null)
  if (!hit) {
    appendAppLog(`[quiz] 无课程日志，拒答 chapterId=${chapterIdFromBody || '(空)'} workId=${workId} url=${url.slice(0, 120)}`)
    return {
      status: 409,
      payload: {
        ok: false,
        error: 'no-course-log',
        message: '这节课还没有课程日志，无法作答（不会拿别的课的内容来凑）',
        detail: { chapterId: chapterIdFromBody },
      },
    }
  }

  // ② 读日志正文（与 askHandler 一致：截断 60000 字符）
  let context = ''
  try {
    context = fs.readFileSync(hit.file, 'utf8').slice(0, 60000)
  } catch {
    appendAppLog(`[quiz] 读日志失败 ${path.basename(hit.file)}`)
    return {
      status: 409,
      payload: { ok: false, error: 'no-course-log', message: '课程日志读取失败', detail: { chapterId: hit.chapterId } },
    }
  }
  if (!context.trim()) {
    appendAppLog(`[quiz] 日志正文为空，拒答 chapterId=${hit.chapterId}`)
    return {
      status: 409,
      payload: { ok: false, error: 'no-course-log', message: '课程日志正文为空', detail: { chapterId: hit.chapterId } },
    }
  }

  // ③ 组装 prompt
  const sysPrompt = [
    `以下是学生正在学习的课程日志（原样转写，未加工）。请优先依据它回答测验题。`,
    `作答纪律：每道题都必须选出答案，即使正文没有直接依据，也要按最合理的推断作答并标注「（推测）」。`,
    `留空不答等于 0 分，和答错完全一样，所以宁可推测也不要空着。`,
    ``,
    `课程：${hit.title}　时长：${hit.duration || '未知'}　章节ID：${hit.chapterId}`,
    ``,
    QUIZ_FORMAT,
    ``,
    `【题干与选项说明】`,
    `有些题干/选项会同时给出 [raw]（原始文本，可能是被字体混淆的乱码）与 [decoded]（解混淆后的文本）。`,
    `请同时参考两者：以 decoded 为主要依据；当 decoded 中出现语义不通、明显不成词的片段时，结合 raw 的字符位置与课程正文上下文判断真实含义。`,
    `遇到标了 [低置信字] 的字符，必须结合课程正文语境确认，不要机械采信 decoded。`,
    `若 raw 与 decoded 都读不通、确实无法理解题意，才允许 keys 给空数组并在 reason 说明；否则必须给出答案。`,
    ``,
    // 2026-10-24 新增：把解码质量告诉 AI，让它知道这章的字有多可信
    ...(dq ? [
      `【本章文字解码质量】`,
      `共 ${dq.obfTotal} 个混淆字，其中 ${dq.lowN} 个低置信（占比 ${Math.round((dq.lowRatio || 0) * 100)}%），平均置信度 ${dq.avg}。`,
      dq.warn
        ? `低置信字较多，题干可能有个别错字。请重点结合课程正文的语义判断题目真实含义，不要因为某个字看起来不通就放弃作答。`
        : `解码质量良好，可按 decoded 正常理解。`,
      ``,
    ] : []),
    `【课程正文】`,
    context,
  ].join('\n')

  const userPrompt = [
    `请作答以下 ${questions.length} 道测验题，严格按 JSON 格式输出。`,
    ``,
    renderQuestionsForPrompt(questions),
  ].join('\n')

  // ④ 调 AI（首次）
  const t0 = Date.now()
  let rawText = ''
  try {
    const reply = await chat({
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
    })
    rawText = String(reply || '')
  } catch (e) {
    const msg = String(e?.message || e)
    appendAppLog(`[quiz] AI 调用失败 chapterId=${hit.chapterId} 题数=${questions.length} 耗时=${Date.now() - t0}ms err=${msg}`)
    const isKey = /API Key|apiKey|还没有配置/i.test(msg)
    return {
      status: isKey ? 409 : 502,
      payload: {
        ok: false,
        error: isKey ? 'ai-not-configured' : 'ai-timeout',
        message: isKey ? '还没有配置模型 API Key，请先在应用左下角「设置」里填写' : `AI 调用失败：${msg}`,
        detail: { chapterId: hit.chapterId },
      },
    }
  }

  // ⑤ 解析（失败重试恰好一次）
  let parsed = extractJson(rawText)
  let retried = false
  if (!parsed) {
    retried = true
    appendAppLog(`[quiz] 首次解析失败，重试一次 chapterId=${hit.chapterId}`)
    try {
      const reply2 = await chat({
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
          {
            role: 'assistant',
            content: String(rawText).slice(0, 2000),
          },
          {
            role: 'user',
            content: '上次输出无法解析为 JSON。这次只输出 JSON 对象本身：第一个字符必须是 {，最后一个字符必须是 }，不要任何其它文字、不要代码围栏。',
          },
        ],
      })
      parsed = extractJson(String(reply2 || ''))
    } catch (e) {
      appendAppLog(`[quiz] 重试调用失败 chapterId=${hit.chapterId} err=${String(e?.message || e)}`)
    }
  }

  const elapsed = Date.now() - t0

  if (!parsed) {
    appendAppLog(`[quiz] parse-failed chapterId=${hit.chapterId} 题数=${questions.length} 重试=${retried} 耗时=${elapsed}ms`)
    return {
      status: 502,
      payload: {
        ok: false,
        error: 'parse-failed',
        message: 'AI 返回的内容无法解析为答案 JSON，已跳过本次作答（不会带着不完整答案提交）',
        detail: { chapterId: hit.chapterId, rawHead: String(rawText).slice(0, 200) },
      },
    }
  }

  // ⑥ 校验 + 收敛
  const { answers, warnings } = validateQuizAnswers(parsed, questions)

  appendAppLog(`[quiz] 作答完成 chapterId=${hit.chapterId} 日志=${path.basename(hit.file)} 题数=${questions.length} 有答案=${answers.length} 重试=${retried} 耗时=${elapsed}ms`)

  // 把「作答依据」广播到应用界面：用户要求能确认答案是不是真按课程内容答的
  // （不是黑盒输出）。记录：课程名、日志文件、题号、答案、理由、耗时。
  const evidence = {
    at: new Date().toISOString(),
    chapterId: hit.chapterId,
    lesson: hit.title || '',
    logFile: path.basename(hit.file),
    duration: hit.duration || '',
    elapsedMs: elapsed,
    retried,
    questions: questions.map((q) => {
      const a = answers.find((x) => String(x.qid) === String(q.qid))
      return {
        qid: String(q.qid),
        qtype: q.qtype,
        stem: renderQuizField(q.stem).text.slice(0, 120),
        keys: a ? a.keys : [],
        reason: a ? a.reason : '',
        answered: Boolean(a),
      }
    }),
    warnings: warnings.length ? warnings : [],
  }
  pushQuizEvidence(evidence)
  broadcastQuizEvent('answered', { text: `已按《${hit.title || ''}》作答 ${answers.length} 题`, evidence })

  if (!answers.length) {
    return {
      status: 200,
      payload: {
        ok: true,
        chapterId: hit.chapterId,
        workId,
        logFile: path.basename(hit.file),
        lesson: hit.title || '',
        answers: [],
        warnings: warnings.length ? warnings : ['AI 未给出任何可用答案，本次不提交'],
      },
    }
  }

  return {
    status: 200,
    payload: {
      ok: true,
      chapterId: hit.chapterId,
      workId,
      logFile: path.basename(hit.file),
      lesson: hit.title || '',
      answers,
      warnings: warnings.length ? warnings : undefined,
    },
  }
}


/**
 * 章节测验作答依据（用户可查看 AI 到底依据什么作答）。
 *
 * 用户诉求（2026-10-24）：「我怎么确定答题的正确率的保障？换一种说法就是
 * 我怎么知道这个题目的答案是 AI 根据课程内容来进行回答的」。
 * 所以每次作答都留档：哪节课、哪个日志文件、每题答案与理由、耗时。
 * 只保留最近 50 条，内存 + 广播给界面，不写敏感内容到磁盘。
 */
const quizEvidenceList = []

function pushQuizEvidence(ev) {
  try {
    quizEvidenceList.unshift(ev)
    if (quizEvidenceList.length > 50) quizEvidenceList.length = 50
    // 顺手落盘一份摘要，便于事后核对（不含完整题干，避免隐私）
    try {
      const p = path.join(DATA_DIR, 'quiz-evidence.json')
      fs.writeFileSync(p, JSON.stringify(quizEvidenceList.slice(0, 20), null, 2), 'utf8')
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function broadcastQuizEvent(type, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents) w.webContents.send('quiz:event', { type, ...payload })
    }
  } catch { /* ignore */ }
}

/**
 * 自动抓取当前页面那节课的课程日志（扩展点「一键播放答题」时自动调用）。
 *
 * 用户要求（2026-10-24）：「用户使用了扩展的[一键播放答题]功能时，应用要配合，
 * 把识别课程日志调成全自动，扩展插件在运行哪个浏览器页面就抓取哪节课程的日志
 * 方便后面视频播放完成之后的答题」。
 *
 * 契约（docs/quiz-api-contract.md B 节）：
 *  · 已有日志且非 force → 同步返回 { ok, reused:true, title, file }
 *  · 需要抓取 → 立即返回 { ok, started:true, jobId }，由扩展轮询 status
 *  · 同一 chapterId 正在抓 → already-running
 *  · 扩展没连上 → no-extension
 */
const autoCaptureRunning = new Map() // chapterId → jobId（防重入）

async function handleAutoCapture({ body }) {
  const url = String(body?.url || '')
  const force = body?.force === true
  const tabId = body?.tabId
  const chapterIdFromBody = String(body?.chapterId || '').trim()

  // ① 已经抓过就直接复用（除非 force）
  if (!force) {
    const existed = findCourseLogForUrl(url)
      || (chapterIdFromBody ? lessons.findByChapterId(NOTES_DIR, chapterIdFromBody) : null)
    if (existed) {
      appendAppLog(`[autocapture] 复用已有日志《${existed.title}》chapterId=${existed.chapterId}`)
      return {
        status: 200,
        payload: {
          ok: true,
          reused: true,
          title: existed.title,
          chapterId: existed.chapterId,
          file: path.basename(existed.file),
        },
      }
    }
  }

  // ② 扩展必须在线
  //    ⚠️ 每条失败路径都必须写日志（2026-10-24 踩坑）：
  //    用户报「自动切到下一节后抓日志超时」，但日志里一个字都没有，
  //    因为这几种提前 return 都没记日志 → 完全无法诊断。现在全部补上。
  if (!ext) {
    appendAppLog(`[autocapture] 失败 no-extension（服务未启动） chapterId=${chapterIdFromBody || '(空)'}`)
    return { status: 503, payload: { ok: false, error: 'no-extension', message: '扩展服务未启动' } }
  }
  const st = ext.state?.()
  const lastHelloAt = st?.lastHello?.at || 0
  const ageMs = lastHelloAt ? Date.now() - lastHelloAt : -1
  const connected = Boolean(lastHelloAt && ageMs < 15000)
  if (!connected) {
    appendAppLog(`[autocapture] 失败 no-extension（扩展心跳过期 ${ageMs < 0 ? '从未连接' : Math.round(ageMs / 1000) + '秒前'}） chapterId=${chapterIdFromBody || '(空)'}`)
    return {
      status: 503,
      payload: { ok: false, error: 'no-extension', message: '浏览器扩展未连接，请确认扩展已加载且学习通页面已打开' },
    }
  }

  // ②.5 tabId 必须有值，否则扩展侧 executeScript 会报
  //      "Error at property 'target': Missing required property 'tabId'"
  //      优先用请求里带的；没带就从扩展上报的标签页列表里按 url/chapterId 找。
  let useTabId = Number.isInteger(tabId) && tabId >= 0 ? tabId : null
  if (useTabId == null) {
    try {
      const tabs = Array.isArray(st?.lastHello?.tabs) ? st.lastHello.tabs : []
      const cid = chapterIdFromBody
      const byUrl = tabs.find((t) => t && t.url && String(t.url).includes('chapterId=' + cid))
      const byLooks = tabs.find((t) => t && t.looksLesson)
      const picked = byUrl || byLooks || tabs[0]
      if (picked && Number.isInteger(picked.id)) useTabId = picked.id
    } catch { /* ignore */ }
  }
  if (useTabId == null) {
    const tabInfo = (() => {
      try {
        const tabs = Array.isArray(st?.lastHello?.tabs) ? st.lastHello.tabs : []
        return `tabs=${tabs.length}` + (tabs.length ? ' ids=' + tabs.map((t) => t?.id).join(',') : '')
      } catch { return 'tabs=?'
      }
    })()
    appendAppLog(`[autocapture] 失败 no-tab（拿不到标签页 id；${tabInfo}） chapterId=${chapterIdFromBody || '(空)'} url=${url.slice(0, 100)}`)
    return {
      status: 409,
      payload: {
        ok: false,
        error: 'no-tab',
        message: '拿不到当前标签页 id（扩展未上报），无法自动抓取。可手动点「📝 课程日志」抓一次。',
        detail: { tabInfo },
      },
    }
  }
  appendAppLog(`[autocapture] 使用 tabId=${useTabId} chapterId=${chapterIdFromBody || '(空)'}`)

  // ③ 防重入：同一 chapterId 只允许一个抓取任务
  const dedupeKey = chapterIdFromBody || url
  const running = autoCaptureRunning.get(dedupeKey)
  if (running) {
    return {
      status: 200,
      payload: { ok: true, started: true, jobId: running, alreadyRunning: true, message: '这节课正在抓取中，沿用同一个任务' },
    }
  }

  // ④ 启动异步抓取，立刻把 jobId 交给扩展
  const jobId = crypto.randomUUID()
  autoCaptureRunning.set(dedupeKey, jobId)
  ext.captureJobs.create(jobId, { chapterId: chapterIdFromBody })

  // 广播到应用界面（用户要求：应用里要能看到自动抓取进度，不能只在后台静默抓）
  const notifyRenderer = (type, payload) => {
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents) {
          w.webContents.send('autocapture:event', { type, jobId, ...payload })
        }
      }
    } catch { /* ignore */ }
  }

  notifyRenderer('start', {
    chapterId: chapterIdFromBody,
    text: '扩展已触发自动抓取，正在准备…',
  })

  const finishFail = (error, extra = {}) => {
    autoCaptureRunning.delete(dedupeKey)
    ext.captureJobs.finish(jobId, { ok: false, error })
    appendAppLog(`[autocapture] 失败 ${error} ${JSON.stringify(extra)}`)
    notifyRenderer('failed', { error, text: `抓取失败：${error}` })
  }

  // 不等它跑完（会 1-3 分钟），后台继续
  ;(async () => {
    try {
      ext.captureJobs.update(jobId, { stage: 'scan', text: '正在通过浏览器插件读取当前页面…' })
      notifyRenderer('stage', { stage: 'scan', text: '正在通过浏览器插件读取当前页面…' })
      const result = await captureLessonViaExtension({
        ext,
        tabId: useTabId,
        notesDir: NOTES_DIR,
        reuse: !force,
        onStage: (stage, text) => {
          const t = String(text || '').slice(0, 200)
          ext.captureJobs.update(jobId, { stage, text: t })
          // 从进度文字里抠出已转写段数，例如「已转写 100 段 / 到 282s」
          const m = /已转写\s*(\d+)\s*段/.exec(String(text || ''))
          if (m) ext.captureJobs.update(jobId, { segments: Number(m[1]) })
          if (stage === 'download') {
            const t2 = /已下载\s*([\d.]+)\s*MB/.exec(String(text || ''))
            if (t2) ext.captureJobs.update(jobId, { total: Number(t2[1]) })
          }
          notifyRenderer('stage', { stage, text: t, segments: m ? Number(m[1]) : undefined })
        },
      })
      autoCaptureRunning.delete(dedupeKey)
      ext.captureJobs.update(jobId, {
        segments: result.segments || 0,
        title: result.lessonName || '',
        chapterId: result.chapterId || chapterIdFromBody,
      })
      ext.captureJobs.finish(jobId, { ok: true, file: result.file ? path.basename(result.file) : null })
      appendAppLog(`[autocapture] 完成 《${result.lessonName || ''}》 chapterId=${result.chapterId || ''} 段数=${result.segments ?? '?'}`)
      notifyRenderer('done', {
        chapterId: result.chapterId || chapterIdFromBody,
        title: result.lessonName || '',
        segments: result.segments || 0,
        file: result.file ? path.basename(result.file) : '',
        text: `课程日志已就绪：《${result.lessonName || ''}》${result.segments ? `（${result.segments} 段）` : ''}`,
      })
    } catch (e) {
      finishFail(String(e?.message || e), { url: url.slice(0, 100) })
    }
  })()

  return { status: 200, payload: { ok: true, started: true, jobId } }
}

/**
 * 为一次问答准备课程上下文。
 *
 * 用户 2026-10-22 反馈：「有点局限于当前对话了，我需要每一个对话都能查到所有课程日志」。
 * ⇒ 不再只取「本对话里那一篇」，而是：
 *   ① 永远附上本机课程清单（课名 / 时长 / 章节号 / 抓取时间），让模型知道有哪些课；
 *   ② 正文按优先级挑最多 3 篇带上：问题里点名的课 > 浏览器当前正在看的课 >
 *      本对话抓过的课 > 问题里的词在正文命中最多的课。
 * 这样任何对话都能问到所有已抓的课，而 token 又不会失控。
 */
/** chatId → 上一轮这通对话实际用了哪几节课（chapterId），用于多轮对话延续上下文 */
const lastContextByChat = new Map()

/**
 * 把问题切成关键词。
 * 中文没有空格，不能只按空格切（2026-10-22 踩过：整句 17 字被当成一个「词」，
 * 又因为长度 > 12 被过滤掉，结果一个关键词都没有）。
 * 做法：英文/数字整词 + 中文 3 字滑窗。
 */
function keywordsOf(text) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(/[A-Za-z0-9_]{2,}/g)) out.add(m[0].toLowerCase())
  for (const seg of s.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 3 <= seg.length; i++) out.add(seg.slice(i, i + 3))
  }
  return [...out].slice(0, 60)
}

/**
 * 从转写正文里挑出与问题最相关的若干段（保持原文顺序）。
 *
 * 2026-10-22 实测：题问「()是现在新出现的人工智能的研究方向」，正确依据是正文
 * [08:04]「现在还有一个新的人工智能的一个研究方向」→ [08:09] Brain Inspired AI，
 * 而模型每次都被前面 [01:25] 那段吸走、答成「人工神经元网络」。
 * 把命中片段单独列一遍放到 prompt 里，模型才看得到那句话。
 */
function pickPassages(transcript, query, limit = 16) {
  const lines = String(transcript || '')
    .split('\n').map((s) => s.trim())
    .filter((s) => /^\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(s))
  if (!lines.length) return []
  const words = keywordsOf(query).filter((w) => w.length >= 2)
  if (!words.length) return []
  const scored = []
  for (const l of lines) {
    let n = 0
    for (const w of words) if (l.includes(w)) n++
    if (n > 0) scored.push({ l, n })
  }
  if (!scored.length) return []
  scored.sort((a, b) => b.n - a.n)
  const chosen = new Set(scored.slice(0, limit).map((x) => x.l))
  return lines.filter((l) => chosen.has(l))
}

function buildCourseContext({ chatId, messages, max = 3, forceChapterId = '' }) {
  const all = listCourseLogs()
  const q = String([...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '')
  const MAX = Math.max(1, Number(max) || 3)
  const picked = []
  const add = (m) => {
    if (m && picked.length < MAX && !picked.some((p) => p.file === m.file)) picked.push(m)
  }
  // 把问题切成关键词。
  // 中文没有空格，不能只按空格切（2026-10-22 踩过：整句 17 字被当成一个「词」，
  // 又因为长度 > 12 被过滤掉，结果一个关键词都没有）。
  // 做法：英文/数字整词 + 中文 3 字滑窗。
  const words = keywordsOf(q)

  // ① 问题里直接点名的课：用户说哪节就带哪节，优先级最高
  //    （2026-10-22 实测踩到的坑：先放「本对话关联课」会把槽位占满，
  //      于是在 A 课会话里问 B 课，B 课的正文反而带不进来）
  let named = 0
  // ⓪ 用户在输入框旁的下拉框里指定了课程：只带这一篇，完全不自动挑
  //    （2026-10-22 用户要求：「多加一个选择框，里面让用户选择课程，这样AI智能体回答就只回答对应课程的日志」）
  if (forceChapterId) {
    const one = all.find((l) => String(l.chapterId) === String(forceChapterId))
    if (one) {
      add(one)
      named = 1
    }
  } else {
    for (const l of all) {
      if (String(l.title || '').length < 2) continue
      if (q.includes(l.title) || words.some((w) => l.title.includes(w))) {
        add(l)
        named++
      }
    }
  }

  // ② 没点名时，沿用「上一轮这通对话实际用的课」。
  //    2026-10-22 实测 bug：第一轮问「人工智能的历史讲什么」答对了，
  //    紧接着问「有原稿吗，我想看看老师都说了什么」——这句里没有课名、
  //    Edge 不在前台时 tab 的 active 一直是 false、对话里又没有 course-log 消息，
  //    于是退到最后的关键词命中，把《五代机》当成了「当前这节课」，
  //    模型回「你提供的课程日志是《五代机》…」——同一对话前后自相矛盾。
  if (!named) {
    for (const cid of lastContextByChat.get(chatId) || []) {
      add(all.find((l) => l.chapterId === cid))
    }
  }

  // ③ 本对话抓过的课：用户在这个会话里明确抓过，比「浏览器当前标签页」更贴近他要问的东西。
  //    2026-10-22 实测 bug：在《人工神经元网络》会话里抓完课，发章节测验截图问「看看这张图」，
  //    因为浏览器 tab 还停在《符号人工智能》，旧③（浏览器当前）先占了唯一槽位（识图当时 max=1），
  //    模型就回「本次提供的课程正文只有《符号人工智能》一节…请你切换到《人工神经元网络》这一节」，
  //    用户当场质疑「如图不是已经抓取了吗，怎么还是显示没抓取」。
  if (!named) {
    try {
      const c = store.getChat(chatId)
      const recent = [...(c?.messages || [])]
        .filter((m) => m.kind === 'course-log' && m.lessonName)
        .slice(-2)
        .reverse()
      for (const m of recent) add(all.find((l) => l.title === m.lessonName))
    } catch { /* ignore */ }
  }

  // ④ 浏览器当前正在看的那节课：active 的优先；
  //    如果只有一个网课标签页，即使 active=false 也认（Edge 窗口在后台时 active 永远 false）
  //    只在还有空槽位时补，别把「本对话刚抓的课」挤掉
  if (!named && picked.length < MAX) {
    try {
      const tabs = (ext ? ext.state()?.lastHello?.tabs : null) || []
      const lessons = tabs.filter((t) => t.looksLesson)
      const tab = lessons.find((t) => t.active) || (lessons.length === 1 ? lessons[0] : null)
      if (tab) add(findCourseLogForUrl(tab.url))
    } catch { /* ignore */ }
  }

  // ⑤ 问题里的词在正文里命中最多的课（已经点名/已有线索时基本不补，避免串课；
  //    允许补的前提是命中至少 2 次，否则「有原稿吗」这种泛问会把别的课带进来）
  if (!named && words.length && picked.length < MAX) {
    const scored = all
      .map((l) => {
        let n = 0
        try {
          const t = fs.readFileSync(l.file, 'utf8')
          for (const w of words) n += t.split(w).length - 1
        } catch { /* ignore */ }
        return { l, n }
      })
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n)
    for (const x of scored) {
      add(x.l)
      if (picked.length >= MAX) break
    }
  }

  // 记住这一轮用的课，下一轮接着用（同一对话里追问「有原稿吗」之类不会换课）
  if (picked.length) {
    lastContextByChat.set(chatId, picked.map((p) => p.chapterId).filter(Boolean))
  } else {
    lastContextByChat.delete(chatId)
  }

  const lines = []
  try {
    appendAppLog(`[context] 选篇 ${picked.length} 篇：${picked.map((p) => p.title).join(' / ') || '(无)'}；点名 ${named}；问题词 ${words.join('|')}`)
  } catch { /* ignore */ }
  lines.push('【本机已保存的课程日志目录】（这只是目录，不是正文）')
  if (!all.length) {
    lines.push('（一篇都还没有：学生还没有用「📝 课程日志」抓过任何课）')
  } else {
    lines.push(`一共 ${all.length} 节：`)
    for (const l of all) {
      lines.push(`- 《${l.title}》${l.duration ? ' · 时长 ' + l.duration : ''}${l.chapterId ? ' · 章节 ' + l.chapterId : ''}${l.time ? ' · 抓于 ' + l.time : ''}`)
    }
  }

  if (picked.length) {
    lines.push('')
    if (forceChapterId) {
      lines.push(`【学生已指定】这次只按《${picked[0].title}》回答：不要引用其他课的日志，也不要建议「切换到本节」「请重新抓取」——这一节的正文已经在下面。`)
    }
    lines.push('【这次提供给你的课程正文】（只有下面这几篇有正文，目录里的其他课这次没有正文）')
    for (const l of picked) {
      const log = lessons.readLog(l.file)
      if (!log) continue
      lines.push('')
      lines.push(`### 《${l.title}》（时长 ${l.duration || '?'}，抓于 ${l.time || '未知'}）`)
      const t = log.transcript
      lines.push(t.length > 50000 ? t.slice(0, 50000) + '\n…（太长，已截断）' : t)
    }
    lines.push('')
    lines.push('注意：目录里有课名 ≠ 这次有正文。学生若问的是目录里另一节、而它不在上面这几篇里，就直接说这一节的正文这次没有带进来（让他切到那一节再问），不要说成「你提供的课程日志是另一篇」。')
  } else {
    lines.push('')
    lines.push('这次没有带上任何课程正文。如果学生问具体课程内容，先说明本机还没有这节的日志，不要凭空回答。')
  }

  lines.push('')
  lines.push(ANSWER_FORMAT)
  return { text: lines.join('\n'), picked }
}

function createWindow() {
  // 启动时恢复用户上次的关闭行为（2026-10-24 修复「不再提醒」不生效）
  restoreCloseBehavior()

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    title: '学习通学伴',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'))

  // 关键：用 showInactive 而不是 show —— 窗口显示出来但不抢焦点，
  // 这样你点应用时 Edge 仍保持激活，学习通播放不会因为失焦而暂停。
  win.once('ready-to-show', () => {
    win.showInactive()
  })

  // 外链走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(url) } catch { /* ignore */ }
    return { action: 'deny' }
  })

  /* 关闭行为：默认最小化到托盘（除非用户选了「退出程序」+「不再提醒」） */
  win.on('close', (e) => {
    if (closeRemember && closeAction === 'quit') return // 直接退
    if (closeRemember && closeAction === 'tray') {
      // 安全阀：托盘不存在时不许隐藏，否则又变成叫不出来的隐形进程
      if (!tray) {
        closeAction = 'quit'
        return
      }
      e.preventDefault()
      win.hide()
      try { win.setSkipTaskbar(false) } catch { /* ignore */ }
      return
    }
    // 未记住选择：弹窗问一次
    e.preventDefault()
    askCloseChoice()
  })

  /**
   * 最小化行为：**就是普通最小化**，不要 hide()。
   *
   * 2026-10-22 教训：之前这里调了 `win.hide()`，
   * 但 hide 之后 `setSkipTaskbar(false)` 也不生效（隐藏窗口本来就不在任务栏），
   * 结果窗口既看不见、任务栏也没有、而托盘又没注册成功
   * ⇒ 变成一个**谁都叫不出来的隐形进程**，用户再启动只看到「已在运行」却找不到窗口。
   *
   * 所以：最小化交给系统默认行为（收进任务栏），窗口始终有可见入口。
   * 真要「收进托盘」的场景，应该由用户点 × 时的选择框决定，而不是最小化按钮。
   */
  win.on('minimize', () => {
    // 不拦截、不 hide。保持任务栏存在，用户随时点得回来。
    try { win.setSkipTaskbar(false) } catch { /* ignore */ }
  })

  // 从托盘恢复时，把窗口重新显示出来（hide() 后 show() 需要 focus）
  win.on('show', () => { /* 占位：Electron 已处理 */ })

  win.on('closed', () => { win = null })
}

/** 关闭时的选择弹窗（对应界面截图里的「关闭设置」） */
function askCloseChoice() {
  if (!win) return

  const dlg = new BrowserWindow({
    width: 460, height: 400,
    parent: win, modal: true, show: false,
    resizable: false, minimizable: false, maximizable: false,
    backgroundColor: '#1b1c1f',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(APP_DIR, 'close-dialog.js'),
    },
  })

  // 2026-10-22 修掉的时序 bug：原来主进程每 300ms 轮询 window.__closeResult，
  // 用户点得快时弹窗先 close、轮询没赶上 ⇒ apply(undefined) ⇒ 什么也不做，
  // 表现成「点最小化/退出都没反应」。改成页面主动 ipc 上报，结果只可能到一次。
  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    ipcMain.removeListener('close-dialog:result', onResult)
    try { if (!dlg.isDestroyed()) dlg.close() } catch { /* ignore */ }
    applyCloseChoice(result)
  }
  const onResult = (event, result) => {
    if (event.sender !== dlg.webContents) return // 只认这个弹窗发来的
    finish(result)
  }
  ipcMain.on('close-dialog:result', onResult)

  dlg.on('closed', () => finish(null)) // 直接关掉弹窗 = 取消
  dlg.loadFile(path.join(APP_DIR, 'renderer', 'close-dialog.html'))
  dlg.once('ready-to-show', () => dlg.show())
}

/** 把弹窗里的选择落到实际行为（最小化到托盘 / 退出 / 开机自启） */
function applyCloseChoice(result) {
  if (!result) return // 取消：什么都不做
  closeAction = result.act === 'quit' ? 'quit' : 'tray'
  closeRemember = Boolean(result.remember)
  try { setAutoStart(Boolean(result.autostart)) } catch { /* ignore */ }
  // ★ 持久化（2026-10-24 修复「保存设置不再提醒不生效」）
  persistCloseBehavior()
  if (closeAction === 'quit') {
    try { app.quit() } catch { /* ignore */ }
    return
  }
  // 安全阀：没有托盘就不能藏起来，否则用户再也找不到窗口
  if (!tray) { try { app.quit() } catch { /* ignore */ } return }
  try { win.hide() } catch { /* ignore */ }
  try { win.setSkipTaskbar(false) } catch { /* ignore */ }
}

/** 开机自启开关（写注册表） */
function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath })
    return true
  } catch { return false }
}

/**
 * 加载托盘图标。
 *
 * 2026-10-22 关键排查结论：
 *   `nativeImage.createFromBuffer(拼的像素)` 得到的图 **isEmpty=false、32x32、PNG 456字节**，
 *   `new Tray(icon)` 也不报错，但 **注册表 `HKCU:\Control Panel\NotifyIconSettings` 里
 *   根本查不到这个应用的托盘项** —— 说明图标没被系统真正接纳。
 *   改用**真实 .ico 文件**（assets/tray.ico）加载，这是 Windows 托盘最稳的格式。
 */
function loadTrayIcon() {
  const candidates = [
    path.join(APP_DIR, 'assets', 'tray.ico'),
    path.join(APP_DIR, 'assets', 'tray.png'),
  ]
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) {
        console.log(`[study-buddy] 托盘图标已加载: ${p} (${JSON.stringify(img.getSize())})`)
        return img
      }
      console.error(`[study-buddy] 图标文件存在但为空: ${p}`)
    } catch (e) {
      console.error(`[study-buddy] 加载图标失败 ${p}:`, e?.message || e)
    }
  }
  // 兜底：程序生成
  console.error('[study-buddy] 没有可用的图标文件，回退到程序生成的图标')
  return buildTrayIcon(1)
}
function buildTrayIcon(badge) {
  try {
    const size = 32
    const buf = Buffer.alloc(size * size * 4)
    const set = (x, y, r, g, b, a) => {
      const i = (y * size + x) * 4
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a // BGRA
    }
    const inRounded = (x, y) => {
      const m = 3
      if (x < m && y < m) return (m - x) ** 2 + (m - y) ** 2 <= m * m
      if (x > size - 1 - m && y < m) return (x - (size - 1 - m)) ** 2 + (m - y) ** 2 <= m * m
      if (x < m && y > size - 1 - m) return (m - x) ** 2 + (y - (size - 1 - m)) ** 2 <= m * m
      if (x > size - 1 - m && y > size - 1 - m) {
        return (x - (size - 1 - m)) ** 2 + (y - (size - 1 - m)) ** 2 <= m * m
      }
      return true
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!inRounded(x, y)) { set(x, y, 0, 0, 0, 0); continue }
        const t = (x + y) / (size * 2)
        set(x, y, Math.round(79 + (139 - 79) * t), Math.round(125 + (92 - 125) * t), Math.round(243 + (246 - 243) * t), 255)
      }
    }
    // 白色书本
    const pageTop = 9, pageBottom = 23
    for (let y = pageTop; y <= pageBottom; y++) {
      for (let x = 7; x <= 14; x++) {
        const edge = y === pageTop || y === pageBottom
        if (edge && x > 8 && x < 13) continue
        set(x, y, 255, 255, 255, 240)
      }
      for (let x = 18; x <= 25; x++) {
        const edge = y === pageTop || y === pageBottom
        if (edge && x > 19 && x < 24) continue
        set(x, y, 255, 255, 255, 200)
      }
    }
    // 角标小圆点：有多个实例时变橙色，提示用户注意
    if (badge && badge > 1) {
      for (let y = 22; y < 30; y++) {
        for (let x = 22; x < 30; x++) {
          const d2 = (x - 25.5) ** 2 + (y - 25.5) ** 2
          if (d2 <= 12) set(x, y, 255, 170, 60, 255)
        }
      }
    }
    const img = nativeImage.createFromBuffer(buf, { width: size, height: size })
    return img.isEmpty() ? nativeImage.createEmpty() : img
  } catch {
    return nativeImage.createEmpty()
  }
}

/**
 * 加载托盘图标。
 *
 * 参照本机 DSH Desktop（同为 Electron，托盘正常）的做法：
 * 用**一组多倍率 PNG**（tray-icon.png / @1.25x / @1.5x / @2x），
 * Electron 会按系统 DPI 自动挑合适的那张。只有一个 32x32 时在高分屏上容易不显示。
 */
function loadTrayIcon() {
  // ① 多倍率 PNG（首选，参照 DSH）
  try {
    const base = path.join(APP_DIR, 'assets', 'tray-icon.png')
    if (fs.existsSync(base)) {
      const img = nativeImage.createFromPath(base)
      if (!img.isEmpty()) {
        console.log(`[study-buddy] 托盘图标(多倍率PNG): ${base}`)
        return img
      }
    }
  } catch (e) {
    console.error('[study-buddy] 多倍率 PNG 加载失败：', e?.message || e)
  }

  // ② .ico 文件
  try {
    const ico = path.join(APP_DIR, 'assets', 'tray.ico')
    if (fs.existsSync(ico)) {
      const img = nativeImage.createFromPath(ico)
      if (!img.isEmpty()) {
        console.log(`[study-buddy] 托盘图标(ico): ${ico}`)
        return img
      }
    }
  } catch { /* ignore */ }

  // ③ 程序生成兜底
  console.error('[study-buddy] 没有可用图标文件，回退到程序生成')
  return buildTrayIcon(1)
}

/** 系统托盘：显示运行状态，并允许重新打开 / 退出 */
function createTray() {
  try {
    if (tray) return
    const icon = loadTrayIcon()

    try {
      const png = icon.toPNG()
      console.log(`[study-buddy] 准备创建托盘 isEmpty=${icon.isEmpty()} size=${JSON.stringify(icon.getSize())} pngBytes=${png.length}`)
    } catch { /* ignore */ }

    tray = new Tray(icon)
    tray.setToolTip('学习通学伴 · 运行中')
    updateTray()
    tray.on('click', () => { showWindow() })
    tray.on('double-click', () => { showWindow() })

    console.log('[study-buddy] 托盘已创建')
  } catch (e) {
    console.error('[study-buddy] 托盘创建失败：', e?.message || e)
  }
}

/** 刷新托盘提示与菜单 */
function updateTray() {
  try {
    if (!tray) return
    tray.setToolTip('学习通学伴 · 运行中（可从右下角托盘区打开）')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '学习通学伴 · 运行中', enabled: false },
      { type: 'separator' },
      { label: '打开学习通学伴', click: () => { showWindow() } },
      { type: 'separator' },
      { label: '退出', click: () => { try { app.quit() } catch { /* ignore */ } } },
    ]))
  } catch { /* ignore */ }
}

/** 从托盘恢复窗口 */
function showWindow() {
  try {
    if (!win || win.isDestroyed()) { createWindow(); return }
    if (!win.isVisible()) win.show()
    win.setSkipTaskbar(false)
    win.restore?.()
    win.focus()
  } catch { /* ignore */ }
}

/* ───────────────────────── IPC ───────────────────────── */

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  dataDir: DATA_DIR,
  notesDir: NOTES_DIR,
}))

/** 渲染层日志落盘，用于排查「按钮点不动」这类静默失败 */
ipcMain.handle('app:log', async (_e, msg) => {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    fs.appendFileSync(path.join(DATA_DIR, 'renderer.log'), line, 'utf8')
  } catch { /* ignore */ }
  return { ok: true }
})

ipcMain.handle('app:quit', async () => {
  try { app.quit() } catch { /* ignore */ }
  return { ok: true }
})

ipcMain.handle('app:hideToTray', async () => {
  try { if (win) win.hide() } catch { /* ignore */ }
  return { ok: true }
})

// 会话持久化
ipcMain.handle('chats:list', async () => store.listChats())
ipcMain.handle('chats:get', async (_e, { id }) => store.getChat(id))
ipcMain.handle('chats:create', async (_e, payload) => store.createChat(payload))
ipcMain.handle('chats:rename', async (_e, { id, title }) => store.renameChat({ id, title }))
ipcMain.handle('chats:delete', async (_e, { id }) => store.deleteChat({ id }))
ipcMain.handle('chats:append', async (_e, { id, message }) => store.appendMessage({ id, message }))
ipcMain.handle('chats:markCapture', async (_e, { id, lesson }) => store.markCapture({ id, lesson }))

// 设置
ipcMain.handle('settings:load', async () => readSettings())
ipcMain.handle('settings:save', async (_e, patch) => writeSettings(patch || {}))
// 一键测试：用界面上当前填的地址/模型/Key 真实请求一次，不落盘
ipcMain.handle('settings:test', async (_e, payload) => {
  const r = await testConnection(payload || {})
  appendAppLog(`[settings:test] ok=${r.ok} status=${r.status || '-'} ${r.ms}ms ${r.model || ''} ${r.error || ''}`)
  return r
})
// 已抓过的课程清单：渲染层用它给「选择浏览器」列表打「已抓过」标记
ipcMain.handle('logs:list', async () => ({
  ok: true,
  dir: NOTES_DIR,
  logs: listCourseLogs().map((l) => ({
    chapterId: l.chapterId,
    title: l.title,
    course: l.course || '',
    duration: l.duration,
    segments: l.segments,
    time: l.time,
    file: l.file,
  })),
}))

// 章节测验作答依据：界面加载时拉一次最近记录，让用户能看到历史作答依据
ipcMain.handle('quiz:recent', async () => ({
  ok: true,
  items: quizEvidenceList.slice(0, 20),
}))

// ── 转写环境（faster-whisper）检查与一键安装 ──
function transcribePaths() {
  const pyenv = path.join(TOOLS_DIR, 'pyenv')
  return {
    tools: TOOLS_DIR,
    py: path.join(pyenv, 'Scripts', 'python.exe'),
    pyenv,
    script: path.join(TOOLS_DIR, 'transcribe.py'),
    setup: path.join(TOOLS_DIR, 'setup-transcribe.ps1'),
    modelDir: path.join(TOOLS_DIR, 'models', 'large-v3-turbo'),
  }
}

ipcMain.handle('transcribe:status', async () => {
  const p = transcribePaths()
  const out = {
    tools: p.tools,
    py: fs.existsSync(p.py),
    script: fs.existsSync(p.script),
    setup: fs.existsSync(p.setup),
    model: fs.existsSync(path.join(p.modelDir, 'model.bin')),
    version: '',
    ok: false,
  }
  if (out.py) {
    // 注意：这里必须用异步 execFile。execFileSync 会卡住主进程（实测打开设置页要等 Python 冷启动好几秒）
    out.version = await new Promise((resolve) => {
      execFile(
        p.py,
        ['-c', 'import faster_whisper;print(faster_whisper.__version__)'],
        { timeout: 25000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            appendAppLog(`[transcribe:status] 导入 faster_whisper 失败：${err.message}`)
            resolve('')
          } else {
            resolve(String(stdout).trim())
          }
        }
      )
    })
  }
  out.ok = out.py && out.script && out.model && !!out.version
  return out
})

let transcribeSetupProc = null

ipcMain.handle('transcribe:setup', async (event) => {
  if (transcribeSetupProc) return { ok: false, error: '安装已经在进行中，请等它跑完。' }
  const p = transcribePaths()
  if (!fs.existsSync(p.setup)) {
    return { ok: false, error: `找不到安装脚本：${p.setup}\n请确认 tools\\setup-transcribe.ps1 还在。` }
  }
  appendAppLog(`[transcribe:setup] 启动 ${p.setup}`)
  const send = (line) => {
    try { event.sender.send('transcribe:setup-log', line) } catch { /* 窗口可能已关 */ }
  }
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p.setup],
    { cwd: TOOLS_DIR, windowsHide: true }
  )
  transcribeSetupProc = child
  const pipe = (stream) => stream.on('data', (buf) => {
    String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) send(l) })
  })
  pipe(child.stdout)
  pipe(child.stderr)
  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c))
    child.on('error', (err) => { send(`[失败] 启动 PowerShell 出错：${err.message}`); resolve(-1) })
  })
  transcribeSetupProc = null
  appendAppLog(`[transcribe:setup] 结束 code=${code}`)
  return { ok: code === 0, code }
})

// 浏览器发现与选择
ipcMain.handle('browsers:list', async () => {  try {
    return { ok: true, browsers: await listBrowsers() }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), browsers: [] }
  }
})

// 启动专用浏览器（绝不碰用户日常浏览器）
ipcMain.handle('browsers:launch', async (_e, { browserId, url, fresh }) => {
  try {
    const r = await launchDedicated({ browserId: browserId || 'edge', url, fresh })
    return { ok: true, ...r }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

ipcMain.handle('browsers:closeDedicated', async () => {
  try {
    const r = await closeDedicated('edge')
    return { ok: true, ...r }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

// 打开学习通登录页到专用浏览器里
ipcMain.handle('browsers:openLogin', async () => {
  try {
    await launchDedicated({ browserId: 'edge', url: 'https://i.chaoxing.com' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

// 课程日志：抓取 + 分析
ipcMain.handle('capture:start', async (event, { chatId, browserId, tabId, via, reuse = true }) => {
  if (currentCapture) return { ok: false, error: '已有抓取任务在进行中' }
  const sender = event.sender
  const send = (type, payload) => {
    try { if (!sender.isDestroyed()) sender.send('capture:event', { type, ...payload }) } catch { /* ignore */ }
    if (type === 'stage') appendAppLog(`[capture:stage] ${payload?.stage} ${payload?.text || ''}`)
  }

  currentCapture = { chatId, browserId, tabId, via, startedAt: Date.now() }
  appendAppLog(`[capture:start] chatId=${chatId} via=${via || '(空)'} browserId=${browserId || '(空)'} tabId=${tabId || '(空)'}`)
  try {
    // 优先走浏览器扩展（不需要调试端口）
    const useExt = (via === 'extension' || tabId) && ext
    appendAppLog(`[capture] 分支=${useExt ? '扩展(无需调试端口)' : 'CDP 调试端口'} ext=${ext ? 'ready' : 'null'}`)
    let result

    if (useExt) {
      send('stage', { stage: 'connect', text: '正在通过浏览器插件连接当前页面…' })
      result = await captureLessonViaExtension({
        ext,
        tabId,
        notesDir: NOTES_DIR,
        onStage: (stage, text) => send('stage', { stage, text }),
        reuse: reuse !== false,
      })
    } else {
      send('stage', { stage: 'connect', text: '正在连接你选择的浏览器…' })
      const conn = await attachToBrowser(browserId)
      result = await captureLesson({
        conn,
        notesDir: NOTES_DIR,
        onStage: (stage, text) => send('stage', { stage, text }),
        onPartial: (chunk) => send('partial', { text: chunk }),
      })
    }

    send('stage', { stage: 'done', text: `已保存到本地：${result.file}` })
    appendAppLog(`[capture:done] file=${result.file} lesson=${result.lessonName || ''} course=${result.courseName || '(未识别)'} segments=${result.segments ?? '?'}`
      + (result.courseName ? '' : ` candidates=${JSON.stringify(result.courseCandidates || {}).slice(0, 300)}`))
    currentCapture = null
    return { ok: true, ...result }
  } catch (e) {
    const msg = String(e?.message || e)
    appendAppLog(`[capture:error] ${msg}\n${e?.stack || ''}`)
    send('stage', { stage: 'error', text: `抓取失败：${msg}` })
    currentCapture = null
    return { ok: false, error: msg }
  }
})

ipcMain.handle('capture:cancel', async () => {
  currentCapture = null
  return { ok: true }
})

// AI 对话
ipcMain.handle('ai:chat', async (event, { chatId, messages, image, forceCourse }) => {
  const sender = event.sender
  const send = (type, payload) => {
    try { if (!sender.isDestroyed()) sender.send('ai:event', { type, ...payload }) } catch { /* ignore */ }
  }
  try {
    const list = Array.isArray(messages) ? messages.slice() : []
    const img = (typeof image === 'string' && image.length > 100) ? image : ''

    // 识图拆两步：①视觉模型只负责「逐字抄图」 ②文字模型拿抄下来的题目 + 检索到的正文作答。
    // 直接让视觉模型边看边答时，实测会把选项字母对错位（第 4 题 A、C、D 答成 A、B、D），
    // 而且题目里的词进不了关键词检索，正文里「新出现的研究方向」这类句子根本带不出来。
    let model = null
    let ocrText = ''
    if (img) {
      const ocr = await recognizeImage(img)
      if (ocr.ok && ocr.text) {
        ocrText = ocr.text
        appendAppLog(`[ai:ocr] ${ocr.ms || 0}ms 抄下 ${ocrText.length} 字`)
      } else {
        appendAppLog(`[ai:ocr] 失败（${ocr.error}），退回直接识图`)
      }
    }

    if (img && !ocrText) {
      // 兜底：抄字失败就直接把图交给视觉模型（普通文本模型收到图片会报「不支持」）
      const s = readSettings()
      model = String(s.visionModel || 'qwen3-vl-plus').trim() || 'qwen3-vl-plus'
      const last = list[list.length - 1]
      const textPart = typeof last.content === 'string' ? last.content : ''
      list[list.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: textPart || '请看看这张图，结合这节课的内容讲解一下。' },
          { type: 'image_url', image_url: { url: img } },
        ],
      }
    } else if (ocrText) {
      // 抄字成功：题目变成纯文本（不传图，省 token 也更快），关键词检索能命中题目里的词
      const last = list[list.length - 1]
      const textPart = typeof last.content === 'string' ? last.content : ''
      list[list.length - 1] = {
        role: 'user',
        content: `【下面是我从图片里抄下来的文字】\n${ocrText}\n\n【我的问题】${textPart || '请据此作答'}`,
      }
    }

    // 选课时只用纯文本（带图消息的 content 是数组，不能当关键词切）
    const plain = list.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : ((Array.isArray(m.content) && m.content.find((c) => c.type === 'text')?.text) || ''),
    }))

    // 上下文由主进程统一构建：不限本对话，所有已抓课程都可用（见 buildCourseContext）
    // 识图时只带 1 篇（图片本身已经占了不少 token，而且图多半就是当前这节）
    // 识图给 2 篇：第一篇是本对话刚抓的课（通常就是图里的那节课），第二篇留给浏览器当前页。
    // 2026-10-22 实测：只给 1 篇时，tab 恰好停在同一门课的别的小节，模型就答「图片对应的课没抓」。
    const ctx = buildCourseContext({
      chatId,
      messages: plain,
      max: image ? 2 : 3,
      forceChapterId: String(forceCourse || '').trim(),
    })
    const sys = ctx.text

    // 识图答题时，把「按题目关键词命中的原文片段」单独再列一遍。
    // 原因见 pickPassages 注释：正文太长，模型会漏掉关键的那一句。
    let passageNote = ''
    if ((ocrText || '') && ctx.picked && ctx.picked.length) {
      try {
        // 只用「题干」做关键词：选项里的词（例如一堆「人工神经元网络」）会把正文里
        // 真正关键的那句挤下去（2026-10-22 实测：[08:04]「现在还有一个新的人工智能的一个研究方向」
        // 在命中列表里排到第 13 位，前面全是 [01:25] 那批同名词）。
        const stem = String(ocrText).split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !/^[A-Da-d][\s.、)）]/.test(s))
          .join('\n')
        const log = lessons.readLog(ctx.picked[0].file)
        const seg = pickPassages(log.transcript, stem || ocrText, 14)
        if (seg.length) {
          passageNote = '\n\n【按题目关键词在本课正文里命中的原文片段（按原文顺序，最相关的都在里面）】\n'
            + seg.join('\n')
            + '\n\n（作答时优先核对这些片段；但结论仍然只能来自正文。）'
          appendAppLog(`[ai:passages] 命中 ${seg.length} 段`)
        } else {
          appendAppLog('[ai:passages] 没有命中片段')
        }
      } catch (e) { appendAppLog(`[ai:passages] 出错：${e.message}`) }
    }
    const imageNote = img
      ? (ocrText
        ? '\n\n【关于这张图片】学生发来一张图，上面那段文字是从图里逐字抄下来的（可能是测验题、课件、板书）。'
          + '请严格依据【课程正文】和这段抄下来的文字作答；抄写可能有错别字，遇到明显对不上的词按读音/字形找正文里的同类词。'
          + '如果图里是题目，先写题号和答案（字母后面补上选项原文），再用一句话说明理由并标时间戳。'
        : '\n\n【关于这张图片】学生随问题发来一张图。请结合图片内容回答。'
          + '如果图和本课日志无关，就直接就图分析，不要硬扯课程内容。'
          + '如果图里是题目（选择题/判断题），请把每道题的正确答案和理由都告诉他。'
          + '不要输出「[无时间戳]」这类占位标记，也不要硬加时间戳。')
      : ''
    const withCtx = sys ? [{ role: 'system', content: sys + passageNote + imageNote }, ...list] : list
    const reply = await chat({ messages: withCtx, onDelta: (t) => send('delta', { text: t }), model })
    // 把「这一轮依据了哪几篇」回传渲染层，用于回答下方显示「依据」与「打开原稿」
    const context = (ctx.picked || []).map((p) => ({ title: p.title, chapterId: p.chapterId, file: p.file, duration: p.duration }))
    if (img) appendAppLog(`[ai:vision] 识图提问 model=${model || '(文字模型)'} ocr=${Boolean(ocrText)} imageKB≈${Math.round(img.length / 1024)}`)
    return { ok: true, reply, context, vision: Boolean(img), ocr: Boolean(ocrText), model }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

ipcMain.handle('shell:openPath', async (_e, p) => {
  try { await shell.openPath(p); return { ok: true } } catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('dialog:pickNotesDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

/* ───────────────────── 浏览器扩展通道 ───────────────────── */

/** 扩展是否已连上 */
ipcMain.handle('ext:status', async () => {
  const st = ext ? ext.state() : { lastHello: null, jobs: [] }
  const hello = st.lastHello
  return {
    ok: true,
    port: extPort,
    listening: Boolean(ext),
    connected: Boolean(hello && Date.now() - hello.at < 10000),
    hello,
    tabs: (hello && Array.isArray(hello.tabs)) ? hello.tabs : [],
  }
})

/** 让扩展重新报一次心跳（用户点了「重连」） */
ipcMain.handle('ext:reconnect', async () => {
  return { ok: true, port: extPort }
})

/** 列出扩展能看到的课程页 */
ipcMain.handle('ext:tabs', async () => {
  const st = ext ? ext.state() : { lastHello: null }
  const tabs = (st.lastHello && Array.isArray(st.lastHello.tabs)) ? st.lastHello.tabs : []
  return { ok: true, tabs, connected: Boolean(st.lastHello && Date.now() - st.lastHello.at < 10000) }
})

/** 通过扩展探测某个标签页 */
ipcMain.handle('ext:probe', async (_e, { tabId }) => {
  if (!ext) return { ok: false, error: '扩展服务未启动' }
  return new Promise((resolve) => {
    const id = ext.enqueue('probe', {
      tabId,
      timeoutMs: 20000,
      onUpdate: (job) => {
        if (job.status === 'done') resolve({ ok: true, result: job.result })
        else if (job.status === 'failed') resolve({ ok: false, error: job.error || '探测失败' })
        ext.clearFinished()
      },
    })
    if (!id) resolve({ ok: false, error: '任务入队失败' })
  })
})

/* ───────────────────────── 生命周期 ───────────────────────── */

app.whenReady().then(async () => {
  // 启动自检：主进程到底能往哪些目录写文件（EPERM 排查用）
  try {
    const { probeDirs } = require('./core/probe-dirs')
    const results = probeDirs()
    console.log('[study-buddy] 目录写权限自检：')
    for (const r of results) {
      console.log(`  ${r.mkdir}/${r.write}/${r.rename}  ${r.dir}${r.error ? '  (' + r.error + ')' : ''}`)
    }
  } catch (e) {
    console.error('[study-buddy] 目录自检失败：', e?.message || e)
  }

  ensureDirs()

  // 单实例判据：能否独占 39517。被占=已有实例在跑。
  const claim = await tryClaimPort(extPort)
  if (!claim.ok) {
    // 已有实例：**先让它把窗口显示出来**，再提示用户，而不是干等一个看不见的进程
    let woke = false
    try {
      const res = await fetch(`http://127.0.0.1:${extPort}/app/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      })
      woke = res.ok
    } catch { /* 唤醒失败就走提示 */ }

    if (!woke) {
      try {
        dialog.showMessageBoxSync({
          type: 'warning',
          title: '学习通学伴已在运行',
          message: '已经有一个「学习通学伴」在运行，但没能把它的窗口叫出来。',
          detail:
            '可能是它以隐藏状态留在后台。\n\n' +
            '请用任务管理器结束所有「electron」进程，然后重新双击桌面快捷方式。',
          buttons: ['好'],
        })
      } catch { /* ignore */ }
    }
    try { app.quit() } catch { /* ignore */ }
    return
  }

  // 探测成功后立刻释放，避免和下面的正式监听冲突
  try {
    await new Promise((r) => claim.server.close(() => r()))
  } catch { /* ignore */ }

  try {
    ext = createExtServer({ port: extPort })
    await ext.listen()
    // 注册「唤醒」处理器：副实例打过来时把窗口叫出来
    ext.setShowHandler(() => {
      try {
        if (!win || win.isDestroyed()) { createWindow(); return }
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.setSkipTaskbar(false)
        win.focus()
        // 强制置前（Windows 有时会拒绝 focus，用 setAlwaysOnTop 闪一下拉回前台）
        try {
          win.setAlwaysOnTop(true)
          setTimeout(() => { try { win.setAlwaysOnTop(false) } catch { /* ignore */ } }, 1200)
        } catch { /* ignore */ }
      } catch { /* ignore */ }
    })
    console.log(`[study-buddy] 扩展服务已监听 127.0.0.1:${extPort}（单实例守护）`)
  } catch (e) {
    console.error('[study-buddy] 扩展服务启动失败：', e?.message || e)
  }

  // 注册页内问答处理器：扩展的面板直接调，用户不用切窗口
  if (ext) {
    ext.setAskHandler(async (question, meta) => {
      const hit = findCourseLogForUrl(meta?.url)
      if (!hit) {
        appendAppLog(`[ask] 当前页面没有对应课程日志 url=${meta?.url || '(空)'}`)
        return '这节课我这里还没有课程日志，我不能拿别的课的内容来回答你。\n\n请回到「学习通学伴」应用，点「📝 课程日志」把这一节抓一次（大约 1～2 分钟），抓完再问我。'
      }
      let context = ''
      try { context = fs.readFileSync(hit.file, 'utf8').slice(0, 60000) } catch { /* ignore */ }
      appendAppLog(`[ask] 用课程日志《${hit.title}》chapterId=${hit.chapterId}`)
      const messages = [
        {
          role: 'system',
          content: `以下是学生正在学习的课程日志（原样转写，未加工）。请只依据它回答，引用具体内容时附上时间戳；日志里没有的内容就直接说没有，不要编。\n\n课程：${hit.title}\n\n${ANSWER_FORMAT}\n\n${context}`,
        },
        { role: 'user', content: question },
      ]
      return await chat({ messages })
    })

    // 面板提问前先问这个：把「识别到哪节课」直接显示给学生看
    ext.setCourseHandler(async (url) => {
      const hit = findCourseLogForUrl(url)
      if (!hit) {
        return {
          matched: false,
          logs: listCourseLogs().slice(0, 8).map((l) => ({ title: l.title, chapterId: l.chapterId })),
        }
      }
      return {
        matched: true,
        lessonName: hit.title,
        duration: hit.duration,
        chapterId: hit.chapterId,
        file: path.basename(hit.file),
      }
    })

    // 章节测验作答：扩展把抓到的题目交上来，这里用课程日志 + AI 出答案
    ext.setQuizAnswerHandler(handleQuizAnswer)

    // 自动抓日志：扩展点「一键播放答题」时自动抓当前页面那节课，不用用户手动操作
    ext.setAutoCaptureHandler(handleAutoCapture)

    // 交卷回执：扩展把「实际交了什么」报回来，留档供用户事后核对
    ext.setQuizSubmittedHandler(async ({ body }) => {
      const ev = {
        at: new Date().toISOString(),
        source: 'extension',
        chapterId: String(body?.chapterId || ''),
        workId: String(body?.workId || ''),
        lesson: String(body?.lesson || ''),
        logFile: String(body?.logFile || ''),
        answers: Array.isArray(body?.answers) ? body.answers : [],
      }
      pushQuizEvidence(ev)
      broadcastQuizEvent('submitted', {
        text: `测验已交卷：《${ev.lesson || '未知名'}》${ev.answers.length} 题`,
        evidence: ev,
      })
      appendAppLog(`[quiz] 交卷回执 chapterId=${ev.chapterId} workId=${ev.workId} 题数=${ev.answers.length}`)
      return { ok: true }
    })
  }

  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * 窗口全关时的行为。
 *
 * 2026-10-22 教训：之前无条件「不退出」，本意是留在托盘。
 * 但**托盘没创建成功时**（或用户没在用托盘），窗口关光而进程不退
 * ⇒ 变成没有窗口、没有托盘入口、又占着端口的僵尸进程，
 *   之后再启动只看到「已在运行」却什么都打不开。
 *
 * 正确逻辑：**有托盘才常驻，没托盘就正常退出。**
 */
app.on('window-all-closed', () => {
  if (tray && closeRemember && closeAction === 'tray') {
    // 用户明确选择了「最小化到托盘」且托盘确实存在 → 常驻
    return
  }
  // 否则正常退出，绝不留僵尸进程
  try { app.quit() } catch { /* ignore */ }
})

app.on('before-quit', async () => {
  closeRemember = true
  closeAction = 'quit'
  try { if (ext) await ext.close() } catch { /* ignore */ }
  // 销毁托盘图标，避免任务栏残留幽灵图标
  try { if (tray) { tray.destroy(); tray = null } } catch { /* ignore */ }
})
