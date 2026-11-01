import assert from 'node:assert/strict'
import { PagedBlockStore, encodeBlockPage } from '../src/pagedBlocks.js'
import { serializeSchematic, deserializeSchematic } from '../src/workerProtocol.js'
import { PARSE_HANDOFF_VERSION, planParseHandoff, createParseHandoffReceiver } from '../src/parseHandoff.js'

const records = length => Array.from({ length }, (_, i) => ({ id: 'minecraft:barrel', x: i, y: 0, z: 0,
  nbt: { id: 'minecraft:barrel', Items: [], x: i }, region: 'test' }))
const emptyMap = () => ({ kind: 'map', values: new Map() })
const wireFor = (blocks, tileEntities = [], entities = []) => ({ metadata: {}, palette: [], blocks,
  bounds: blocks.bounds || {}, tileEntities, entities, regions: [], nbtInfo: {} })
const rejected = action => assert.throws(action, { code: 'WORKER_PROTOCOL' })
function roundTrip(wire) {
  const plan = planParseHandoff(wire)
  assert.ok(plan)
  assert.equal(plan.header.version, PARSE_HANDOFF_VERSION)
  const receiver = createParseHandoffReceiver(structuredClone(plan.header)), log = []
  for (const packet of plan.packets) {
    receiver.append(structuredClone(packet))
    log.push([packet.kind, packet.region, packet.start, packet.values.length / (packet.kind === 'map' ? 2 : 1)])
  }
  assert.equal(log.length, plan.header.partCount)
  const result = receiver.finish()
  assert.deepEqual(result, structuredClone(wire))
  assert.deepEqual(Object.keys(result), Object.keys(wire))
  rejected(() => receiver.finish())
  return { result, plan, log }
}
assert.equal(planParseHandoff(wireFor(emptyMap(), records(12))), null)

// Two overlapping regions: original Map insertion order, non-air override and
// air fall-through; a page crosses a packet boundary, without expanding cells.
const height = 257, volume = 64 * 256 * height
function bigRegion() {
  const backing = new ArrayBuffer(536)
  const palette = new Uint32Array(backing, 4, 2), words = new Uint32Array(backing, 24, 128)
  palette.set([0, 1]); words[0] = 0b10110
  // Synthetic views intentionally share a backing buffer and have unused bytes.
  new Uint8Array(backing)[0] = 73
  const page = { palette, length: 4096, count: 3, bits: 1, words }
  const pages = Array(volume / 4096).fill(0); pages[0] = page
  pages[1024] = encodeBlockPage(Uint32Array.from({ length: 4096 }, (_, i) => i === 4095 ? 1 : 0))
  return { name: 'test', minX: 0, minY: 0, minZ: 0, maxX: 63, maxY: height - 1, maxZ: 255,
    width: 64, height, depth: 256, localToGlobal: [0],
    states: { volume, pages, bytes: 10000, count: 4, counts: Float64Array.of(4) } }
}
const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 63, maxY: height - 1, maxZ: 255, width: 64, height, depth: 256 }
{
  const region = bigRegion(), second = { name: 'overlay', minX: 1, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 0,
    width: 2, height: 1, depth: 1, localToGlobal: [1],
    states: { volume: 2, pages: [encodeBlockPage(Uint32Array.of(1, 0))], bytes: 42, count: 1, counts: Float64Array.of(1) } }
  const blocks = new PagedBlockStore([region, second], bounds, 2)
  const tileEntities = records(16385)
  const nbt = tileEntities[2048].nbt, bytes = new ArrayBuffer(40)
  nbt.bytes = new Uint8Array(bytes, 8, 4); nbt.ints = new Int32Array(bytes, 4, 6)
  nbt.ints[1] = 0x87654321; nbt.long = -549755813889n
  nbt.repeated = nbt.ints
  const originalPages = region.states.pages, original = [...blocks]
  const wire = serializeSchematic({ ...wireFor(blocks, tileEntities, [{ id: 'test', nbt: { Pos: [0, 2, -0] } }]), blocks })
  const { result, log, plan } = roundTrip(wire)
  assert.deepEqual(log.slice(0, 3), [['pages', 0, 0, 1024], ['pages', 0, 1024, 4], ['pages', 1, 0, 1]])
  assert.equal(plan.header.result.blocks.regions[0].states.pages.length, 0)
  assert.equal(plan.header.result.tileEntities.length, 0)
  assert.equal(region.states.pages, originalPages)
  assert.equal(region.states.pages[0].palette.buffer.byteLength, 536)
  assert.deepEqual([...blocks], original, 'The worker can still build/query the complete store')
  const graph = result.blocks
  assert.equal(result.bounds, graph.bounds)
  assert.equal(graph.regions[0].after[0], graph.regions[1])
  assert.equal(graph.regions[1].before[0], graph.regions[0])
  assert.equal(graph.regions[1].overlaps[0], graph.regions[0])
  assert.equal(graph.regionGrid.cells.get(0)[0], graph.regions[0])
  const page = graph.regions[0].states.pages[0], cloned = result.tileEntities[2048].nbt
  assert.equal(page.palette.buffer, page.words.buffer)
  assert.equal(page.words.byteOffset, 24)
  assert.equal(new Uint8Array(page.words.buffer)[0], 73)
  assert.equal(cloned.bytes.buffer, cloned.ints.buffer)
  assert.equal(cloned.repeated, cloned.ints)
  assert.equal(cloned.bytes.byteOffset, 8)
  assert.deepEqual(Object.keys(page), Object.keys(originalPages[0]))
  assert.deepEqual(Object.keys(graph.regions[0]), Object.keys(region))
  const restored = deserializeSchematic(result).blocks
  assert.deepEqual([...restored], original)
  assert.deepEqual(restored.paletteCounts, blocks.paletteCounts)
  assert.equal(restored.get(1), 1)
  assert.equal(restored.get(2), 0)
}
{
  const blocks = new PagedBlockStore([bigRegion()], bounds, 1)
  const { result } = roundTrip(serializeSchematic(wireFor(blocks, [], records(16384))))
  assert.equal(result.blocks.onlyRegion, result.blocks.regions[0])
  assert.equal(result.bounds, result.blocks.bounds)
  assert.equal(result.blocks.regionGrid, null)
}
{
  const values = new Map()
  for (let i = 0; i < 32769; i++) values.set(2 ** 32 + i * 3, i % 7)
  values.delete(2 ** 32 + 32768 * 3); values.set(Number.MAX_SAFE_INTEGER, 31)
  const { log, result, plan } = roundTrip(wireFor({ kind: 'map', values }, records(1)))
  assert.equal(result.blocks.values.keys().next().value, 2 ** 32)
  assert.equal(result.blocks.values.get(Number.MAX_SAFE_INTEGER), 31)
  assert.deepEqual([...result.blocks.values], [...values])
  assert.deepEqual(log.map(p => [p[0], p[2], p[3]]), [
    ['map', 0, 8192], ['map', 8192, 8192], ['map', 16384, 8192], ['map', 24576, 8192], ['map', 32768, 1], ['tileEntities', 0, 1],
  ])
  const first = plan.packets[Symbol.iterator]().next().value
  assert.ok(first.values instanceof Float64Array)
  const fractional = first.values.slice(), duplicate = first.values.slice()
  fractional[0] = .25; duplicate[2] = duplicate[0]
  for (const bad of [{ ...first, start: 1 }, { ...first, region: 0 }, { ...first, kind: 'entities' },
    { ...first, values: [] }, { ...first, values: first.values.subarray(1) },
    { ...first, values: fractional }, { ...first, values: duplicate }]) {
    const receiver = createParseHandoffReceiver(structuredClone(plan.header))
    rejected(() => receiver.append(bad)); rejected(() => receiver.finish())
  }
  const partial = createParseHandoffReceiver(structuredClone(plan.header))
  partial.append(first); rejected(() => partial.finish())
}
{
  const { header, packets } = planParseHandoff(wireFor(emptyMap(), records(16384)))
  const first = packets[Symbol.iterator]().next().value
  const sparse = first.values.slice(); delete sparse[50]
  const receiver = createParseHandoffReceiver(structuredClone(header))
  rejected(() => receiver.append({ ...first, values: sparse }))
  rejected(() => createParseHandoffReceiver({ ...header, version: 999 }))
  rejected(() => createParseHandoffReceiver({ ...header, partCount: header.partCount + 1 }))
  rejected(() => createParseHandoffReceiver({ ...header, counts: { ...header.counts, tileEntities: -1 } }))
  // A large but representable header must not allocate an output array up front.
  const huge = structuredClone(header); huge.counts.tileEntities = 0xffffffff; huge.partCount = Math.ceil(0xffffffff / 2048)
  const partial = createParseHandoffReceiver(huge)
  assert.equal(huge.result.tileEntities.length, 0); rejected(() => partial.finish())
}
console.log('PASS parse handoff: ordered map/overlapping pages, aliases/typed offsets/NBT, unchanged worker store, bounded packets and malformed/partial transfers')
