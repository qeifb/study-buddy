/**
 * 扩展弹出面板：显示与应用的连接状态、识别到的学习通页面。
 */

const DEFAULT_PORT = 39517

function $(id) { return document.getElementById(id) }

async function getPort() {
  const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT })
  return port
}

async function refresh() {
  $('ver').textContent = chrome.runtime.getManifest().version
  const port = await getPort()
  $('port').value = port

  const dot = $('dot')
  const text = $('status-text')

  // 问后台一次
  let r = null
  try {
    r = await chrome.runtime.sendMessage({ type: 'ping' })
  } catch { r = null }

  if (r && r.ok) {
    dot.className = 'dot ok'
    text.textContent = `已连接应用（端口 ${port}）`
  } else {
    dot.className = 'dot err'
    text.textContent = r?.lastError ? `应用未响应` : '应用没开或端口不对'
  }

  // 列出学习通页面
  const tabs = await chrome.tabs.query({})
  const course = tabs.filter((t) => /chaoxing\.com|xuexitong\.com/i.test(String(t.url || '')))
  $('tab-count').textContent = String(course.length)

  const box = $('tabs')
  box.textContent = ''
  if (!course.length) {
    const d = document.createElement('div')
    d.className = 'box'
    d.innerHTML = '<div class="u">还没有打开学习通页面。先在学习通里打开一节视频课。</div>'
    box.appendChild(d)
  } else {
    for (const t of course.slice(0, 5)) {
      const isLesson = /studentstudy|knowledge\/cards|ananas\/modules/i.test(String(t.url || ''))
      const d = document.createElement('div')
      d.className = 'box'

      const title = document.createElement('div')
      title.className = 't'
      title.textContent = (isLesson ? '🎬 ' : '📄 ') + (t.title || '(无标题)')
      d.appendChild(title)

      const u = document.createElement('div')
      u.className = 'u'
      u.textContent = String(t.url || '').slice(0, 80)
      d.appendChild(u)

      const badge = document.createElement('div')
      badge.className = isLesson ? 'ok' : 'no'
      badge.style.marginTop = '3px'
      badge.style.fontSize = '11px'
      badge.textContent = isLesson ? '这是播放页，可以抓' : '不是播放页'
      d.appendChild(badge)

      box.appendChild(d)
    }
  }
}

$('save').onclick = async () => {
  const port = Number($('port').value) || DEFAULT_PORT
  await chrome.storage.local.set({ port })
  await chrome.runtime.sendMessage({ type: 'set-port', port })
  setTimeout(refresh, 500)
}

refresh()
setInterval(refresh, 3000)
