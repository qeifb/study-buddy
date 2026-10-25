/**
 * 受限桥接层：渲染层只能拿到这里显式暴露的方法。
 */
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

const subscribe = (channel, handler) => {
  const listener = (_e, data) => { try { handler(data) } catch { /* ignore */ } }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('studyBuddy', {
  info: () => invoke('app:info'),
  /** 渲染层日志：写到文件，便于排查（之前异常全被吞掉了） */
  log: (msg) => invoke('app:log', String(msg ?? '')),
  quit: () => invoke('app:quit'),
  hideToTray: () => invoke('app:hideToTray'),

  chats: {
    list: () => invoke('chats:list'),
    get: (payload) => invoke('chats:get', payload),
    create: (payload) => invoke('chats:create', payload),
    rename: (payload) => invoke('chats:rename', payload),
    delete: (payload) => invoke('chats:delete', payload),
    append: (payload) => invoke('chats:append', payload),
    markCapture: (payload) => invoke('chats:markCapture', payload),
  },

  visionTest: (payload) => ipcRenderer.invoke('vision:test', payload),


  settings: {
    load: () => invoke('settings:load'),
    save: (payload) => invoke('settings:save', payload),
    /** 用传入的地址/模型/Key 真实请求一次，验证能不能用（不落盘） */
    test: (payload) => invoke('settings:test', payload),
  },

  browsers: {
    list: () => invoke('browsers:list'),
    launch: (payload) => invoke('browsers:launch', payload),
    closeDedicated: () => invoke('browsers:closeDedicated'),
    openLogin: () => invoke('browsers:openLogin'),
  },

  ext: {
    status: () => invoke('ext:status'),
    tabs: () => invoke('ext:tabs'),
    probe: (payload) => invoke('ext:probe', payload),
    reconnect: () => invoke('ext:reconnect'),
  },

  capture: {
    start: (payload) => invoke('capture:start', payload),
    cancel: () => invoke('capture:cancel'),
    onEvent: (handler) => subscribe('capture:event', handler),
  },

  /** 自动抓日志（扩展点「一键播放答题」时触发）：进度广播到界面 */
  autocapture: {
    onEvent: (handler) => subscribe('autocapture:event', handler),
  },

  /** 章节测验作答依据：让用户看到 AI 是按哪节课、哪一段内容作答的 */
  quiz: {
    onEvent: (handler) => subscribe('quiz:event', handler),
    recent: () => invoke('quiz:recent'),
  },

  ai: {
    chat: (payload) => invoke('ai:chat', payload),
    onEvent: (handler) => subscribe('ai:event', handler),
  },

  /** 已抓过的课程清单（按 chapterId 去重判断要不要重复下载） */
  logs: {
    list: () => invoke('logs:list'),
  },

  /** 转写环境（faster-whisper）：检查 + 一键安装 */
  disk: {

    usage: () => ipcRenderer.invoke('disk:usage'),

    cleanCdrive: () => ipcRenderer.invoke('disk:cleanCdrive'),

  },

  transcribe: {
    status: () => invoke('transcribe:status'),
    setup: () => invoke('transcribe:setup'),
    onLog: (handler) => subscribe('transcribe:setup-log', handler),
  },

  shell: {
    openPath: (p) => invoke('shell:openPath', p),
    pickNotesDir: () => invoke('dialog:pickNotesDir'),
  },
})
