import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync, deflateSync } from 'node:zlib'
import { buildSchematicOverview } from '../src/schematicOverview.js'
import { inspectLitematica, readLitematicaWindow } from '../src/litematicaWindow.js'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const str = s => { const b = Buffer.from(s), length = Buffer.alloc(2); length.writeUInt16BE(b.length); return Buffer.concat([length, b]) }
const tag = (t, name, b) => Buffer.concat([Buffer.from([t]), str(name), b])
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
const list = (t, entries) => Buffer.concat([Buffer.from([t]), int(entries.length), ...entries])
const vec = xyz => compound(...xyz.map((v, i) => tag(3, 'xyz'[i], int(v))))
const longArray = (indices, bits) => {
  const count = Math.ceil(indices.length * bits / 64), b = Buffer.alloc(count * 8)
  for (let i = 0; i < indices.length; i++) {
    const word = Math.floor(i * bits / 64), bit = i * bits % 64, value = BigInt(indices[i])
    b.writeBigUInt64BE(b.readBigUInt64BE(word * 8) | BigInt.asUintN(64, value << BigInt(bit)), word * 8)
    if (bit + bits > 64) b.writeBigUInt64BE(b.readBigUInt64BE((word + 1) * 8) | (value >> BigInt(64 - bit)), (word + 1) * 8)
  }
  return Buffer.concat([int(count), b])
}
function fixture({ size = [13, 5, 7], position = [-11, 25, -7], paletteSize = 5, overlap = false, invalid = false, spreadEntities = false } = {}) {
  const total = size.reduce((v, n) => v * Math.abs(n), 1), values = new Uint16Array(total)
  for (let i = 0; i < total; i++) values[i] = i % 17 < 4 ? 0 : (i * 73 + 19) % paletteSize
  if (invalid) values[0] = 7
  const names = Array.from({ length: paletteSize }, (_, i) => i ? ['stone', 'water', 'oak_stairs', 'glass'][(i - 1) % 4] : 'air')
  const minimum = position.map((p, i) => Math.min(p, p + size[i] + 1))
  const entity = (x, y, z) => compound(tag(8, 'id', str('minecraft:pig')), tag(9, 'Pos', list(6, [x, y, z].map(double))),
    tag(4, 'LongField', Buffer.from('fedcba9876543210', 'hex')), tag(11, 'IntArray', Buffer.concat([int(2), int(-100), int(200)])),
    tag(12, 'LongArray', Buffer.concat([int(1), Buffer.from('123456789abcdef0', 'hex')])) )
  const region = compound(
    tag(12, 'BlockStates', longArray(values, Math.max(2, Math.ceil(Math.log2(paletteSize))))),
    tag(9, 'Entities', list(10, spreadEntities ? [entity(1, 1, 1), entity(129, 1, 1), entity(2, 1, 1)] : [entity(...minimum.map((v, i) => v - position[i] + 1.123456789123)), entity(999, 999, 999)])),
    tag(9, 'TileEntities', list(10, [compound(tag(8, 'id', str('minecraft:sign')), ...['x', 'y', 'z'].map(a => tag(3, a, int(1))))])),
    tag(10, 'Size', vec(size)), tag(10, 'Position', vec(position)),
    tag(9, 'BlockStatePalette', list(10, names.map((name, i) => compound(tag(8, 'Name', str('minecraft:' + name)), tag(10, 'Properties', compound(tag(8, 'test', str(String(i))))))))),
  )
  const second = compound(tag(10, 'Size', vec([1, 1, 1])), tag(10, 'Position', vec(minimum)),
    tag(9, 'BlockStatePalette', list(10, [compound(tag(8, 'Name', str('minecraft:gold_block')))])), tag(12, 'BlockStates', longArray([0], 2)))
  return tag(10, '', compound(tag(10, 'Regions', compound(tag(10, '__proto__', region), ...(overlap ? [tag(10, 'second', second)] : [])))))
}
const cells = data => [...data.blocks].map(([k, i]) => [`${data.bounds.minX + k % data.bounds.width},${data.bounds.minY + Math.floor(k / (data.bounds.width * data.bounds.depth))},${data.bounds.minZ + Math.floor(k / data.bounds.width) % data.bounds.depth}`, data.palette[i].key]).sort(([a], [b]) => a.localeCompare(b))
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))
function assertOverview(actual, expected) {
  const { overview: grid, bounds } = actual
  const expectedCells = new Map()
  for (const [key, gi] of expected.blocks) {
    const x = key % bounds.width, y = Math.floor(key / (bounds.width * bounds.depth)), z = Math.floor(key / bounds.width) % bounds.depth
    const cell = (Math.floor(y / grid.step) * grid.depth + Math.floor(z / grid.step)) * grid.width + Math.floor(x / grid.step)
    expectedCells.set(cell, true)
  }
  assert.equal(grid.occupied, expectedCells.size)
  for (let i = 0; i < grid.states.length; i++) assert.equal(Boolean(grid.states[i]), expectedCells.has(i), `overview occupancy at ${i}`)
  assert.ok(grid.exposedFaces <= 500000)
}

for (const negative of [false, true]) for (const compress of [x => x, gzipSync, deflateSync]) {
  const file = new Blob([compress(fixture({ size: [13, 5, 7].map(n => negative ? -n : n), overlap: true }))])
  const info = await inspectLitematica(file), reference = await readLitematicaWindow(file, info)
  const { data, archive } = await buildSchematicOverview(file, info)
  assert.equal(archive.mode, 'memory'); assert.ok(archive.cacheBytes > 0)
  assert.deepEqual(data.bounds, info.bounds); assert.equal(data.blocks.size, 0)
  assertOverview(data, reference)
  const bounds = { ...info.bounds, maxX: info.bounds.minX + 4, maxY: info.bounds.minY + 2, maxZ: info.bounds.minZ + 3 }
  const actual = await archive.readWindow(bounds), expected = await readLitematicaWindow(file, info, bounds)
  assert.deepEqual(cells(actual), cells(expected))
  assert.deepEqual(plain(actual.entities), plain(expected.entities)); assert.deepEqual(plain(actual.tileEntities), plain(expected.tileEntities))
  assert.ok(actual.entities[0].nbt.IntArray instanceof Int32Array)
  assert.ok(actual.entities[0].nbt.LongArray instanceof BigInt64Array)
  assert.equal(typeof actual.entities[0].nbt.LongField, 'bigint')
  // Transferring the large overview buffer must leave worker-side detail usable.
  structuredClone(data.overview.states, { transfer: [data.overview.states.buffer] })
  assert.deepEqual(cells(await archive.readWindow(bounds)), cells(expected))
  archive.dispose(); await assert.rejects(archive.readWindow(bounds), { name: 'AbortError' })
}
console.log('PASS whole-scene occupancy, negative coordinates, field order, overlapping regions, exact windows, NBT types and transferred overview')

const orderedFile = new Blob([fixture({ size: [192, 5, 7], position: [0, 0, 0], spreadEntities: true })])
const orderedInfo = await inspectLitematica(orderedFile), ordered = await buildSchematicOverview(orderedFile, orderedInfo)
assert.deepEqual(plain((await ordered.archive.readWindow(orderedInfo.bounds)).entities), plain((await readLitematicaWindow(orderedFile, orderedInfo, orderedInfo.bounds)).entities))
ordered.archive.dispose()
console.log('PASS original entity ordering across spatial cache batches')

// The 3-bit packed array crosses a one-megabyte compressed-segment boundary.
const wideFile = new Blob([gzipSync(fixture({ size: [700003, 2, 3] }))])
const wideInfo = await inspectLitematica(wideFile), wide = await buildSchematicOverview(wideFile, wideInfo)
const crossCell = Math.floor(1024 * 1024 * 8 / 3), crossX = crossCell % wideInfo.regions[0].width
const bounds = { ...wideInfo.bounds, minX: wideInfo.bounds.minX + crossX - 17, maxX: wideInfo.bounds.minX + crossX + 37 }
const actual = await wide.archive.readWindow(bounds), expected = await readLitematicaWindow(wideFile, wideInfo, bounds)
assert.deepEqual(cells(actual), cells(expected))
assert.ok(wide.data.overview.states.length <= 2200000)
const counts = new Map()
for (let i = 0; i < 700003 * 2 * 3; i++) {
  const value = i % 17 < 4 ? 0 : (i * 73 + 19) % 5
  if (value) { const name = ['stone', 'water', 'oak_stairs', 'glass'][value - 1]; counts.set('minecraft:' + name, (counts.get('minecraft:' + name) || 0) + 1) }
}
assert.deepEqual(wide.data.materialCounts, counts)
wide.archive.dispose()
console.log('PASS compressed-segment crossings, nonaligned packed offsets, voxel memory budget and complete material counts')

const file = new Blob([gzipSync(fixture())]), info = await inspectLitematica(file)
for (const maxCacheBytes of [0, 1]) {
  const { data, archive } = await buildSchematicOverview(file, info, { maxCacheBytes, maxFaces: 6 })
  assert.equal(archive.mode, 'stream'); assert.equal(archive.cacheBytes, 0); assert.equal(data.overview.exposedFaces, 6)
  const expected = await readLitematicaWindow(file, info, info.bounds), actual = await archive.readWindow(info.bounds)
  assert.deepEqual(cells(actual), cells(expected)); archive.dispose()
}
await assert.rejects(buildSchematicOverview(file, info, { signal: AbortSignal.abort() }), { name: 'AbortError' })
const abort = new AbortController()
await assert.rejects(buildSchematicOverview(wideFile, wideInfo, { signal: abort.signal, onProgress() { abort.abort() } }), { name: 'AbortError' })
const bad = new Blob([fixture({ invalid: true })]), badInfo = await inspectLitematica(bad)
await assert.rejects(buildSchematicOverview(bad, badInfo), { code: 'invalidBlockStates' })
const corrupt = Buffer.from(gzipSync(fixture())); corrupt[corrupt.length - 8] ^= 1
await assert.rejects(buildSchematicOverview(new Blob([corrupt]), info))
const cached = await buildSchematicOverview(file, info)
await assert.rejects(cached.archive.readWindow(info.bounds, { signal: AbortSignal.abort() }), { name: 'AbortError' })
await assert.rejects(cached.archive.readWindow({ ...info.bounds, minX: info.bounds.minX - 1 }), { code: 'invalidWindow' })
cached.archive.dispose()
console.log('PASS face budget, cache budget fallback, cancellation, invalid indices, checksums and window validation')

// A source can be delivered as one compressed chunk. Check that the inflater
// receives bounded input even when the archive visitor pauses to compress data.
const noise = Buffer.alloc(256 * 1024)
let random = 123456789
for (let i = 0; i < noise.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; noise[i] = random & 255 }
const base = fixture(), noisy = Buffer.concat([base.subarray(0, -1), tag(7, 'unused', Buffer.concat([int(noise.length), noise])), Buffer.from([0])])
const NativeDecompressionStream = globalThis.DecompressionStream
let largestInput = 0
try {
  globalThis.DecompressionStream = class {
    constructor(format) {
      const tap = new TransformStream({ transform(chunk, controller) { largestInput = Math.max(largestInput, chunk.length); controller.enqueue(chunk) } })
      return { writable: tap.writable, readable: tap.readable.pipeThrough(new NativeDecompressionStream(format)) }
    }
  }
  await inspectLitematica(new Blob([gzipSync(noisy)]))
} finally { globalThis.DecompressionStream = NativeDecompressionStream }
assert.ok(largestInput > 0 && largestInput <= 32768)
console.log('PASS bounded inflate input for single-chunk compressed Blob streams')

// Stream 550 MB of virtual packed data without allocating it. The one occupied
// cell is beyond 2^32 packed bits, which must never use 32-bit offset arithmetic.
const farIndex = 1_100_000_000, farWords = Math.ceil((farIndex + 1) * 4 / 64)
const prefix = tag(10, '', tag(10, 'Regions', tag(10, 'far', tag(12, 'BlockStates', int(farWords)))))
const suffix = Buffer.concat([compound(tag(10, 'Size', vec([farIndex + 1, 1, 1])), tag(10, 'Position', vec([0, 0, 0])),
  tag(9, 'BlockStatePalette', list(10, Array.from({ length: 9 }, (_, i) => compound(tag(8, 'Name', str(i ? 'minecraft:stone' : 'minecraft:air'))))))), Buffer.from([0, 0])])
const virtual = {
  slice: (a, b) => new Blob([prefix.subarray(a, b)]),
  stream() {
    let phase = 0, remaining = farWords * 8
    const zero = Buffer.alloc(65536)
    return new ReadableStream({ pull(controller) {
      if (!phase) { phase++; controller.enqueue(prefix); return }
      if (remaining) {
        const n = Math.min(remaining, zero.length), bytes = n === remaining ? Buffer.alloc(n) : zero
        remaining -= n
        if (!remaining) bytes.writeBigUInt64BE(1n, n - 8)
        controller.enqueue(bytes); return
      }
      if (phase === 1) { phase++; controller.enqueue(suffix); return }
      controller.close()
    } })
  },
}
const virtualInfo = await inspectLitematica(virtual), farOverview = await buildSchematicOverview(virtual, virtualInfo, { maxCacheBytes: 0 })
assert.equal(farOverview.data.overview.occupied, 1)
assert.equal(farOverview.data.overview.states.at(-1), 1)
assert.equal(farOverview.data.materialCounts.get('minecraft:stone'), 1)
farOverview.archive.dispose()
console.log('PASS 550 MB bounded streaming overview and offsets beyond 2^32 packed bits')

for (const fileName of ['samples/demo.litematic', ...readdirSync('schematics').filter(n => n.startsWith('投影预览测试')).map(n => 'schematics/' + n)]) {
  const file = new Blob([readFileSync(fileName)]), info = await inspectLitematica(file)
  const expected = await readLitematicaWindow(file, info), { data, archive } = await buildSchematicOverview(file, info)
  assertOverview(data, expected)
  const bounds = info.suggestedWindow, exact = await archive.readWindow(bounds), reference = await readLitematicaWindow(file, info, bounds)
  assert.deepEqual(cells(exact), cells(reference)); assert.deepEqual(plain(exact.entities), plain(reference.entities)); assert.deepEqual(plain(exact.tileEntities), plain(reference.tileEntities))
  archive.dispose(); console.log('PASS existing schematic overview + detail', fileName)
}

if (process.argv.includes('--large')) for (const name of readdirSync('schematics').filter(n => n.startsWith('完整海盗城') || n.startsWith('Parrots'))) {
  const start = performance.now(), file = new Blob([readFileSync('schematics/' + name)])
  const info = await inspectLitematica(file), { data, archive } = await buildSchematicOverview(file, info)
  const overviewSeconds = (performance.now() - start) / 1000
  assert.equal(archive.mode, 'memory'); assert.ok(data.overview.occupied > 0)
  assert.deepEqual(data.bounds, info.bounds)
  assert.ok(data.overview.states.length <= 2200000); assert.ok(data.overview.exposedFaces <= 500000)
  const detailStart = performance.now(), detail = await archive.readWindow(info.suggestedWindow)
  const detailSeconds = (performance.now() - detailStart) / 1000
  const expected = await readLitematicaWindow(file, info, info.suggestedWindow)
  assert.ok(detail.blocks.size > 0); assert.deepEqual(cells(detail), cells(expected))
  assert.deepEqual(plain(detail.entities), plain(expected.entities)); assert.deepEqual(plain(detail.tileEntities), plain(expected.tileEntities))
  console.log('PASS large overview + exact cached detail', JSON.stringify({ name, sourceBounds: info.bounds, step: data.overview.step, occupied: data.overview.occupied, faces: data.overview.exposedFaces,
    cacheMiB: +(archive.cacheBytes / 1048576).toFixed(1), overviewSeconds: +overviewSeconds.toFixed(1), detailSeconds: +detailSeconds.toFixed(2), detailBlocks: detail.blocks.size,
    countedBlocks: [...data.materialCounts.values()].reduce((a, b) => a + b, 0), rssMiB: Math.round(process.memoryUsage().rss / 1048576) }))
  archive.dispose()
}
