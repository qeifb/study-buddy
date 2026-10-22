/**
 * 「关闭设置」弹窗的 preload。
 *
 * 为什么需要它：弹窗内容是 data URL，原来靠主进程每 300ms 轮询
 * `window.__closeResult` 取结果；用户点得快时轮询没赶上、窗口先 close，
 * 主进程读到 undefined 就什么都不做 —— 表现就是「点最小化/退出没反应」。
 * 改成由页面主动把结果 post 给主进程，彻底消除竞态。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('closeDialog', {
  submit(result) {
    ipcRenderer.send('close-dialog:result', result)
  },
})
