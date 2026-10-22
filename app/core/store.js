/**
 * 本地存储：对话、消息、抓取记录全部落地成 JSON，不联网也不同步。
 *
 * 用户的界面要求（docx 原话）：
 *   「左边新建对话和对话保留区域可以模仿照搬，方便学生用户寻找历史课程对话内容」
 *   「第一次新建对话肯定是显示默认名『新对话』，等用户真实使用其抓取课程内容时，再把对话名称自动更改成网课课程名」
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * 数据目录由 core/paths.js 统一解析（<root>\data）。
 *
 * 以前用「%LOCALAPPDATA% 写不进就退 app\_data」的探测式选择，
 * 结果是同一台机器上两套 chats.json 并存、用户找不到自己的会话。
 * 现在只有一个确定位置；沙箱里启动时 paths.js 自己会退到 app\_data。
 */
const { DATA_DIR } = require('./paths')

const FILE = path.join(DATA_DIR, 'chats.json')

/** 旧版位置（Roaming），用于首次迁移 */
const LEGACY_FILE = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'study-buddy', 'study-buddy', 'chats.json',
)

function ensure() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
}

function readAll() {
  ensure()
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const j = JSON.parse(raw)
    if (j && Array.isArray(j.chats)) return j
  } catch { /* 首次运行或损坏，试旧位置 */ }

  // 兼容迁移：旧版在 Roaming，读到就搬到新位置
  try {
    const raw = fs.readFileSync(LEGACY_FILE, 'utf8')
    const j = JSON.parse(raw)
    if (j && Array.isArray(j.chats)) {
      try { writeAll(j) } catch { /* ignore */ }
      return j
    }
  } catch { /* 都没有 */ }

  return { version: 1, chats: [] }
}

/**
 * 原子写入：先写 .tmp 再 rename。
 *
 * 2026-10-21 遇到过 `EPERM: open chats.json.tmp`——根因是两个应用实例同时跑，
 * 抢同一个 tmp 文件。除了加单实例锁，这里也加重试兜底：
 * ①tmp 文件名带 pid，避免多实例撞同一个文件；②失败重试几次。
 */
function writeAll(db) {
  ensure()
  const pid = process.pid || 0
  const tmp = `${FILE}.${pid}.tmp`
  const text = JSON.stringify(db, null, 2)

  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, FILE)
      return
    } catch (e) {
      lastErr = e
      // 清理残留，退避重试
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      const wait = 20 * (attempt + 1)
      const until = Date.now() + wait
      while (Date.now() < until) { /* 极短自旋，避免引入异步改动 */ }
    }
  }

  // 最后兜底：直接覆盖写目标文件（放弃原子性，但至少不丢数据）
  try {
    fs.writeFileSync(FILE, text, 'utf8')
    return
  } catch { /* 放弃写入 */ }

  throw lastErr || new Error('写入 chats.json 失败')
}

const now = () => Date.now()
const uid = () => crypto.randomUUID()

const store = {
  /** 列表：按「最近活动」倒序，界面左侧按时间分组展示 */
  listChats() {
    const db = readAll()
    return db.chats
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: (c.messages || []).length,
        lesson: c.lesson || null,
        /** 只在用户没手动改过名时，才允许自动改名 */
        titleAuto: c.titleAuto !== false,
      }))
  },

  createChat({ title } = {}) {
    const db = readAll()
    const chat = {
      id: uid(),
      title: title || '新对话',
      titleAuto: true,
      messages: [],
      lesson: null,
      createdAt: now(),
      updatedAt: now(),
    }
    db.chats.push(chat)
    writeAll(db)
    return chat
  },

  renameChat({ id, title, manual = true }) {
    const db = readAll()
    const c = db.chats.find((x) => x.id === id)
    if (!c) return null
    c.title = String(title || '新对话').slice(0, 80)
    if (manual) c.titleAuto = false
    c.updatedAt = now()
    writeAll(db)
    return c
  },

  deleteChat({ id }) {
    const db = readAll()
    const i = db.chats.findIndex((x) => x.id === id)
    if (i < 0) return false
    db.chats.splice(i, 1)
    writeAll(db)
    return true
  },

  appendMessage({ id, message }) {
    const db = readAll()
    const c = db.chats.find((x) => x.id === id)
    if (!c) return null
    c.messages.push({ ...message, at: message.at || now() })
    c.updatedAt = now()
    writeAll(db)
    return c
  },

  /** 抓取成功后：记录本课信息，并按用户规则自动改标题 */
  markCapture({ id, lesson }) {
    const db = readAll()
    const c = db.chats.find((x) => x.id === id)
    if (!c) return null
    c.lesson = lesson
    // 用户明确要求：首次真正抓取后把「新对话」改成课程名；手动改过名的不覆盖
    if (c.titleAuto !== false && (!c.title || c.title === '新对话' || c.titleAuto === true)) {
      c.title = String(lesson.lessonName || lesson.title || '课程对话').slice(0, 80)
    }
    c.updatedAt = now()
    writeAll(db)
    return c
  },

  getChat(id) {
    const db = readAll()
    return db.chats.find((x) => x.id === id) || null
  },
}

module.exports = { store, DATA_DIR }
