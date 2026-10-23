// Optional full UI test with real Chrome/WebGL; CHROME_PATH overrides the binary.
// The test-only Vite transform exposes existing app instances, never a production hook.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const string = s => { const b = Buffer.from(s), n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]) }
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
const list = (type, items) => Buffer.concat([Buffer.from([type]), int(items.length), ...items])
const vec = values => compound(...values.map((n, i) => tag(3, 'xyz'[i], int(n))))
const text = (name, value) => tag(8, name, string(value))
const number = (name, value) => tag(3, name, int(value))
const stack = (id, count, slot = 0, extras = []) => compound(text('id', 'minecraft:' + id), number('count', count), number('Slot', slot), ...extras)
const palette = [['air'], ['white_concrete'], ['chest', { facing: 'south', type: 'single', waterlogged: 'false' }],
  ['chest', { facing: 'north', type: 'left', waterlogged: 'false' }], ['chest', { facing: 'north', type: 'right', waterlogged: 'false' }],
  ['furnace', { facing: 'south', lit: 'true' }], ['oak_slab', { type: 'bottom', waterlogged: 'false' }],
  ['water', { level: '0' }], ['honey_block'], ['red_banner', { rotation: '0' }]]
const size = [14, 4, 6], cells = new Map(), width = size[0], depth = size[2]
const key = (x, y, z) => x + z * width + y * width * depth
for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) cells.set(key(x, 0, z), 1)
for (const [x, y, z, gi] of [[1, 1, 1, 2], [3, 1, 1, 3], [4, 1, 1, 4], [6, 1, 1, 5], [1, 1, 3, 6], [3, 1, 3, 7], [5, 1, 3, 8], [7, 1, 3, 9]]) cells.set(key(x, y, z), gi)
const words = Array(Math.ceil(size.reduce((a, b) => a * b, 1) * 4 / 64)).fill(0n)
for (const [key, gi] of cells) words[Math.floor(key * 4 / 64)] |= BigInt(gi) << BigInt(key * 4 % 64)
const packed = Buffer.alloc(words.length * 8); words.forEach((n, i) => packed.writeBigInt64BE(BigInt.asIntN(64, n), i * 8))
const tile = (id, pos, extra = []) => compound(text('id', 'minecraft:' + id), ...pos.map((n, i) => number('xyz'[i], n)), ...extra)
const entity = (id, pos, extra = [], rotation = [0, 0]) => compound(text('id', 'minecraft:' + id), tag(9, 'Pos', list(6, pos.map(double))), tag(9, 'Rotation', list(6, rotation.map(double))), ...extra)
const paletteTags = palette.map(([id, props = {}]) => compound(
  text('Name', 'minecraft:' + id), tag(10, 'Properties', compound(...Object.entries(props).map(([k, v]) => text(k, v)))),
))
const fixture = gzipSync(tag(10, '', compound(number('Version', 6), number('MinecraftDataVersion', 4900),
  tag(10, 'Metadata', compound(text('Name', 'Selection verification'), text('Author', 'LWV tests'))),
  tag(10, 'Regions', compound(tag(10, '检查区域', compound(tag(10, 'Position', vec([-4, 0, -2])), tag(10, 'Size', vec(size)),
    tag(9, 'BlockStatePalette', list(10, paletteTags)),
    tag(12, 'BlockStates', Buffer.concat([int(words.length), packed])),
    tag(9, 'TileEntities', list(10, [
      tile('chest', [1, 1, 1], [tag(9, 'Items', list(10, [stack('diamond', 64, 0), stack('apple', 3, 13, [tag(10, 'components', compound(text('minecraft:custom_name', '<img src=x onerror="window.__selectionPwned=1">')))])]))]),
      tile('chest', [3, 1, 1], [tag(9, 'Items', list(10, [stack('stone', 32, 0)]))]),
      tile('chest', [4, 1, 1], [tag(9, 'Items', list(10, [stack('iron_ingot', 8, 26)]))]),
      tile('furnace', [6, 1, 1], [number('CookTime', 45), number('CookTimeTotal', 200), tag(9, 'Items', list(10, []))]),
      tile('banner', [7, 1, 3]),
    ])),
    tag(9, 'Entities', list(10, [
      entity('zombie', [9.5, 1, 1.5], [tag(6, 'Health', double(7.5)), number('NoAI', 1),
        tag(9, 'attributes', list(10, [compound(text('id', 'minecraft:max_health'), tag(6, 'base', double(20)))])),
        tag(10, 'equipment', compound(tag(10, 'head', stack('iron_helmet', 1)), tag(10, 'mainhand', stack('diamond_sword', 1)))),
      ], [0, 15]),
      entity('item_frame', [9, 1.5, 3.97], [number('Facing', 3), tag(10, 'Item', stack('diamond', 1))]),
      entity('item_frame', [11, 1.5, 3.97], [number('Facing', 3), tag(10, 'Item', stack('apple', 3))]),
      entity('oak_boat', [12, 1, 1.2], [tag(9, 'Passengers', list(10, [entity('pig', [12, 1.5, 1.2], [number('Health', 6)])]))]),
    ])),
  )))),
)))
const server = await createServer({
  plugins: [{ name: 'selection-test',
    transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/main.js')) return code + `\nwindow.__inspectionTest = { renderer, inspector, imageExport, assets, openFile, setRenderMode, getData: () => currentData, getBusy: () => busy };`
    },
    configureServer(server) { server.middlewares.use('/__selection-fixture.litematic', (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); res.end(fixture) }) },
  }],
  server: { host: '127.0.0.1', port: 5199, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/scripts/_ref/**'] } },
})
await server.listen()
const profile = resolve('scripts/_ref/selection-browser-' + Date.now()); await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--disable-background-networking',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket, send
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
  send = (method, params = {}) => new Promise((resolve, reject) => {
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
    throw Error('Browser timeout: ' + expression + ' ' + await evaluate('document.getElementById("status").textContent'))
  }
  let touch = false
  const click = async (x, y, button = 'left') => {
    if (touch) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); return
    }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }
  const pointAt = async (position, offset = [1.2, .7, 3]) => evaluate(`(() => {
    const r = __inspectionTest.renderer, target = r.camera.position.clone().set(...${JSON.stringify(position)});
    r.camera.position.copy(target).add(r.camera.position.clone().set(...${JSON.stringify(offset)})); r.controls.target.copy(target); r.controls.update(); r.requestRender();
    const rect = r.renderer.domElement.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`)
  const selectAt = async (position, offset) => { const p = await pointAt(position, offset); await click(p.x, p.y); await until('!!__inspectionTest.inspector.details'); return evaluate('__inspectionTest.inspector.details.id') }
  const clear = () => evaluate('__inspectionTest.inspector.clear()')
  const ready = () => until('!!window.__inspectionTest?.getData() && !__inspectionTest.getBusy()')
  await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/?file=/__selection-fixture.litematic' }); await ready()
  assert.equal(await selectAt([-2.5, 1.4, -.5]), 'minecraft:chest')
  await until('__inspectionTest.inspector.names && document.querySelectorAll("#schematicInspector .material-icon.loaded").length === 2')
  assert.equal(await evaluate('document.getElementById("selectionTitle").textContent'), '箱子')
  assert.equal(await evaluate('document.querySelectorAll(".inspector-inventory-grid .inspector-slot").length'), 27)
  assert.ok((await evaluate('document.querySelector(".inspector-inventory-count").textContent')).includes('67'))
  assert.deepEqual(await evaluate('__inspectionTest.inspector.details.position'), [-3, 1, -1])
  const screen = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('scripts/_ref/selection-chest.png', Buffer.from(screen.data, 'base64'))
  await evaluate('document.querySelectorAll(".inspector-slot:not(.empty)")[1].click()')
  assert.equal(await evaluate('window.__selectionPwned'), undefined, 'NBT strings are text, never HTML')
  assert.ok((await evaluate('document.querySelector(".inspector-item-detail").textContent')).includes('<img'))
  await evaluate('document.getElementById("langBtn").click()')
  assert.equal(await evaluate('document.getElementById("selectionTitle").textContent'), 'Chest')
  assert.ok((await evaluate('document.querySelector(".inspector-inventory-count").textContent')).includes('slots used'))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  assert.equal(await evaluate('__inspectionTest.inspector.outline.visible'), false)
  assert.equal(await selectAt([-.5, 1.4, -.5]), 'minecraft:chest')
  assert.equal(await evaluate('__inspectionTest.inspector.details.containers.length'), 2)
  await clear()
  const p = await pointAt([-2.5, 1.4, -.5])
  await click(p.x, p.y, 'right'); assert.equal(await evaluate('__inspectionTest.inspector.selection'), null)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 30, y: p.y, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 })
  assert.equal(await evaluate('__inspectionTest.inspector.selection'), null, 'orbit is not a click')
  assert.equal(await selectAt([5.5, 2.1, -.5], [0, .1, 3]), 'minecraft:zombie')
  assert.equal(await evaluate('__inspectionTest.inspector.details.health'), 7.5)
  assert.equal(await evaluate('__inspectionTest.inspector.details.maxHealth'), 20)
  assert.equal(await evaluate('document.querySelectorAll(".inspector-equipment").length'), 2)
  const mobShot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('scripts/_ref/selection-mob.png', Buffer.from(mobShot.data, 'base64'))
  await clear(); assert.equal(await selectAt([5, 1.5, 1.97], [0, 0, 3]), 'minecraft:item_frame')
  assert.equal(await evaluate('__inspectionTest.inspector.details.containers[0].entries[0].stack.id'), 'minecraft:diamond')
  await clear(); assert.equal(await selectAt([7, 1.5, 1.97], [0, 0, 3]), 'minecraft:item_frame')
  assert.equal(await evaluate('__inspectionTest.inspector.details.containers[0].entries[0].stack.id'), 'minecraft:apple')
  await clear(); assert.equal(await selectAt([3.5, 2, 1.6], [0, .2, 3]), 'minecraft:red_banner')
  await clear(); assert.equal(await selectAt([1.5, 1.5, 1.5], [0, .3, 3]), 'minecraft:honey_block')
  await evaluate('document.getElementById("projectionBtn").click()')
  await clear(); assert.equal(await selectAt([-2.5, 1.4, -.5]), 'minecraft:chest')
  await evaluate('__inspectionTest.setRenderMode("single")'); await ready()
  assert.equal(await evaluate('__inspectionTest.inspector.selection'), null, 'layer rebuild clears stale selection')
  await evaluate('__inspectionTest.setRenderMode("all")'); await ready()
  assert.equal(await selectAt([-2.5, 1.4, -.5]), 'minecraft:chest')
  await evaluate('document.getElementById("imageExportBtn").click()'); await until('__inspectionTest.imageExport.isOpen')
  assert.equal(await evaluate('__inspectionTest.inspector.outline.visible'), false, 'selection is excluded from export')
  await evaluate('__inspectionTest.imageExport.dialog.close()')
  await until('!__inspectionTest.imageExport.isOpen')
  await evaluate('document.getElementById("packSummaryBtn").click(); document.getElementById("unloadAllPacks").click()')
  await until('!__inspectionTest.getBusy() && __inspectionTest.assets.packs.length === 0')
  await evaluate('document.getElementById("settingsPanel").close()')
  assert.equal(await selectAt([-2.5, 1.4, -.5]), 'minecraft:chest')
  console.log('PASS desktop interactions, packs and export')
  await clear(); await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); touch = true
  const pinch = await pointAt([-2.5, 1.4, -.5])
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pinch, id: 0 }, { x: pinch.x + 20, y: pinch.y, id: 1 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal(await evaluate('__inspectionTest.inspector.selection'), null, 'pinch is not a selection')
  await delay(100); assert.equal(await selectAt([-2.5, 1.4, -.5]), 'minecraft:chest')
  assert.ok(await evaluate('(() => { const r=document.getElementById("schematicInspector").getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth&&r.top>64&&r.bottom<innerHeight })()'), 'mobile card fits screen')
  const mobile = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('scripts/_ref/selection-mobile.png', Buffer.from(mobile.data, 'base64'))
  await evaluate('document.getElementById("clearBtn").click()')
  assert.equal(await evaluate('__inspectionTest.inspector.selection'), null)
  assert.equal(await evaluate('document.getElementById("schematicInspector").hidden'), true)
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log('PASS browser selection: actual clicks, chest slots/icons, safe NBT, translation, double chests, drag/right-click, mob health/equipment, batched frames, banner, honey, orthographic, layers, export, pack unload, mobile and clear.')
} catch (error) {
  if (send) {
    const shot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) await writeFile('scripts/_ref/selection-failure.png', Buffer.from(shot.data, 'base64'))
  }
  throw error
} finally { socket?.close(); chrome.kill(); await server.close() }
