import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer as createNetServer } from 'node:net'

// Optional integration check: npm run setup and Chrome are required.
const httpPort = Number(process.env.COMPACT_TEST_PORT || 5308)
const debugPort = Number(process.env.COMPACT_DEBUG_PORT || 9227)
const probe = createNetServer()
await new Promise((yes, no) => { probe.once('error', no); probe.listen(debugPort, '127.0.0.1', yes) })
await new Promise(yes => probe.close(yes))
const server = await createServer({
  cacheDir: 'node_modules/.vite-compact-browser',
  server: { host: '127.0.0.1', port: httpPort, strictPort: true, open: false, hmr: false,
    watch: { ignored: ['**/scripts/_ref/**'] } },
})
await server.listen()
const profile = resolve('scripts/_ref/compact-profile-' + Date.now())
await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort,
  '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank',
  ...(process.env.COMPACT_GPU_POWER === 'low-power' ? ['--force_low_power_gpu'] : []),
  ...(process.env.COMPACT_GPU_POWER === 'high-performance' ? ['--force_high_performance_gpu'] : []),
], { windowsHide: true, stdio: 'ignore' })
let socket, launchError
chrome.once('error', error => { launchError = error })
const pending = new Map(), errors = []
try {
  let pages
  for (let i = 0; i < 100 && !pages; i++) {
    if (launchError) throw launchError
    try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() } catch {}
    if (!pages?.some(page => page.type === 'page')) { pages = null; await delay(100) }
  }
  if (!pages) throw Error('Chrome startup failed; set CHROME_PATH to the browser executable')
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((yes, no) => { socket.onopen = yes; socket.onerror = no })
  let serial = 0
  socket.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Browser closed')) }; pending.clear() }
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled') {
      const args = message.params.args.map(arg => arg.value ?? arg.description)
      if (message.params.type === 'error') errors.push({ console: args })
      else if (args[0] === 'STAGE') console.log(...args)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)) }, 180000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: 1, mobile: false })
  const powerPreference = process.env.COMPACT_GPU_POWER || 'default'
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/scripts/compact-faces-browser.html?powerPreference=${encodeURIComponent(powerPreference)}` })
  let ready = false
  for (let i = 0; i < 300 && !ready; i++) {
    if (errors.length) throw Error(JSON.stringify(errors))
    ready = await evaluate('!!window.runCompactFaces')
    if (!ready) await delay(100)
  }
  if (!ready) throw Error('Browser test did not initialize')
  const result = await evaluate('runCompactFaces()')
  for (const failure of result.failures || []) {
    const prefix = `scripts/_ref/compact-failure-${failure.pack}-${failure.scenario}-${failure.layer}-${failure.index}`
    for (const [name, base64] of Object.entries(failure.images)) await writeFile(`${prefix}-${name}.png`, Buffer.from(base64, 'base64'))
    delete failure.images
  }
  await writeFile('scripts/_ref/compact-faces-browser.json', JSON.stringify({ result, errors }, null, 2))
  if (result.changedPixels || errors.length) throw Error('Compact face GPU regression: ' + JSON.stringify({ result, errors }))
  console.log(`PASS compact GPU: ${result.results.length} vanilla/XK views, ${result.pixelSamples} compared pixels, zero differences; ${result.gpu}`)
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear(); chrome.kill(); await server.close()
}
