import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { AssetProvider } from '../src/assets.js'
import { createPlayerHeadPreparation } from '../src/headTextures.js'
import { selectionSource } from '../src/selectionSources.js'

const angleCases = [
  ...Array.from({ length: 16 }, (_, rotation) => ({ label: 'rotation:' + rotation, rotation: String(rotation) })),
  ...['north', 'south', 'east', 'west'].map(facing => ({ label: 'facing:' + facing, facing })),
  ...[-1, 16, 17, .5, 2.75, 'bad'].map(rotation => ({ label: 'rotation:' + rotation, rotation })),
  { label: 'facing:unknown', facing: 'unknown', rotation: '7' },
]
function geometryHash(geometry) {
  const hash = createHash('sha256')
  for (const name of ['position', 'uv', 'normal', 'index']) {
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name)
    const array = attribute.array
    hash.update(`${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}:${array.length};`)
    hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength))
  }
  return hash.digest('hex')
}
function viewer() {
  const value = Object.create(Renderer.prototype)
  value.scene = new THREE.Scene(); value.headsGroup = new THREE.Group(); value.scene.add(value.headsGroup)
  return value
}
function texture(name) {
  const value = new THREE.Texture(); value.name = name; value.image = { width: 64, height: 64 }; return value
}
const goldenHeads = angleCases.map((entry, i) => ({ ...entry, x: i * 3 - 20, y: i % 4 - 2, z: -7 }))
// Captured from the unmodified cfaf675 Renderer before adding head prefetch or
// geometry sharing. Includes attribute layout/type and exact Float32/Uint32
// bytes; equivalent-looking -90/270 and 0/360 must not be normalized together.
const GOLDEN = {
  'rotation:0': '6ed657525f793a2c1bc86f2c66a1677034ca24bb4858dc475e40496d6917fa91',
  'rotation:1': 'ca82d57632eed21e380068bb5c395124260ade7b2bf186246b46768e8cde102e',
  'rotation:2': 'd5632e8c7db4adc54bcf80457d9ea376505613db53a0aa2767453bddf3f570cb',
  'rotation:3': '6b17e45f6ef239db36401a9bfe1effd3aa16ecbaf89d9c4bb8789823264ec34e',
  'rotation:4': '30eff950b003c016aef34636afe2f7a5f3ece6ff9970cbdaa572ebed8d02b11c',
  'rotation:5': 'eaa4bfdb0ca5e7e8d8d58dd546882bed969921e4653f6ffa6adbf12eea9c7157',
  'rotation:6': 'd47a589e438f9c1fe1de7f0f9deed63e9885f198779653116c8e543a1a4a6081',
  'rotation:7': 'f5df012de5306eaac4a5ec41ca10d939729e0daef47e216950721b2fdc0f7b18',
  'rotation:8': '442b6c7d7573fadc810cc5bd55a4cc1b0eedadecc5bbfee5de63fbd0d5901e7a',
  'rotation:9': '9457c1668b6702c9f457abe5214075161e6a74c880893cb34157deee798c7e7d',
  'rotation:10': '46f42a917db42966bf950004a088efd9befdee97bf4e4c70dab006820569b281',
  'rotation:11': 'e85ad9725cff881e3b1232994ce1cc6fb6f1a3b5220971629c4752d1accb0be0',
  'rotation:12': 'b540cdc06dbe988d4a3864c8b4a19c5f689bacdbda073f52652d30e4b8dbdf0a',
  'rotation:13': 'efb9b494259bb03dd2ebe9442e2c62fdf7ad2284b83d752d3e844186fb297df6',
  'rotation:14': '3b6bee01e6880492c024e9af39e884c0baf036a78a2e6b0bd44f519e89e89170',
  'rotation:15': '816ef3e28da980e2bfed51b7f2ff581b0fac3b90b4a74ee2718e07d3fcac07b9',
  'facing:north': '442b6c7d7573fadc810cc5bd55a4cc1b0eedadecc5bbfee5de63fbd0d5901e7a',
  'facing:south': '6ed657525f793a2c1bc86f2c66a1677034ca24bb4858dc475e40496d6917fa91',
  'facing:east': '25b618897d1bf7d779e8e11215687d2dbb75a01dcf29d7bb4eafe1f43cf1b970',
  'facing:west': '30eff950b003c016aef34636afe2f7a5f3ece6ff9970cbdaa572ebed8d02b11c',
  'rotation:-1': '816ef3e28da980e2bfed51b7f2ff581b0fac3b90b4a74ee2718e07d3fcac07b9',
  'rotation:16': 'b6cca31cf8863fd5bdfc1bdde5bea76048c937ab2285c07e9c6338b3e76a53e7',
  'rotation:17': 'ca82d57632eed21e380068bb5c395124260ade7b2bf186246b46768e8cde102e',
  'rotation:0.5': '2f605dd4683a214f9f8a9db4c4cd9f7847b49d19007a00a731ded8d686009062',
  'rotation:2.75': '278935e809226fc509fd9f29acfd3c35393dd3b8d857ad8fbc2855e19873dfb7',
  'rotation:bad': '6ed657525f793a2c1bc86f2c66a1677034ca24bb4858dc475e40496d6917fa91',
  'facing:unknown': '6ed657525f793a2c1bc86f2c66a1677034ca24bb4858dc475e40496d6917fa91',
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
const head = (x, skinUrl, y = 0) => ({ x, y, z: 0, skinUrl, rotation: 0 })
function assertProgress(records, total) {
  assert.equal(records[0].fraction, 0)
  assert.equal(records.at(-1).fraction, 1)
  assert.equal(records.at(-1).completed, total)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    assert.equal(record.total, total)
    assert.equal(record.fraction, record.completed / total)
    if (i) assert.ok(record.completed >= records[i - 1].completed, 'Completed heads never move backwards')
  }
}
const progressRecorder = records => (fraction, detail) => records.push({ fraction, ...detail })

{
  const view = viewer(), tex = texture('golden'), assets = new AssetProvider(), progress = []
  assets._getTexture = async () => tex
  view._layerMode = 'single'; view._layerY = 0
  await view.renderPlayerHeads(goldenHeads, assets, { onProgress: progressRecorder(progress) })
  assertProgress(progress, goldenHeads.length)
  const shared = new Map(), geometries = new Set(), materials = new Set()
  for (let i = 0; i < goldenHeads.length; i++) {
    const entry = goldenHeads[i], mesh = view.headsGroup.children[i]
    assert.equal(geometryHash(mesh.geometry), GOLDEN[entry.label], entry.label + ': unchanged geometry/UV/normal/index bytes')
    assert.deepEqual(mesh.position.toArray(), [entry.x, entry.y, entry.z])
    assert.deepEqual(selectionSource(mesh), { kind: 'block', position: [entry.x, entry.y, entry.z] })
    assert.equal(mesh.userData.schematicLayer, entry.y)
    assert.equal(mesh.visible, entry.y === 0)
    assert.equal(mesh.material.map, tex); assert.equal(mesh.material.alphaTest, .5); assert.equal(mesh.material.flatShading, true)
    assert.equal(mesh.material.transparent, false)
    if (i) assert.ok(mesh.material.id > view.headsGroup.children[i - 1].material.id, 'Keep opaque material creation order')
    const angle = entry.facing ? ({ north: 180, south: 0, east: -90, west: 90 }[entry.facing] || 0) : (Number(entry.rotation) || 0) * 22.5
    if (shared.has(angle)) assert.equal(mesh.geometry, shared.get(angle), 'Share the exact same angle')
    else shared.set(angle, mesh.geometry)
    geometries.add(mesh.geometry); materials.add(mesh.material)
  }
  assert.equal(geometries.size, shared.size)
  assert.equal(materials.size, goldenHeads.length, 'Sharing geometry must not share/order material IDs differently')
  assert.notEqual(shared.get(-90), shared.get(270)); assert.notEqual(shared.get(0), shared.get(360))
  let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0
  for (const geometry of geometries) geometry.addEventListener('dispose', () => geometryDisposals++)
  for (const material of materials) material.addEventListener('dispose', () => materialDisposals++)
  tex.addEventListener('dispose', () => textureDisposals++)
  view.clearHeads(); view.clearHeads()
  assert.equal(geometryDisposals, geometries.size); assert.equal(materialDisposals, materials.size); assert.equal(textureDisposals, 0)
}
{
  const first = viewer(), second = viewer(), assets = new AssetProvider(), tex = texture('shared provider')
  assets._getTexture = async () => tex
  await first.renderPlayerHeads([head(0), head(1)], assets)
  await second.renderPlayerHeads([head(2), head(3)], assets)
  assert.notEqual(first.headsGroup.children[0].geometry, second.headsGroup.children[0].geometry, 'Geometry ownership stops at the viewer boundary')
  let otherDisposed = 0, textureDisposed = 0
  second.headsGroup.children[0].geometry.addEventListener('dispose', () => otherDisposed++)
  tex.addEventListener('dispose', () => textureDisposed++)
  first.clearHeads(); assert.equal(otherDisposed, 0); assert.equal(textureDisposed, 0)
  assert.equal(geometryHash(second.headsGroup.children[0].geometry), GOLDEN['rotation:0'])
  second.clearHeads(); assert.equal(otherDisposed, 1); assert.equal(textureDisposed, 0)
}
{
  // A preview can fail after its shared head geometry was built but before the
  // result reaches a scene. Dispose that geometry once without losing the error
  // or destroying borrowed textures still owned by the provider.
  const originalBlocks = Renderer.prototype._buildBlockMeshes, originalBanners = Renderer.prototype.renderBanners
  const assets = new AssetProvider(), tex = texture('failed preview'), failure = new Error('Preview banner failure')
  let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0
  assets._getTexture = async () => tex
  tex.addEventListener('dispose', () => textureDisposals++)
  Renderer.prototype._buildBlockMeshes = async () => {}
  Renderer.prototype.renderBanners = async function () {
    const [first, second] = this.headsGroup.children
    assert.equal(first.geometry, second.geometry)
    first.geometry.addEventListener('dispose', () => geometryDisposals++)
    for (const mesh of this.headsGroup.children) mesh.material.addEventListener('dispose', () => materialDisposals++)
    throw failure
  }
  try { await assert.rejects(Renderer.buildBlockPreview({ heads: [head(0), head(1)] }, assets), error => error === failure) }
  finally { Renderer.prototype._buildBlockMeshes = originalBlocks; Renderer.prototype.renderBanners = originalBanners }
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 2); assert.equal(textureDisposals, 0)
}
console.log('PASS player heads: cfaf675 golden bytes, exact angles, independent material order, source/layer metadata, shared disposal and viewer isolation')

{
  const view = viewer(), first = deferred(), second = deferred(), fallback = deferred(), missing = deferred(), progress = []
  const gates = new Map([['first', first], ['second', second], ['missing', missing]])
  const requested = [], assets = { cacheRevision: 0, getExternalTexture: key => { requested.push(key); return gates.get(key).promise }, getTexture: () => fallback.promise }
  const heads = [head(0, 'first', -1), head(1, 'second'), head(2, 'first'), head(3), head(4, 'missing'), head(5, 'second')]
  const pending = view.renderPlayerHeads(heads, assets, { onProgress: progressRecorder(progress) })
  const firstTexture = texture('first'), secondTexture = texture('second'), fallbackTexture = texture('steve')
  second.resolve(secondTexture); fallback.resolve(fallbackTexture); missing.resolve(null)
  await settle()
  assert.equal(view.headsGroup.children.length, 0, 'A ready later skin cannot move ahead of the first input head')
  first.resolve(firstTexture); await pending
  assert.deepEqual(view.headsGroup.children.map(mesh => mesh.position.x), [0, 1, 2, 3, 5])
  assert.deepEqual(view.headsGroup.children.map(mesh => mesh.material.map.name), ['first', 'second', 'first', 'steve', 'second'])
  assert.deepEqual(requested, ['first', 'second', 'missing'])
  assertProgress(progress, heads.length)
  for (let i = 1; i < view.headsGroup.children.length; i++) assert.ok(view.headsGroup.children[i - 1].material.id < view.headsGroup.children[i].material.id)
  view.clearHeads()
}

{
  const view = viewer(), heads = [head(0, 'retry'), head(1, 'ok'), head(2, 'retry')]
  const calls = [], recovered = texture('recovered'), ok = texture('ok')
  const assets = { getExternalTexture(key) {
    calls.push(key)
    return key === 'ok' ? ok : calls.length === 1 ? null : recovered
  } }
  const headPreparation = createPlayerHeadPreparation(heads, assets)
  await settle()
  assert.deepEqual(calls, ['retry', 'ok']); assert.equal(view.headsGroup.children.length, 0)
  await view.renderPlayerHeads(heads, assets, { headPreparation })
  assert.deepEqual(calls, ['retry', 'ok', 'retry'], 'Only the later duplicate retries the prepared failure')
  assert.deepEqual(view.headsGroup.children.map(o => [o.position.x, o.material.map.name]), [[1, 'ok'], [2, 'recovered']])
  headPreparation.stop(); view.clearHeads()
}
{
  const view = viewer(), assets = new AssetProvider(), heads = [head(0)]
  const old = texture('old Steve'), fresh = texture('new Steve')
  assets._getTexture = async () => old
  const headPreparation = createPlayerHeadPreparation(heads, assets)
  await settle()
  assets.clearCaches(); assets._getTexture = async () => fresh
  await view.renderPlayerHeads(heads, assets, { headPreparation })
  assert.equal(view.headsGroup.children[0].material.map, fresh, 'An invalidated preparation falls back to the active pack')
  headPreparation.stop(); view.clearHeads()
}
console.log('PASS render consumes prepared results in order and reloads skins from a changed resource pack')

for (const action of ['abort', 'clear', 'replacement', 'revision']) {
  const view = viewer(), gate = deferred(), controller = new AbortController(), progress = []
  const late = texture('late'), fresh = texture('fresh')
  let lateDisposed = 0; late.addEventListener('dispose', () => lateDisposed++)
  const assets = { cacheRevision: 0, getExternalTexture: url => url === 'late' ? gate.promise : Promise.resolve(fresh) }
  const old = view.renderPlayerHeads([head(0, 'late'), head(1, 'late')], assets, { signal: controller.signal, onProgress: progressRecorder(progress) })
  if (action === 'abort') { controller.abort(); await assert.rejects(old, { name: 'AbortError' }) }
  else if (action === 'clear') { view.clearHeads(); await old }
  else if (action === 'replacement') await view.renderPlayerHeads([head(9, 'fresh')], assets)
  else assets.cacheRevision++
  const sentinel = action === 'replacement' ? view.headsGroup.children[0] : new THREE.Group()
  if (action !== 'replacement') view.headsGroup.add(sentinel)
  const reports = progress.length
  gate.resolve(late); await old.catch(error => { if (action !== 'abort') throw error }); await settle()
  assert.deepEqual(view.headsGroup.children, [sentinel], action + ': late work cannot attach or remove replacement objects')
  assert.equal(progress.length, reports, action + ': late completion cannot publish old progress')
  assert.equal(lateDisposed, 0, action + ': late borrowed textures stay owned by the provider')
  assert.equal(view._sceneBuildDepth, 0, action + ': release the drawing hold')
  view.clearHeads()
}
console.log('PASS player heads: out-of-order skins retain input order, missing skins count as completed, abort/clear/replacement/revision reject stale scene work')

// Force predictable CPU-budget checkpoints while using real event-loop tasks.
// Promise-only texture cache hits must not finish the whole list before a timer.
const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
let clock = 0
Object.defineProperty(performance, 'now', { configurable: true, value: () => ++clock })
try {
  const view = viewer(), tex = texture('warm'), progress = [], heads = Array.from({ length: 256 }, (_, x) => head(x))
  let taskRan = false
  const timer = setTimeout(() => { taskRan = true }, 0)
  try {
    await view.renderPlayerHeads(heads, { getTexture: () => Promise.resolve(tex) }, { onProgress: progressRecorder(progress) })
    assert.ok(taskRan, 'Cached heads yield a real task before the complete build returns')
    assertProgress(progress, heads.length)
    assert.ok(progress.length > 2, 'Long builds report intermediate completions')
  } finally { clearTimeout(timer); view.clearHeads() }
  const cancelled = viewer(), controller = new AbortController()
  const pending = cancelled.renderPlayerHeads(heads, { getTexture: () => Promise.resolve(tex) }, { signal: controller.signal })
  const abortTimer = setTimeout(() => controller.abort(), 0)
  try { await assert.rejects(pending, { name: 'AbortError' }) }
  finally { clearTimeout(abortTimer) }
  assert.ok(cancelled.headsGroup.children.length < heads.length, 'Input cancellation interrupts cached CPU work')
  const count = cancelled.headsGroup.children.length; await settle()
  assert.equal(cancelled.headsGroup.children.length, count)
  cancelled.clearHeads()
} finally {
  if (originalNow) Object.defineProperty(performance, 'now', originalNow)
  else delete performance.now
}
console.log('PASS player heads: bounded warm-cache task yielding, prompt cancellation and monotonic count progress')
