/**
 * 统一路径解析（2026-10-22 把应用整体迁到 E 盘时引入）。
 *
 * 目录布局（<root> 默认是 app 目录的上一级）：
 *   <root>\app              源代码 + node_modules
 *   <root>\data             用户数据：chats.json / settings.json / course-logs / main.log
 *   <root>\runtime          Electron userData（锁文件、缓存、Local Storage）
 *   <root>\browser-profile  专用浏览器 profile（不碰用户日常浏览器）
 *   <root>\tools            转写环境：pyenv / transcribe.py / models
 *
 * 迁移前这些散在四个地方：%LOCALAPPDATA%\study-buddy、%APPDATA%\study-buddy、
 * %LOCALAPPDATA%\study-buddy-app、%LOCALAPPDATA%\dsh-study-companion。
 * 分散的直接后果是「两套 chats.json 同时存在」和「C 盘被视频/模型撑满」。
 * 现在全部收在 <root> 下，整个文件夹搬到别的盘也能直接用。
 *
 * 可用环境变量 STUDY_BUDDY_HOME 覆盖根目录（便携版/多实例场景）。
 */
const fs = require('node:fs')
const path = require('node:path')

/** <root>\app */
const APP_DIR = path.resolve(__dirname, '..')

/** 真的写一个文件再删掉，避免只看目录存在就误判 */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const t = path.join(dir, `.wtest-${process.pid}`)
    fs.writeFileSync(t, 'x')
    fs.rmSync(t, { force: true })
    return true
  } catch {
    return false
  }
}

function pickRoot() {
  const candidates = [
    process.env.STUDY_BUDDY_HOME,
    path.dirname(APP_DIR), // <root>\app -> <root>
    APP_DIR,               // 便携版：exe 与 app 同层
  ].filter(Boolean)

  for (const c of candidates) {
    const abs = path.resolve(c)
    if (canWrite(abs)) return abs
  }
  return path.resolve(path.dirname(APP_DIR))
}

const ROOT = pickRoot()
const DATA_DIR = canWrite(path.join(ROOT, 'data'))
  ? path.join(ROOT, 'data')
  : path.join(APP_DIR, '_data') // 沙箱里启动时的兜底
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const BROWSER_PROFILE_DIR = path.join(ROOT, 'browser-profile')
const TOOLS_DIR = path.join(ROOT, 'tools')
const NOTES_DIR = path.join(DATA_DIR, 'course-logs')

module.exports = {
  APP_DIR,
  ROOT,
  DATA_DIR,
  RUNTIME_DIR,
  BROWSER_PROFILE_DIR,
  TOOLS_DIR,
  NOTES_DIR,
  canWrite,
}
