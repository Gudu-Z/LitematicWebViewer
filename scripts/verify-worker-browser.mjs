import assert from 'node:assert/strict'
import { createServer, build, preview } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer as createNetServer } from 'node:net'

// A large-volume, sparse synthetic file crosses the automatic paging threshold
// while keeping the regression inexpensive and independent of GPU/assets.
const int = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b }
const string = value => { const b = Buffer.from(value), size = Buffer.alloc(2); size.writeUInt16BE(b.length); return Buffer.concat([size, b]) }
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
const text = (name, value) => tag(8, name, string(value))
const compound = (...values) => Buffer.concat([...values, Buffer.from([0])])
const list = (type, values) => Buffer.concat([Buffer.from([type]), int(values.length), ...values])
const vector = (name, values) => tag(10, name, compound(...['x', 'y', 'z'].map((axis, i) => tag(3, axis, int(values[i])))))
function region(name, position, size, valueAt) {
  const volume = size.reduce((a, b) => a * b, 1), states = Buffer.alloc(Math.ceil(volume / 32) * 8)
  // Two-bit slots never straddle their 64-bit word; independent Java byte order.
  for (let i = 0; i < volume; i++) {
    const value = valueAt(i % size[0], Math.floor(i / (size[0] * size[2])), Math.floor(i / size[0]) % size[2])
    const word = Math.floor(i / 32), slot = i % 32
    states[word * 8 + 7 - Math.floor(slot / 4)] |= value << (slot % 4 * 2)
  }
  return tag(10, name, compound(vector('Position', position), vector('Size', size),
    tag(9, 'BlockStatePalette', list(10, ['air', 'stone', 'glass'].map(name => compound(text('Name', 'minecraft:' + name))))),
    tag(12, 'BlockStates', Buffer.concat([int(states.length / 8), states]))))
}
const fixtures = {
  small: await readFile('schematics/投影预览测试.litematic'),
  paged: gzipSync(tag(10, '', compound(tag(10, 'Metadata', compound(text('Name', 'Worker regression'))),
    tag(10, 'Regions', compound(region('base', [-20, -5, -30], [128, 129, 128], (x, y, z) => x < 64 && y < 32 && z < 64 ? 1 : 0),
      region('overlay', [-16, -1, -26], [8, 8, 8], (x, y, z) => (x + y + z) % 3 ? 2 : 0)))))),
}
const serveFixtures = server => { server.middlewares.use((request, response, next) => {
  const url = new URL(request.url, 'http://test')
  if (url.searchParams.has('csp')) response.setHeader('Content-Security-Policy', "worker-src 'none'")
  const bytes = fixtures[url.pathname.replace('/__worker-test/', '')]
  if (!url.pathname.startsWith('/__worker-test/') || !bytes) return next()
  response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytes)
}) }
const plugin = { name: 'worker-browser-fixtures', configureServer: serveFixtures, configurePreviewServer: serveFixtures }
const entry = resolve('scripts/worker-browser.html'), outDir = resolve('scripts/_ref/worker-browser-dist-' + process.pid)
const profile = resolve('scripts/_ref/worker-profile-' + Date.now())
await mkdir(profile, { recursive: true })
let server, chrome, socket, launchError
const pending = new Map(), errors = [], results = []
try {
  // Chrome's port=0 can choose a Fetch-forbidden port (observed 1723).
  // Reserve an available safe port before starting the isolated browser.
  let debugPort
  for (let i = 0; i < 30 && !debugPort; i++) {
    const candidate = 20000 + Math.floor(Math.random() * 40000), probe = createNetServer()
    try { await new Promise((yes, no) => { probe.once('error', no); probe.listen(candidate, '127.0.0.1', yes) }) } catch { continue }
    await new Promise(yes => probe.close(yes)); debugPort = candidate
  }
  assert.ok(debugPort, 'Available browser debugging port')
  chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--disable-background-networking',
    '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  chrome.once('error', error => { launchError = error })
  let pages
  for (let i = 0; i < 100 && !pages; i++) {
    if (launchError) throw launchError
    try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() } catch {}
    if (!pages?.some(page => page.type === 'page')) { pages = null; await delay(100) }
  }
  assert.ok(pages, 'Chrome startup; set CHROME_PATH if necessary')
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((yes, no) => { socket.onopen = yes; socket.onerror = no })
  let serial = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer)
      message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  }
  socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Chrome closed')) }; pending.clear() }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 120000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  for (const mode of ['dev', 'production']) {
    const options = { configFile: false, plugins: [plugin], publicDir: false, cacheDir: 'node_modules/.vite-worker-browser' }
    if (mode === 'dev') {
      server = await createServer({ ...options, server: { host: '127.0.0.1', port: 0, open: false, hmr: false,
        watch: { ignored: ['**/scripts/_ref/**'] } } }); await server.listen()
    } else {
      await build({ ...options, build: { outDir, emptyOutDir: true, rolldownOptions: { input: entry } } })
      server = await preview({ ...options, build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } })
    }
    const base = server.resolvedUrls.local[0].replace(/\/$/, '')
    for (const csp of [false, true]) {
      await send('Page.navigate', { url: base + '/scripts/worker-browser.html' + (csp ? '?csp=1' : '') })
      let ready = false
      for (let i = 0; i < 300 && !ready; i++) { ready = await evaluate('!!window.runWorkerBrowser'); if (!ready) await delay(50) }
      assert.ok(ready, 'Test page initialization')
      const result = await evaluate(`runWorkerBrowser({ csp: ${csp} })`)
      results.push({ mode, csp, ...result })
      assert.equal(errors.length, 0, 'No uncaught browser errors')
      console.log(`PASS ${mode} ${csp ? 'CSP startup fallback' : 'real Worker parse/build/cancel'}`, csp ? result : {
        geometries: result.geometries, blocks: result.blocks, heartbeatTicks: result.heartbeatTicks,
        maxGap: Number(result.maxGap.toFixed(1)), parseCancelMs: Number(result.parseCancelMs.toFixed(1)), buildCancelMs: Number(result.buildCancelMs.toFixed(1)),
        cooperativeCancelMs: Number(result.cooperativeCancelMs.toFixed(1)),
      })
    }
    await server.close(); server = null
  }
  await writeFile('scripts/_ref/worker-browser.json', JSON.stringify({ results, errors }, null, 2))
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear(); chrome?.kill()
  if (server) await server.close()
}
