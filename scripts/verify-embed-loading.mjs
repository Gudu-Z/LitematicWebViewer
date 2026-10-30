import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import { normalizeOptions, applyTheme } from '../src/previewOptions.js'
import { PROTOCOL, validFile } from '../src/embedProtocol.js'
import { throwIfAborted, withAbort } from '../src/loadingTask.js'

// Execute the real card orchestration with deterministic resource/render gates.
// The worker protocol/geometry and browser layout have their own integration tests.
const source = (await readFile(new URL('../src/embed.js', import.meta.url), 'utf8')).replace(/^import .+\r?\n/gm, '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async (condition, label) => {
  for (let i = 0; i < 500; i++) { if (condition()) return; await delay(1) }
  assert.fail(`Timed out waiting for ${label}`)
}
const file = id => new File([Uint8Array.of(id)], `${id}.litematic`)

function fixture({ parseGates = new Map(), bakeGates = new Map(), buildGates = new Map(), geometryError = null } = {}) {
  const events = [], parses = [], renders = [], released = [], windowEvents = new Map(), documentEvents = new Map()
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
      this.active = { id, palette: [{ name: String(id) }], bounds: { id }, entities: [], tileEntities: [] }
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
      options.onStage({ phase: 'count', stageFraction: .5 })
      onProgress(.2)
      await withAbort(buildGates.get(data.id)?.promise ?? Promise.resolve(), options.signal)
      throwIfAborted(options.signal)
      if (geometryError === data.id) throw Object.assign(Error('budget'), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
      options.onStage({ phase: 'assemble', stageFraction: 1 }); onProgress(1)
    }
    async renderSigns(_, assets, options) { throwIfAborted(options.signal) }
    async renderPlayerHeads(_, assets, options) { throwIfAborted(options.signal) }
    async renderBanners(_, assets, options) { throwIfAborted(options.signal) }
    async renderStatues(_, assets, options) { throwIfAborted(options.signal) }
    async renderDecoratedPots(_, assets, options) { throwIfAborted(options.signal) }
    async renderEntities(_, assets, data, onProgress, options) { throwIfAborted(options.signal); onProgress(1) }
    dispose() { this.disposed = true }
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
    AssetProvider: class { beginTextureLoad() { loads++; return () => { loads-- } } trimTextures() {} addPack() {} },
    BlockModelResolver: class { async resolve(name) { await bakeGates.get(Number(name))?.promise; return {} } },
    ViewerPacks: class { async init() { return '' } },
    normalizeOptions, applyTheme, PROTOCOL, validFile, throwIfAborted, withAbort,
    extractSigns: () => [], extractPlayerHeads: () => [], extractBanners: () => [],
    extractStatues: () => [], extractDecoratedPots: () => [], applyCamera() {}, openFullViewer() {},
  })
  vm.runInContext(source, context, { filename: 'embed.js' })
  const dispatch = (type, detail = {}) => windowEvents.get(type)?.(detail)
  return { nodes, events, parses, renders, released, document, get client() { return client }, get renderer() { return renderer },
    load: id => dispatch('message', { source: parent, origin: 'https://archive.example', data: { protocol: PROTOCOL, channel: 'test', type: 'load', file: file(id) } }),
    idle: () => !vm.runInContext('pumping', context), current: () => vm.runInContext('current', context),
    dispatch, visibility: hidden => { document.hidden = hidden; documentEvents.get('visibilitychange')() },
    clean: () => { assert.equal(loads, 0); assert.equal(sceneUpdates, 0); assert.equal(client.active, null) },
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
assert.deepEqual(one.released, [2]); one.clean(); one.dispatch('pagehide', { persisted: false }); parseGate.resolve()

// A slow model request must not hold the next file behind a canceled load.
const bakeGate = deferred(), two = fixture({ bakeGates: new Map([[3, bakeGate]]) })
two.load(3)
await until(() => two.client.active?.id === 3, 'model baking')
two.load(4)
await until(two.idle, 'replacement during model baking')
assert.deepEqual(two.renders, [4]); assert.equal(two.current().file.name, '4.litematic')
assert.deepEqual(two.released, [3, 4]); two.clean(); two.dispatch('pagehide', { persisted: false }); bakeGate.resolve()

// Page caching pauses painting, terminates unfinished geometry and resumes it on return.
const buildGate = deferred(), three = fixture({ buildGates: new Map([[5, buildGate]]) })
three.load(5)
await until(() => three.renders.length === 1, 'geometry stage')
assert.match(three.nodes.get('status').textContent, /Counting visible faces.*50%/)
three.dispatch('pagehide', { persisted: true })
await until(three.idle, 'cached page cancellation')
assert.equal(three.renderer.active, false); three.clean()
buildGate.resolve(); three.dispatch('pageshow')
await until(three.idle, 'cached page resume')
assert.equal(three.current().file.name, '5.litematic')
assert.equal(three.parses.length, 2); assert.equal(three.renderer.disposed, false)
three.visibility(true); assert.equal(three.renderer.active, false)
three.visibility(false); assert.equal(three.renderer.active, true)
three.clean(); three.dispatch('pagehide', { persisted: false })

// Geometry overflow is reported once without silently lowering detail or retaining a worker.
const four = fixture({ geometryError: 6 })
four.load(6); await until(four.idle, 'geometry budget error')
assert.match(four.nodes.get('status').textContent, /visible model exceeds the memory budget/)
assert.equal(four.events.filter(event => event.type === 'error').length, 1)
assert.equal(four.current(), null); four.clean(); four.dispatch('pagehide', { persisted: false })

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
