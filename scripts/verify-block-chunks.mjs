// Spatial block groups preserve exact face data and global transparent order.
// Layer updates use only the prebuilt layer index and keep untouched chunks intact.
import assert from 'node:assert/strict'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { createBlockChunkIndex, buildBlockChunk, planBlockChunkUpdate } from '../src/blockChunks.js'

const directions = ['up', 'down', 'east', 'west', 'north', 'south']
function cube(texture, to = [16, 16, 16]) {
  return bakeModel({ textures: { all: texture }, elements: [{ from: [0, 0, 0], to,
    faces: Object.fromEntries(directions.map(direction => [direction, { texture: '#all', cullface: direction }])) }] })
}
const palette = [
  { name: 'minecraft:stone', baked: cube('block/stone') },
  { name: 'minecraft:dirt', baked: cube('block/dirt') },
  { name: 'minecraft:glass', baked: cube('block/glass') },
  { name: 'minecraft:water', properties: { level: '0' } },
  { name: 'minecraft:water', properties: { level: '4' } },
  { name: 'minecraft:lava', properties: { level: '0' } },
  { name: 'minecraft:bubble_column' },
  { name: 'minecraft:oak_slab', baked: cube('block/shared', [16, 8, 16]) },
  { name: 'minecraft:oak_planks', baked: cube('block/shared') },
  { name: 'minecraft:oak_fence', properties: { waterlogged: 'true' }, baked: cube('block/oak_planks', [6, 16, 6]) },
  { name: 'minecraft:custom_overhang', baked: { ...cube('block/overhang', [20, 16, 16]), fullCube: true } },
  { name: 'minecraft:end_portal', baked: cube('special/end_portal', [16, 1, 16]) },
  { name: 'minecraft:oak_log' },
]
const bounds = { minX: -35, minY: -19, minZ: 6, width: 48, height: 48, depth: 8 }
const rawBlocks = new Map()
const keyAt = (x, y, z) => x + z * bounds.width + y * bounds.width * bounds.depth
for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) for (let z = 0; z < 4; z++) {
  rawBlocks.set(keyAt(x, y, z), x % 3 === 0 ? 1 : 0)
}
for (let y = 14; y < 18; y++) for (let x = 14; x < 18; x++) for (let z = 5; z < 8; z++) {
  rawBlocks.set(keyAt(x, y, z), 2 + ((x * 3 + y + z) % 11))
}
// Arbitrary Map insertion order is intentional, especially for fluid face ordering.
const hash = key => Math.imul(key ^ 0x12345678, 2654435761) >>> 0
const blocks = new Map([...rawBlocks].sort((a, b) => hash(a[0]) - hash(b[0])))
const data = { palette, blocks, bounds }
const options = { chunkSize: 16, maxChunks: 64, minBlocks: 1, minTextureBlocks: 1 }
const index = createBlockChunkIndex(data, options)
assert.equal(index.enabled, true)
assert.equal(index.chunks.size, 9)
assert.deepEqual([...index.splitGroups].sort(), ['block/dirt', 'block/stone'])
assert.equal(createBlockChunkIndex(data).enabled, true, 'Normal large structures use default thresholds')

function makeFilter(desc) {
  if (!desc || desc.mode === 'all' && !desc.regionKey) return null
  return (x, y) => (desc.mode === 'single' ? y === desc.layerY
    : desc.mode === 'below' ? y <= desc.layerY
      : desc.mode === 'above' ? y >= desc.layerY : true)
    && (!desc.regionKey || x < bounds.minX + 21)
}
function faces(group) {
  const result = []
  for (let v = 0; v < group.positions.length / 3; v += 4) {
    result.push([...group.positions.subarray(v * 3, (v + 4) * 3), ...group.uvs.subarray(v * 2, (v + 4) * 2)].join(','))
  }
  return result
}
let comparedFaces = 0
function compare(reference, results, label) {
  const rebuilt = new Map()
  let emitted = 0
  for (const { groups, emitted: count } of results.values()) {
    emitted += count
    for (const [key, group] of groups) {
      if (!rebuilt.has(key)) rebuilt.set(key, [])
      rebuilt.get(key).push(group)
      if (group.indices) for (let face = 0; face < group.indices.length / 6; face++) {
        const v = face * 4
        assert.deepEqual([...group.indices.subarray(face * 6, (face + 1) * 6)], [v, v + 1, v + 2, v + 2, v + 1, v + 3])
      }
    }
  }
  assert.equal(emitted, reference.emitted, `${label}: face count`)
  assert.deepEqual([...rebuilt.keys()].sort(), [...reference.groups.keys()].sort(), `${label}: texture keys`)
  for (const [key, expected] of reference.groups) {
    const actual = rebuilt.get(key)
    if (!index.splitGroups.has(key)) {
      assert.equal(actual.length, 1, `${label}: ${key} remains one global group`)
      assert.deepEqual(actual[0], expected, `${label}: ${key} preserves every byte and face order`)
    } else {
      assert.deepEqual(actual.flatMap(faces).sort(), faces(expected).sort(), `${label}: ${key} world vertices and UVs`)
    }
  }
  comparedFaces += emitted
}

// Default buildFaceGroups callers remain unchanged; a candidate list never changes neighbour culling.
const full = await buildFaceGroups(palette, blocks, bounds)
assert.deepEqual(await buildFaceGroups(palette, blocks, bounds, null, null, { keys: [...blocks.keys()] }), full)
const firstChunk = index.chunks.values().next().value
const partial = await buildFaceGroups(palette, blocks, bounds, null, null, {
  keys: firstChunk.keys, includeGroup: key => key === 'block/stone',
})
assert.deepEqual([...partial.groups.keys()], ['block/stone'])
assert.ok(partial.emitted < full.emitted)
assert.deepEqual(await buildFaceGroups(palette, blocks, bounds, null, null, { keys: [] }), { groups: new Map(), emitted: 0, geometryBytes: 0 })

const steps = [
  null,
  { mode: 'below', layerY: bounds.minY + 22 },
  { mode: 'below', layerY: bounds.minY + 23 },
  { mode: 'below', layerY: bounds.minY + 15 },
  { mode: 'below', layerY: bounds.minY + 16 },
  { mode: 'single', layerY: bounds.minY + 15 },
  { mode: 'single', layerY: bounds.minY + 16 },
  { mode: 'above', layerY: bounds.minY + 16 },
  { mode: 'above', layerY: bounds.minY + 15 },
  { mode: 'single', layerY: bounds.minY - 1 },
  { mode: 'below', layerY: bounds.minY + 100 },
  { mode: 'all', layerY: 999 },
  { mode: 'all', layerY: 1000 },
  { mode: 'below', layerY: bounds.minY + 16, regionKey: 'hide-east' },
  { mode: 'below', layerY: bounds.minY + 17, regionKey: 'hide-east' },
  null,
]
const results = new Map()
let previous
let localizedScan = 0
for (const [step, desc] of steps.entries()) {
  const filter = makeFilter(desc)
  const savedIterator = blocks[Symbol.iterator]
  blocks[Symbol.iterator] = () => { throw new Error('Layer planning must not scan blocks') }
  let plan
  try { plan = planBlockChunkUpdate(index, previous, desc) }
  finally { blocks[Symbol.iterator] = savedIterator }
  if (step === 2) {
    assert.equal(plan.dirty.length, 3, 'Moving a boundary within one chunk only rebuilds that chunk row')
    assert.ok(plan.scannedBlocks < blocks.size / 2)
    localizedScan = plan.scannedBlocks
  }
  if (step === 4) assert.equal(plan.dirty.length, 7, 'Crossing a chunk boundary rebuilds both rows and affected global fluids')
  if (step === 12) assert.deepEqual(plan.dirty, [], 'all mode ignores layerY')
  if (step === 13 || step === 15) assert.equal(plan.fullRebuild, true, 'Region changes invalidate every group')
  for (const id of plan.dirty) {
    const result = await buildBlockChunk(index, id, filter)
    assert.equal(result.scannedBlocks, id === null ? index.globalKeys.length : index.chunks.get(id).keys.length)
    results.set(id, result)
  }
  compare(await buildFaceGroups(palette, blocks, bounds, null, filter), results, `step ${step}`)
  previous = desc
}

const coarsened = createBlockChunkIndex(data, { ...options, maxChunks: 2 })
assert.ok(coarsened.chunks.size <= 2)
assert.ok(coarsened.chunkSize > options.chunkSize)
const single = createBlockChunkIndex(data, { ...options, maxChunks: 1 })
assert.equal(single.enabled, false, 'A single chunk keeps the original draw grouping')
assert.deepEqual(await buildBlockChunk(single, null, null), { ...full, scannedBlocks: blocks.size })

const small = { ...data, blocks: new Map([...blocks].slice(0, 20)) }
const smallIndex = createBlockChunkIndex(small)
assert.equal(smallIndex.enabled, false, 'Small structures do not multiply draw calls')
const rareTextures = { ...data, blocks: new Map([...blocks].filter(([, gi]) => gi > 1)) }
assert.equal(createBlockChunkIndex(rareTextures).enabled, false, 'Tiny groups and unsafe textures stay global')
const unmetTextureThreshold = createBlockChunkIndex(data, { ...options, minTextureBlocks: blocks.size + 1 })
assert.equal(unmetTextureThreshold.enabled, false)

// Larger/smaller world offsets keep exact Float32 conversion. Unsafe collapsed cells fall back entirely.
for (const offset of [-30_000_000, -8192, 8192, 30_000_000, 0.25]) {
  const moved = { ...data, bounds: { ...bounds, minX: offset } }
  const movedIndex = createBlockChunkIndex(moved, options)
  assert.equal(movedIndex.enabled, Number.isInteger(offset) && Math.abs(offset) < 2 ** 24)
  const reference = await buildFaceGroups(palette, blocks, moved.bounds)
  if (!movedIndex.enabled) {
    assert.deepEqual(await buildBlockChunk(movedIndex, null, null), { ...reference, scannedBlocks: blocks.size })
  } else {
    const movedResults = new Map()
    for (const id of movedIndex.ids) movedResults.set(id, await buildBlockChunk(movedIndex, id, null))
    compare(reference, movedResults, `offset ${offset}`)
  }
}

console.log(`Block chunk regression passed: ${comparedFaces} exact faces/particles; local layer update scans ${localizedScan}/${blocks.size} blocks; fluid/global byte order unchanged.`)
