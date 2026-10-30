import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { PagedBlockStore, encodeBlockPage, blockPageBytes } from '../src/pagedBlocks.js'
import { parseLitematica } from '../src/litematica.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { createSchematicWorker } from '../src/schematicWorker.js'
import { SchematicWorkerClient } from '../src/workerClient.js'
import { serializeSchematic, deserializeSchematic, filterFromDescriptor, transferBuffers, deserializeWorkerError } from '../src/workerProtocol.js'

function region(minX, values) {
  const page = encodeBlockPage(Uint32Array.from(values)), counts = new Float64Array(3)
  for (const value of values) if (value) counts[value - 1]++
  return { minX, maxX: minX + values.length - 1, minY: -2, maxY: -2, minZ: -3, maxZ: -3,
    width: values.length, height: 1, depth: 1, localToGlobal: [0, 1, 2],
    states: { pages: [page], counts, volume: values.length, count: counts.reduce((a, b) => a + b), bytes: blockPageBytes(page) } }
}
const bounds = { minX: -5, minY: -2, minZ: -3, width: 10, height: 1, depth: 1 }
const original = new PagedBlockStore([region(-5, [1, 2, 0, 1, 0, 2]), region(-3, [3, 0, 2, 3, 0, 1, 2, 3])], bounds, 3)
const expected = [...original], wire = structuredClone(serializeSchematic({ blocks: original, bounds }))
const iterator = PagedBlockStore.prototype.entriesForPalette
let restored
try {
  PagedBlockStore.prototype.entriesForPalette = function () { throw new Error('Unexpected region rescan') }
  restored = deserializeSchematic(wire).blocks
} finally { PagedBlockStore.prototype.entriesForPalette = iterator }
assert.deepEqual([...restored], expected)
assert.deepEqual(restored.paletteCounts, original.paletteCounts)
assert.equal(restored.keyView.length, original.size)
assert.deepEqual([...restored.keyView], [...original.keys()])
assert.equal(restored.regions[0].after[0], restored.regions[1], 'Region reference identity survives cloning')
assert.equal(restored.regionGrid.cells.get(0)[0], restored.regions[0])
assert.notEqual(restored.cache, original.cache)
for (let key = -1; key <= bounds.width; key++) assert.equal(restored.get(key), original.get(key))
const mask = Uint8Array.of(0, 1, 0)
assert.deepEqual([...restored.entriesForPalette(mask)], [...original.entriesForPalette(mask)])
console.log('PASS worker page hydration preserves overlapping-region order/counts/indexes without rescanning')

const received = [], transferred = []
const worker = createSchematicWorker({ postMessage(message, transfer) {
  received.push(structuredClone(message, { transfer }))
  transferred.push(...transfer)
} })
let id = 0
async function request(message) {
  const current = ++id
  await worker.handle({ session: 1, ...message, id: current })
  const response = received.find(item => item.id === current && (item.type === 'result' || item.type === 'error'))
  assert.ok(response)
  if (response.type === 'error') throw deserializeWorkerError(response.error)
  return response.result
}
const bytes = readFileSync('schematics/投影预览测试.litematic')
const parsed = await parseLitematica(bytes, null, { compactBlocks: true, renderOnly: true })
const loaded = deserializeSchematic(await request({ type: 'parse', bytes, options: { compactBlocks: true, renderOnly: true } }))
assert.deepEqual([...loaded.blocks], [...parsed.blocks])
for (const field of ['bounds', 'palette', 'metadata', 'tileEntities', 'entities', 'regions', 'nbtInfo']) assert.deepEqual(loaded[field], parsed[field], field)
assert.ok(bytes.byteLength > 0, 'Caller bytes remain usable')
const cube = bakeModel({ textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
}] })
const palette = parsed.palette.map(entry => ({ ...entry, baked: cube }))
const mid = parsed.bounds.minY + Math.floor(parsed.bounds.height / 2)
const hidden = [{ minX: parsed.bounds.minX, maxX: parsed.bounds.minX + 2, minY: parsed.bounds.minY,
  maxY: parsed.bounds.minY + parsed.bounds.height - 1, minZ: parsed.bounds.minZ, maxZ: parsed.bounds.minZ + 2 }]
for (const compactFaces of [false, true]) for (const descriptor of [null,
  ...['single', 'below', 'above'].map(mode => ({ mode, layerY: mid })), { mode: 'all', hiddenRegions: hidden }]) {
  const options = { compactFaces, trackBlocks: true }
  const before = await buildFaceGroups(palette, parsed.blocks, parsed.bounds, null, filterFromDescriptor(descriptor), options)
  const after = await request({ type: 'build', palette, descriptor, options })
  assert.deepEqual(after, structuredClone(before), `Exact ordered geometry: compact=${compactFaces}, filter=${descriptor?.mode}`)
}
const keys = [...parsed.blocks.keys()].slice(0, 10), options = { keys, includeGroups: ['block/stone'], compactFaces: false }
assert.deepEqual(await request({ type: 'build', palette, options }), structuredClone(await buildFaceGroups(palette, parsed.blocks, parsed.bounds,
  null, null, { ...options, includeGroup: key => options.includeGroups.includes(key) })))
assert.ok(transferred.length > 0)
assert.ok(transferred.every(buffer => buffer.byteLength === 0), 'Returned geometry/NBT buffers were transferred, not copied')
assert.deepEqual([...loaded.blocks], [...parsed.blocks], 'Later worker builds do not detach main block pages')
assert.ok(received.some(item => item.phase === 'parse' && item.fraction === 1))
assert.ok(received.some(item => item.phase === 'fill' && item.fraction === 1))
assert.ok(received.some(item => item.phase === 'allocate' && item.detail?.bytes > 0 && item.detail.groups.length))
assert.ok(received.some(item => item.phase === 'fill' && Number.isSafeInteger(item.detail?.completed)))
for (const message of received.filter(item => item.type === 'progress')) assert.ok(message.stageFraction >= 0 && message.stageFraction <= 1)
await assert.rejects(request({ type: 'build', palette, options: { maxGeometryBytes: 1 } }), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
await assert.rejects(request({ type: 'build', session: 999, palette }), { code: 'WORKER_SESSION' })
await request({ type: 'release' })
await assert.rejects(request({ type: 'build', palette }), { code: 'WORKER_SESSION' })
console.log('PASS real schematic parse and exact ordinary/compact geometry across layers/regions/keys; zero-copy output and session release')

for (const bad of [{ mode: 'eval' }, { mode: 'single', layerY: NaN }, { mode: 'above', layerY: 1.5 },
  { mode: 'all', regionKey: 'hidden' }, { mode: 'all', hiddenRegions: {} },
  { mode: 'all', hiddenRegions: [{ ...hidden[0], maxX: -999999 }] }]) assert.throws(() => filterFromDescriptor(bad))
const backing = new ArrayBuffer(16), keep = new ArrayBuffer(8), cycle = {}
cycle.self = cycle; cycle.map = new Map([[new Uint8Array(backing), new Float32Array(backing)], ['keep', keep]])
assert.deepEqual(transferBuffers(cycle, new Set([keep])), [backing])

let finishParse, parseStarted
const started = new Promise(resolve => { parseStarted = resolve }), messages = []
const slow = createSchematicWorker({ postMessage: message => messages.push(structuredClone(message)),
  parse: async () => { parseStarted(); return new Promise(resolve => { finishParse = resolve }) } })
const pending = slow.handle({ type: 'parse', id: 50, session: 5 })
await started
await slow.handle({ type: 'parse', id: 51, session: 6 })
assert.equal(messages.at(-1).error.code, 'WORKER_BUSY')
await slow.handle({ type: 'cancel', id: 50, session: 5 })
finishParse({ blocks: new Map(), bounds })
await pending
assert.equal(messages.at(-1).error.name, 'AbortError')
assert.ok(!messages.some(message => message.id === 50 && message.type === 'result'))
await slow.handle({ type: 'build', id: 52, session: 5, palette })
assert.equal(messages.at(-1).error.code, 'WORKER_SESSION')
const failure = createSchematicWorker({ postMessage: message => messages.push(message), parse: async () => {
  throw Object.assign(new Error('Too large'), { code: 'FILE_TOO_LARGE', reason: 'blocks', bytes: 123, maxBytes: 100 })
} })
await failure.handle({ type: 'parse', id: 53, session: 7 })
assert.deepEqual(messages.at(-1).error, { name: 'Error', message: 'Too large', code: 'FILE_TOO_LARGE', reason: 'blocks', bytes: 123, maxBytes: 100 })
console.log('PASS strict filters, deduplicated/retained transfers, busy/cancelled jobs and structured resource errors')

// Exercise the actual module entry point and client across an isolated thread,
// with only the standard DedicatedWorker messaging names adapted for Node.
const workerSource = `import { parentPort } from 'node:worker_threads';
  globalThis.self = {
    postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
    addEventListener: (type, handler) => parentPort.on(type, data => handler({ data })),
  };
  await import(${JSON.stringify(new URL('../src/schematicWorker.js', import.meta.url).href)});`
const client = new SchematicWorkerClient({ workerFactory() {
  const thread = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)))
  const transport = { postMessage: data => thread.postMessage(data), terminate: () => { void thread.terminate() } }
  thread.on('message', data => transport.onmessage?.({ data }))
  thread.on('error', error => transport.onerror?.({ message: error.message }))
  thread.on('messageerror', () => transport.onmessageerror?.())
  return transport
} })
try {
  const data = await client.parse(bytes, null, { renderOnly: true, compactBlocks: true })
  assert.ok(client.canBuild(data))
  assert.deepEqual([...data.blocks], [...parsed.blocks])
  const result = await client.build(data, { palette, compactFaces: true, trackBlocks: true })
  const expected = await buildFaceGroups(palette, parsed.blocks, parsed.bounds, null, null, { compactFaces: true, trackBlocks: true })
  assert.deepEqual(result, structuredClone(expected))
  const slice = { mode: 'single', layerY: mid }
  assert.deepEqual(await client.build(data, { palette, descriptor: slice, compactFaces: true }),
    structuredClone(await buildFaceGroups(palette, parsed.blocks, parsed.bounds, null, filterFromDescriptor(slice), { compactFaces: true })))
  assert.deepEqual([...data.blocks], [...parsed.blocks])
} finally { client.dispose() }
console.log('PASS isolated module Worker handshake, page transfer/hydration, repeat builds and byte-exact geometry through real client')
