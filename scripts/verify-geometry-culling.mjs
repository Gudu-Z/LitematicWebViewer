import assert from 'node:assert/strict'
import { buildFaceGroups, isSkipBlock, isTransparent, isLayeredTranslucentBlock } from '../src/geometry.js'
import { bakeModel } from '../src/modelBaker.js'
import { PagedBlockStore, encodeBlockPage, blockPageBytes, BLOCK_PAGE_SIZE } from '../src/pagedBlocks.js'

// Deliberately small, direct reference: collect each visible face in ordinary
// arrays, with no compiled palette, direction memoization, or two-pass cache.
// The expected output does not call the optimized culling/building functions.
function reference(palette, blocks, bounds, filter, options) {
  const groups = new Map(), stride = bounds.width * bounds.depth
  const short = name => name.replace(/^minecraft:/, '')
  const renderable = p => p?.baked?.quads?.length && !isSkipBlock(p.name)
    && !['player_head', 'player_wall_head'].includes(short(p.name))
  const sameHides = p => short(p.name).includes('glass') || short(p.name).endsWith('_leaves') || isLayeredTranslucentBlock(p.name)
  const worldVisible = (x, y, z) => !filter || filter(x + bounds.minX, y + bounds.minY, z + bounds.minZ, y)
  let emitted = 0
  for (const key of options.keys || blocks.keys()) {
    const gi = blocks.get(key), p = palette[gi]
    if (!renderable(p)) continue
    const x = key % bounds.width, z = Math.floor(key / bounds.width) % bounds.depth, y = Math.floor(key / stride)
    if (!worldVisible(x, y, z)) continue
    for (const q of p.baked.quads) {
      let groupKey = q.texKey
      if (isLayeredTranslucentBlock(p.name)) groupKey += '|translucent'
      else if (/(redstone_dust_dot|redstone_dust_line0|redstone_dust_line1)$/.test(groupKey)) groupKey += '|p' + (Number(p.properties?.power) || 0)
      if (options.includeGroup && !options.includeGroup(groupKey)) continue
      if (q.cullface) {
        const nx = x + q.cullface[0], ny = y + q.cullface[1], nz = z + q.cullface[2]
        if (nx >= 0 && nx < bounds.width && ny >= 0 && ny < bounds.height && nz >= 0 && nz < bounds.depth && worldVisible(nx, ny, nz)) {
          const other = palette[blocks.get(nx + nz * bounds.width + ny * stride)]
          if (other && ((renderable(other) && other.baked.fullCube && !isTransparent(other.name))
            || (sameHides(p) && sameHides(other) && short(p.name) === short(other.name)))) continue
        }
      }
      let group = groups.get(groupKey)
      if (!group) groups.set(groupKey, group = { positions: [], uvs: [], indices: [], blockKeys: [] })
      const base = group.positions.length / 3
      for (let i = 0; i < 4; i++) {
        group.positions.push(x + bounds.minX + q.verts[i][0], y + bounds.minY + q.verts[i][1], z + bounds.minZ + q.verts[i][2])
        group.uvs.push(...q.uvs[i])
      }
      group.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
      group.blockKeys.push(key)
      emitted++
    }
  }
  for (const [key, g] of groups) groups.set(key, {
    positions: Float32Array.from(g.positions), uvs: Float32Array.from(g.uvs),
    indices: g.positions.length / 3 < 65536 ? Uint16Array.from(g.indices) : Uint32Array.from(g.indices),
    ...(options.trackBlocks ? { blockKeys: bounds.width * bounds.height * bounds.depth <= 2 ** 32
      ? Uint32Array.from(g.blockKeys) : Float64Array.from(g.blockKeys) } : {}),
    v: g.positions.length / 3, f: g.indices.length,
  })
  return { groups, emitted }
}

const cube = bakeModel({ textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
}] })
const overlay = { fullCube: false, quads: [...cube.quads, ...cube.quads].map((q, i) => ({ ...q,
  texKey: i % 3 ? 'block/overlay' : 'block/stone',
  verts: q.verts.map(v => v.map(c => c + i / 65536)),
})) }
// Non-cardinal and zero vectors must retain the original direct lookup rules.
const custom = { fullCube: false, quads: [null, [2, 0, 0], [0, 0, 0], [-1, -1, 0], [.25, 0, 0], [.5, 0, .5], [0, .5, .5]].map((cf, i) => ({
  ...cube.quads[i % 6], cullface: cf, texKey: 'block/custom',
})) }
const palette = ['stone', 'glass', 'glass', 'ice', 'oak_leaves', 'slime_block', 'honey_block', 'stone_stairs', 'air', 'barrier', 'player_head']
  .map((name, i) => ({ name: 'minecraft:' + name, properties: { variant: String(i) }, baked: cube }))
palette.push({ name: 'minecraft:overlay', baked: overlay }, { name: 'minecraft:custom', baked: custom },
  { name: 'minecraft:redstone_wire', properties: { power: '12' }, baked: { fullCube: false, quads: cube.quads.map(q => ({ ...q, texKey: 'block/redstone_dust_line0' })) } },
  { name: 'minecraft:unresolved', baked: null },
  // A skipped leaf model can still hide the same block type, matching legacy.
  { name: 'minecraft:oak_leaves', baked: null })
let checks = 0
async function compare(blocks, bounds, filter = null, options = {}, referenceBlocks = blocks) {
  const expected = reference(palette, referenceBlocks, bounds, filter, options)
  for (const cullCacheBytes of [0, 64, 65536, undefined]) {
    const actual = await buildFaceGroups(palette, blocks, bounds, null, filter, { ...options, cullCacheBytes, yieldTask: async () => {} })
    assert.equal(actual.emitted, expected.emitted)
    assert.deepEqual([...actual.groups.keys()], [...expected.groups.keys()], 'First visible face determines group insertion order')
    assert.deepEqual(actual.groups, expected.groups, 'Exact face/vertex/UV/index/source order, including cache prefix fallback')
    checks++
  }
}

const bounds = { minX: -123.25, minY: -90, minZ: 1000000, width: 7, depth: 9, height: 4 }
const blocks = new Map(), volume = bounds.width * bounds.depth * bounds.height
for (let i = 0; i < volume; i++) if (i % 17) blocks.set((i * 131) % volume, (i * 97 + (i >> 3)) % palette.length)
for (const filter of [null, (_x, _y, _z, ly) => ly === 1, (x, _y, z) => x < bounds.minX + 4 && z >= bounds.minZ + 2]) {
  for (const options of [{}, { trackBlocks: true }, { trackBlocks: true, includeGroup: key => key !== 'block/stone' },
    { trackBlocks: true, keys: [...blocks.keys()].reverse().filter((_, i) => i % 3).concat([1, 1, volume + 1]) }]) await compare(blocks, bounds, filter, options)
}
const wide = { minX: -2000000, minY: 1024, minZ: 17, width: 65537, depth: 65537, height: 3 }, stride = wide.width * wide.depth
await compare(new Map([[stride, 0], [stride + 1, 11], [stride + 2, 12], [stride + wide.width, 1], [stride + wide.width + 1, 2], [3 * stride - 1, 0]]), wide, null, { trackBlocks: true })
await compare(new Map(), bounds)
await compare(new Map([[0, 0], [1, 0]]), { ...bounds, width: 2, depth: 1, height: 1 }, null, { includeGroup: () => false })

// Enough alternating hidden masks to cross cache slabs, checkpoint yields and
// Uint16 index capacity; cells without geometry must not misalign replay.
const longBounds = { minX: 0, minY: 0, minZ: 0, width: 70001, depth: 1, height: 1 }
const longBlocks = new Map()
for (let i = 0; i < longBounds.width; i++) longBlocks.set(i, i % 5 === 0 ? 14 : 0)
await compare(longBlocks, longBounds, null, { trackBlocks: true })

function paged(regions, bounds) {
  const expected = new Map()
  const records = regions.map(({ x, y, z, width, height, depth, value }) => {
    const volume = width * height * depth, values = new Uint32Array(volume), counts = new Float64Array(palette.length)
    let count = 0
    for (let i = 0; i < volume; i++) {
      const gi = value(i)
      if (gi === undefined) continue
      values[i] = gi + 1; counts[gi]++; count++
      expected.set(i % width + x + (Math.floor(i / width) % depth + z) * bounds.width + (Math.floor(i / (width * depth)) + y) * bounds.width * bounds.depth, gi)
    }
    const pages = []
    for (let i = 0; i < volume; i += BLOCK_PAGE_SIZE) pages.push(encodeBlockPage(values.subarray(i, i + BLOCK_PAGE_SIZE)))
    return { minX: bounds.minX + x, minY: bounds.minY + y, minZ: bounds.minZ + z,
      maxX: bounds.minX + x + width - 1, maxY: bounds.minY + y + height - 1, maxZ: bounds.minZ + z + depth - 1,
      width, height, depth, localToGlobal: Uint32Array.from({ length: palette.length }, (_, i) => i),
      states: { volume, count, counts, pages, bytes: pages.reduce((sum, page) => sum + blockPageBytes(page), 0) } }
  })
  const store = new PagedBlockStore(records, bounds, palette.length)
  assert.deepEqual([...store], [...expected], 'Paged iteration preserves Map insertion/override order')
  return { store, expected }
}
const region = { x: 0, y: 0, z: 0, width: bounds.width, height: bounds.height, depth: bounds.depth, value: i => blocks.get(i) }
for (const regions of [[region], [region, { x: 2, y: 0, z: 1, width: 4, height: 3, depth: 5, value: i => i % 7 ? (i * 5) % palette.length : undefined }]]) {
  const { store, expected } = paged(regions, bounds)
  await compare(store, bounds, null, { trackBlocks: true }, expected)
  await compare(store, bounds, (_x, _y, _z, ly) => ly === 1, { trackBlocks: true, keys: store.keyView }, expected)
}

// Pure fluids skip the model loop; waterlogged models emit both. Their presence
// between cached cells must not shift the sequential cull-mask replay.
const water = palette.length
palette.push({ name: 'minecraft:water', properties: { level: '3' }, baked: cube },
  { name: 'minecraft:bubble_column', baked: cube },
  { name: 'minecraft:oak_stairs', properties: { waterlogged: 'true' }, baked: overlay },
  { name: 'minecraft:lava', properties: { level: '0' }, baked: cube })
const mixed = new Map()
for (let i = 0; i < volume; i++) mixed.set((i * 131) % volume, [0, water, 11, water + 1, 14, water + 2, 2, water + 3][i % 8])
const mixedStore = paged([{ ...region, value: i => mixed.get(i) }], bounds)
for (const source of [mixed, mixedStore.store]) for (const filter of [null, (_x, _y, _z, ly) => ly === 1]) {
  const before = await buildFaceGroups(palette, source, bounds, null, filter, { trackBlocks: true, cullCacheBytes: 0 })
  for (const cullCacheBytes of [64, 65536, undefined]) {
    const after = await buildFaceGroups(palette, source, bounds, null, filter, { trackBlocks: true, cullCacheBytes })
    assert.deepEqual(after, before, 'Fluid/normal interleaving and cache exhaustion preserve every output field')
    checks++
  }
}
console.log(`Geometry culling: ${checks} exact reference comparisons passed`)
