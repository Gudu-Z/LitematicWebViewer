import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer as createNetServer } from 'node:net'

const profile = resolve('scripts/_ref/gpu-upload-profile-' + Date.now())
await mkdir(profile, { recursive: true })
let server, chrome, socket, launchError
const pending = new Map()
try {
  let port
  for (let i = 0; i < 30 && !port; i++) {
    const candidate = 20000 + Math.floor(Math.random() * 40000), probe = createNetServer()
    try { await new Promise((yes, no) => { probe.once('error', no); probe.listen(candidate, '127.0.0.1', yes) }) } catch { continue }
    await new Promise(yes => probe.close(yes)); port = candidate
  }
  assert.ok(port, 'Available safe Chrome debugging port')
  chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + port,
    '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  chrome.once('error', error => { launchError = error })
  let pages
  for (let i = 0; i < 100 && !pages; i++) {
    if (launchError) throw launchError
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch {}
    if (!pages?.some(page => page.type === 'page')) { pages = null; await delay(100) }
  }
  assert.ok(pages, 'Isolated Chrome startup')
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((yes, no) => { socket.onopen = yes; socket.onerror = no })
  let serial = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result) }
  }
  socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Chrome closed')) }; pending.clear() }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 60000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  server = await createServer({ configFile: false, publicDir: false, cacheDir: 'node_modules/.vite-gpu-upload',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/scripts/_ref/**'] } } })
  await server.listen()
  await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/gpu-upload-browser.html` })
  for (let i = 0; i < 100; i++) { if (await evaluate('!!window.__gpuUploadResult')) break; await delay(50) }
  const result = await evaluate('window.__gpuUploadResult')
  assert.equal(result?.pass, true)
  result.scheduling = await evaluate('window.runGPUUploadScheduling()')
  await writeFile('scripts/_ref/gpu-upload-report.json', JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  socket?.close(); chrome?.kill(); await server?.close()
}
