import { preview } from 'vite'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

// Run npm run build first. Exercise the public SDK against a different archive origin.
const server = await preview({ base: '/LitematicWebViewer/', preview: { host: '127.0.0.1', port: 5178, strictPort: true, open: false } })
const base = 'http://127.0.0.1:5178/LitematicWebViewer/'
const profile = resolve('scripts/_ref/full-viewer-profile'), downloads = resolve('scripts/_ref/full-viewer-downloads')
await mkdir(profile, { recursive: true }); await mkdir(downloads, { recursive: true })
await unlink(resolve(profile, 'DevToolsActivePort')).catch(() => {})
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let archive, socket
const exceptions = [], completed = []
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let serial = 0
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id)
      if (message.error) reject(Error(JSON.stringify(message.error))); else resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    else if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') completed.push(message.params.guid)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression, extra = {}) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  return { ws, send, evaluate }
}
async function until(check, label, attempts = 300) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await delay(100) }
  throw Error(`Timeout: ${label} ${JSON.stringify(exceptions)}`)
}
try {
  let port
  await until(async () => { try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port } catch {} }, 'Chrome port')
  const pages = () => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
  const client = await connect((await pages()).find(p => p.type === 'page').webSocketDebuggerUrl)
  socket = client.ws
  const { send, evaluate } = client
  const wait = (expression, label) => until(() => evaluate(expression), label)
  const frameEval = async expression => {
    const src = await evaluate('document.querySelector("#preview iframe")?.src')
    const { frameTree } = await send('Page.getFrameTree')
    const frame = frameTree.childFrames.find(f => f.frame.url === src)
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName: 'full-viewer-verification' })
    return evaluate(expression, { contextId: executionContextId, userGesture: true })
  }
  const frameWait = (expression, label) => until(() => frameEval(expression), label)
  const shot = async name => {
    await delay(250)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`scripts/_ref/full-viewer-${name}.png`, Buffer.from(result.data, 'base64'))
  }
  const mouseClick = async selector => {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const sample = await readFile('public/demo.litematic')
  let privateDownloads = 0, generated
  archive = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (req.url === '/private') {
      if (req.headers['x-archive-session'] !== 'example') { res.writeHead(403); res.end(); return }
      privateDownloads++; res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(sample); return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url === '/generated') { res.end(generated); return }
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#edf4ef;font:14px system-ui;color:#25483d}header{padding:14px 24px;display:flex;justify-content:space-between}#preview{height:680px;margin:0 16px;border:1px solid #b7cfbe;border-radius:14px}footer{height:1400px;padding:24px}</style><header><span>BUILD ARCHIVE / 完整预览</span><button id="open">Open full page</button></header><div id="preview"></div><footer>Archive content</footer><script type="module">
      import { createLitematicViewer, createLitematicCard } from '${base}embed.js?v=full-viewer-test';
      window.events=[];window.camera=null;
      window.file=new File([await(await fetch('/private',{headers:{'X-Archive-Session':'example'}})).blob()],'private.litematic');
      window.options={file,pack:'vanilla',lang:'en',theme:'light',style:{accent:'#21796b',radius:10},viewer:{brand:{name:'Build archive <b>safe</b>',logo:'${base}brand/logo.svg',returnUrl:location.origin+'/build/42'},expanded:{materials:false}},onStatus:e=>{events.push(e);window.statusEvent=e},onCameraChange:c=>window.camera=c};
      window.card=createLitematicViewer(document.getElementById('preview'),options);
      window.quick=()=>{card.destroy();window.card=createLitematicCard(document.getElementById('preview'),options)};
      document.getElementById('open').onclick=()=>card.openFullViewer();
    </script>`)
  })
  await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve))
  const host = `http://127.0.0.1:${archive.address().port}`
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true })
  // Seed the independent site's preferences before entering the integration.
  await send('Page.navigate', { url: base + '?pack=vanilla' })
  await wait('document.querySelector("#app")?.getAttribute("aria-busy")==="false"', 'standalone initialized')
  await evaluate(`localStorage.setItem('viewer-illager-extra-arms-v1','true');localStorage.setItem('viewer-resource-packs-v1','["favorite-user-pack"]')`)
  await send('Page.navigate', { url: host })
  await wait('window.statusEvent?.type==="loaded"', 'full iframe private file')
  assert.equal(privateDownloads, 1)
  assert.equal(await frameEval('document.documentElement.dataset.viewerTheme'), 'light')
  assert.equal(await frameEval('document.querySelector(".brand-full").textContent'), 'Build archive <b>safe</b>')
  assert.equal(await frameEval('document.querySelector(".brand-full b")'), null, 'archive names are plain text')
  assert.equal(await frameEval('document.getElementById("archiveReturn").href'), host + '/build/42')
  assert.equal(await frameEval('document.getElementById("archiveReturn").target'), '_blank')
  assert.equal(await frameEval('document.getElementById("illagerExtraArms").checked'), false, 'integration does not read personal settings')
  assert.equal(await frameEval('document.getElementById("materialListBody").classList.contains("collapsed")'), true)
  assert.ok(await frameEval('document.querySelectorAll("#materialListBody li").length') > 0)
  assert.equal(await frameEval('document.getElementById("materialPanel").open'), false, 'materials open on demand')
  assert.equal(await frameEval('getComputedStyle(document.querySelector(".panel")).color'), 'rgb(33, 51, 72)')
  await evaluate('card.setOptions({lang:"zh",viewer:{brand:{name:"建筑档案馆"}}})')
  await frameWait('document.documentElement.lang==="zh-CN"', 'Chinese full viewer')
  await shot('light')
  await evaluate('card.setOptions({lang:"en"})')
  await frameWait('document.documentElement.lang==="en"', 'English full viewer')
  await frameEval('document.getElementById("materialSummaryBtn").click();document.getElementById("materialListToggle").click()')
  assert.equal(await frameEval('document.getElementById("materialPanel").open'), true)
  await frameWait('document.querySelectorAll(".material-icon.loaded img").length===4 && [...document.querySelectorAll(".material-icon img")].every(i=>i.complete&&i.naturalWidth===64)', 'material thumbnails')
  const stoneIcon = await frameEval('document.querySelector(\'.material-icon[data-material="stone"] img\').src')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("materialPanel")).backgroundColor'), 'rgb(255, 255, 255)', 'material card follows the archive theme')
  await shot('materials')
  await frameEval('document.getElementById("materialCloseBtn").click();document.getElementById("renderMode").value="single";document.getElementById("renderMode").dispatchEvent(new Event("change"))')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false"', 'layer renders')
  await evaluate('window.savedFrame=document.querySelector("#preview iframe");scrollTo(0,1100)')
  await delay(350)
  assert.equal(await evaluate('document.querySelector("#preview iframe")===savedFrame'), true, 'full viewer retains session offscreen')
  await evaluate('scrollTo(0,0)'); await delay(200)
  assert.equal(await frameEval('document.getElementById("renderMode").value'), 'single')
  await evaluate('card.setOptions({style:{accent:"#8047a1"}})')
  await frameWait('getComputedStyle(document.documentElement).getPropertyValue("--accent")==="#8047a1"', 'dynamic accent')
  assert.equal(await frameEval('document.getElementById("materialListBody").classList.contains("collapsed")'), false, 'theme update preserves user expansion')
  await wait('window.camera!==null', 'initial camera event')
  await evaluate('window.orbitCamera=JSON.stringify(camera)')
  await frameEval('document.getElementById("moveModeBtn").click()')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 350, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 370, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 370, button: 'left', clickCount: 1 })
  await wait('JSON.stringify(camera)!==orbitCamera', 'flight camera event')
  await evaluate('card.resetView()')
  await frameEval('document.getElementById("settingsBtn").click()')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("settingsPanel")).backgroundColor'), 'rgb(255, 255, 255)')
  await frameEval('document.getElementById("illagerExtraArms").click()')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false"', 'session preference change')
  await frameEval('document.getElementById("illagerExtraArms").click()')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false"', 'second session preference change')
  assert.equal(await frameEval('localStorage.getItem("viewer-illager-extra-arms-v1")'), 'true')
  await frameEval('document.getElementById("packsTab").click();document.querySelector("#availablePackList [data-action=load]").click()')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false" && document.getElementById("loadedPackCount").textContent==="1"', 'load session pack')
  await frameEval('document.getElementById("unloadAllPacks").click()')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false"', 'session pack change')
  assert.equal(await frameEval('localStorage.getItem("viewer-resource-packs-v1")'), '["favorite-user-pack"]')
  const zip = new JSZip().file('pack.mcmeta', JSON.stringify({ pack: { pack_format: 84, description: 'Session test' } })).file('assets/minecraft/lang/en_us.json', '{}')
  zip.file('assets/minecraft/textures/block/stone.png', await readFile('public/assets/minecraft/textures/block/red_concrete.png'))
  const zipBytes = [...await zip.generateAsync({ type: 'uint8array' })]
  const databasesBefore = await frameEval('indexedDB.databases().then(list=>list.map(db=>db.name).sort())')
  await frameEval(`(()=>{const input=document.getElementById('packInput'),dt=new DataTransfer();dt.items.add(new File([new Uint8Array(${JSON.stringify(zipBytes)})],'session-only.zip'));input.files=dt.files;input.dispatchEvent(new Event('change'))})()`)
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false" && document.querySelector("#loadedPackList [data-pack-id=\'local:session-only.zip\']")', 'import session ZIP')
  assert.deepEqual(await frameEval('indexedDB.databases().then(list=>list.map(db=>db.name).sort())'), databasesBefore, 'ZIP import creates no persistent database')
  await shot('settings')
  await frameEval('document.getElementById("settingsCloseBtn").click();document.getElementById("materialSummaryBtn").click()')
  await frameWait('document.querySelectorAll(".material-icon.loaded").length===4', 'resource pack thumbnails')
  assert.notEqual(await frameEval('document.querySelector(\'.material-icon[data-material="stone"] img\').src'), stoneIcon, 'material icons follow local packs')
  await frameEval('document.getElementById("materialCloseBtn").click();document.getElementById("packSummaryBtn").click();document.getElementById("unloadAllPacks").click()')
  await frameWait('document.getElementById("app").getAttribute("aria-busy")==="false"', 'unload icon pack')
  await frameEval('document.getElementById("settingsCloseBtn").click();document.getElementById("materialSummaryBtn").click()')
  await frameWait('document.querySelectorAll(".material-icon.loaded").length===4', 'restored thumbnails')
  assert.equal(await frameEval('document.querySelector(\'.material-icon[data-material="stone"] img\').src'), stoneIcon, 'unload restores vanilla icons')
  await frameEval('document.getElementById("materialCloseBtn").click()')
  await frameEval('document.getElementById("settingsCloseBtn").click();document.getElementById("imageExportBtn").click()')
  await frameWait('document.getElementById("imageExport").open && !document.getElementById("exportSave").disabled', 'export studio in full iframe')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("imageExport")).color'), 'rgb(33, 51, 72)')
  await shot('export')
  await frameEval('document.getElementById("exportWidth").value="512";document.getElementById("exportHeight").value="512";document.getElementById("exportWidth").dispatchEvent(new Event("change"));document.getElementById("exportSave").click()')
  await until(() => completed.length > 0, 'sandbox allows PNG download')
  assert.equal((await readFile(resolve(downloads, completed[0]))).toString('hex', 0, 8), '89504e470d0a1a0a')
  await frameEval('document.getElementById("exportBack").click()')
  await evaluate('card.setOptions({viewer:{header:false,layout:"compact",density:"compact",panels:{metadata:false},tools:{catalog:false,packs:false,help:false}}})')
  await frameWait('document.body.classList.contains("viewer-no-header")', 'compact layout')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("viewer")).top'), '0px')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("entityPreviewBtn")).display'), 'none')
  await frameEval('document.getElementById("infoPanelBtn").click()')
  assert.equal(await frameEval('getComputedStyle(document.getElementById("right-panel")).display'), 'flex')
  await shot('compact')
  await evaluate(`(()=>{const f=document.querySelector('#preview iframe'),u=new URL(f.src);f.contentWindow.postMessage({protocol:'litematic-preview-v1',channel:'wrong',type:'configure',options:{theme:'dark'}},u.origin)})()`)
  await delay(100)
  assert.equal(await frameEval('document.documentElement.dataset.viewerTheme'), 'light', 'wrong channels cannot change UI')
  await evaluate('card.setCamera({projection:"orthographic",zoom:1.4});card.setOptions({theme:"auto"})')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await frameWait('document.documentElement.dataset.viewerTheme==="dark"', 'system theme')
  await wait('window.camera?.projection==="orthographic" && Math.abs(camera.zoom-1.4)<.001', 'camera event')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(250)
  assert.equal(await frameEval('document.documentElement.scrollWidth===innerWidth'), true)
  await shot('mobile')
  await frameEval('document.getElementById("materialSummaryBtn").click()')
  assert.equal(await frameEval('(()=>{const r=document.getElementById("materialPanel").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'), true, 'mobile material card fits the viewport')
  await shot('materials-mobile')
  await evaluate('card.setOptions({viewer:{panels:{materials:false}}})')
  await frameWait('!document.getElementById("materialPanel").open && getComputedStyle(document.getElementById("materialSummaryBtn")).display==="none"', 'hiding materials dismisses the modal')
  await evaluate('card.setOptions({viewer:{panels:{materials:true}}})')
  await evaluate('card.setOptions({theme:"light",viewer:{header:true,layout:"auto",brand:{name:"Archive themed viewer"}}})')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await delay(200)
  const checkPopup = async (trigger, lang = 'en') => {
    const previous = new Set((await pages()).map(p => p.id))
    await trigger()
    let popup
    await until(async () => { popup = (await pages()).find(p => !previous.has(p.id) && p.type === 'page' && p.url.startsWith(base)); return !!popup }, 'full page popup')
    const other = await connect(popup.webSocketDebuggerUrl)
    try {
      await until(() => other.evaluate('document.body.classList.contains("has-model") && document.getElementById("app").getAttribute("aria-busy")==="false"'), 'popup file handoff')
      assert.equal(await other.evaluate('document.documentElement.dataset.viewerTheme'), 'light')
      assert.equal(await other.evaluate('document.documentElement.lang'), lang === 'zh' ? 'zh-CN' : 'en')
      assert.equal(await other.evaluate('document.getElementById("fileName").textContent'), 'private.litematic')
      assert.equal(await other.evaluate('document.getElementById("archiveReturn").href'), host + '/build/42')
      assert.equal(await other.evaluate('window.opener===null && !location.hash'), true)
      assert.equal(await other.evaluate('new URL(location).searchParams.has("appearance")'), true)
    } finally { other.ws.close(); await send('Target.closeTarget', { targetId: popup.id }) }
    await send('Page.bringToFront')
  }
  await frameEval('document.getElementById("langBtn").click();document.getElementById("bgColor").value="#e6f3eb";document.getElementById("bgColor").dispatchEvent(new Event("input"))')
  await evaluate('card.setOptions({style:{accent:"#21796b"}})')
  await frameWait('getComputedStyle(document.documentElement).getPropertyValue("--accent")==="#21796b"', 'host theme update after UI choices')
  assert.equal(await frameEval('document.documentElement.lang'), 'zh-CN', 'host theme update preserves in-viewer language')
  await checkPopup(() => mouseClick('#open'), 'zh')
  assert.equal(privateDownloads, 1, 'full page transfer does not refetch private source')
  await evaluate('quick()')
  await wait('document.querySelector("#preview > div")?.dataset.state==="loaded"', 'quick preview with same theme')
  await checkPopup(async () => {
    const point = await frameEval('(()=>{const r=document.getElementById("open").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()')
    const origin = await evaluate('(()=>{const r=document.querySelector("#preview iframe").getBoundingClientRect();return {x:r.left,y:r.top}})()')
    for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x + origin.x, y: point.y + origin.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  })
  await evaluate('card.destroy();window.card=null')
  // Invalid sources report an error (not a trailing loading event), then recover.
  await send('Page.navigate', { url: host })
  await wait('window.statusEvent?.type==="loaded"', 'fresh full viewer')
  await evaluate('card.load(new File(["not NBT"],"bad.litematic"))')
  await wait('window.statusEvent?.type==="error"', 'invalid file error')
  await delay(100)
  assert.equal(await evaluate('statusEvent.type'), 'error')
  await evaluate('card.load(file)')
  await wait('window.statusEvent?.type==="loaded"', 'load after error')
  // Generate and run the new full-viewer example without hand-written integration glue.
  await send('Page.navigate', { url: base + 'embed-example.html?lang=en#customize' })
  await wait('typeof document.getElementById("presetCustom")?.onclick==="function"', 'configurator')
  await evaluate('document.getElementById("presetCustom").click();document.getElementById("cfgMode").value="viewer";document.getElementById("cfgMode").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("customPreview").scrollIntoView({block:"center"})')
  await wait('document.querySelector("#customPreview > div")?.dataset.state==="loaded"', 'configurator full mode')
  await shot('configurator')
  generated = '<!doctype html><meta charset="utf-8">' + (await evaluate('document.getElementById("configCode").textContent')).replaceAll('https://lwv.loafing.club/', base)
  assert.match(generated, /createLitematicViewer/)
  await send('Page.navigate', { url: host + '/generated' })
  await wait('document.querySelector("#preview > div")?.dataset.state==="loaded"', 'generated full embed')
  assert.equal(await frameEval('document.documentElement.dataset.viewerTheme'), 'light')
  // The independent homepage still uses its original UI and persisted preference.
  await send('Page.navigate', { url: base + '?pack=vanilla' })
  await wait('document.querySelector("#app")?.getAttribute("aria-busy")==="false"', 'independent site reload')
  assert.equal(await evaluate('document.documentElement.dataset.viewerTheme'), undefined)
  assert.equal(await evaluate('document.getElementById("illagerExtraArms").checked'), true)
  assert.equal(await evaluate('localStorage.getItem("viewer-resource-packs-v1")'), '["favorite-user-pack"]')
  await evaluate('localStorage.removeItem("viewer-resource-packs-v1");localStorage.removeItem("viewer-illager-extra-arms-v1")')
  assert.deepEqual(exceptions, [], 'no uncaught exceptions')
  console.log('Passed full cross-origin private-file viewer, layers/materials, live/auto themes, safe branding, responsive panels, session-only settings/packs, exported PNG download, offscreen retention, camera events, authenticated handoff from full/quick viewers, generated full embed and independent-site defaults.')
} finally {
  socket?.close(); chrome.kill()
  if (archive) await new Promise(resolve => archive.close(resolve))
  await new Promise(resolve => server.httpServer.close(resolve))
}
