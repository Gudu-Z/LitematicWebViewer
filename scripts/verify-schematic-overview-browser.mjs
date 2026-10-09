// Browser integration for automatic whole-schematic previews. --large also imports
// the two private local originals. Test hooks are injected by this server only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const integer = n => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(n); return bytes }
const string = value => { const bytes = Buffer.from(value), size = Buffer.alloc(2); size.writeUInt16BE(bytes.length); return Buffer.concat([size, bytes]) }
const tag = (type, name, value) => Buffer.concat([Buffer.from([type]), string(name), value])
const compound = (...values) => Buffer.concat([...values, Buffer.from([0])])
const vector = values => compound(...values.map((value, i) => tag(3, 'xyz'[i], integer(value))))

async function makeFixture() {
  const width = 192, height = 96, depth = 192, states = Buffer.alloc(width * height * depth / 4)
  let blocks = 0
  for (let y = 0, index = 0; y < height; y++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++, index++) {
    const tower = x % 48 >= 10 && x % 48 < 34 && z % 48 >= 10 && z % 48 < 34
    const state = y < 63 ? 1 : y === 63 ? 2 : tower && y < 89 ? (y % 5 === 0 ? 3 : 1) : 0
    if (state) blocks++
    // Litematica words are big-endian, with palette values packed low bits first.
    states[Math.floor(index / 32) * 8 + 7 - Math.floor(index % 32 / 4)] |= state << (index % 4 * 2)
  }
  const palette = ['air', 'stone', 'grass_block', 'glass'].map(name => compound(tag(8, 'Name', string('minecraft:' + name))))
  const region = compound(tag(10, 'Position', vector([-160, 7, -60])), tag(10, 'Size', vector([width, height, depth])),
    tag(9, 'BlockStatePalette', Buffer.concat([Buffer.from([10]), integer(palette.length), ...palette])),
    tag(12, 'BlockStates', Buffer.concat([integer(states.length / 8), states])))
  const bytes = tag(10, '', compound(tag(3, 'Version', integer(7)), tag(10, 'Regions', compound(tag(10, 'Whole town', region))),
    tag(10, 'Metadata', compound(tag(8, 'Name', string('Whole overview browser fixture')), tag(3, 'TotalBlocks', integer(blocks)), tag(3, 'TotalVolume', integer(width * height * depth))))))
  const file = resolve('scripts/_ref/overview-browser-fixture.litematic')
  await writeFile(file, gzipSync(bytes))
  return { file, bounds: { minX: -160, maxX: 31, minY: 7, maxY: 102, minZ: -60, maxZ: 131, width, height, depth }, blocks }
}

await mkdir('scripts/_ref', { recursive: true })
const fixture = await makeFixture()
const server = await createServer({ base: '/LitematicWebViewer/', server: { host: '127.0.0.1', port: 5198, strictPort: true, open: false,
  hmr: false, watch: { ignored: ['**/scripts/_ref/**', '**/schematics/**'] } },
  plugins: [{ name: 'schematic-overview-test-hooks', transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/main.js')) return
    return code + `\nwindow.__overviewCheck={get renderer(){return renderer},get data(){return currentData},get session(){return currentLoadSession},get busy(){return busy},get imageExport(){return imageExport},get lod(){return lodController},openFile};\n`
  } }],
})
await server.listen()
const profile = resolve('scripts/_ref/overview-browser-' + Date.now())
await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
const errors = [], results = [], memorySamples = []
try {
  let port
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {}
    if (!port) await delay(100)
  }
  assert.ok(port, 'Chrome startup')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map(), workers = new Set(); let serial = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id); if (!callback) return
      pending.delete(message.id); clearTimeout(callback.timer)
      if (message.error) callback.reject(Error(JSON.stringify(message.error))); else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '))
    else if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'worker') workers.add(message.params.sessionId)
    else if (message.method === 'Target.detachedFromTarget') workers.delete(message.params.sessionId)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  let memoryLabel = '', lastMemory = 0
  const captureMemory = async label => {
    lastMemory = Date.now()
    const page = await send('Runtime.getHeapUsage')
    const samples = await Promise.allSettled([...workers].map(id => send('Runtime.getHeapUsage', {}, id)))
    memorySamples.push({ label, time: Date.now(), page, workers: samples.filter(s => s.status === 'fulfilled').map(s => s.value) })
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async (expression, milliseconds = 120000) => {
    const deadline = Date.now() + milliseconds
    do {
      if (memoryLabel && Date.now() - lastMemory > 2000) await captureMemory(memoryLabel)
      if (await evaluate(expression)) return
      await delay(150)
    } while (Date.now() < deadline)
    throw Error('Page timeout: ' + expression + ' ' + JSON.stringify(await evaluate(`({status:document.getElementById('status')?.textContent,dialog:document.getElementById('schematicLoad')?.textContent,error:document.getElementById('errorBanner')?.textContent})`)))
  }
  const idle = () => until('window.__overviewCheck && !__overviewCheck.busy')
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const upload = async file => {
    const input = await send('Runtime.evaluate', { expression: 'document.getElementById("fileInput")' })
    await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [resolve(file)] })
  }
  const screenshot = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`scripts/_ref/overview-${name}.png`, Buffer.from(shot.data, 'base64'))
  }
  async function check(label, whole = true) {
    await idle(); await delay(150)
    const result = await evaluate(`(() => {
      const {renderer:r,data:d}=__overviewCheck;
      r.renderer.render(r.scene,r.camera);
      const gl=r.renderer.getContext(), pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const colors=new Set();for(let i=0;i<pixels.length;i+=16)colors.add(pixels[i]*65536+pixels[i+1]*256+pixels[i+2]);
      let meshes=0,invalid=0;const g=d?.overview?r.overviewGroup:r.group;g?.traverse(o=>{if(!o.isMesh)return;meshes++;for(const a of Object.values(o.geometry.attributes))for(const v of a.array)if(!Number.isFinite(v))invalid++});
      return {status:document.getElementById('status').textContent,range:document.getElementById('loadedRange').textContent,error:document.getElementById('errorBanner').textContent,colors:colors.size,meshes,invalid,bounds:d?.bounds,overview:!!d?.overview,contextLost:gl.isContextLost(),chooserSeen:window.rangeChooserSeen};
    })()`)
    assert.equal(result.error, '', label + ': ' + result.error)
    assert.equal(result.overview, whole, label + ' mode')
    assert.equal(result.contextLost, false)
    assert.equal(result.invalid, 0)
    assert.ok(result.meshes > 0 && result.colors > 12, label + ': visible geometry ' + JSON.stringify(result))
    assert.equal(result.chooserSeen, false, 'Opening must never ask for a range')
    await screenshot(label)
    console.log('PASS', label, JSON.stringify(result)); results.push({ label, ...result })
    return result
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5198/LitematicWebViewer/?pack=vanilla' })
  await idle()
  await evaluate(`window.rangeChooserSeen=false;new MutationObserver(()=>{if(document.querySelector('#schematicLoad .load-range')?.hidden===false)window.rangeChooserSeen=true}).observe(document.body,{subtree:true,childList:true,attributes:true})`)
  await upload('samples/demo.litematic'); await check('demo', false)
  await evaluate(`document.documentElement.style.setProperty('--ui-surface','#ffffff');document.documentElement.style.setProperty('--ui-text','#213348')`)
  await upload(fixture.file); await until('!!document.querySelector("#schematicLoad .load-cancel")')
  assert.equal(await evaluate('getComputedStyle(document.getElementById("schematicLoad")).backgroundColor'), 'rgb(255, 255, 255)')
  await click('#schematicLoad .load-cancel'); await idle()
  assert.equal(await evaluate('document.getElementById("fileName").textContent'), 'demo.litematic', 'Cancel preserves the old view')
  await evaluate(`document.documentElement.style.removeProperty('--ui-surface');document.documentElement.style.removeProperty('--ui-text')`)
  await upload(fixture.file)
  const overview = await check('automatic-whole-fixture')
  assert.deepEqual(overview.bounds, fixture.bounds)
  assert.equal(await evaluate('document.getElementById("changeRangeBtn").hidden'), true)
  assert.equal(await evaluate('document.getElementById("loadedRange").hidden'), false)
  assert.deepEqual(await evaluate('__overviewCheck.renderer._bounds'), fixture.bounds)

  // Orbit zoom into the central roof; exact detail should arrive without recentering.
  await evaluate(`(()=>{const r=__overviewCheck.renderer;r.setMoveMode('orbit');r.controls.target.set(-64,72,36);r.camera.position.set(-40,103,65);r.controls.update();window.detailCamera=r.camera.position.toArray()})()`)
  await until('__overviewCheck.renderer.detailData?.blocks?.size>0')
  assert.deepEqual(await evaluate('__overviewCheck.renderer._bounds'), fixture.bounds)
  assert.ok(await evaluate('__overviewCheck.renderer.camera.position.toArray().every((v,i)=>Math.abs(v-window.detailCamera[i])<1e-6)'), 'Detail must preserve camera')
  assert.equal(await evaluate('__overviewCheck.busy'), false, 'Background detail must leave controls available')
  await check('automatic-near-detail')

  await evaluate(`document.getElementById('renderMode').value='below';document.getElementById('renderMode').dispatchEvent(new Event('change'))`)
  await idle(); await screenshot('slice-whole')
  await evaluate(`document.getElementById('renderMode').value='all';document.getElementById('renderMode').dispatchEvent(new Event('change'))`)
  await idle()
  await click('#imageExportBtn'); await until('document.getElementById("imageExport").open')
  const exportBounds = await evaluate(`(()=>{const b=__overviewCheck.imageExport.bounds();return {min:b.min.toArray(),max:b.max.toArray()}})()`)
  assert.ok(exportBounds.min[0] <= fixture.bounds.minX && exportBounds.max[0] >= fixture.bounds.maxX + 1, 'Export includes full overview width')
  assert.ok(exportBounds.min[2] <= fixture.bounds.minZ && exportBounds.max[2] >= fixture.bounds.maxZ + 1, 'Export includes full overview depth')
  await screenshot('export-whole'); await click('#exportBack')
  await click('#langBtn')
  assert.match(await evaluate('document.getElementById("loadedRange").textContent'), /overview|whole|detail/i)
  await click('#langBtn')

  // Create an in-flight detail read, then replace the schematic. Its completion
  // must not restore stale geometry or mutate the new file's bounds/status.
  await evaluate(`(()=>{const session=__overviewCheck.session,read=session.loadDetail.bind(session);session.loadDetail=async(...args)=>{const result=await read(...args);window.detailResultReady=true;await new Promise(resolve=>{window.releaseDetailResult=resolve});return result}})()`)
  await evaluate(`(()=>{const r=__overviewCheck.renderer;r.controls.target.set(-136,72,-36);r.camera.position.set(-112,103,-7);r.controls.update()})()`)
  await until('window.detailResultReady===true')
  await upload('samples/demo.litematic'); await check('replace-during-detail', false)
  await evaluate('window.releaseDetailResult()')
  await delay(1200)
  assert.equal(await evaluate('!!__overviewCheck.renderer.detailData'), false)
  assert.equal(await evaluate('__overviewCheck.renderer.overviewGroup.children.length'), 0)
  assert.equal(await evaluate('document.getElementById("fileName").textContent'), 'demo.litematic')

  if (process.argv.includes('--large')) {
    const files = (await readdir('schematics')).filter(name => name.startsWith('完整海盗城') || name.startsWith('Parrots'))
    assert.equal(files.length, 2, 'Both local originals must be present')
    for (const [index, name] of files.entries()) {
      if (index === 0) {
        await upload('schematics/' + name); await until('!!document.querySelector("#schematicLoad .load-cancel")')
        await click('#schematicLoad .load-cancel'); await idle()
        assert.equal(await evaluate('document.getElementById("fileName").textContent'), 'demo.litematic', 'Cancel preserves the old view')
      }
      await evaluate('window.loadTicks=0;window.tickTimer=setInterval(()=>window.loadTicks++,20)')
      memoryLabel = name
      await upload('schematics/' + name); await until('!__overviewCheck.busy', 600000)
      assert.ok(await evaluate('window.loadTicks>10'), 'Main thread responsive during whole-file preparation')
      await evaluate('clearInterval(window.tickTimer)')
      const result = await check(index ? 'pirate-whole' : 'council-whole')
      assert.deepEqual(result.bounds, await evaluate('__overviewCheck.session.info.bounds'), 'Entire original bounds preserved')
      assert.equal(await evaluate('document.getElementById("fileName").textContent'), name)
      await evaluate(`(()=>{const r=__overviewCheck.renderer,b=__overviewCheck.session.info.suggestedWindow,x=(b.minX+b.maxX)/2,y=(b.minY+b.maxY)/2,z=(b.minZ+b.maxZ)/2;r.controls.target.set(x,y,z);r.camera.position.set(x+30,y+35,z+30);r.controls.update()})()`)
      await until('__overviewCheck.renderer.detailData?.blocks?.size>0', 180000)
      await check(index ? 'pirate-near' : 'council-near')
      assert.deepEqual(await evaluate('__overviewCheck.renderer._bounds'), result.bounds, 'Detail keeps the whole original bounds')
      await captureMemory(name + '-near-ready')
      memoryLabel = ''
    }
  }
  await click('#clearBtn')
  assert.equal(await evaluate('__overviewCheck.renderer.overviewGroup.children.length'), 0)
  assert.equal(await evaluate('!!__overviewCheck.renderer.detailData'), false)
  assert.equal(await evaluate('document.getElementById("loadedRange").hidden'), true)
  assert.deepEqual(errors, [], 'No WebGL or JavaScript errors')
  await writeFile('scripts/_ref/overview-browser-results.json', JSON.stringify(results, null, 2))
  if (memorySamples.length) {
    await writeFile('scripts/_ref/overview-browser-memory.json', JSON.stringify(memorySamples, null, 2))
    console.log('Peak worker JS heap MiB:', Math.round(Math.max(...memorySamples.flatMap(s => s.workers.map(w => w.usedSize))) / 1048576),
      'backing storage MiB:', Math.round(Math.max(...memorySamples.flatMap(s => s.workers.map(w => w.backingStorageSize || 0))) / 1048576))
  }
  console.log('PASS automatic full bounds, no range chooser, near detail, slicing, export, localization and lifecycle')
} finally {
  socket?.close(); chrome.kill()
  await server.close()
}
