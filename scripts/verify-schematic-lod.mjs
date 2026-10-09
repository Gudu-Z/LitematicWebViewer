import assert from 'node:assert/strict'
import * as THREE from 'three'
import { detailWindow, overviewFocus, SchematicLod } from '../src/schematicLod.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const vector = xyz => new THREE.Vector3(...xyz)
const dimensions = b => ({ ...b, width: b.maxX - b.minX + 1, height: b.maxY - b.minY + 1, depth: b.maxZ - b.minZ + 1 })
function grid(bounds, step, occupied = []) {
  const b = dimensions(bounds), width = Math.ceil(b.width / step), height = Math.ceil(b.height / step), depth = Math.ceil(b.depth / step)
  const states = new Uint32Array(width * height * depth)
  for (const [x, y, z] of occupied) states[x + z * width + y * width * depth] = 1
  return { bounds: b, overview: { step, width, height, depth, states } }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('detail windows align with coarse cells at negative coordinates, source edges and partial cells', () => {
  const data = grid({ minX: -137, maxX: 170, minY: -29, maxY: 55, minZ: -93, maxZ: 129 }, 8)
  for (const point of [[-137, -29, -93], [170.999, 55.999, 129.999], [-60.125, 1, 18], [-10000, 10000, 10000]]) {
    for (const side of [96, 64, 32]) {
      const b = detailWindow(data, vector(point), side)
      for (const a of ['X', 'Y', 'Z']) {
        assert.ok(b['min' + a] >= data.bounds['min' + a] && b['max' + a] <= data.bounds['max' + a])
        assert.equal((b['min' + a] - data.bounds['min' + a]) % 8, 0)
        assert.ok(b['max' + a] - b['min' + a] + 1 <= side)
        assert.ok(b['max' + a] === data.bounds['max' + a] || (b['max' + a] + 1 - data.bounds['min' + a]) % 8 === 0)
      }
      const size = dimensions(b)
      assert.ok(size.width * size.height * size.depth <= 1048576)
    }
  }
  const small = grid({ minX: -4, maxX: -2, minY: 12, maxY: 12, minZ: 9, maxZ: 13 }, 8)
  assert.deepEqual(dimensions(detailWindow(small, vector([-3, 12, 11]))), small.bounds)
})

test('DDA crosses empty gaps, clipped layers and negative coordinates without hitting hidden regions', () => {
  const data = grid({ minX: -8, maxX: 7, minY: -4, maxY: 7, minZ: -8, maxZ: 7 }, 4, [[1, 1, 2], [1, 2, 2]])
  const ray = [vector([-2, 2, 20]), vector([0, 0, -1])]
  let point = overviewFocus(data, ...ray)
  assert.ok(point && point.z < 4 && point.z > 3.99)
  assert.equal(overviewFocus(data, vector([6, 2, 20]), ray[1]), null)
  assert.equal(overviewFocus(data, ...ray, { mode: 'single', layerY: 5 }), null)
  point = overviewFocus(data, vector([-2, 20, 2]), vector([0, -1, 0]), { mode: 'below', layerY: 1 })
  assert.ok(point && point.y < 2 && point.y > 1.99)
  point = overviewFocus(data, vector([-2, -20, 2]), vector([0, 1, 0]), { mode: 'above', layerY: 5 })
  assert.ok(point && point.y > 5 && point.y < 5.01)
  assert.equal(overviewFocus(data, ...ray, { hiddenRegions: [{ minX: -4, maxX: -1, minY: 0, maxY: 3, minZ: 0, maxZ: 3 }] }), null)
  assert.equal(overviewFocus(data, ...ray, { mode: 'below', layerY: -10 }), null)
  assert.equal(overviewFocus(data, vector([-2, 2, 20]), vector([0, 0, 1])), null)
})

test('DDA diagonal ties advance all axes instead of hitting cells only touched at an edge', () => {
  const data = grid({ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0 }, 1, [[1, 0, 0]])
  assert.equal(overviewFocus(data, vector([-1, -1, .5]), vector([1, 1, 0]).normalize()), null)
  data.overview.states.fill(0); data.overview.states[3] = 1
  const point = overviewFocus(data, vector([-1, -1, .5]), vector([1, 1, 0]).normalize())
  assert.ok(point && point.x >= 1 && point.y >= 1)
  const cube = grid({ minX: -2, maxX: -1, minY: -2, maxY: -1, minZ: -2, maxZ: -1 }, 1, [[1, 0, 0], [1, 1, 0]])
  assert.equal(overviewFocus(cube, vector([-3, -3, -3]), vector([1, 1, 1]).normalize()), null)
})

test('DDA hidden-region decisions match the overview renderer coarse-cell centre', () => {
  const data = grid({ minX: 0, maxX: 7, minY: 0, maxY: 7, minZ: 0, maxZ: 7 }, 8, [[0, 0, 0]])
  const origin = vector([1, 1, 20]), direction = vector([0, 0, -1])
  assert.equal(overviewFocus(data, origin, direction, { hiddenRegions: [{ minX: 3, maxX: 4, minY: 3, maxY: 4, minZ: 3, maxZ: 4 }] }), null,
    'the rendered cell is hidden even when its entry point lies outside the hidden region')
  assert.ok(overviewFocus(data, origin, direction, { hiddenRegions: [{ minX: 0, maxX: 2, minY: 0, maxY: 2, minZ: 6, maxZ: 7 }] }),
    'the rendered cell remains visible when only its entry point lies in a hidden region')
  assert.equal(overviewFocus(data, vector([1, 1.5, 20]), direction, { mode: 'single', layerY: 1, hiddenRegions: [{ minX: 3, maxX: 4, minY: 1, maxY: 1, minZ: 3, maxZ: 4 }] }), null,
    'region filtering samples the centre of the clipped layer')
})

test('DDA never crosses a layer clipping boundary to focus an excluded adjacent cell', () => {
  const data = grid({ minX: 0, maxX: 3, minY: 0, maxY: 7, minZ: 0, maxZ: 3 }, 4, [[0, 1, 0]])
  assert.equal(overviewFocus(data, vector([2, -10, 2]), vector([0, 1, 0]), { mode: 'below', layerY: 3 }), null)
  data.overview.states[0] = 1; data.overview.states[1] = 0
  assert.equal(overviewFocus(data, vector([2, 10, 2]), vector([0, -1, 0]), { mode: 'above', layerY: 4 }), null)
})

// A deterministic timer drives the actual controller and asynchronous stages.
// Rendering is represented by ownership/visibility records, with no WebGL needed.
async function harness(run) {
  const originalTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, performance: globalThis.performance }
  let time = 1000, serial = 0, paused = false
  const timers = new Map(), states = [], requests = [], preparations = [], installs = [], disposals = []
  globalThis.performance = { now: () => time }
  globalThis.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  const data = grid({ minX: -128, maxX: 127, minY: -32, maxY: 31, minZ: -128, maxZ: 127 }, 8)
  data.overview.states.fill(1)
  const direction = vector([0, 0, -1])
  const camera = { position: vector([-80, 0, 200]), getWorldDirection(out) { return out.copy(direction) }, isOrthographicCamera: false, top: 160, bottom: -160, zoom: 2 }
  const renderer = {
    camera, visible: 'original', detailData: null,
    async prepareDetail(detail, _assets, options) { preparations.push({ detail, options }); return { id: detail.id } },
    installDetail(stage, detail) { installs.push(stage); this.visible = stage.id; this.detailData = detail },
    disposeDetail(stage) { disposals.push(stage) },
    clearDetail() { this.visible = 'overview'; this.detailData = null },
  }
  function result(selection, id = requests.length, paletteSize = 1) {
    return { id, bounds: dimensions(selection), palette: Array.from({ length: paletteSize }, (_, i) => ({ name: 'minecraft:block_' + i, properties: {} })), blocks: new Map(Array.from({ length: paletteSize }, (_, i) => [i, i])) }
  }
  const session = { async loadDetail(selection, options) { requests.push({ selection, options }); return result(selection) } }
  const resolver = { async resolve() { return { quads: [] } } }
  const lod = new SchematicLod({ renderer, data, session, resolver, assets: {}, paused: () => paused, filter: () => ({}), options: () => ({}), onState: s => states.push(s) })
  const api = {
    lod, renderer, data, session, resolver, requests, preparations, installs, disposals, timers, states, result,
    tick(x = camera.position.x, z = camera.position.z) { camera.position.set(x, 0, z); time += 200; lod.tick() },
    pause(value) { paused = value; time += 200; lod.tick() },
    start() {
      assert.equal(timers.size, 1, 'exactly one debounced load is scheduled')
      const [id, timer] = [...timers][0]
      assert.ok(timer.at > time, 'detail load waits for camera movement to settle')
      time = timer.at; timers.delete(id); return timer.fn()
    },
  }
  try { await run(api) }
  finally { lod.dispose(); Object.assign(globalThis, originalTimers) }
}

test('camera debounce cancels stale reads and installs a prepared window atomically', () => harness(async h => {
  const old = deferred(), nextStage = deferred()
  h.session.loadDetail = (selection, options) => { h.requests.push({ selection, options }); return h.requests.length === 1 ? old.promise : Promise.resolve(h.result(selection, 'new')) }
  h.renderer.prepareDetail = async (detail, _assets, options) => { h.preparations.push({ detail, options }); return nextStage.promise }
  h.tick(); assert.equal(h.requests.length, 0)
  const initial = h.start(); await microtasks()
  h.tick(80)
  assert.equal(h.requests[0].options.signal.aborted, true)
  old.resolve(h.result(h.requests[0].selection, 'stale')); await initial
  assert.equal(h.preparations.length, 0); assert.equal(h.renderer.visible, 'original')
  const next = h.start(); await microtasks()
  assert.equal(h.preparations.length, 1); assert.equal(h.renderer.visible, 'original', 'old scene remains visible while replacement prepares')
  nextStage.resolve({ id: 'new' }); await next
  assert.equal(h.renderer.visible, 'new'); assert.equal(h.installs.length, 1)
  assert.equal(h.lod.activeBounds.minX, 32); assert.equal(h.states.at(-1).kind, 'detail')
}))

test('a stale prepared stage is disposed, preserving the currently visible scene', () => harness(async h => {
  const stage = deferred()
  h.renderer.prepareDetail = async (detail, _assets, options) => { h.preparations.push({ detail, options }); return stage.promise }
  h.tick(); const loading = h.start(); await microtasks()
  assert.equal(h.preparations.length, 1)
  h.tick(80); stage.resolve({ id: 'stale-stage' }); await loading
  assert.equal(h.renderer.visible, 'original'); assert.equal(h.installs.length, 0)
  assert.deepEqual(h.disposals, [{ id: 'stale-stage' }]); assert.equal(h.timers.size, 1)
}))

test('returning to the installed window cancels another request without reloading either window', () => harness(async h => {
  h.tick(); await h.start(); const visible = h.renderer.visible
  const waiting = deferred()
  h.session.loadDetail = (selection, options) => { h.requests.push({ selection, options }); return waiting.promise }
  h.tick(80); const next = h.start(); await microtasks()
  h.tick(-80)
  assert.equal(h.requests[1].options.signal.aborted, true); assert.equal(h.lod.wanted, null)
  waiting.resolve(h.result(h.requests[1].selection, 'discarded')); await next
  assert.equal(h.renderer.visible, visible); assert.equal(h.installs.length, 1)
  assert.equal(h.requests.length, 2); assert.equal(h.timers.size, 0); assert.equal(h.states.at(-1).kind, 'detail')
}))

test('pausing aborts work, resumes automatically, and disposal removes only its own frame callback', () => harness(async h => {
  const waiting = deferred()
  h.session.loadDetail = (selection, options) => { h.requests.push({ selection, options }); return waiting.promise }
  h.tick(); const first = h.start(); await microtasks(); h.pause(true)
  assert.equal(h.requests[0].options.signal.aborted, true)
  waiting.resolve(h.result(h.requests[0].selection)); await first
  assert.equal(h.installs.length, 0); assert.equal(h.timers.size, 0)
  h.session.loadDetail = async selection => h.result(selection, 'resumed')
  h.pause(false); await h.start(); assert.equal(h.renderer.visible, 'resumed')
  const replacement = () => {}
  h.renderer.onLodFrame = replacement; h.lod.dispose()
  assert.equal(h.renderer.onLodFrame, replacement)
  h.tick(); assert.equal(h.timers.size, 0)
}))

test('complex windows shrink progressively, preserve old content, and avoid repeated failed requests', () => harness(async h => {
  h.session.loadDetail = async (selection, options) => {
    h.requests.push({ selection, options })
    if (selection.maxX - selection.minX + 1 > 32) throw Object.assign(new Error('complex'), { code: 'windowTooComplex' })
    return h.result(selection, 'small')
  }
  h.tick(); await h.start()
  assert.deepEqual(h.requests.map(r => r.selection.maxX - r.selection.minX + 1), [96, 64, 32])
  assert.equal(h.renderer.visible, 'small'); assert.equal(h.installs.length, 1)
  h.session.loadDetail = async (selection, options) => { h.requests.push({ selection, options }); throw Object.assign(new Error('complex'), { code: 'windowTooComplex' }) }
  h.tick(80); await h.start(); const count = h.requests.length
  assert.equal(h.renderer.visible, 'small'); assert.equal(h.states.at(-1).kind, 'limited')
  h.tick(80); assert.equal(h.timers.size, 0); assert.equal(h.requests.length, count)
  h.lod.reset(); assert.equal(h.renderer.visible, 'overview'); assert.equal(h.lod.activeBounds, null); assert.equal(h.lod.failedKey, null)
}))

test('model resolution has bounded concurrency and stops requesting resources after cancellation', () => harness(async h => {
  const resolvers = []
  h.session.loadDetail = async selection => h.result(selection, 'many', 20)
  h.resolver.resolve = () => new Promise(resolve => resolvers.push(resolve))
  h.tick(); const loading = h.start(); await microtasks()
  assert.equal(resolvers.length, 8)
  h.tick(80)
  for (const resolve of resolvers) resolve({ quads: [] })
  await loading
  assert.equal(resolvers.length, 8, 'remaining twelve stale palette entries were never requested')
  assert.equal(h.preparations.length, 0); assert.equal(h.installs.length, 0)
}))

test('zooming away restores the full overview and orthographic zoom can request distant detail', () => harness(async h => {
  h.tick(); await h.start(); assert.ok(h.lod.activeBounds)
  h.tick(-80, 600)
  assert.equal(h.lod.activeBounds, null); assert.equal(h.renderer.visible, 'overview'); assert.equal(h.timers.size, 0)
  h.renderer.camera.isOrthographicCamera = true
  h.tick(-80, 1000); await h.start()
  assert.ok(h.lod.activeBounds); assert.equal(h.states.at(-1).kind, 'detail')
}))

let failures = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (error) { failures++; console.error('FAIL', name, error.stack) }
}
if (failures) process.exitCode = 1
