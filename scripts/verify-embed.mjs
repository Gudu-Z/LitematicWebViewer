import { preview } from 'vite'
import { createServer as createHTTPServer } from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
// Run npm run build first. Set CHROME_PATH if Chrome is installed elsewhere.
const server = await preview({ base: '/LitematicWebViewer/', preview: { host: '127.0.0.1', port: 5178, strictPort: true, open: false } })
const profile = resolve('scripts/_ref/embed-verify-profile')
await mkdir(profile, { recursive: true })
await unlink(resolve(profile, 'DevToolsActivePort')).catch(() => {})
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let chromeLog = ''
chrome.stderr.on('data', chunk => { chromeLog += chunk.toString() })
let socket, archive
try {
  let port
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {}
    if (!port) await delay(100)
  }
  if (!port) throw new Error('Chrome debugging port not ready: ' + chromeLog)
  let pages
  for (let i = 0; i < 50 && !pages; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch {}
    if (!pages) await delay(100)
  }
  if (!pages) throw new Error('Chrome is not accepting connections: ' + chromeLog)
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let nextId = 0
  const pending = new Map()
  const errors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
      else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  const waitFor = async (expression, label, attempts = 300) => {
    for(let i=0;i<attempts;i++) { if(await evaluate(expression))return; await delay(100); }
    throw Error('Timeout: '+label+' '+JSON.stringify(errors));
  };
  const shot = async name => {
    await delay(300);
    const result=await send('Page.captureScreenshot',{format:'png'});
    await writeFile('scripts/_ref/inspection-fixes-'+name+'.png',Buffer.from(result.data,'base64'));
  };

  const base = 'http://127.0.0.1:5178/LitematicWebViewer/'
  const sample = await readFile('public/demo.litematic')
  let privateDownloads = 0
  archive = createHTTPServer((request, response) => {
    if (request.url === '/cors.litematic') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': new URL(base).origin }); response.end(sample); return
    }
    if (request.url === '/private.litematic') {
      if (request.headers['x-archive-session'] !== 'example-session') { response.writeHead(403); response.end(); return }
      privateDownloads++; response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(sample); return
    }
    if (request.url === '/no-cors.litematic') { response.writeHead(200); response.end(sample); return }
    if (request.url === '/html') { response.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': new URL(base).origin }); response.end('<p>Download page, not a file</p>'); return }
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#101c2b;color:white}#row{display:flex;gap:20px}.card{width:340px;height:250px;border-radius:12px}#d{margin-top:1400px}</style><div id="row"><div id="a" class="card"></div><div id="b" class="card"></div><div id="c" class="card"></div></div><div id="d" class="card"></div><script type="module">
      import { createLitematicCard } from '${base}embed.js';
      window.events={};window.cards={};
      const file = new File([await(await fetch('/private.litematic',{headers:{'X-Archive-Session':'example-session'}})).blob()],'private.litematic');
      for (const id of ['a','b','c','d']) cards[id]=createLitematicCard(document.getElementById(id),{lang:'en',pack:'vanilla',...(id==='a'?{url:'/cors.litematic'}:id==='c'?{url:'/html'}:{file}),onStatus:data=>{events[id]=data;}});
    </script>`)
  })
  await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve))
  const host = `http://127.0.0.1:${archive.address().port}`
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: host })
  await waitFor('window.events?.a?.type==="loaded" && window.events?.b?.type==="loaded"', 'cross-origin URL and protected File previews')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2, 'pool limits active frames')
  assert.equal(privateDownloads, 1, 'protected file fetched only by the host')
  const frameEval = async (id, expression) => {
    const src = await evaluate(`document.querySelector('#${id} iframe').src`)
    const tree = await send('Page.getFrameTree')
    const child = tree.frameTree.childFrames.find(value => value.frame.url === src)
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'verification' })
    const result = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  assert.equal(await frameEval('b', 'document.documentElement.lang'), 'en')
  assert.equal(await frameEval('b', 'document.querySelector("canvas").style.touchAction'), 'pan-y')
  await shot('embed-cross-origin')
  const hash = () => frameEval('b', 'document.querySelector("canvas").toDataURL()')
  const before = await hash()
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra })
  const targets = async () => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page')
  const countBefore = (await targets()).length
  await mouse('mousePressed', 500, 140, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseMoved', 590, 160, { button: 'left', buttons: 1 })
  await mouse('mouseReleased', 590, 160, { button: 'left', clickCount: 1 })
  await delay(150)
  assert.notEqual(await hash(), before, 'orbit changes rendered view')
  assert.equal((await targets()).length, countBefore, 'drag does not open a tab')
  const afterDrag = await hash()
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await delay(200)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  assert.equal(await hash(), afterDrag, 'card ignores WASD')
  // Same parent, wrong channel: cannot replace the schematic.
  await evaluate(`(()=>{const frame=document.querySelector('#b iframe');frame.contentWindow.postMessage({protocol:'litematic-preview-v1',channel:'wrong',type:'load',url:'${host}/html'},'${new URL(base).origin}')})()`)
  await delay(150)
  assert.equal(await frameEval('b', 'document.getElementById("preview").dataset.state'), 'loaded')
  const victimChannel = await evaluate('new URL(document.querySelector("#b iframe").src).searchParams.get("channel")')
  await frameEval('a', `parent.frames[1].postMessage({protocol:'litematic-preview-v1',channel:${JSON.stringify(victimChannel)},type:'load',url:'${host}/html'},'${new URL(base).origin}')`)
  await delay(150)
  assert.equal(await frameEval('b', 'document.getElementById("preview").dataset.state'), 'loaded', 'sibling window with correct channel is rejected')

  await mouse('mousePressed', 520, 140, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', 520, 140, { button: 'left', clickCount: 1 })
  let popup
  for (let attempt = 0; attempt < 100 && !popup; attempt++) { popup = (await targets()).find(t => t.url.startsWith(base) && !t.url.includes('embed')); if (!popup) await delay(100) }
  assert.ok(popup, 'tap opens full viewer')
  const pageList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const popupSocket = new WebSocket(pageList.find(p => p.id === popup.targetId).webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { popupSocket.onopen = resolve; popupSocket.onerror = reject })
  let popupId = 0
  const popupPending = new Map()
  popupSocket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { popupPending.get(message.id)(message.result); popupPending.delete(message.id) } }
  const popupEval = expression => new Promise(resolve => { const id = ++popupId; popupPending.set(id, value => resolve(value.result?.value)); popupSocket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })) })
  try {
    let loaded = false
    for (let attempt = 0; attempt < 300 && !loaded; attempt++) { loaded = await popupEval('document.body.classList.contains("has-model") && document.getElementById("app").getAttribute("aria-busy")==="false"'); if (!loaded) await delay(100) }
    assert.ok(loaded, 'private file reaches full viewer')
    assert.equal(await popupEval('document.getElementById("fileName").textContent'), 'private.litematic')
    assert.equal(await popupEval('window.opener===null && !location.hash'), true, 'one-shot handoff drops opener and token')
    assert.equal(await popupEval('document.documentElement.lang'), 'en')
    assert.equal(await popupEval('document.querySelectorAll("#loadedPackList [data-pack-id]").length'), 0, 'vanilla preset carries over')
    assert.equal(privateDownloads, 1, 'full viewer does not refetch private file')
  } finally { popupSocket.close(); await send('Target.closeTarget', { targetId: popup.targetId }) }
  await send('Page.bringToFront')
  await evaluate('document.querySelector("#c button").click()')
  await waitFor('window.events.c?.type==="error"', 'HTML download rejected')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2)
  assert.match(await evaluate('events.c.message'), /web page/)
  await evaluate(`cards.c.load('${host}/cors.litematic')`)
  await waitFor('window.events.c?.type==="loaded"', 'failed card can recover')
  await evaluate('window.scrollTo(0,1500)')
  await waitFor('!document.querySelector("#a iframe") && !document.querySelector("#b iframe") && !document.querySelector("#c iframe") && window.events.d?.type==="loaded"', 'offscreen contexts released')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 1)
  await evaluate('Object.values(cards).forEach(card=>card.destroy())')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0, 'destroy removes frames')
  await send('Page.navigate', { url: base + 'embed.html?' + new URLSearchParams({ file: host + '/no-cors.litematic', pack: 'vanilla', lang: 'en' }) })
  await waitFor('document.getElementById("preview")?.dataset.state==="error"', 'CORS failure is visible')
  assert.match(await evaluate('document.getElementById("status").textContent'), /CORS/)
  await send('Page.navigate', { url: base + 'embed-example.html' })
  await waitFor('document.querySelectorAll("iframe").length===2', 'built example page')
  await delay(1000)
  await evaluate('document.getElementById("sample").click()')
  await waitFor('document.querySelector("#fileCard > div").dataset.state==="loaded"', 'example data card with XK')
  await shot('embed-example')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=390'), true, 'mobile example fits')
  await shot('embed-example-mobile')
  await send('Page.navigate', { url: base + '?' + new URLSearchParams({ file: host + '/cors.litematic', lang: 'en', pack: 'vanilla' }) })
  await waitFor('document.body.classList.contains("has-model") && document.getElementById("app").getAttribute("aria-busy")==="false"', 'full viewer loads URL without a handoff')
  assert.equal(await evaluate('document.getElementById("fileName").textContent'), 'cors.litematic')
  assert.equal(await evaluate('document.getElementById("langLabel").textContent'), 'EN')
  await evaluate('document.getElementById("projectionBtn").click()')
  assert.equal(await evaluate('document.getElementById("projectionBtn").getAttribute("aria-pressed")'), 'true', 'full viewer still supports projection switching')
  const exceptions = errors.filter(error => error.exception || error.exceptionId)
  assert.deepEqual(exceptions, [], 'no uncaught JavaScript exceptions')
  console.log('Passed cross-origin URL/CORS and protected-file loading, full-viewer handoff without refetch/storage, drag vs click, orbit-only keys, source/channel checks, HTML rejection/recovery, bounded iframe pool/offscreen release, XK example, mobile and production subdirectory paths.')
} finally {
  socket?.close(); chrome.kill()
  if (archive) await new Promise(resolve => archive.close(resolve))
  await new Promise(resolve => server.httpServer.close(resolve))
}
