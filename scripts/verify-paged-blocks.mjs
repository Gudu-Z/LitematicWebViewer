import assert from 'node:assert/strict'
import { deflateSync, gzipSync, gunzipSync, inflateRawSync } from 'node:zlib'
import { BLOCK_PAGE_SIZE, BlockStatePageWriter, PagedBlockStore, createBlockPageBudget, decodeBlockPage, encodeBlockPage } from '../src/pagedBlocks.js'
import { readSchematicNBT } from '../src/schematicNbt.js'
import { parseLitematica, parseLitematicaRaw } from '../src/litematica.js'
import { NbtStreamFilter } from '../src/nbtStream.js'
import { parseNBT } from '../src/nbt.js'

// Build the source independently using 64-bit arithmetic, rather than the
// decoder or page encoder being tested. Long payloads use Java NBT byte order.
function packed(values, bits) {
  const longs = Array(Math.ceil(values.length * bits / 64)).fill(0n)
  for (let i = 0; i < values.length; i++) {
    const position = i * bits, index = Math.floor(position / 64), shift = position % 64
    longs[index] |= BigInt(values[i]) << BigInt(shift)
    if (shift + bits > 64) longs[index + 1] |= BigInt(values[i]) >> BigInt(64 - shift)
  }
  const bytes = Buffer.alloc(longs.length * 8)
  longs.forEach((value, i) => bytes.writeBigUInt64BE(BigInt.asUintN(64, value), i * 8))
  return bytes
}

const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes }
const string = value => { const bytes = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]) }
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
const text = (name, value) => tag(8, name, string(value))
const compound = (...values) => Buffer.concat([...values, Buffer.from([0])])
const list = (type, values) => Buffer.concat([Buffer.from([type]), int(values.length), ...values])
const vector = (name, values) => tag(10, name, compound(...['x', 'y', 'z'].map((axis, i) => tag(3, axis, int(values[i])))))
const paletteTag = names => tag(9, 'BlockStatePalette', list(10, names.map(name => compound(text('Name', 'minecraft:' + name)))))
const statesTag = bytes => tag(12, 'BlockStates', Buffer.concat([int(bytes.length / 8), bytes]))
const region = (name, position, size, names, states) => tag(10, name, compound(
  // BlockStates preceding its palette/size exercises the two-pass header lookup.
  statesTag(states), paletteTag(names), vector('Position', position), vector('Size', size),
))
const schematic = (regions, rootName = 'Regions') => tag(10, '', compound(
  tag(10, rootName, compound(...regions)),
  tag(10, 'Metadata', compound(text('Name', 'Paged test'), tag(3, 'TotalBlocks', int(40_000_000)))),
))

function expandPages(states) {
  const out = new Uint32Array(states.volume)
  states.pages.forEach((page, i) => {
    const start = i * BLOCK_PAGE_SIZE, end = Math.min(out.length, start + BLOCK_PAGE_SIZE)
    if (typeof page === 'number') out.fill(page, start, end)
    else out.set(decodeBlockPage(page), start)
  })
  return out
}

for (const bits of [2, 3, 5, 8, 9, 12, 16, 17]) {
  const length = 2 ** (bits - 1) + 1, omitted = new Set([1, 2, length - 1])
  const palette = Array.from({ length }, (_, i) => ({ Name: omitted.has(i) ? (i === 1 ? 'minecraft:air' : 'minecraft:barrier') : 'minecraft:stone' }))
  const values = Uint32Array.from({ length: BLOCK_PAGE_SIZE * 2 + 27 }, (_, i) => ((i * 7919) ^ (i >> 5)) % length)
  const expected = Uint32Array.from(values, value => omitted.has(value) ? 0 : value + 1)
  const counts = new Float64Array(length)
  for (const value of values) if (!omitted.has(value)) counts[value]++
  const source = packed(values, bits)
  for (const chunkSizes of [[1], [7], [1, 3, 9, 4095, 65537], [source.length]]) {
    const budget = createBlockPageBudget(), writer = new BlockStatePageWriter(palette, values.length, source.length / 8, budget)
    let offset = 0, part = 0
    const reused = Buffer.alloc(Math.max(...chunkSizes))
    while (offset < source.length) {
      const count = Math.min(chunkSizes[part++ % chunkSizes.length], source.length - offset)
      source.copy(reused, 0, offset, offset + count)
      writer.push(reused.subarray(0, count)); reused.fill(0); offset += count
    }
    const states = writer.finish()
    assert.deepEqual(expandPages(states), expected, `bits=${bits}, chunks=${chunkSizes}`)
    assert.deepEqual(states.counts, counts)
    assert.equal(states.count, counts.reduce((sum, count) => sum + count, 0))
    assert.equal(states.bytes, budget.bytes)
    assert.equal(states.pages.length, 3)
  }
}
const runValues = Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, i) => i < 2000 ? 0 : i < 4000 ? 70000 : 3)
const runPage = encodeBlockPage(runValues)
assert.ok(runPage.runs)
assert.deepEqual(decodeBlockPage(runPage), runValues)
const denseValues = Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, i) => i % 7)
const densePage = encodeBlockPage(denseValues)
assert.ok(densePage.words)
assert.deepEqual(decodeBlockPage(densePage), denseValues)
assert.equal(encodeBlockPage(Uint32Array.of(70000, 70000)), 70000)
assert.equal(encodeBlockPage(new Uint32Array(BLOCK_PAGE_SIZE)), 0)
console.log('PASS independently packed 2–17 bit states, arbitrary/reused byte chunks, partial pages, runs and dense palettes')

const palette = [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }]
for (const [volume, longs] of [[1, 0], [-1, 0], [1.5, 1], [1, -1], [1, 1.5], [1, Infinity]]) {
  assert.throws(() => new BlockStatePageWriter(palette, volume, longs), RangeError)
}
assert.throws(() => new BlockStatePageWriter([], 1, 1), RangeError)
for (const bytes of [Buffer.alloc(7), Buffer.alloc(16)]) {
  const writer = new BlockStatePageWriter(palette, 1, 1)
  writer.push(bytes); assert.throws(() => writer.finish(), /Truncated/)
}
const limited = new BlockStatePageWriter(palette, 1, 1, createBlockPageBudget(7))
limited.push(Buffer.alloc(8))
assert.throws(() => limited.finish(), { code: 'FILE_TOO_LARGE', reason: 'blocks' })
for (const limit of [-1, 1.5, NaN, Infinity]) assert.throws(() => createBlockPageBudget(limit), RangeError)
const empty = new BlockStatePageWriter([], 0, 0).finish()
assert.equal(empty.count, 0); assert.equal(empty.pages.length, 0)
console.log('PASS incomplete/extra packed data, invalid dimensions and bounded page allocation')

// Compare full iteration order and random access with a separately constructed
// world. Local palettes change order; later air must not erase an earlier block.
const definitions = [], world = new Map()
const allNames = ['air', 'stone', 'glass', 'barrier', 'oak_planks']
for (let i = 0; i < 12; i++) {
  const position = [i % 4 * 3 - 4, Math.floor(i / 4) - 2, i % 3 * 2 - 3]
  const size = [i % 2 ? -7 : 8, i % 3 ? 3 : -4, i % 2 ? 9 : -8]
  const dimensions = size.map(Math.abs), start = size.map((s, axis) => s < 0 ? position[axis] + s + 1 : position[axis])
  const names = allNames.map((_, n) => allNames[(n + i) % allNames.length])
  const values = Uint32Array.from({ length: dimensions.reduce((a, b) => a * b) }, (_, n) => (n * 11 + (n >> 3) + i) % names.length)
  values.forEach((value, n) => {
    const name = names[value]
    if (name === 'air' || name === 'barrier') return
    const x = n % dimensions[0] + start[0]
    const z = Math.floor(n / dimensions[0]) % dimensions[2] + start[2]
    const y = Math.floor(n / (dimensions[0] * dimensions[2])) + start[1]
    world.set(`${x},${y},${z}`, 'minecraft:' + name)
  })
  definitions.push(region('overlap' + i, position, size, names, packed(values, 3)))
}
for (const rootName of ['Regions', 'SubRegions']) {
  const bytes = schematic(definitions, rootName)
  const data = await parseLitematicaRaw(bytes, undefined, { compactBlocks: true })
  const legacy = await parseLitematicaRaw(bytes, undefined, { compactBlocks: false })
  const b = data.bounds, expected = [...world].map(([position, name]) => {
    const [x, y, z] = position.split(',').map(Number)
    return [x - b.minX + (z - b.minZ) * b.width + (y - b.minY) * b.width * b.depth, name]
  })
  const named = entries => [...entries].map(([key, value]) => [key, data.palette[value].name])
  assert.deepEqual(named(data.blocks), expected)
  assert.deepEqual([...data.blocks], [...legacy.blocks])
  assert.equal(data.blocks.size, world.size)
  assert.equal(data.blocks.keyView.length, world.size)
  assert.deepEqual([...data.blocks.keyView], [...legacy.blocks.keys()])
  for (let key = 0; key < b.width * b.height * b.depth; key++) {
    assert.equal(data.blocks.get(key), legacy.blocks.get(key))
    assert.equal(data.blocks.has(key), legacy.blocks.has(key))
  }
  for (const key of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, b.width * b.height * b.depth]) assert.equal(data.blocks.get(key), undefined)
  const counts = new Float64Array(data.palette.length)
  for (const [, gi] of legacy.blocks) counts[gi]++
  assert.deepEqual(data.blocks.paletteCounts, counts)
  for (let gi = 0; gi < data.palette.length; gi++) {
    const wanted = new Uint8Array(data.palette.length); wanted[gi] = 1
    assert.deepEqual([...data.blocks.entriesForPalette(wanted)], [...legacy.blocks].filter(([, value]) => gi === value))
  }
  const visited = [], receiver = {}
  data.blocks.forEach(function (value, key, store) { assert.equal(this, receiver); assert.equal(store, data.blocks); visited.push([key, value]) }, receiver)
  assert.deepEqual(visited, [...legacy.blocks])
}
console.log('PASS negative sizes/origins, 12 overlapping regions, palette remapping, exact order/counts and filtered queries')

const gridRegions = []
for (let i = 0; i < 9; i++) {
  const position = [i % 3 * 128 - 130, Math.floor(i / 3) * 128 - 129, i % 2 * 128 - 2]
  const size = [6, 3, 4], values = Uint32Array.from({ length: 72 }, (_, n) => (n + i) % 3)
  gridRegions.push(region('grid' + i, position, size, ['air', 'stone', 'water'], packed(values, 2)))
}
// These neighbours straddle x=128 relative to the global minimum. Their
// palette order differs, so checking adjacency cannot assume equal local IDs.
gridRegions.push(region('seamL', [-3, 0, 0], [1, 1, 1], ['air', 'stone'], packed([1], 2)))
gridRegions.push(region('seamR', [-2, 0, 0], [1, 1, 1], ['water', 'air'], packed([0], 2)))
const gridBytes = schematic(gridRegions)
const indexed = await parseLitematicaRaw(gridBytes, undefined, { compactBlocks: true })
const indexedReference = await parseLitematicaRaw(gridBytes, undefined, { compactBlocks: false })
assert.ok(indexed.blocks.regionGrid.cells.size > 1)
assert.deepEqual([...indexed.blocks], [...indexedReference.blocks])
const gb = indexed.bounds, keyAt = (x, y, z) => x - gb.minX + (z - gb.minZ) * gb.width + (y - gb.minY) * gb.width * gb.depth
assert.equal(indexed.palette[indexed.blocks.get(keyAt(-3, 0, 0))].name, 'minecraft:stone')
assert.equal(indexed.palette[indexed.blocks.get(keyAt(-2, 0, 0))].name, 'minecraft:water')
for (const [key] of indexedReference.blocks) {
  for (const offset of [0, -1, 1, -gb.width, gb.width, -gb.width * gb.depth, gb.width * gb.depth]) {
    assert.equal(indexed.blocks.get(key + offset), indexedReference.blocks.get(key + offset))
  }
}
let seed = 1234
for (let i = 0; i < 10000; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const key = seed % (gb.width * gb.height * gb.depth)
  assert.equal(indexed.blocks.get(key), indexedReference.blocks.get(key))
}

// Extremely wide, mostly uniform regions should coarsen the candidate grid;
// its memory budget depends on references, rather than the enclosing volume.
const wideWidth = 2 ** 24, wideRegions = Array.from({ length: 3 }, (_, i) => {
  const pages = Array(wideWidth / BLOCK_PAGE_SIZE).fill(0); pages[0] = 1
  return {
    minX: i * wideWidth, minY: 0, minZ: 0, maxX: (i + 1) * wideWidth - 1, maxY: 0, maxZ: 0,
    width: wideWidth, height: 1, depth: 1,
    states: { pages, volume: wideWidth, count: BLOCK_PAGE_SIZE, counts: Float64Array.of(BLOCK_PAGE_SIZE), bytes: pages.length * 8 }, localToGlobal: [0],
  }
})
const wide = new PagedBlockStore(wideRegions, { minX: 0, minY: 0, minZ: 0, width: wideWidth * 3, height: 1, depth: 1 }, 1)
assert.ok(wide.regionGrid.cellSize > 128 && wide.regionGrid.cells.size <= 262144)
for (let i = 0; i < 3; i++) {
  assert.equal(wide.get(i * wideWidth), 0)
  assert.equal(wide.get(i * wideWidth + BLOCK_PAGE_SIZE - 1), 0)
  assert.equal(wide.get(i * wideWidth + BLOCK_PAGE_SIZE), undefined)
  assert.equal(wide.get((i + 1) * wideWidth - 1), undefined)
}
assert.equal([...wide].length, BLOCK_PAGE_SIZE * 3)
console.log('PASS region candidate-grid boundaries, sparse holes, neighbour seams and adaptive allocation budget')

// A reader traversing more than 128 nonuniform pages must keep its decoded
// cache bounded while revisiting evicted pages still returns exact values.
const pages = Array.from({ length: 256 }, (_, i) => encodeBlockPage(Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, n) => n % 3 ? 1 : i % 2 + 1)))
const volume = pages.length * BLOCK_PAGE_SIZE
const bounded = new PagedBlockStore([{
  minX: 0, minY: 0, minZ: 0, maxX: volume - 1, maxY: 0, maxZ: 0, width: volume, height: 1, depth: 1,
  states: { pages, volume, count: volume, counts: Float64Array.of(0, volume), bytes: 0 }, localToGlobal: [0, 1],
}], { minX: 0, minY: 0, minZ: 0, width: volume, height: 1, depth: 1 }, 2)
for (let i = 0; i < pages.length; i++) assert.equal(bounded.get(i * BLOCK_PAGE_SIZE), i % 2)
assert.ok(bounded.cache.pages.size <= 128)
assert.equal(bounded.get(BLOCK_PAGE_SIZE), 1)
console.log('PASS bounded decoded-page cache and exact lookup after eviction')

// Direct NBT streaming uses cuts through tag names, lengths and long payloads;
// an extracted LongArray is replaced by an empty retained array, without
// changing unrelated fields or feeding borrowed source buffers to later work.
const nbtValues = Uint32Array.from({ length: 101 }, (_, i) => i % 3)
const nbtBytes = schematic([region('split_字节', [-2, 0, 1], [101, 1, 1], ['air', 'stone', 'glass'], packed(nbtValues, 2))])
for (const chunkSize of [1, 2, 7, 13, 65536]) {
  let states
  const filter = new NbtStreamFilter(undefined, { arraySink(path, type, length) {
    if (type !== 12) return null
    assert.deepEqual(path, ['Regions', 'split_字节', 'BlockStates'])
    const writer = new BlockStatePageWriter([{ Name: 'air' }, { Name: 'stone' }, { Name: 'glass' }], nbtValues.length, length)
    return { push: bytes => writer.push(bytes), finish() { states = writer.finish() } }
  } })
  for (let offset = 0; offset < nbtBytes.length; offset += chunkSize) filter.push(nbtBytes.subarray(offset, offset + chunkSize))
  const filtered = filter.finish(), root = parseNBT(filtered.bytes)
  assert.equal(root.Metadata.Name, 'Paged test')
  assert.equal(root.Regions['split_字节'].BlockStates.length, 0)
  assert.deepEqual(expandPages(states), Uint32Array.from(nbtValues, value => value ? value + 1 : 0))
}
console.log('PASS NBT field/UTF-8/LongArray byte boundaries and streamed array replacement')

// 32 million cell positions, with two visible blocks, force real extraction
// without a huge expected Map. The packed source is 8 MiB, retained NBT < 4 KiB.
const largeStates = Buffer.alloc(8 * 1024 * 1024)
largeStates.writeBigUInt64BE(1n, 0)
largeStates.writeBigUInt64BE(2n << 62n, largeStates.length - 8)
const large = schematic([region('large', [0, 0, 0], [32768, 16, 64], ['air', 'stone', 'glass'], largeStates)])
const compressed = gzipSync(large)
for (const input of [large, compressed, deflateSync(large)]) {
  const progress = []
  const { root, stats } = await readSchematicNBT(input, { compactBlocks: true, streamThreshold: 0, maxBytes: 4096, onProgress: value => progress.push(value) })
  const states = root.Regions.large.BlockStates
  assert.equal(states.isPagedBlockStates, true)
  assert.equal(states.volume, 33_554_432)
  assert.equal(states.count, 2)
  assert.equal(states.pages.length, 8192)
  assert.equal(root.Metadata.TotalBlocks, 40_000_000)
  assert.equal(stats.blockStateBytes, largeStates.length)
  assert.equal(stats.compactBlockBytes, states.bytes)
  assert.ok(stats.retainedBytes < 4096 && states.bytes < 100_000)
  assert.equal(progress.at(-1), 1)
  assert.ok(progress.some(value => value > .5 && value < 1), 'array decoding reports intermediate progress')
  assert.ok(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1])))
}
const largeParsed = await parseLitematica(compressed, undefined, { streamThreshold: 0 })
assert.equal(largeParsed.blocks.isPagedBlockStore, true)
assert.deepEqual([...largeParsed.blocks], [[0, 1], [33_554_431, 2]])
assert.deepEqual(largeParsed.bounds, { minX: 0, minY: 0, minZ: 0, maxX: 32767, maxY: 15, maxZ: 63, width: 32768, height: 16, depth: 64 })
assert.equal(largeParsed.blocks.get(33_554_431), 2)
assert.equal(largeParsed.blocks.get(33_554_430), undefined)
console.log('PASS >20M volume, two-pass extraction before headers, gzip/zlib/raw, exact sparse coordinates and intermediate progress')

// Force native gzip to emit a prefix and reject concatenation, on both passes.
// All aborted writers must be discarded; progress cannot regress on retries.
const Native = globalThis.DecompressionStream
try {
  globalThis.DecompressionStream = class {
    constructor(format) {
      if (format !== 'gzip') return new Native(format)
      const chunks = []
      return new TransformStream({ transform(chunk) { chunks.push(chunk) }, flush(controller) {
        const input = Buffer.concat(chunks), first = inflateRawSync(input.subarray(10), { info: true })
        if (first.engine.bytesWritten + 18 !== input.length) { controller.enqueue(first.buffer); throw new TypeError('Extra member') }
        controller.enqueue(gunzipSync(input))
      } })
    }
  }
  const cut = Math.floor(large.length * .6)
  const concatenated = Buffer.concat([gzipSync(large.subarray(0, cut)), gzipSync(large.subarray(cut))])
  const progress = []
  const result = await parseLitematica(concatenated, value => progress.push(value), { streamThreshold: 0 })
  assert.deepEqual([...result.blocks], [[0, 1], [33_554_431, 2]])
  assert.ok(progress.every((value, i) => !i || value >= progress[i - 1]))
  assert.equal(progress.at(-1), 1)
} finally { globalThis.DecompressionStream = Native }
console.log('PASS concatenated gzip retries discard partial pages and keep progress monotonic')

const corrupt = Buffer.from(compressed); corrupt[corrupt.length - 8] ^= 1
await assert.rejects(readSchematicNBT(corrupt, { compactBlocks: true, streamThreshold: 0 }), /gzip|compressed|data check/i)
await assert.rejects(readSchematicNBT(large.subarray(0, -30), { compactBlocks: true, streamThreshold: 0 }), RangeError)
const tooShort = schematic([region('bad', [0, 0, 0], [100, 1, 1], ['air', 'stone'], Buffer.alloc(8))])
await assert.rejects(parseLitematicaRaw(tooShort, undefined, { compactBlocks: true }), RangeError)
const invalidArray = tag(10, '', compound(tag(12, 'broken', int(-1))))
await assert.rejects(readSchematicNBT(invalidArray, { compactBlocks: true, streamThreshold: 0 }), RangeError)
await assert.rejects(readSchematicNBT(large, { compactBlocks: true, streamThreshold: 0, maxBytes: 5 }), { code: 'FILE_TOO_LARGE', reason: 'retained' })
await assert.rejects(readSchematicNBT(large, { compactBlocks: true, streamThreshold: 0, maxExpandedBytes: 1024 }), { code: 'FILE_TOO_LARGE', reason: 'scan' })
console.log('PASS corrupted compression, truncated streams, invalid arrays and retained/scan budgets')
