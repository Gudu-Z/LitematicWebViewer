// Parsing/geometry invariants for load-time optimizations; no downloaded assets needed.
import assert from 'node:assert/strict'
import { gzipSync, deflateSync } from 'node:zlib'
import { parseNBT } from '../src/nbt.js'
import { parseLitematica, parseLitematicaRaw } from '../src/litematica.js'
import { buildFaceGroups } from '../src/geometry.js'

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
