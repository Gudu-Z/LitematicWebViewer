// Parsing/geometry invariants for load-time optimizations; no downloaded assets needed.
import assert from 'node:assert/strict'
import { gzipSync, deflateSync } from 'node:zlib'
import { parseNBT } from '../src/nbt.js'
import { parseLitematica, parseLitematicaRaw } from '../src/litematica.js'
import { buildFaceGroups } from '../src/geometry.js'
import { extractSigns, extractBanners, extractPlayerHeads, extractDecoratedPots } from '../src/schematicDetails.js'
import { getMobAppearance } from '../src/entityAppearance.js'
import { readEquipment } from '../src/equipmentState.js'
import { movingPistonParts } from '../src/movingPistons.js'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const string = s => { const b = Buffer.from(s), n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]) }
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
const list = (type, items) => Buffer.concat([Buffer.from([type]), int(items.length), ...items])
const vec = values => compound(...values.map((n, i) => tag(3, 'xyz'[i], int(n))))
const longArray = values => {
  const bytes = Buffer.alloc(values.length * 8)
  values.forEach((n, i) => bytes.writeBigInt64BE(BigInt.asIntN(64, n), i * 8))
  return Buffer.concat([int(values.length), bytes])
}

const signed = [0n, 1n, -1n, -0x8000000000000000n, 0x7fffffffffffffffn, 0xfedcba9876543210n]
const rawNBT = tag(10, '', compound(tag(12, 'longs', longArray(signed)), tag(8, '名字', string('投影测试 🦜'))))
const unaligned = Buffer.concat([Buffer.alloc(3), rawNBT, Buffer.alloc(5)]).subarray(3, 3 + rawNBT.length)
assert.deepEqual([...parseNBT(unaligned).longs], signed.map(n => BigInt.asIntN(64, n)))
assert.equal(parseNBT(unaligned)['名字'], '投影测试 🦜')
assert.throws(() => parseNBT(rawNBT.subarray(0, 19)), RangeError)
console.log('PASS NBT signed longs, byte offsets, Unicode and truncated arrays')

// Skipping must consume every binary payload exactly, without decoding its text.
const hidden = compound(
  ...[1, 2, 3, 4, 5, 6].map((type, i) => tag(type, 'number' + type, Buffer.alloc([1, 2, 4, 8, 4, 8][i]))),
  tag(7, 'bytes', Buffer.concat([int(3), Buffer.from([1, 2, 3])])),
  tag(8, 'text', string('not decoded in a preview')),
  tag(9, 'numbers', list(6, [double(1.5), double(-2.5)])),
  tag(9, 'lists', list(9, [list(8, [string('nested skipped text')]), list(0, [])])),
  tag(9, 'objects', list(10, [compound(tag(8, 'private', string('container data')))])),
  tag(11, 'ints', Buffer.concat([int(2), int(-1), int(7)])),
  tag(12, 'longs', longArray(signed)),
)
const selectiveRaw = tag(10, '', compound(tag(3, 'before', int(17)), tag(10, 'skip', hidden), tag(8, 'after', string('retained'))))
assert.equal(parseNBT(selectiveRaw).skip.text, 'not decoded in a preview')
const originalDecode = TextDecoder.prototype.decode, decodedText = []
try {
  TextDecoder.prototype.decode = function(...args) { const value = originalDecode.apply(this, args); decodedText.push(value); return value }
  assert.deepEqual(parseNBT(selectiveRaw, (_path, name) => name !== 'skip'), { before: 17, after: 'retained' })
  assert.ok(!decodedText.includes('not decoded in a preview') && !decodedText.includes('container data'), 'Skipped NBT values are never decoded')
} finally { TextDecoder.prototype.decode = originalDecode }
for (const [type, payload] of [[7, int(-1)], [11, int(2147483647)], [12, int(-1)], [9, Buffer.concat([Buffer.from([6]), int(-1)])], [8, Buffer.from([255, 255])]]) {
  assert.throws(() => parseNBT(tag(10, '', compound(tag(type, 'skip', payload))), () => false), RangeError)
}
assert.throws(() => parseNBT(tag(10, '', compound(tag(99, 'skip', Buffer.alloc(0)))), () => false), /NBT/)
console.log('PASS selective NBT skips all payload types without decoding values and rejects truncated/invalid skipped fields')

const textTag = (name, value) => tag(8, name, string(value))
const inventory = tag(9, 'Items', list(10, [compound(textTag('id', 'minecraft:diamond'), tag(3, 'count', int(64)))]))
const tileTag = (id, extra) => compound(textTag('id', 'minecraft:' + id), tag(3, 'x', int(0)), tag(3, 'y', int(0)), tag(3, 'z', int(0)), ...extra)
const pig = compound(textTag('id', 'minecraft:pig'), tag(3, 'Age', int(-24000)), tag(1, 'Saddle', Buffer.from([1])), inventory)
const wither = compound(textTag('id', 'minecraft:wither'), tag(6, 'Health', double(60)), tag(10, 'Brain', hidden), inventory,
  tag(9, 'attributes', list(10, [compound(textTag('id', 'minecraft:max_health'), tag(6, 'base', double(300)))])))
const previewRaw = tag(10, '', compound(tag(10, 'Regions', compound(tag(10, 'preview', compound(
  tag(10, 'Position', vec([3, -2, 5])), tag(10, 'Size', vec([-1, 1, 1])),
  tag(9, 'BlockStatePalette', list(10, [compound(textTag('Name', 'minecraft:red_banner'))])), tag(12, 'BlockStates', longArray([0n])),
  tag(9, 'TileEntities', list(10, [
    tileTag('chest', [inventory, tag(10, 'components', hidden)]),
    tileTag('banner', [tag(9, 'patterns', list(10, [compound(textTag('pattern', 'minecraft:stripe_top'), textTag('color', 'blue'))]))]),
    tileTag('sign', [tag(10, 'front_text', compound(textTag('color', 'red'), tag(9, 'messages', list(8, [string('Storage')]))))]),
    tileTag('skull', [tag(10, 'profile', compound(textTag('name', 'Player')))]),
    tileTag('decorated_pot', [tag(9, 'sherds', list(8, [string('minecraft:archer_pottery_sherd')]))]),
    tileTag('piston', [tag(10, 'blockState', compound(textTag('Name', 'minecraft:stone'))), tag(3, 'facing', int(5)), tag(6, 'progress', double(.25))]),
  ])),
  tag(9, 'Entities', list(10, [wither, compound(textTag('id', 'minecraft:oak_chest_boat'), inventory,
    tag(9, 'Passengers', list(10, [compound(textTag('id', 'minecraft:armor_stand'), tag(1, 'ShowArms', Buffer.from([1])),
      tag(10, 'equipment', compound(tag(10, 'head', compound(textTag('id', 'minecraft:leather_helmet'), tag(3, 'count', int(1)),
        tag(10, 'components', compound(tag(3, 'minecraft:dyed_color', int(0x55aaff)))))))),
      tag(9, 'Passengers', list(10, [pig])), tag(10, 'Brain', hidden))])))])),
  tag(9, 'PendingBlockTicks', list(10, [compound(textTag('id', 'private tick'))])),
))))))
const fullPreview = await parseLitematicaRaw(previewRaw), cardPreview = await parseLitematicaRaw(previewRaw, null, { renderOnly: true })
for (const key of ['metadata', 'palette', 'blocks', 'bounds', 'regions']) assert.deepEqual(cardPreview[key], fullPreview[key], key + ' must remain identical')
assert.equal(fullPreview.tileEntities[0].nbt.Items[0].count, 64, 'Full viewer retains container contents')
assert.ok(!cardPreview.tileEntities.some(tile => tile.id === 'minecraft:chest'), 'Cards do not retain inspection-only block entities')
for (const extract of [extractSigns, extractBanners, extractPlayerHeads, extractDecoratedPots]) {
  assert.deepEqual(extract(cardPreview.tileEntities, cardPreview), extract(fullPreview.tileEntities, fullPreview))
}
assert.deepEqual(movingPistonParts(cardPreview.tileEntities.at(-1).nbt), movingPistonParts(fullPreview.tileEntities.at(-1).nbt))
assert.ok(!Object.hasOwn(cardPreview.entities[0].nbt, 'Brain') && !Object.hasOwn(cardPreview.entities[0].nbt, 'Items'))
for (const data of [fullPreview, cardPreview]) {
  assert.ok(getMobAppearance(data.entities[0], 'wither', data).layers.some(layer => layer.name === 'wither_armor'), 'Health still drives visible shields')
}
const savedStand = fullPreview.entities[1].nbt.Passengers[0], cardStand = cardPreview.entities[1].nbt.Passengers[0]
assert.deepEqual(readEquipment(cardStand), readEquipment(savedStand), 'Dyed equipment and nested passengers stay visible')
assert.equal(cardStand.ShowArms, 1)
assert.equal(cardStand.Passengers[0].Age, -24000)
assert.equal(cardStand.Passengers[0].Saddle, 1)
assert.ok(!Object.hasOwn(cardStand, 'Brain') && !Object.hasOwn(cardStand.Passengers[0], 'Items'))
assert.deepEqual(await parseLitematica(gzipSync(previewRaw), null, { renderOnly: true }), cardPreview)
console.log('PASS render-only cards retain geometry, signs, flags, heads, pots, pistons, health-driven effects, equipment and nested passengers; full inspection remains complete')

const names = ['air', 'stone', 'water', 'glass', 'structure_void', 'light']
const specs = [
  { name: '负尺寸', origin: [300, 4, 10], size: [-257, -3, -97] },
  { name: '重叠区域', origin: [50, 2, -70], size: [5, 2, 3] },
  { name: '高而窄', origin: [0, -30, 0], size: [1, 1001, 1] },
  { name: '宽而薄', origin: [-70010, 0, 0], size: [70003, 1, 1] },
]
const expected = new Map()
function region(spec, ri) {
  const [w, h, d] = spec.size.map(Math.abs)
  const corner = spec.origin.map((p, axis) => spec.size[axis] < 0 ? p + spec.size[axis] + 1 : p)
  const words = Array(Math.ceil(w * h * d * 3 / 64)).fill(0n)
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const index = x + w * (z + d * y), state = (index * 7 + ri) % names.length
    const bit = index * 3, word = Math.floor(bit / 64), offset = bit % 64
    words[word] |= BigInt(state) << BigInt(offset)
    if (offset + 3 > 64) words[word + 1] |= BigInt(state) >> BigInt(64 - offset)
    if (state >= 1 && state <= 3) expected.set([x + corner[0], y + corner[1], z + corner[2]].join(','), 'minecraft:' + names[state])
  }
  return tag(10, spec.name, compound(
    tag(10, 'Position', vec(spec.origin)), tag(10, 'Size', vec(spec.size)),
    tag(9, 'BlockStatePalette', list(10, names.map(name => compound(tag(8, 'Name', string('minecraft:' + name)))))),
    tag(12, 'BlockStates', longArray(words)),
    tag(9, 'TileEntities', list(10, [compound(tag(8, 'id', string('minecraft:sign')), tag(3, 'x', int(1)), tag(3, 'y', int(0)), tag(3, 'z', int(2)))])),
    tag(9, 'Entities', list(10, [compound(tag(8, 'id', string('minecraft:pig')), tag(9, 'Pos', list(6, [.125, -.25, 1.5].map(double))))])),
  ))
}
const raw = tag(10, '', compound(tag(10, 'Regions', compound(...specs.map(region)))))
const progress = []
const data = await parseLitematicaRaw(raw, f => progress.push(f))
assert.equal(progress.at(-1), 1)
assert.ok(progress.every((f, i) => f >= 0 && f <= 1 && (!i || f >= progress[i - 1])))
const actual = new Map(), b = data.bounds
for (const [key, gi] of data.blocks) {
  actual.set([key % b.width + b.minX, Math.floor(key / (b.width * b.depth)) + b.minY, Math.floor(key / b.width) % b.depth + b.minZ].join(','), data.palette[gi].name)
}
assert.deepEqual(actual, expected, 'Every visible block keeps its world position, state and overlap order')
assert.ok(Math.max(...data.blocks.keys()) > 2 ** 32, 'Fixture exercises large coordinate keys')
specs.forEach((spec, i) => {
  const corner = spec.origin.map((p, axis) => spec.size[axis] < 0 ? p + spec.size[axis] + 1 : p)
  assert.deepEqual([data.tileEntities[i].x, data.tileEntities[i].y, data.tileEntities[i].z], [corner[0] + 1, corner[1], corner[2] + 2])
  assert.deepEqual(data.entities[i].pos, spec.origin.map((p, axis) => p + [.125, -.25, 1.5][axis]))
})
for (const bytes of [gzipSync(raw), deflateSync(raw), raw]) {
  assert.deepEqual(await parseLitematica(bytes), data, 'Compression format must not change parsed output')
}
console.log('PASS chunk boundaries, wide/tall regions, negative sizes, overlaps, skipped states, entities and progress')

const compact = await parseLitematicaRaw(raw, null, { compactBlocks: true })
assert.ok(compact.blocks.isPagedBlockStore)
assert.deepEqual([...compact.blocks], [...data.blocks], 'Paged storage preserves Map insertion and overlapping-region overwrite order')
assert.equal(compact.blocks.size, data.blocks.size)
for (const [key, gi] of data.blocks) assert.equal(compact.blocks.get(key), gi)
for (const key of ['metadata', 'palette', 'bounds', 'regions', 'tileEntities', 'entities']) assert.deepEqual(compact[key], data[key])
for (let gi = 0; gi < data.palette.length; gi++) {
  const wanted = data.palette.map((_p, i) => i === gi)
  assert.deepEqual([...compact.blocks.entriesForPalette(wanted)], [...data.blocks].filter(([, value]) => value === gi))
  assert.equal(compact.blocks.paletteCounts[gi], [...data.blocks.values()].filter(value => value === gi).length)
}
console.log('PASS compact pages preserve complete states, negative sizes, overlapping regions, large keys and palette-filtered queries')

const quad = { texKey: 'block/redstone_dust_dot', cullface: null, normal: [0, 1, 0],
  verts: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] }
const baked = { fullCube: false, quads: [quad] }
const palette = [0, 15].map(power => ({ name: 'minecraft:redstone_wire', properties: { power: String(power) }, baked }))
const bounds = { minX: 0, minY: 0, minZ: 0, width: 5, height: 1, depth: 1 }
const cells = new Map([[0, 0], [2, 1], [4, 0]])
const full = await buildFaceGroups(palette, cells, bounds)
assert.deepEqual([...full.groups.keys()], ['block/redstone_dust_dot|p0', 'block/redstone_dust_dot|p15'])
assert.equal(full.groups.get('block/redstone_dust_dot|p0').positions.length, 24)
assert.deepEqual([...full.groups.get('block/redstone_dust_dot|p15').positions], quad.verts.flatMap(v => [v[0] + 2, v[1], v[2]]))
const sliced = await buildFaceGroups(palette, cells, bounds, null, x => x === 2)
assert.deepEqual([...sliced.groups.keys()], ['block/redstone_dust_dot|p15'])
assert.deepEqual(await buildFaceGroups(palette, cells, bounds), full, 'Rebuilding must not retain filtered group references')
assert.equal(Object.hasOwn(quad, 'group'), false, 'Shared baked quads remain reusable')

for (const count of [1, 16383, 16384, 16385]) {
  const blocks = new Map(Array.from({ length: count }, (_, i) => [i, 0]))
  const { groups } = await buildFaceGroups(palette, blocks, { ...bounds, width: count })
  const g = groups.values().next().value
  assert.equal(g.indices.BYTES_PER_ELEMENT, count < 16384 ? 2 : 4)
  assert.equal(g.positions.length, count * 12)
  for (let face = 0; face < count; face++) {
    assert.deepEqual([...g.indices.subarray(face * 6, face * 6 + 6)], [0, 1, 2, 2, 1, 3].map(n => face * 4 + n))
  }
}
console.log('PASS redstone tint groups, repeated slice builds and 16/32-bit index boundaries')
