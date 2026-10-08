import { preview } from 'vite'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Run npm run build first. The isolated browser and output files stay in scripts/_ref/.
const server = await preview({ preview: { host: '127.0.0.1', port: 5178, strictPort: true, open: false } })
const profile = resolve('scripts/_ref/image-export-profile'), downloads = resolve('scripts/_ref/image-export-downloads')
await mkdir(profile, { recursive: true }); await mkdir(downloads, { recursive: true })
await unlink(resolve(profile, 'DevToolsActivePort')).catch(() => {})
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket, chromeLog = ''
chrome.stderr.on('data', chunk => { chromeLog += chunk.toString() })
try {
  let port
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {}
    if (!port) await delay(100)
  }
  if (!port) throw Error('Chrome did not start: ' + chromeLog)
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0
  const pending = new Map(), errors = [], completedDownloads = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id); pending.delete(message.id)
      if (message.error) callback.reject(Error(JSON.stringify(message.error)))
      else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') completedDownloads.push(message.params.guid)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression, name) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error('Timeout: ' + name + ' ' + JSON.stringify(errors))
  }
  const click = async selector => {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const change = async (id, value, type = 'change') => {
    await evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});el[el.type==='checkbox'?'checked':'value']=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}))})()`)
    await delay(80)
  }
  const shot = async name => {
    await delay(150)
    const result = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`scripts/_ref/${name}.png`, Buffer.from(result.data, 'base64'))
  }
  const canvas = () => evaluate('document.querySelector("#exportFrame canvas").toDataURL()')
  await send('Runtime.enable'); await send('Page.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5178/?pack=vanilla' })
  await waitFor('document.querySelector("#imageExport") && !document.getElementById("imageExportBtn").disabled', 'export entry ready')
  assert.equal(await evaluate('document.getElementById("imageExportBtn").nextElementSibling.id'), 'uiToggleBtn')
  await click('#imageExportBtn')
  assert.equal(await evaluate('document.getElementById("imageExport").matches(":modal")'), true)
  assert.equal(await evaluate('document.getElementById("exportSave").disabled'), true, 'empty scene cannot export')
  await shot('image-export-empty')
  await click('#exportDemo')
  await waitFor('document.body.classList.contains("has-model") && !document.getElementById("exportSave").disabled', 'demo loads from studio')
  assert.equal(await evaluate('document.getElementById("exportSourceName").textContent'), 'demo.litematic')
  await click('#exportBack')
  await delay(150)
  const mainBefore = await evaluate('document.querySelector("#viewer canvas").toDataURL()')
  await click('#imageExportBtn')
  await delay(150)
  assert.equal(await evaluate('document.getElementById("exportProjection").value'), 'orthographic', 'default isometric projection')
  await shot('image-export-desktop')
  const beforeOrbit = await canvas()
  const point = await evaluate('(()=>{const r=document.getElementById("exportFrame").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()')
  for (const [type, x, y] of [['mousePressed', point.x, point.y], ['mouseMoved', point.x + 50, point.y + 20], ['mouseReleased', point.x + 50, point.y + 20]]) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await delay(100)
  assert.notEqual(await canvas(), beforeOrbit, 'drag rotates export independently')
  const beforePan = await canvas()
  for (const [type, x, y] of [['mousePressed', point.x, point.y], ['mouseMoved', point.x + 25, point.y], ['mouseReleased', point.x + 25, point.y]]) await send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: type === 'mouseReleased' ? 0 : 2, clickCount: 1 })
  await delay(100)
  assert.notEqual(await canvas(), beforePan, 'right drag pans')
  const beforeZoom = await canvas()
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -160 }); await delay(100)
  assert.notEqual(await canvas(), beforeZoom, 'wheel zooms')
  await click('[data-export-view="iso"]')
  await change('exportWidth', 512, 'input'); await change('exportHeight', 320, 'input')
  await change('exportFilename', '导出验证')
  // Observe the actual blob offered to the browser's download, without replacing encoding.
  await evaluate('window.exportBlobs=[];window.originalBlobURL=URL.createObjectURL;URL.createObjectURL=function(blob){if(blob.type==="image/png")exportBlobs.push(blob);return originalBlobURL.call(this,blob)}')
  const exportPNG = async (includePixels = true) => {
    const count = await evaluate('exportBlobs.length')
    await click('#exportSave')
    await waitFor(`exportBlobs.length===${count + 1} && document.getElementById('imageExport').getAttribute('aria-busy')==='false'`, 'PNG encoded')
    return evaluate(`(async()=>{const blob=exportBlobs.at(-1), bitmap=await createImageBitmap(blob), c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const pixels=ctx.getImageData(0,0,c.width,c.height).data;let empty=0,filled=0;for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)empty++;if(pixels[i]===255)filled++}return {width:c.width,height:c.height,empty,filled,corner:[...pixels.slice(0,4)],pixels:${includePixels ? 'c.toDataURL()' : 'null'}}})()`)
  }
  const transparent = await exportPNG()
  assert.equal(transparent.width, 512); assert.equal(transparent.height, 320)
  assert.ok(transparent.empty > 1000 && transparent.filled > 1000, 'PNG contains both transparent background and rendered geometry')
  await change('exportShowGuides', true)
  const guided = await exportPNG()
  assert.equal(guided.pixels, transparent.pixels, 'composition guides and all UI are absent from PNG')
  await change('exportBackground', 'solid'); await change('exportColor', '#3867c7', 'input')
  const solid = await exportPNG()
  assert.equal(solid.empty, 0); assert.deepEqual(solid.corner, [56, 103, 199, 255], 'solid color is exported in sRGB')
  await writeFile('scripts/_ref/image-export-result.png', Buffer.from(transparent.pixels.split(',')[1], 'base64'))
  await change('exportRatio', '1')
  await click('[data-export-size="4096"]')
  const highResolution = await exportPNG(false)
  assert.equal(highResolution.width, 4096); assert.equal(highResolution.height, 4096, '4K export uses requested pixels, independent of viewport size')
  await change('exportWidth', 8192, 'input'); await change('exportHeight', 8192, 'input')
  assert.equal(await evaluate('document.getElementById("exportSave").disabled'), true, 'oversized images are rejected')
  await change('exportWidth', 512.5, 'input'); await change('exportHeight', 320, 'input')
  assert.equal(await evaluate('document.getElementById("exportSave").disabled'), true, 'fractional sizes are rejected')
  await change('exportWidth', 512, 'input')
  await change('exportProjection', 'perspective')
  assert.notEqual(await canvas(), beforeOrbit)
  await click('#exportBack'); await delay(150)
  assert.equal(await evaluate('document.querySelector("#viewer canvas").toDataURL()'), mainBefore, 'viewer camera, background and overlays restored exactly')
  assert.equal(await evaluate('document.activeElement.id'), 'imageExportBtn', 'focus restored')
  for (let i = 0; i < 3; i++) { await click('#imageExportBtn'); await click('#exportBack') }
  await click('#imageExportBtn'); await delay(150)
  assert.equal(await evaluate('document.getElementById("exportSave").disabled'), false, 'reopening releases old contexts safely')
  await click('#exportLang')
  assert.equal(await evaluate('document.getElementById("exportTitle").textContent'), 'Export image')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await evaluate('document.getElementById("imageExport").scrollTop=0')
  await delay(100)
  assert.equal(await evaluate('document.getElementById("imageExport").scrollWidth<=390'), true, 'mobile has no horizontal overflow')
  await shot('image-export-mobile')
  await change('exportBackground', 'transparent')
  await exportPNG()
  for (let attempt = 0; attempt < 50 && completedDownloads.length < 5; attempt++) await delay(100)
  assert.equal(completedDownloads.length, 5, 'all PNG files completed browser downloads')
  const bytes = await readFile(resolve(downloads, completedDownloads[0]))
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', 'download is a PNG')
  assert.equal(bytes.readUInt32BE(16), 512); assert.equal(bytes.readUInt32BE(20), 320)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor('!document.getElementById("imageExport").open', 'Escape exits studio')
  await change('renderMode', 'single')
  await waitFor('document.getElementById("app").getAttribute("aria-busy")==="false"', 'layer selection rebuilt')
  await click('#imageExportBtn')
  const sliced = await exportPNG()
  assert.notEqual(sliced.pixels, transparent.pixels, 'export uses the selected layer geometry')
  await click('#exportBack')
  assert.equal(await evaluate('document.getElementById("renderMode").value'), 'single', 'export does not reset selected layers')
  assert.deepEqual(errors, [], 'no runtime exceptions')
  console.log('Passed empty-state loading, existing scene/layer reuse, orbit/pan/zoom, exact PNG size/alpha/color through 4K, real downloads, UI exclusion, limits, state restoration, repeated disposal, mobile layout and English UI.')
} finally {
  socket?.close(); chrome.kill()
  await new Promise(resolve => server.httpServer.close(resolve))
}
