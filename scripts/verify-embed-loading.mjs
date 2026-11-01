import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import * as THREE from 'three'
import { normalizeOptions, applyTheme } from '../src/previewOptions.js'
import { PROTOCOL, validFile } from '../src/embedProtocol.js'
import { throwIfAborted, withAbort } from '../src/loadingTask.js'
import { createPlayerHeadPreparation } from '../src/headTextures.js'
import { extractPlayerHeads as readPlayerHeads } from '../src/schematicDetails.js'
import { Renderer as HeadRenderer } from '../src/renderer.js'

// Execute the real card orchestration with deterministic resource/render gates.
// The worker protocol/geometry and browser layout have their own integration tests.
const source = (await readFile(new URL('../src/embed.js', import.meta.url), 'utf8')).replace(/^import .+\r?\n/gm, '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async (condition, label) => {
  for (let i = 0; i < 500; i++) { if (condition()) return; await delay(1) }
  assert.fail(`Timed out waiting for ${label}`)
}
const file = id => new File([Uint8Array.of(id)], `${id}.litematic`)
const texture = key => { const tex = new THREE.Texture(); tex.name = key; return tex }

function fixture({ parseGates = new Map(), bakeGates = new Map(), buildGates = new Map(), geometryError = null,
  skins = new Map(), fetchSkin = async key => texture(key) } = {}) {
  const events = [], parses = [], renders = [], released = [], windowEvents = new Map(), documentEvents = new Map()
  const extracted = [], headRenders = [], skinRequests = [], baking = [], clearListeners = new Set()
  let subscriptions = 0
  function requestSkin(key) { skinRequests.push(key); return fetchSkin(key, skinRequests.filter(request => request === key).length) }
  const element = () => {
    const attributes = new Map()
    return { dataset: {}, style: { setProperty() {} }, hidden: false, disabled: false, textContent: '',
      setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
      addEventListener() {}, getAttribute: key => attributes.get(key) }
  }
  const nodes = new Map(['preview', 'message', 'status', 'progress', 'retry', 'open', 'fit', 'hint', 'canvas'].map(id => [id, element()]))
  let client, renderer, loads = 0, sceneUpdates = 0
  class Client {
    constructor() { client = this; this.active = null; this.disposed = false }
    async parse(bytes, onProgress, options) {
      assert.equal(options.renderOnly, true, 'Cards must omit non-rendered NBT')
      assert.ok(options.signal instanceof AbortSignal)
      const id = new Uint8Array(bytes)[0], call = { id, onProgress, signal: options.signal }
      parses.push(call)
      onProgress(.1, { phase: 'decompress', stageFraction: .2 })
      await withAbort(parseGates.get(id)?.promise ?? Promise.resolve(), options.signal)
      throwIfAborted(options.signal)
      onProgress(1, { phase: 'parse', stageFraction: 1 })
      const urls = skins.get(id) || [], blocks = new Map(), tileEntities = [...urls, 'filtered-out'].map((url, x) => {
        // The final skull NBT sits on a non-player block and must not preload.
        blocks.set(x, x < urls.length ? 1 : 0)
        const encoded = Buffer.from(JSON.stringify({ textures: { SKIN: { url } } })).toString('base64')
        return { id: 'minecraft:skull', x, y: 0, z: 0, nbt: { profile: { properties: url ? [{ name: 'textures', value: encoded }] : [] } } }
      })
      this.active = { id, palette: [{ name: String(id) }, { name: 'minecraft:player_head', properties: { rotation: '0' } }],
        blocks, bounds: { minX: 0, minY: 0, minZ: 0, width: tileEntities.length, height: 1, depth: 1 }, entities: [], tileEntities }
      return this.active
    }
    release(data) { released.push(data.id); if (this.active === data) this.active = null }
    cancel() { this.active = null }
    dispose() { this.disposed = true; this.cancel() }
  }
  class View {
    constructor() {
      renderer = this
      this.controls = { addEventListener() {}, update() {}, target: { toArray: () => [0, 0, 0] } }
      this.camera = { position: { toArray: () => [1, 1, 1] }, zoom: 1, updateProjectionMatrix() {} }
      this.disposed = false
      // Real geometry/material and prefetch handoff, without opening a GPU.
      this.headView = Object.create(HeadRenderer.prototype); this.headView.headsGroup = new THREE.Group()
    }
    setBackgroundColor() {} setUnderwaterFogEnabled() {} requestRender() {}
    setWireframesVisible() {} setDimensionsVisible() {} setProjectionMode() {} fitToBounds() {}
    getProjectionMode() { return 'perspective' }
    setActive(value) { this.active = value }
    beginSceneUpdate() { sceneUpdates++; return () => { sceneUpdates-- } }
    async render(data, assets, onProgress, filter, fit, options) {
      assert.equal(this.workerClient, client, 'Cards must use the worker for geometry too')
      assert.equal(options.signal, parses.at(-1).signal)
      renders.push(data.id)
      this.headView.clearHeads()
      options.onStage({ phase: 'count', stageFraction: .5 })
      onProgress(.2)
      await withAbort(buildGates.get(data.id)?.promise ?? Promise.resolve(), options.signal)
      throwIfAborted(options.signal)
      if (geometryError === data.id) throw Object.assign(Error('budget'), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
      options.onStage({ phase: 'assemble', stageFraction: 1 }); onProgress(1)
    }
    async renderSigns(_, assets, options) { throwIfAborted(options.signal) }
    async renderPlayerHeads(heads, assets, options) {
      assert.equal(heads, extracted.at(-1).heads, 'Use the exact heads extracted after parse')
      headRenders.push(heads)
      await this.headView.renderPlayerHeads(heads, assets, options)
    }
    async renderBanners(_, assets, options) { throwIfAborted(options.signal) }
    async renderStatues(_, assets, options) { throwIfAborted(options.signal) }
    async renderDecoratedPots(_, assets, options) { throwIfAborted(options.signal) }
    async renderEntities(_, assets, data, onProgress, options) { throwIfAborted(options.signal); onProgress(1) }
    dispose() { this.disposed = true; this.headView.clearHeads() }
  }
  const parent = { postMessage: event => events.push(event) }
  const window = { addEventListener: (type, handler) => windowEvents.set(type, handler) }
  const document = { hidden: false, documentElement: element(), body: element(), fonts: { add() {} },
    getElementById: id => nodes.get(id), addEventListener: (type, handler) => documentEvents.set(type, handler) }
  const context = vm.createContext({ console, URL, URLSearchParams, File, Blob, AbortController, AbortSignal,
    setTimeout, clearTimeout, location: { search: '?parentOrigin=https://archive.example&channel=test&lang=en&pack=vanilla', href: 'https://viewer.example/embed.html' },
    document, window, parent, matchMedia: () => ({ matches: false, addEventListener() {} }),
    IntersectionObserver: class { observe() {} }, FontFace: class { async load() { return this } },
    SchematicWorkerClient: Client, Renderer: View,
    AssetProvider: class {
      cacheRevision = 0
      beginTextureLoad() { loads++; return () => { loads-- } }
      trimTextures() {} addPack() {}
      getTexture(key) { return requestSkin(key) } getExternalTexture(key) { return requestSkin(key) }
      onCacheClear(listener) { subscriptions++; clearListeners.add(listener); return () => clearListeners.delete(listener) }
    },
    BlockModelResolver: class { async resolve(name) { baking.push(name); await bakeGates.get(Number(name))?.promise; return {} } },
    ViewerPacks: class { async init() { return '' } },
    normalizeOptions, applyTheme, PROTOCOL, validFile, throwIfAborted, withAbort,
    createPlayerHeadPreparation, extractSigns: () => [], extractBanners: () => [],
    extractPlayerHeads(tiles, data) { const heads = readPlayerHeads(tiles, data); extracted.push({ id: data.id, heads }); return heads },
    extractStatues: () => [], extractDecoratedPots: () => [], applyCamera() {}, openFullViewer() {},
  })
  vm.runInContext(source, context, { filename: 'embed.js' })
  const dispatch = (type, detail = {}) => windowEvents.get(type)?.(detail)
  return { nodes, events, parses, renders, released, document, baking, extracted, headRenders, skinRequests, get subscriptions() { return subscriptions },
    get client() { return client }, get renderer() { return renderer },
    load: id => dispatch('message', { source: parent, origin: 'https://archive.example', data: { protocol: PROTOCOL, channel: 'test', type: 'load', file: file(id) } }),
    idle: () => !vm.runInContext('pumping', context), current: () => vm.runInContext('current', context),
    dispatch, visibility: hidden => { document.hidden = hidden; documentEvents.get('visibilitychange')() },
    clean: () => { assert.equal(loads, 0); assert.equal(sceneUpdates, 0); assert.equal(client.active, null); assert.equal(clearListeners.size, 0) },
  }
}

// Superseding parsing must abort immediately, ignore late progress and load only the new file.
const parseGate = deferred(), one = fixture({ parseGates: new Map([[1, parseGate]]) })
one.load(1)
await until(() => one.parses.length === 1, 'first parse')
assert.match(one.nodes.get('status').textContent, /Decompressing.*20%/)
one.parses[0].onProgress(0, { phase: 'decompress', stageFraction: 0,
  detail: { phase: 'decompress', processedBytes: 128 * 1024 ** 2 } })
assert.equal(one.nodes.get('status').textContent, 'Decompressing file (128.0 MiB processed)…')
assert.equal(one.nodes.get('progress').value, 0, 'Actual bytes update the text without inventing a percent')
one.parses[0].onProgress(0, { phase: 'decompress', detail: { phase: 'decompress', processedBytes: 1.5 * 1024 ** 3 } })
assert.equal(one.nodes.get('status').textContent, 'Decompressing file (1.5 GiB processed)…')
one.parses[0].onProgress(.2, { phase: 'decompress', stageFraction: .4 })
assert.equal(one.nodes.get('status').textContent, 'Decompressing file… 40%', 'Known totals restore stage percentage')
one.load(2)
await until(one.idle, 'replacement load')
assert.equal(one.parses[0].signal.aborted, true)
assert.equal(one.current().file.name, '2.litematic')
assert.deepEqual(one.renders, [2])
const complete = one.nodes.get('status').textContent
one.parses[0].onProgress(.5, { phase: 'parse', stageFraction: .5 })
assert.equal(one.nodes.get('status').textContent, complete, 'Stale progress cannot overwrite the next file')
assert.equal(one.events.filter(event => event.type === 'error').length, 0)
assert.deepEqual(one.skinRequests, [], 'A skull NBT on another block (no rendered heads) must start no request')
assert.equal(one.subscriptions, 0, 'Headless cards need no resource subscription')
assert.deepEqual(one.released, [2]); one.clean(); one.dispatch('pagehide', { persisted: false }); parseGate.resolve()

// A slow model request must not hold the next file behind a canceled load.
const bakeGate = deferred(), staleSkins = deferred(), two = fixture({ bakeGates: new Map([[3, bakeGate]]),
  skins: new Map([[3, Array.from({ length: 12 }, (_, i) => 'stale-' + i)]]), fetchSkin: () => staleSkins.promise })
two.load(3)
await until(() => two.baking.includes('3'), 'model baking')
assert.equal(two.skinRequests.length, 8, 'Start bounded skin requests while baking is blocked')
two.load(4)
await until(two.idle, 'replacement during model baking')
assert.deepEqual(two.renders, [4]); assert.equal(two.current().file.name, '4.litematic')
staleSkins.resolve(texture('stale')); await delay(0)
assert.equal(two.skinRequests.length, 8, 'Supersession stops requesting later skins from the old card')
assert.equal(two.renderer.headView.headsGroup.children.length, 0)
assert.deepEqual(two.released, [3, 4]); two.clean(); two.dispatch('pagehide', { persisted: false }); bakeGate.resolve()

// Page caching pauses painting, terminates unfinished geometry and resumes it on return.
const buildGate = deferred(), suspendedSkin = deferred(), three = fixture({ buildGates: new Map([[5, buildGate]]),
  skins: new Map([[5, ['resume']]]), fetchSkin: () => suspendedSkin.promise })
three.load(5)
await until(() => three.renders.length === 1, 'geometry stage')
assert.match(three.nodes.get('status').textContent, /Counting visible faces.*50%/)
three.dispatch('pagehide', { persisted: true })
await until(three.idle, 'cached page cancellation')
assert.equal(three.renderer.active, false); three.clean()
assert.deepEqual(three.skinRequests, ['resume']); assert.equal(three.headRenders.length, 0)
buildGate.resolve(); suspendedSkin.resolve(texture('resume')); three.dispatch('pageshow')
await until(three.idle, 'cached page resume')
assert.equal(three.current().file.name, '5.litematic')
assert.equal(three.parses.length, 2); assert.equal(three.renderer.disposed, false)
assert.deepEqual(three.renderer.headView.headsGroup.children.map(mesh => mesh.material.map.name), ['resume'])
three.visibility(true); assert.equal(three.renderer.active, false)
three.visibility(false); assert.equal(three.renderer.active, true)
three.clean(); three.dispatch('pagehide', { persisted: false })

// Geometry overflow is reported once without silently lowering detail or retaining a worker.
const failedBuildSkin = deferred(), four = fixture({ geometryError: 6,
  skins: new Map([[6, Array.from({ length: 12 }, (_, i) => 'budget-' + i)]]), fetchSkin: () => failedBuildSkin.promise })
four.load(6); await until(four.idle, 'geometry budget error')
assert.match(four.nodes.get('status').textContent, /visible model exceeds the memory budget/)
assert.equal(four.events.filter(event => event.type === 'error').length, 1)
assert.equal(four.current(), null); four.clean()
failedBuildSkin.resolve(texture('discarded')); await delay(0)
assert.equal(four.skinRequests.length, 8, 'A non-cancellation geometry error must stop pending preparation too')
assert.equal(four.headRenders.length, 0); four.dispatch('pagehide', { persisted: false })

// Removing a card while parsing permanently stops its worker and drops queued replacements.
const removalGate = deferred(), five = fixture({ parseGates: new Map([[7, removalGate]]) })
five.load(7); await until(() => five.parses.length === 1, 'removal parse')
five.load(8); five.dispatch('pagehide', { persisted: false })
await until(five.idle, 'card removal')
assert.equal(five.client.disposed, true); assert.equal(five.renderer.disposed, true)
assert.deepEqual(five.renders, []); assert.equal(five.events.some(event => event.type === 'error'), false)
five.dispatch('pageshow'); five.load(9)
assert.equal(five.parses.length, 1, 'Destroyed cards must not start queued or new workers')
five.clean(); removalGate.resolve()
console.log('PASS embedded worker loading: supersession, late results, cancellation, BFCache, disposal, visibility and budget errors')

// Skin requests overlap both model and geometry work. Completion is consumed
// only in original head order, including a first failure and its later retry.
const models = deferred(), geometry = deferred(), firstSkin = deferred()
const six = fixture({ bakeGates: new Map([[10, models]]), buildGates: new Map([[10, geometry]]),
  skins: new Map([[10, ['slow', 'retry', 'retry', null]]]), fetchSkin: (key, attempt) => {
    if (key === 'slow') return firstSkin.promise
    if (key === 'retry' && attempt === 1) return Promise.resolve(null)
    return Promise.resolve(texture(key))
  } })
six.load(10); await until(() => six.baking.includes('10'), 'prepared skins during model baking')
assert.deepEqual(six.skinRequests, ['slow', 'retry', 'entity/player/wide/steve'])
assert.equal(six.headRenders.length, 0); assert.equal(six.extracted.length, 1)
models.resolve(); await until(() => six.renders.includes(10), 'geometry while first skin remains pending')
assert.equal(six.renderer.headView.headsGroup.children.length, 0, 'No out-of-order early attachment')
geometry.resolve(); await until(() => six.headRenders.length === 1, 'head result consumption')
assert.equal(six.current(), null, 'A pending first skin still prevents declaring the preview complete')
firstSkin.resolve(texture('slow')); await until(six.idle, 'complete prepared heads')
assert.equal(six.extracted.length, 1); assert.equal(six.current().file.name, '10.litematic')
assert.deepEqual(six.skinRequests, ['slow', 'retry', 'entity/player/wide/steve', 'retry'], 'No duplicate first requests at handoff')
assert.deepEqual(six.renderer.headView.headsGroup.children.map(mesh => [mesh.position.x, mesh.material.map.name]),
  [[0, 'slow'], [2, 'retry'], [3, 'entity/player/wide/steve']], 'First missing skin skipped; only the second matching head retries')
six.clean(); six.dispatch('pagehide', { persisted: false })
console.log('PASS embedded head preparation: requests overlap models/geometry, lazy headless cards, exactly-once extraction, ordered results and failure/retry parity')
