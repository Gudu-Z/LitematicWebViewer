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
    response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#101c2b;color:white}#row{display:flex;gap:20px}.card{width:340px;height:250px;border-radius:12px}#d{margin-top:1400px}dialog{display:none!important}</style><div id="row"><div id="a" class="card"></div><div id="b" class="card"></div><div id="c" class="card"></div></div><div id="d" class="card"></div><button id="launch" style="position:fixed;top:310px;left:20px">Preview modal</button><script type="module">
      import { createLitematicCard, openLitematicPreview } from '${base}embed.js';
      window.events={};window.cards={};
      const file = new File([await(await fetch('/private.litematic',{headers:{'X-Archive-Session':'example-session'}})).blob()],'private.litematic');
      for (const id of ['a','b','c','d']) cards[id]=createLitematicCard(document.getElementById(id),{lang:'en',pack:'vanilla',...(id==='a'?{url:'/cors.litematic'}:id==='c'?{url:'/html'}:{file}),onStatus:data=>{events[id]=data;}});
      window.openModal=()=>window.modal=openLitematicPreview({file,name:'Private schematic',lang:'en',pack:'vanilla',onStatus:data=>{events.modal=data;}});
      document.getElementById('launch').onclick=openModal;
    </script>`)
  })
  await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve))
  const host = `http://127.0.0.1:${archive.address().port}`
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: host })
  await waitFor('window.events?.a?.type==="loaded" && window.events?.b?.type==="loaded"', 'cross-origin URL and protected File previews')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2, 'pool limits active frames')
  assert.equal(privateDownloads, 1, 'protected file fetched only by the host')
  const frameQuery = id => id === 'modal' ? 'document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("iframe")' : `document.querySelector('#${id} iframe')`
  const frameEval = async (id, expression) => {
    const src = await evaluate(`${frameQuery(id)}.src`)
    const tree = await send('Page.getFrameTree')
    const child = tree.frameTree.childFrames.find(value => value.frame.url === src)
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'verification' })
    const result = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  assert.equal(await frameEval('b', 'document.documentElement.lang'), 'en')
  assert.equal(await frameEval('b', 'document.querySelector("canvas").style.touchAction'), 'none')
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
  const afterOrbit = await hash()
  await mouse('mousePressed', 530, 140, { button: 'right', buttons: 2, clickCount: 1 })
  await mouse('mouseMoved', 555, 155, { button: 'right', buttons: 2 })
  await mouse('mouseReleased', 555, 155, { button: 'right', clickCount: 1 })
  await delay(100)
  assert.notEqual(await hash(), afterOrbit, 'right-drag pans the preview')
  const afterPan = await hash()
  await mouse('mouseWheel', 530, 140, { deltaX: 0, deltaY: -160 })
  await delay(150)
  assert.notEqual(await hash(), afterPan, 'wheel zooms the preview')
  await frameEval('b', 'document.getElementById("fit").click()'); await delay(100)
  assert.equal(await hash(), before, 'reset restores the original framing')
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
  await delay(100)
  assert.equal((await targets()).length, countBefore, 'clicking the model stays inside the preview')
  const clickInFrame = async (id, selector) => {
    const point = await frameEval(id, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const origin = await evaluate(`(()=>{const r=${frameQuery(id)}.getBoundingClientRect();return {x:r.left,y:r.top}})()`)
    await mouse('mousePressed', origin.x + point.x, origin.y + point.y, { button: 'left', buttons: 1, clickCount: 1 })
    await mouse('mouseReleased', origin.x + point.x, origin.y + point.y, { button: 'left', clickCount: 1 })
  }
  await clickInFrame('b', '#open')
  let popup
  for (let attempt = 0; attempt < 100 && !popup; attempt++) { popup = (await targets()).find(t => t.url.startsWith(base) && !t.url.includes('embed')); if (!popup) await delay(100) }
  assert.ok(popup, 'explicit full-viewer button opens a new tab')
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
  await evaluate('document.getElementById("launch").focus(); document.getElementById("launch").click()')
  await waitFor('document.querySelector("[data-litematic-preview]")?.shadowRoot.querySelector(".viewport > div")?.dataset.state==="loaded"', 'cross-origin protected file modal')
  assert.equal(await evaluate('location.origin'), host, 'modal stays on the archive page')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0, 'modal releases background cards')
  assert.equal(await evaluate('document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("dialog").matches(":modal")'), true)
  assert.equal(await evaluate('document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("dialog").getBoundingClientRect().width > 500'), true, 'host dialog CSS does not leak into the modal')
  assert.equal(await evaluate('document.documentElement.style.overflow'), 'hidden')
  await clickInFrame('modal', 'canvas')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor('!document.querySelector("[data-litematic-preview]")', 'Escape closes modal from inside iframe')
  assert.equal(await evaluate('document.activeElement.id'), 'launch', 'focus returns to the trigger')
  assert.equal(await evaluate('document.documentElement.style.overflow'), '', 'host scrolling is restored')
  await evaluate('openModal()')
  await waitFor('document.querySelector("[data-litematic-preview]")?.shadowRoot.querySelector(".viewport > div")?.dataset.state==="loaded"', 'modal can reopen')
  await mouse('mousePressed', 5, 5, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', 5, 5, { button: 'left', clickCount: 1 })
  await waitFor('!document.querySelector("[data-litematic-preview]")', 'backdrop closes modal')
  await evaluate('openModal(); openModal(); modal.close()')
  assert.equal(await evaluate('document.querySelectorAll("[data-litematic-preview]").length'), 0, 'replacement and programmatic close release modal roots')
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
  await waitFor('typeof document.getElementById("modelTab")?.onclick === "function"', 'built example page')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0, 'gallery starts with an image and no renderer')
  await evaluate('document.getElementById("modelTab").click()')
  await waitFor('document.querySelector("#detailPreview > div")?.dataset.state==="loaded"', 'gallery preview with XK')
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1040, deviceScaleFactor: 1, mobile: false })
  await shot('embed-example')
  await evaluate('document.getElementById("quickPreview").click()')
  await waitFor('document.querySelector("[data-litematic-preview]")?.shadowRoot.querySelector(".viewport > div")?.dataset.state==="loaded"', 'example popup')
  await shot('embed-popup')
  await evaluate('document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("button").click()')
  await waitFor('document.querySelector("#detailPreview > div")?.dataset.state==="loaded"', 'gallery resumes after modal closes')
  await evaluate('document.getElementById("imageTab").click()')
  assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0, 'returning to images releases the preview')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=390'), true, 'mobile example fits')
  await shot('embed-example-mobile')
  await evaluate('document.getElementById("quickPreview").click()')
  await waitFor('document.querySelector("[data-litematic-preview]")?.shadowRoot.querySelector(".viewport > div")?.dataset.state==="loaded"', 'mobile popup')
  assert.equal(await evaluate('(()=>{const r=document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("dialog").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()'), true, 'mobile modal fits viewport')
  await shot('embed-popup-mobile')
  const mobileBefore = await frameEval('modal', 'document.querySelector("canvas").toDataURL()')
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 400, id: 1 }, { x: 240, y: 400, id: 2 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 115, y: 400, id: 1 }, { x: 275, y: 400, id: 2 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await delay(100)
  assert.notEqual(await frameEval('modal', 'document.querySelector("canvas").toDataURL()'), mobileBefore, 'two-finger pinch changes the preview scale')
  await evaluate('document.querySelector("[data-litematic-preview]").shadowRoot.querySelector("button").click()')
  await send('Page.navigate', { url: base + '?' + new URLSearchParams({ file: host + '/cors.litematic', lang: 'en', pack: 'vanilla' }) })
  await waitFor('document.body.classList.contains("has-model") && document.getElementById("app").getAttribute("aria-busy")==="false"', 'full viewer loads URL without a handoff')
  assert.equal(await evaluate('document.getElementById("fileName").textContent'), 'cors.litematic')
  assert.equal(await evaluate('document.getElementById("langLabel").textContent'), 'EN')
  await evaluate('document.getElementById("projectionBtn").click()')
  assert.equal(await evaluate('document.getElementById("projectionBtn").getAttribute("aria-pressed")'), 'true', 'full viewer still supports projection switching')
  const exceptions = errors.filter(error => error.exception || error.exceptionId)
  assert.deepEqual(exceptions, [], 'no uncaught JavaScript exceptions')
  console.log('Passed cross-origin URL/File loading, orbit/pan/wheel/reset, explicit full-viewer handoff, modal Escape/backdrop/focus/cleanup and style isolation, gallery switching, mobile pinch/layout, source/channel checks, iframe pool/recovery and production paths.')
} finally {
  socket?.close(); chrome.kill()
  if (archive) await new Promise(resolve => archive.close(resolve))
  await new Promise(resolve => server.httpServer.close(resolve))
}
