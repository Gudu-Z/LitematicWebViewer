import { SchematicWorkerClient } from '../src/workerClient.js'
import { parseLitematica } from '../src/litematica.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { serializeSchematic, filterFromDescriptor } from '../src/workerProtocol.js'

function assert(value, message) { if (!value) throw Error(message) }
// Compare values and insertion order, including every byte of geometry buffers.
function equal(actual, expected, path = 'value', seen = new WeakMap()) {
  if (Object.is(actual, expected)) return
  assert(actual && expected && typeof actual === 'object' && typeof expected === 'object', `${path}: value differs`)
  if (seen.get(actual) === expected) return
  seen.set(actual, expected)
  if (ArrayBuffer.isView(actual) || actual instanceof ArrayBuffer) {
    assert(actual.constructor === expected.constructor && actual.byteLength === expected.byteLength, `${path}: buffer shape differs`)
    const a = new Uint8Array(actual.buffer ?? actual, actual.byteOffset ?? 0, actual.byteLength)
    const b = new Uint8Array(expected.buffer ?? expected, expected.byteOffset ?? 0, expected.byteLength)
    for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `${path}: byte ${i} differs`)
    return
  }
  if (actual instanceof Map || actual instanceof Set) {
    assert(actual.constructor === expected.constructor && actual.size === expected.size, `${path}: collection differs`)
    equal([...actual], [...expected], path + '.entries', seen); return
  }
  const keys = Object.keys(actual), expectedKeys = Object.keys(expected)
  assert(keys.length === expectedKeys.length && keys.every((key, i) => key === expectedKeys[i]), `${path}: fields/order differ`)
  for (const key of keys) equal(actual[key], expected[key], `${path}.${key}`, seen)
}
async function rejects(job, expected) {
  try { await job } catch (error) {
    for (const [key, value] of Object.entries(expected)) assert(error[key] === value, `Expected ${key}=${value}; received ${error[key]}`)
    return error
  }
  throw Error('Expected task to reject')
}
const fetchFixture = async name => (await fetch('/__worker-test/' + name)).arrayBuffer()
function cube(texture) {
  return bakeModel({ textures: { all: texture }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
    faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
  }] })
}

window.runWorkerBrowser = async ({ csp = false } = {}) => {
  const small = await fetchFixture('small'), large = csp ? null : await fetchFixture('paged')
  let fallbackCalls = 0
  const client = new SchematicWorkerClient({ parseFallback: (...args) => { fallbackCalls++; return parseLitematica(...args) } })
  const samples = [], stages = new Set()
  const progress = (fraction, detail) => {
    assert(fraction >= 0 && fraction <= 1, 'Progress is bounded')
    if (detail?.phase) { stages.add(detail.phase); assert(detail.stageFraction >= 0 && detail.stageFraction <= 1, 'Phase progress is bounded') }
  }
  const measure = async (name, action) => {
    const start = performance.now(); let previous = start, maxGap = 0, ticks = 0
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++ }, 8)
    try { return await action() } finally {
      clearInterval(timer)
      const end = performance.now()
      samples.push({ name, ms: end - start, ticks, maxGap: Math.max(maxGap, end - previous) })
    }
  }
  try {
    if (csp) {
      const expected = await parseLitematica(small, null, { renderOnly: true })
      const data = await client.parse(small, null, { renderOnly: true })
      equal(serializeSchematic(data), serializeSchematic(expected), 'CSP fallback')
      assert(fallbackCalls === 1 && !client.canBuild(data), 'Real worker-src CSP failure falls back before parsing')
      return { cspFallback: true, blocks: data.blocks.size }
    }
    let geometries = 0, data, main
    for (const [name, bytes, options] of [['small', small, { renderOnly: true, compactBlocks: false }], ['paged', large, { renderOnly: true }]]) {
      main = await parseLitematica(bytes, null, options)
      data = await measure(name + '-worker-parse', () => client.parse(bytes, progress, options))
      equal(serializeSchematic(data), serializeSchematic(main), name + ' parse fields/pages')
      equal([...data.blocks], [...main.blocks], name + ' page iteration')
      assert(bytes.byteLength > 0 && client.canBuild(data), name + ' input/session remain usable')
      assert(!!data.blocks.isPagedBlockStore === (name === 'paged'), name + ' chooses expected block representation')
      if (name === 'paged') assert(data.blocks.size === 131072, 'The permanent regression crosses the 65536-block scheduler yield boundary')
      const palette = data.palette.map(entry => ({ ...entry, baked: cube(entry.name.endsWith('glass') ? 'block/glass' : 'block/stone') }))
      const layerY = data.bounds.minY + (name === 'paged' ? 16 : Math.floor(data.bounds.height / 2))
      const hiddenRegions = [{ minX: data.bounds.minX + 4, maxX: data.bounds.minX + 10, minY: data.bounds.minY,
        maxY: data.bounds.minY + data.bounds.height - 1, minZ: data.bounds.minZ + 4, maxZ: data.bounds.minZ + 10 }]
      for (const compactFaces of [false, true]) for (const descriptor of [null,
        ...['single', 'below', 'above'].map(mode => ({ mode, layerY })), { mode: 'all', hiddenRegions }, { mode: 'below', layerY, hiddenRegions }]) {
        const options = { compactFaces, trackBlocks: true }, baseline = await buildFaceGroups(palette, main.blocks, main.bounds, null, filterFromDescriptor(descriptor), options)
        const background = await measure(`${name}-worker-build-${compactFaces}-${descriptor?.mode ?? 'all'}`,
          () => client.build(data, { palette, descriptor, ...options }, progress))
        equal(background, structuredClone(baseline), `${name} exact geometry ${compactFaces}/${descriptor?.mode}`)
        geometries++
      }
      const error = await rejects(client.build(data, { palette, compactFaces: true }, progress, { maxGeometryBytes: 1 }), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
      assert(error.bytes > error.maxBytes && error.maxBytes === 1, 'Budget diagnostics retain byte counts')
      equal(serializeSchematic(data), serializeSchematic(main), name + ' main pages after all builds')
    }
    // Exercise a queued Worker message at an actual geometry checkpoint, as well
    // as the client abort/terminate path below. Channel yields must let the
    // worker process cancellation messages and keep its retained store reusable.
    let cooperativeStarted = 0
    const cooperativePalette = data.palette.map(entry => ({ ...entry, baked: cube('block/stone') }))
    await rejects(client.build(data, { palette: cooperativePalette, compactFaces: true }, (fraction, detail) => {
      if (!cooperativeStarted && detail.phase === 'count') {
        cooperativeStarted = performance.now()
        client.worker.postMessage({ type: 'cancel', id: [...client.pending.keys()][0], session: client.session })
      }
    }), { name: 'AbortError' })
    const cooperativeCancelMs = performance.now() - cooperativeStarted
    assert(cooperativeStarted && client.canBuild(data), 'Queued cancellation reaches the worker without terminating the retained session')
    const resumed = await client.build(data, { palette: cooperativePalette, compactFaces: true })
    assert(resumed.emitted > 0, 'The same worker session builds again after cooperative cancellation')
    const parseAbort = new AbortController(); let abortedAt = 0
    await rejects(client.parse(large, () => { abortedAt ||= performance.now(); parseAbort.abort() }, { signal: parseAbort.signal }), { name: 'AbortError' })
    const parseCancelMs = performance.now() - abortedAt
    assert(abortedAt && !client.worker, 'Parse cancellation terminates real worker immediately')
    data = await client.parse(large)
    const beforeBuild = structuredClone(serializeSchematic(data)), buildAbort = new AbortController()
    const palette = data.palette.map(entry => ({ ...entry, baked: cube('block/stone') }))
    abortedAt = 0
    await rejects(client.build(data, { palette, compactFaces: true }, (fraction, detail) => {
      if (detail.phase === 'allocate' || fraction > 0) { abortedAt ||= performance.now(); buildAbort.abort() }
    }, { signal: buildAbort.signal }), { name: 'AbortError' })
    const buildCancelMs = performance.now() - abortedAt
    assert(abortedAt && !client.canBuild(data) && !client.worker, 'Build cancellation terminates worker and invalidates session')
    equal(serializeSchematic(data), beforeBuild, 'Cancelled build preserves main arrays')
    const reopened = await client.parse(small)
    assert(client.canBuild(reopened), 'A fresh file opens after cancellation')
    assert(fallbackCalls === 0, 'Healthy Worker never executes main-thread fallback')
    assert(stages.has('decompress') && stages.has('parse') && stages.has('count') && stages.has('allocate') && stages.has('fill'), 'All real stages reached the client')
    assert(samples.some(sample => sample.ticks > 0), 'Main-thread heartbeat continues during background work')
    return { geometries, blocks: main.blocks.size, stages: [...stages], samples, cooperativeCancelMs, parseCancelMs, buildCancelMs,
      heartbeatTicks: samples.reduce((sum, sample) => sum + sample.ticks, 0), maxGap: Math.max(...samples.map(sample => sample.maxGap)) }
  } finally { client.dispose() }
}
