import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import JSZip from 'jszip'
import { AssetProvider } from '../src/assets.js'
import { BlockModelResolver } from '../src/blocks.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups, buildFaceGroupsStream } from '../src/geometry.js'
import { GeometryReceiver } from '../src/geometryReceiver.js'
import { transferBuffers } from '../src/workerProtocol.js'
import { PagedBlockStore, encodeBlockPage, blockPageBytes } from '../src/pagedBlocks.js'

let compared = 0, packets = 0, reused = 0, compactBatches = 0, largestPacket = 0
async function compare(palette, blocks, bounds, options = {}, batchBytes = 4096, filter = null) {
  const before = await buildFaceGroups(palette, blocks, bounds, null, filter, options)
  const receiver = new GeometryReceiver(), slabUses = new Map()
  const result = await buildFaceGroupsStream(palette, blocks, bounds, null, filter, { ...options, batchBytes,
    onLayout: layout => receiver.acceptLayout(structuredClone(layout)),
    onBatch: async batch => {
      assert.ok(batch.slabs.length > 0)
      largestPacket = Math.max(largestPacket, batch.slabs.length)
      assert.ok(batch.slabs.reduce((bytes, slab) => bytes + slab.buffer.byteLength, 0) <= batchBytes)
      assert.equal(new Set(batch.slabs.map(slab => slab.buffer)).size, batch.slabs.length)
      for (const slab of batch.slabs) {
        const count = slabUses.get(slab.slabId) || 0
        if (count) reused++
        slabUses.set(slab.slabId, count + 1)
      }
      const mainBatch = structuredClone(batch, { transfer: transferBuffers(batch) })
      assert.ok(batch.slabs.every(slab => slab.buffer.byteLength === 0), 'Worker relinquishes each transmitted slab')
      await receiver.acceptBatch(mainBatch)
      const ack = structuredClone({ slabs: [...mainBatch.slabs].reverse() }, { transfer: mainBatch.slabs.map(slab => slab.buffer) })
      assert.ok(mainBatch.slabs.every(slab => slab.buffer.byteLength === 0), 'ACK relinquishes borrowed slabs, not final receiver arrays')
      for (const record of receiver.records) for (const field of record.spec.buffers) assert.equal(record.data[field.name].length, field.length)
      packets++
      return ack
    },
  })
  const received = structuredClone(result, { transfer: transferBuffers(result) })
  const after = receiver.finish(received)
  assert.deepEqual(after, structuredClone(before), 'All final fields, group order, counters, bounds and templates match legacy')
  for (const [key, original] of before.groups) {
    const next = after.groups.get(key)
    for (const [name, value] of Object.entries(original)) if (ArrayBuffer.isView(value)) {
      assert.deepEqual(new Uint8Array(next[name].buffer, next[name].byteOffset, next[name].byteLength),
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength), key + '/' + name + ': exact underlying bytes')
    }
    if (original.isCompactFaceData) compactBatches += original.cellBounds.length / 6
  }
  compared += before.emitted
  return { before, after, result: received, slabUses, receiver }
}

const cube = bakeModel({ textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
}] })
const stone = [{ name: 'minecraft:stone', baked: cube }]
const bounds = { minX: -17, minY: -3, minZ: -9, width: 6000, height: 1, depth: 1 }
const blocks = new Map(Array.from({ length: 3000 }, (_, i) => [i * 2, 0]))
for (const compactFaces of [false, true]) {
  const output = await compare(stone, blocks, bounds, { compactFaces, trackBlocks: true }, 1073)
  const group = output.after.groups.get('block/stone')
  if (compactFaces) assert.ok(group.cellBounds.length > 6, 'Segments cross multiple original 4,096-face batches')
  else assert.equal(group.indices.constructor, Uint32Array, 'Index type uses full group size, even though segments are tiny')
}
const wideBounds = { minX: -100, minY: -100, minZ: -1, width: 70000, height: 70000, depth: 1 }
const wideBlocks = new Map(Array.from({ length: 700 }, (_, i) => [2 ** 32 + i * 2, 0]))
for (const compactFaces of [false, true]) await compare(stone, wideBlocks, wideBounds, { compactFaces, trackBlocks: true }, 1025)
console.log('PASS tiny recycled segments across global Uint32 indices, 4,096-face bounds, wide source keys and separate compact Y')

const root = 'public/assets/minecraft/', assets = new AssetProvider(), originalFetch = globalThis.fetch
assets.baseUrl = 'https://streaming-geometry.test/'
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl))
  const path = root + String(url).slice(assets.baseUrl.length)
  return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 })
}
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
try {
  for (const xk of [false, true]) {
    assets.packs = xk ? [{ name: 'XK', zip: pack }] : []; assets.clearCaches()
    const resolver = new BlockModelResolver(assets), palette = []
    for (const name of ['stone', 'glass', 'slime_block', 'honey_block', 'water', 'lava', 'bubble_column', 'oak_stairs', 'hopper', 'redstone_wire', 'decorated_pot']) {
      const properties = { facing: 'north', half: 'bottom', shape: 'outer_left', waterlogged: name === 'oak_stairs' ? 'true' : 'false', level: '0', power: '15' }
      palette.push({ name: 'minecraft:' + name, properties, baked: await resolver.resolve('minecraft:' + name, properties) })
    }
    palette.push({ name: 'minecraft:precision_fixture', baked: bakeModel({ textures: { all: 'block/stone' }, elements: [{
      from: [-5, .000001, -3], to: [19, 13.23456, 18], rotation: { axis: 'y', angle: 13.12345, origin: [8, 8, 8] },
      faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all' }])),
    }] }) })
    palette.push({ name: 'minecraft:absolute_fixture', baked: { fullCube: false, quads: [{ texKey: 'block/stone',
      verts: [[1e10, 0, 0], [1e10, 1, 0], [1e10, 0, 1], [1e10, 1, 1]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]],
    }] } })
    for (const offset of [-8192, 1_000_000]) {
      const bounds = { minX: offset, minY: -3, minZ: -offset, width: 32, height: 4, depth: 16 }
      const map = new Map(Array.from({ length: 260 }, (_, i) => [(i * 7919) % 2048, i % palette.length]))
      const values = new Uint32Array(2048), counts = new Float64Array(palette.length)
      for (const [key, gi] of map) { values[key] = gi + 1; counts[gi]++ }
      const page = encodeBlockPage(values)
      const paged = new PagedBlockStore([{ ...bounds, maxX: offset + 31, maxY: 0, maxZ: -offset + 15,
        localToGlobal: palette.map((_, i) => i), states: { pages: [page], counts, volume: values.length, count: map.size, bytes: blockPageBytes(page) },
      }], bounds, palette.length)
      for (const compactFaces of [false, true]) for (const store of [map, paged]) {
        await compare(palette, store, bounds, { compactFaces, trackBlocks: true }, 4096)
        await compare(palette, store, bounds, { compactFaces, trackBlocks: true }, 4096, (_x, y) => y === -2)
      }
      await compare(palette, map, bounds, { compactFaces: true, trackBlocks: true }, 512 * 1024)
    }
  }
} finally { globalThis.fetch = originalFetch; assets.clearCaches() }
assert.ok(largestPacket > 1, 'Multi-slab packets and reversed ACK order preserve every group')
console.log(`PASS vanilla/XK, fluids/bubbles/waterlogging, transparent groups, transformed models, precision/absolute templates, negative/large coordinates, paged/Map stores and layer cuts: ${compared} exact faces/points, ${packets} packets, ${reused} slab reuses, ${compactBatches} spatial batches`)

let scans = 0
const watched = { size: blocks.size, get: key => blocks.get(key), *[Symbol.iterator]() { scans++; yield* blocks } }
await compare(stone, watched, bounds, { compactFaces: true, trackBlocks: true, keys: [...blocks.keys()].slice(0, 25), includeGroup: key => key === 'block/stone' })
assert.equal(scans, 0, 'Restricted key builds do not scan the full store')
await compare(stone, watched, bounds, { compactFaces: true })
assert.equal(scans, 4, 'Legacy plus streaming performs exactly two full scans each')
await compare(stone, new Map(), bounds, { compactFaces: true })
await compare(stone, blocks, bounds, { compactFaces: true, includeGroup: () => false })

for (const batchBytes of [0, 1, 1.5, NaN, 32 * 1024 ** 2 + 1]) {
  await assert.rejects(buildFaceGroupsStream(stone, blocks, bounds, null, null, { batchBytes, onLayout() {}, onBatch() {} }), RangeError)
}
let laidOut = false
await assert.rejects(buildFaceGroupsStream(stone, blocks, bounds, null, null, {
  maxGeometryBytes: 1, onLayout() { laidOut = true }, onBatch() {},
}), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
assert.equal(laidOut, false, 'Geometry budget failure precedes layout/receiver allocation')

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
for (const phase of ['layout', 'batch']) {
  const controller = new AbortController(), started = defer(), gate = defer()
  let batches = 0
  const pending = buildFaceGroupsStream(stone, blocks, bounds, null, null, { batchBytes: 1024, signal: controller.signal,
    async onLayout() { if (phase === 'layout') { started.resolve(); await gate.promise } },
    async onBatch(batch) { batches++; started.resolve(); await gate.promise; return { slabs: batch.slabs } },
  })
  await started.promise; await Promise.resolve()
  assert.equal(batches, phase === 'batch' ? 1 : 0, 'No next batch while consumer applies backpressure')
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' })
  gate.resolve(); await Promise.resolve()
  assert.equal(batches, phase === 'batch' ? 1 : 0, 'Cancelled callbacks cannot restart generation')
}
for (const reply of [() => null, batch => ({ slabs: [] }), batch => ({ slabs: batch.slabs.map(s => ({ ...s, buffer: new ArrayBuffer(1) })) }),
  batch => ({ slabs: batch.slabs.map(s => ({ ...s, slabId: s.slabId + 999 })) })]) {
  await assert.rejects(buildFaceGroupsStream(stone, blocks, bounds, null, null, {
    batchBytes: 1024, onLayout() {}, onBatch: batch => reply(batch),
  }), { code: 'WORKER_PROTOCOL' })
}
console.log('PASS two-pass iteration, candidate/group filtering, empty streams, pre-allocation budgets, backpressure, immediate cancellation and recycled-slab validation')
