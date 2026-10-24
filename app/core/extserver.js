/**
 * 给浏览器扩展用的本地 HTTP 服务。
 *
 * 为什么用 HTTP 而不是调试端口（CDP）：
 *   CDP 要求浏览器带 --remote-debugging-port 启动，普通用户不会这么干，
 *   而「已运行的浏览器无法事后加端口」——这是之前卡住的真正原因。
 *   扩展则天然住在用户日常浏览器里，只要反过来让应用开个口就行。
 *
 * 安全：只监听 127.0.0.1，校验 Origin 必须是 chrome-extension://。
 */
const http = require('node:http')
const crypto = require('node:crypto')

/** 默认端口（可用 settings 覆盖） */
const DEFAULT_PORT = 39517

/** 调试端点开关：默认关闭，需要时设 STUDY_BUDDY_DEBUG=1 开启 */
const DEBUG_ENDPOINTS = process.env.STUDY_BUDDY_DEBUG === '1'

/** 待办任务表：id → job */
const jobs = new Map()
/** 扩展最近一次心跳 */
let lastHello = null
/** 扩展最近一次上报的播放状态 */
let lastPlayState = null
/** 页内问答处理器（由 main.js 注入） */
let askHandler = null
/** 章节测验作答处理器（由 main.js 注入，见 docs/quiz-api-contract.md A 节） */
let quizAnswerHandler = null
/** 自动抓日志处理器（由 main.js 注入，见 docs/quiz-api-contract.md B 节） */
let autoCaptureHandler = null
/** 交卷回执处理器（由 main.js 注入）：扩展报回实际提交了什么，供留档核对 */
let quizSubmittedHandler = null
/** 自动抓取任务表：jobId → 进度对象（内存即可，抓取是一次性的） */
const autoCaptureJobs = new Map()
/** 当前页面对应哪节课（面板提问前先问一次，好把「识别到哪节课」显示给用户） */
let courseHandler = null
/** 唤醒窗口处理器（由 main.js 注入） */
let showHandler = null

function json(res, code, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch { /* 客户端已断开 */ }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); return resolve(null) }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** 只允许来自扩展的请求 */
function isExtensionRequest(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true // 扩展的 SW 发请求可能不带 Origin，放行（仍是 127.0.0.1）
  return origin.startsWith('chrome-extension://') || origin.startsWith('extension://')
}

function createExtServer({ port = DEFAULT_PORT, onLog, existingServer } = {}) {
  const log = (m) => { try { onLog && onLog(String(m)) } catch { /* ignore */ } }

  async function handler(req, res) {
    try {
      await handle(req, res)
    } catch (e) {
      // 兜底：任何未捕获异常都要以 JSON 形式回给调用方，
      // 否则扩展只看到「500 且 body 为空」，完全无法排查。
      try {
        json(res, 500, { ok: false, error: `服务端异常：${String(e?.message || e)}`, stack: String(e?.stack || '').split('\n').slice(0, 4) })
      } catch { /* 已经发过响应 */ }
      log(`请求处理异常 ${req.method} ${req.url}: ${e?.message || e}`)
    }
  }

  // 复用调用方已经绑定好的 server（用于「端口即单实例锁」的机制）
  const server = existingServer || http.createServer(handler)
  if (existingServer) existingServer.on('request', handler)

  async function handle(req, res) {
    if (!isExtensionRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname

    // 扩展心跳：顺便把「我看到了哪些标签页」报上来
    if (req.method === 'POST' && path === '/ext/hello') {
      const body = await readBody(req)
      lastHello = { ...(body || {}), at: Date.now() }
      log(`扩展已连接（${lastHello.version || '?'}），可见课程页 ${ (lastHello.tabs || []).length } 个`)
      return json(res, 200, { ok: true, server: { name: 'study-buddy', version: 1 } })
    }

    // 扩展来领任务
    if (req.method === 'POST' && path === '/ext/poll') {
      await readBody(req)
      for (const [id, job] of jobs) {
        if (job.dispatched) continue
        job.dispatched = true
        job.dispatchedAt = Date.now()
        return json(res, 200, { job: { id, type: job.type, tabId: job.tabId, args: job.args || undefined } })
      }
      return json(res, 200, { job: null })
    }

    // 扩展上报任务结果
    const m = /^\/ext\/job\/(.+)$/.exec(path)
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1])
      const body = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { ok: false, error: 'job not found' })
      job.status = body?.status || 'unknown'
      if (body?.result !== undefined) job.result = body.result
      if (body?.error) job.error = body.error
      if (job.status === 'done' || job.status === 'failed') job.finishedAt = Date.now()
      if (typeof job.onUpdate === 'function') {
        try { job.onUpdate(job) } catch { /* ignore */ }
      }
      return json(res, 200, { ok: true })
    }

    if (path === '/ext/status') {
      return json(res, 200, {
        ok: true,
        port,
        connected: Boolean(lastHello && lastHello.at && Date.now() - lastHello.at < 10000),
        lastHello,
        pendingJobs: [...jobs.values()].filter((j) => !j.finishedAt).length,
        jobs: [...jobs.values()].slice(-10).map((j) => ({
          id: j.id, type: j.type, status: j.status,
          error: j.error, hasResult: j.result !== undefined,
          createdAt: j.createdAt, finishedAt: j.finishedAt,
        })),
      })
    }

    // 调试端点：只在显式开启调试时可用（供命令行验证链路）
    if (DEBUG_ENDPOINTS) {
      if (req.method === 'POST' && path === '/ext/enqueue') {
        const body = await readBody(req)
        if (!body || !body.type) return json(res, 400, { ok: false, error: 'need type' })
        const id = crypto.randomUUID()
        const job = {
          id, type: body.type, tabId: body.tabId, args: body.args,
          status: 'pending', createdAt: Date.now(),
        }
        jobs.set(id, job)
        setTimeout(() => {
          if (!job.finishedAt) {
            job.status = 'failed'
            job.error = '扩展没有响应（超时）'
            job.finishedAt = Date.now()
          }
        }, Number(body.timeoutMs) || 20000)
        return json(res, 200, { ok: true, id })
      }

      const g = /^\/ext\/result\/(.+)$/.exec(path)
      if (req.method === 'GET' && g) {
        const job = jobs.get(decodeURIComponent(g[1]))
        if (!job) return json(res, 404, { ok: false, error: 'job not found' })
        return json(res, 200, {
          ok: true, id: job.id, type: job.type, status: job.status,
          error: job.error, result: job.result,
        })
      }
    }

    // 当前页面是哪节课：面板在提问前先调，把识别结果显示出来
    if (req.method === 'POST' && path === '/ext/course') {
      const body = await readBody(req)
      if (typeof courseHandler !== 'function') {
        return json(res, 503, { ok: false, error: '应用还没准备好（courseHandler 未注册）' })
      }
      try {
        const info = await courseHandler(body?.url || '')
        return json(res, 200, { ok: true, ...info })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message || e) })
      }
    }

    // 页内问答：扩展里的面板直接调这里，避免用户切窗口
    if (req.method === 'POST' && path === '/ext/ask') {
      const body = await readBody(req)
      const question = String(body?.question || '').trim()
      if (!question) return json(res, 400, { ok: false, error: 'question 不能为空' })

      if (typeof askHandler !== 'function') {
        return json(res, 503, { ok: false, error: '应用还没准备好回答（askHandler 未注册）' })
      }
      try {
        const reply = await askHandler(question, { context: body?.context || '', url: body?.url || '' })
        return json(res, 200, { ok: true, reply })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message || e) })
      }
    }

    // 章节测验作答：扩展把题目结构交上来，应用用课程日志 + AI 产出答案。
    // 契约见 docs/quiz-api-contract.md A 节；本文件只做协议校验与错误码映射，
    // 语义（找日志、调 AI、解析 JSON）在 main.js 注入的 handler 里。
    if (req.method === 'POST' && path === '/ext/quizAnswer') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'bad-request', message: '请求体不是合法 JSON' })
      }

      const url = String(body.url || '').trim()
      const questions = Array.isArray(body.questions) ? body.questions : null
      if (!url) {
        return json(res, 400, { ok: false, error: 'bad-request', message: 'url 不能为空' })
      }
      if (!questions || !questions.length) {
        return json(res, 400, { ok: false, error: 'bad-request', message: 'questions 不能为空' })
      }

      // 每题必须有 qid 与 options；题干允许是字符串或结构化对象（见契约 0.4.1）
      for (const q of questions) {
        if (!q || typeof q !== 'object') {
          return json(res, 400, { ok: false, error: 'bad-request', message: 'questions 元素必须是对象' })
        }
        if (!String(q.qid || '').trim()) {
          return json(res, 400, { ok: false, error: 'bad-request', message: '每道题必须有 qid' })
        }
        if (!Array.isArray(q.options) || !q.options.length) {
          return json(res, 400, { ok: false, error: 'bad-request', message: `题目 ${q.qid} 缺少 options` })
        }
      }

      if (typeof quizAnswerHandler !== 'function') {
        return json(res, 503, { ok: false, error: 'no-extension', message: '应用还没准备好作答（quizAnswerHandler 未注册）' })
      }

      try {
        const out = await quizAnswerHandler({ body })
        // handler 返回 { status, payload } 时按之输出；否则一律 200
        if (out && typeof out === 'object' && out.status && out.payload) {
          return json(res, out.status, out.payload)
        }
        return json(res, 200, out)
      } catch (e) {
        return json(res, 500, { ok: false, error: 'internal-error', message: String(e?.message || e) })
      }
    }

    // 章节测验交卷回执：扩展提交后把「实际交了什么」报回来，
    // 应用据此留档（用户要能事后核对 AI 到底按什么作答、交了什么）。
    if (req.method === 'POST' && path === '/ext/quizSubmitted') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'bad-request', message: '请求体不是合法 JSON' })
      }
      try {
        if (typeof quizSubmittedHandler === 'function') {
          const r = await quizSubmittedHandler({ body })
          return json(res, 200, r || { ok: true })
        }
        return json(res, 200, { ok: true, note: 'handler 未注册，已忽略' })
      } catch (e) {
        return json(res, 500, { ok: false, error: 'internal-error', message: String(e?.message || e) })
      }
    }

    // 自动抓取当前页面那节课的课程日志（扩展点「一键播放答题」时自动调用）。
    // 契约见 docs/quiz-api-contract.md B 节。抓取是长任务（1-3 分钟），
    // 所以立即返回 jobId，由扩展轮询 /ext/autoCapture/status 拿进度。
    if (req.method === 'POST' && path === '/ext/autoCapture') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'bad-request', message: '请求体不是合法 JSON' })
      }
      const url = String(body.url || '').trim()
      if (!url) {
        return json(res, 400, { ok: false, error: 'bad-request', message: 'url 不能为空' })
      }
      if (typeof autoCaptureHandler !== 'function') {
        return json(res, 503, { ok: false, error: 'no-extension', message: '应用还没准备好抓取（autoCaptureHandler 未注册）' })
      }
      try {
        const out = await autoCaptureHandler({ body })
        if (out && typeof out === 'object' && out.status && out.payload) {
          return json(res, out.status, out.payload)
        }
        return json(res, 200, out)
      } catch (e) {
        return json(res, 500, { ok: false, error: 'internal-error', message: String(e?.message || e) })
      }
    }

    // 自动抓取的进度轮询
    if (req.method === 'GET' && path === '/ext/autoCapture/status') {
      const jobId = String(url.searchParams.get('jobId') || '').trim()
      if (!jobId) return json(res, 400, { ok: false, error: 'bad-request', message: 'jobId 不能为空' })
      const job = autoCaptureJobs.get(jobId)
      if (!job) return json(res, 404, { ok: false, error: 'no-such-job', message: '找不到该抓取任务' })
      return json(res, 200, {
        ok: true,
        jobId,
        stage: job.stage,
        text: job.text,
        segments: job.segments,
        total: job.total,
        done: job.done,
        error: job.error,
        file: job.file,
        title: job.title,
        chapterId: job.chapterId,
      })
    }

    // 唤醒：副实例发现端口被占时，调这个让已有的主实例把窗口显示出来
    if (req.method === 'POST' && path === '/app/show') {
      await readBody(req)
      try {
        if (typeof showHandler === 'function') showHandler()
        return json(res, 200, { ok: true, shown: true })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message || e) })
      }
    }

    // 播放看门狗：扩展报告暂停
    if (req.method === 'POST' && path === '/ext/playstate') {
      const body = await readBody(req)
      lastPlayState = { ...(body || {}), at: Date.now() }
      return json(res, 200, { ok: true })
    }

    json(res, 404, { ok: false, error: 'not found' })
  }

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        // 复用已绑定的 server 时，它已经在 listen 了，直接返回
        if (existingServer && server.listening) return resolve({ port })
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve({ port }))
      })
    },
    close() {
      return new Promise((resolve) => { try { server.close(() => resolve()) } catch { resolve() } })
    },
    /** 新建一个任务，等扩展来领 */
    enqueue(type, { tabId, args, onUpdate, timeoutMs = 20000 } = {}) {
      const id = crypto.randomUUID()
      const job = { id, type, tabId, args, status: 'pending', createdAt: Date.now(), onUpdate }
      jobs.set(id, job)
      setTimeout(() => {
        if (!job.finishedAt) {
          job.status = 'failed'
          job.error = '扩展没有响应（超时）'
          job.finishedAt = Date.now()
          if (typeof onUpdate === 'function') { try { onUpdate(job) } catch { /* ignore */ } }
        }
      }, timeoutMs)
      return id
    },
    getJob(id) { return jobs.get(id) || null },
    state() { return { lastHello, jobs: [...jobs.values()], lastPlayState } },
    /** 注册页内问答处理器 */
    setAskHandler(fn) { askHandler = fn },
    setCourseHandler(fn) { courseHandler = fn },
    /** 注册自动抓取处理器 */
    setAutoCaptureHandler(fn) { autoCaptureHandler = fn },
    /** 注册交卷回执处理器 */
    setQuizSubmittedHandler(fn) { quizSubmittedHandler = fn },
    /** 抓取任务进度操作（main.js 的 handler 调用） */
    captureJobs: {
      create(id, init) {
        autoCaptureJobs.set(id, {
          stage: 'pending', text: '准备中…', segments: 0, total: 0,
          done: false, error: null, file: null,
          title: init?.title || '', chapterId: init?.chapterId || '',
          createdAt: Date.now(),
        })
        return autoCaptureJobs.get(id)
      },
      update(id, patch) {
        const j = autoCaptureJobs.get(id)
        if (!j) return null
        Object.assign(j, patch || {})
        return j
      },
      finish(id, { ok, error, file } = {}) {
        const j = autoCaptureJobs.get(id)
        if (!j) return null
        j.done = true
        j.stage = ok ? 'done' : 'failed'
        j.error = error || null
        if (file) j.file = file
        // 10 分钟后清掉，避免内存里堆一堆旧任务
        setTimeout(() => autoCaptureJobs.delete(id), 10 * 60 * 1000)
        return j
      },
      get(id) { return autoCaptureJobs.get(id) || null },
    },
    /**
     * 注册章节测验作答处理器（由 main.js 注入，避免 extserver ←→ main 循环依赖）。
     * handler 签名：async ({ body }) => payload | { status, payload }
     */
    setQuizAnswerHandler(fn) { quizAnswerHandler = fn },
    /** 注册「显示窗口」处理器（供副实例唤醒主实例） */
    setShowHandler(fn) { showHandler = fn },
    getPlayState() { return lastPlayState },
    clearFinished() {
      for (const [id, j] of jobs) if (j.finishedAt) jobs.delete(id)
    },
  }
}

module.exports = { createExtServer, DEFAULT_PORT }
