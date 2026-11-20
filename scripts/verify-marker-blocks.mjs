import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { parseLitematica, parseLitematicaRaw } from '../src/litematica.js'
import { createSchematicWorker } from '../src/schematicWorker.js'
import { deserializeSchematic } from '../src/workerProtocol.js'

const int = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b }
const string = value => { const b = Buffer.from(value), n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]) }
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
const text = (name, value) => tag(8, name, string(value))
const vector = (name, values) => tag(10, name, compound(...values.map((n, i) => tag(3, 'xyz'[i], int(n)))))
const state = (name, properties = {}) => compound(text('Name', name), tag(10, 'Properties',
  compound(...Object.entries(properties).map(([key, value]) => text(key, value)))))
const region = (name, position, size, palette, words) => tag(10, name, compound(
  // Streamed BlockStates may arrive before their size, position and local palette.
  tag(12, 'BlockStates', Buffer.concat([int(words.length / 8), words])),
  tag(9, 'BlockStatePalette', Buffer.concat([Buffer.from([10]), int(palette.length), ...palette])),
  vector('Size', size), vector('Position', position),
))

function schematic(height) {
  const palette = [
    state('minecraft:air'), state('minecraft:stone'), state('minecraft:barrier'), state('minecraft:light', { level: '7' }),
    state('minecraft:structure_void'), state('minecraft:moving_piston'), state('minecraft:cave_air'),
    state('minecraft:void_air'), state('example:light'),
  ]
  // Nine states fit four bits. Larger heights add only air above the same cells.
  const words = Buffer.alloc(16 * 16 * height / 2)
  for (const [index, local] of [[0, 2], [1, 1], [15, 3], [17, 4], [255, 6], [256, 5], [257, 7], [258, 8], [65536, 3]]) {
    const offset = Math.floor(index / 16) * 8
    words.writeBigUInt64BE(words.readBigUInt64BE(offset) | BigInt(local) << BigInt(index % 16 * 4), offset)
  }
  return tag(10, '', compound(tag(10, 'Regions', compound(
    // Palette index zero is a marker in an all-zero word, including its padding.
    region('overlay', [-6, -3, -13], [2, 1, 1], [state('minecraft:light', { level: '3' })], Buffer.alloc(8)),
    region('negative', [9, height - 4, 2], [-16, -height, -16], palette, words),
  ))))
}

const expectedMarkers = [
  { x: -6, y: -3, z: -13, state: 0 },
  { x: -5, y: -3, z: -13, state: 0 },
  { x: -6, y: -3, z: -13, state: 3 },
  { x: 9, y: -3, z: -13, state: 4 },
  { x: -5, y: -3, z: -12, state: 5 },
  { x: -6, y: -2, z: -13, state: 6 },
  { x: -6, y: 253, z: -13, state: 4 },
]
const expectedBlocks = [[1, 2], [256, 6], [258, 9]] // stone, moving piston, namespaced non-marker

async function verify(parse, bytes, options, paged) {
  const previous = await parse(bytes, undefined, options)
  const data = await parse(bytes, undefined, { ...options, markerBlocks: true })
  assert.ok(!Object.hasOwn(previous, 'markerBlocks'))
  assert.deepEqual(data.markerBlocks, expectedMarkers)
  assert.deepEqual(data.markerBlocks.map(({ state }) => data.palette[state].name),
    ['light', 'light', 'barrier', 'light', 'structure_void', 'moving_piston', 'light'].map(name => 'minecraft:' + name))
  assert.equal(data.palette[0].properties.level, '3')
  assert.equal(data.palette[4].properties.level, '7')
  for (const key of ['palette', 'metadata', 'bounds', 'regions', 'entities', 'tileEntities', 'nbtInfo']) {
    assert.deepEqual(data[key], previous[key], key)
  }
  assert.deepEqual([...data.blocks], expectedBlocks)
  assert.deepEqual([...data.blocks], [...previous.blocks])
  if (paged) {
    assert.ok(data.blocks.isPagedBlockStore && previous.blocks.isPagedBlockStore)
    assert.deepEqual(data.blocks.paletteCounts, previous.blocks.paletteCounts)
    assert.deepEqual(data.blocks.regions.map(r => r.states), previous.blocks.regions.map(r => r.states))
  } else {
    assert.ok(data.blocks instanceof Map && previous.blocks instanceof Map)
  }
  return data
}

const raw = schematic(257), compressed = gzipSync(raw)
await verify(parseLitematica, compressed, { compactBlocks: false }, false)
await verify(parseLitematicaRaw, raw, { compactBlocks: true, markerBlocks: false }, true)
console.log('PASS marker blocks in Map and compact decoders: encounter order, world coordinates, palette properties, unchanged blocks and opt-in default')

// 8 MiB of packed states triggers extraction in readSchematicNBT's second pass.
const streamed = await verify(parseLitematica, gzipSync(schematic(65536)), { renderOnly: true, streamThreshold: 0 }, true)
assert.equal(streamed.nbtInfo.blockStateBytes, 8 * 1024 * 1024)
console.log('PASS streamed render-only markers match the Map decoder across extracted and buffered regions')

let result
const worker = createSchematicWorker({ postMessage(message, transfer) {
  if (message.type === 'error') throw new Error(message.error.message)
  if (message.type === 'result') result = structuredClone(message.result, { transfer })
} })
await worker.handle({ type: 'parse', id: 1, session: 1, bytes: compressed, options: { compactBlocks: true, markerBlocks: true } })
const restored = deserializeSchematic(result)
assert.deepEqual(restored.markerBlocks, expectedMarkers)
assert.deepEqual([...restored.blocks], expectedBlocks)
console.log('PASS worker parse options and marker blocks survive the structured-clone hand-off')
