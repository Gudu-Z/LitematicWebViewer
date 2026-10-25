// Optional real-browser integration. Pass a local schematic to check the
// reported oversized file; otherwise generate a small, highly compressed fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const single = await readFile('public/demo.litematic'), raw = gunzipSync(single)
const multi = Buffer.concat([gzipSync(raw.subarray(0, 7)), gzipSync(Buffer.alloc(0)), gzipSync(raw.subarray(7))])
const repeated = gzipSync(Buffer.alloc(1024 * 1024, 1))
const oversized = process.argv[2] ? await readFile(process.argv[2]) : Buffer.concat(Array(513).fill(repeated))
const fixtures = { single, multi, oversized }
const server = await createServer({
  plugins: [{ name: 'gzip-test',
    transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/main.js')) return code + '\nwindow.__gzipTest = { openFile, getBusy: () => busy, getData: () => currentData };'
    },
    configureServer(server) {
      server.middlewares.use('/__gzip/', (request, response, next) => {
        const data = fixtures[request.url.slice(1)]
        if (!data) return next()
        response.setHeader('Content-Type', 'application/octet-stream'); response.end(data)
      })
    },
  }],
  server: { host: '127.0.0.1', port: 5195, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/scripts/_ref/**'] } },
})
await server.listen()
const profile = resolve('scripts/_ref/gzip-browser-' + Date.now()); await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--disable-background-networking',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
try {
  let port
  for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {} if (!port) await delay(100) }
  assert.ok(port, 'Chrome startup')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0; const pending = new Map(), errors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result) }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  const until = async expression => {
    for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error('Browser timeout: ' + expression)
  }
  const base = 'http://127.0.0.1:5195'
  const load = name => evaluate(`(async () => __gzipTest.openFile(new File([await (await fetch('/__gzip/${name}')).arrayBuffer()], '${name}.litematic')))()`)
  const screenshot = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile('scripts/_ref/gzip-' + name + '.png', Buffer.from(shot.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: base + '/?file=/__gzip/single&pack=vanilla' })
  await until('!!window.__gzipTest?.getData() && !__gzipTest.getBusy()')
  const count = await evaluate('__gzipTest.getData().blocks.size')
  assert.ok(count > 0)
  assert.equal(await evaluate('performance.getEntriesByType("resource").some(entry => entry.name.includes("/pako.js") || entry.name.includes("/pako/dist/"))'), false, 'Ordinary files do not download the fallback module')
  const nativeError = await evaluate(`(async () => {
    const blob = await (await fetch('/__gzip/multi')).blob();
    try { const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader(); while (!(await reader.read()).done) {} return null }
    catch (error) { return error.message }
  })()`)
  assert.match(nativeError, /compressed|gzip|stream/i)
  assert.equal(await load('multi'), true)
  assert.equal(await evaluate('__gzipTest.getData().blocks.size'), count)
  await screenshot('multi-loaded')
  console.log('PASS Chrome reproduces native failure and renders the complete multi-member schematic')
  assert.equal(await load('oversized'), false)
  assert.match(await evaluate('document.getElementById("errorBanner").textContent'), /解压后超过 512 MiB/)
  assert.equal(await evaluate('__gzipTest.getBusy()'), false)
  await screenshot('oversized-main')
  await evaluate('document.getElementById("langBtn").click()')
  assert.equal(await load('oversized'), false)
  assert.match(await evaluate('document.getElementById("errorBanner").textContent'), /decompressed schematic exceeds 512 MiB/)
  assert.equal(await load('single'), true, 'A rejected oversized load does not break subsequent loads')
  console.log('PASS main viewer rejects oversized expansion with Chinese/English messages and recovers')

  await send('Page.navigate', { url: base + '/embed.html?file=/__gzip/multi&pack=vanilla&lang=en' })
  await until('document.getElementById("preview")?.dataset.state === "loaded"')
  await screenshot('multi-embed')
  for (const lang of ['zh', 'en']) {
    await send('Page.navigate', { url: base + '/embed.html?file=/__gzip/oversized&pack=vanilla&lang=' + lang })
    await until('document.getElementById("preview")?.dataset.state === "error"')
    assert.match(await evaluate('document.getElementById("status").textContent'), lang === 'zh' ? /解压后超过 512 MiB/ : /decompressed schematic exceeds 512 MiB/)
  }
  await screenshot('oversized-embed')
  assert.deepEqual(errors, [], 'No unhandled browser errors')
  console.log('PASS embedded card renders multi-member files and reports expansion limits in both languages')
} finally { socket?.close(); chrome.kill(); await server.close() }
