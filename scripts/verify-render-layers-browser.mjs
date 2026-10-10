// Real uploads and main-viewer controls; diagnostic access is injected only by
// this test server. No test hooks are shipped in the production bundle.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const float = n => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
const str = s => { const b = Buffer.from(s), n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]) }
const tag = (type, name, value) => Buffer.concat([Buffer.from([type]), str(name), value])
const compound = (...values) => Buffer.concat([...values, Buffer.from([0])])
const list = (type, values) => Buffer.concat([Buffer.from([type]), int(values.length), ...values])
const vec = values => compound(...values.map((n, i) => tag(3, 'xyz'[i], int(n))))
const mob = (id, x, y, z, extra = []) => compound(tag(8, 'id', str('minecraft:' + id)), tag(9, 'Pos', list(6, [x, y + 3, z].map(double))), tag(9, 'Rotation', list(5, [float(0), float(0)])), ...extra)
const palette = [
  ['air', {}], ['stone', {}], ['oak_sign', { rotation: '0', waterlogged: 'false' }],
  ['player_head', { rotation: '0' }], ['white_banner', { rotation: '0' }],
  ['decorated_pot', { facing: 'north', waterlogged: 'false', cracked: 'false' }],
  ['copper_golem_statue', { facing: 'north', copper_golem_pose: 'standing', waterlogged: 'false' }],
]
const entries = [mob('zombie', 1.5, -1.75, 1.5), mob('pig', 2.5, -.01, 1.5), mob('armor_stand', 3.5, .5, 1.5),
  mob('item_frame', 4.5, 1.5, 1.5, [tag(1, 'Facing', Buffer.from([3]))]),
  mob('oak_boat', 5.5, 3.25, 1.5, [tag(9, 'Passengers', list(10, [mob('pig', 5.5, 4.5, 1.5)]))])]
function region(origin, entities, details) {
  const width = 8, height = 10, depth = 5, words = Array(Math.ceil(width * height * depth * 3 / 64)).fill(0n)
  const put = (x, y, z, state) => {
    const bit = (x + z * width + y * width * depth) * 3, index = Math.floor(bit / 64), shift = bit % 64
    words[index] |= BigInt(state) << BigInt(shift)
    if (shift > 61) words[index + 1] |= BigInt(state) >> BigInt(64 - shift)
  }
  for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) put(x, 0, z, 1)
  const tiles = []
  if (details) for (const y of [1, 3, 6]) {
    for (let p = 2; p < palette.length; p++) {
      const x = p - 2; put(x, y, 3, p)
      if (p === 6) continue
      const id = { 2: 'sign', 3: 'skull', 4: 'banner', 5: 'decorated_pot' }[p]
      tiles.push(compound(tag(8, 'id', str('minecraft:' + id)), tag(3, 'x', int(x)), tag(3, 'y', int(y)), tag(3, 'z', int(3)),
        ...(p === 2 ? [tag(10, 'front_text', compound(tag(9, 'messages', list(8, ['Layer ' + (y - 3), '', '', ''].map(str)))))] : [])))
    }
  }
  const packed = Buffer.alloc(words.length * 8); words.forEach((word, i) => packed.writeBigUInt64BE(BigInt.asUintN(64, word), i * 8))
  return compound(tag(10, 'Position', vec(origin)), tag(10, 'Size', vec([width, height, depth])),
    tag(9, 'BlockStatePalette', list(10, palette.map(([name, props]) => compound(tag(8, 'Name', str('minecraft:' + name)),
      tag(10, 'Properties', compound(...Object.entries(props).map(([key, value]) => tag(8, key, str(value))))))))),
    tag(12, 'BlockStates', Buffer.concat([int(words.length), packed])), tag(9, 'Entities', list(10, entities)), tag(9, 'TileEntities', list(10, tiles)))
}
await mkdir('scripts/_ref', { recursive: true })
const file = resolve('scripts/_ref/render-layers.litematic')
await writeFile(file, gzipSync(tag(10, '', compound(tag(3, 'Version', int(7)), tag(10, 'Regions', compound(
  tag(10, 'Layer models', region([0, -3, 0], entries, true)), tag(10, 'Second region', region([10, -3, 0], [mob('cow', 1.5, 1.5, 1.5)], false))))))))
const server = await createServer({ server: { host: '127.0.0.1', port: 5196, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/scripts/_ref/**'] } },
  plugins: [{ name: 'layer-test-access', transform(code, id) {
    if (id.replaceAll('\\', '/').endsWith('/src/main.js')) return code + '\nwindow.__layers={get renderer(){return renderer},get data(){return currentData},get view(){return view},get busy(){return busy},get exporter(){return imageExport}};'
  } }] })
await server.listen()
const profile = resolve('scripts/_ref/render-layers-browser-' + Date.now())
await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
try {
  let port
  for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {} if (!port) await delay(100) }
  assert.ok(port, 'Chrome started')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map(), errors = []; let serial = 0
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data)
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => reject(Error('CDP timeout ' + method)), 20000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
  const until = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await delay(100) } throw Error('Timeout ' + expression + JSON.stringify(errors)) }
  const idle = () => until('!!window.__layers && !__layers.busy')
  const click = async id => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await idle() }
  const mode = async value => { await evaluate(`(()=>{const e=document.getElementById('renderMode');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'))})()`); await idle() }
  const visible = () => evaluate('__layers.renderer.entitiesGroup.children.filter(o=>o.visible).map(o=>o.userData.schematicLayer).sort((a,b)=>a-b)')
  const shot = async name => { await delay(150); const png = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('scripts/_ref/render-layers-' + name + '.png', Buffer.from(png.data, 'base64')) }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5196/?pack=vanilla' }); await idle()
  const input = await send('Runtime.evaluate', { expression: 'document.getElementById("fileInput")' })
  await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [file] })
  await until('!__layers.busy && __layers.data?.entities.length===6')
  await evaluate('window.originalLayerModels=[...__layers.renderer.entitiesGroup.children];window.originalCamera=__layers.renderer.camera.position.toArray()')
  assert.deepEqual(await visible(), [-2, -1, 0, 1, 1, 3]); await shot('all')
  await mode('single'); assert.deepEqual(await visible(), []) // Initial Y = -3.
  await click('layerUpBtn'); assert.deepEqual(await visible(), [-2]); await shot('single')
  for (const key of ['signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']) {
    assert.deepEqual(await evaluate(`__layers.renderer.${key}.children.filter(o=>o.visible).map(o=>o.userData.schematicLayer)`), [-2], key)
  }
  await click('layerUpBtn'); assert.deepEqual(await visible(), [-1])
  await mode('below'); assert.deepEqual(await visible(), [-2, -1])
  await mode('above'); assert.deepEqual(await visible(), [-1, 0, 1, 1, 3])
  assert.ok(await evaluate('__layers.renderer.entitiesGroup.children.every((o,i)=>o===originalLayerModels[i])'), 'Controls reuse existing models')
  assert.deepEqual(await evaluate('__layers.renderer.camera.position.toArray()'), await evaluate('originalCamera'), 'Layer controls preserve camera position')
  await evaluate('__layers.renderer.camera.position.y=1.2'); await click('locateBtn')
  assert.equal(await evaluate('__layers.view.layerY'), 1); assert.deepEqual(await visible(), [1, 1, 3])
  await mode('single'); assert.deepEqual(await visible(), [1, 1])
  await evaluate(`(()=>{const e=document.getElementById('showEntities');e.checked=false;e.dispatchEvent(new Event('change'))})()`)
  await click('layerDownBtn'); assert.deepEqual(await visible(), [0])
  assert.equal(await evaluate('__layers.renderer.entitiesGroup.visible'), false)
  await evaluate(`(()=>{const e=document.getElementById('showEntities');e.checked=true;e.dispatchEvent(new Event('change'));const h=document.getElementById('showEntityHitboxes');h.checked=true;h.dispatchEvent(new Event('change'))})()`)
  await click('imageExportBtn'); await until('!!__layers.exporter.isOpen && !document.getElementById("exportSave").disabled')
  const bounds = await evaluate('(()=>{const b=__layers.exporter.bounds();return {min:b.min.y,max:b.max.y}})()')
  assert.ok(bounds.min >= 0 && bounds.max < 3, 'Export bounds exclude hidden layers, including high entities and flags')
  await shot('export'); await click('exportBack')
  await click('layerUpBtn')
  await evaluate(`document.querySelectorAll('#regionListBody button')[1].click()`); await idle()
  assert.deepEqual(await visible(), [1], 'Region filter intersects the current layer')
  await evaluate(`document.querySelectorAll('#regionListBody button')[1].click()`); await idle()
  assert.deepEqual(await visible(), [1, 1], 'Rebuilt region models inherit the active layer')
  await click('clearBtn')
  assert.equal(await evaluate('__layers.renderer.entitiesGroup.children.length'), 0)
  await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [file] })
  await until('!__layers.busy && __layers.data?.entities.length===6')
  assert.equal(await evaluate('__layers.view.renderMode'), 'all'); assert.deepEqual(await visible(), [-2, -1, 0, 1, 1, 3])
  assert.deepEqual(errors, [])
  console.log('PASS browser layer modes, up/down, locate, model/camera retention, block entities, entity toggle, export, regions and clear/reopen')
} finally { socket?.close(); chrome.kill(); await server.close() }
