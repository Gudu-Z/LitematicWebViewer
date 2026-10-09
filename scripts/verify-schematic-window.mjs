import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync, deflateSync } from 'node:zlib'
import { inspectLitematica, readLitematicaWindow, decodePackedSpan, validateWindow, MAX_WINDOW_VOLUME } from '../src/litematicaWindow.js'
import { parseLitematica } from '../src/litematica.js'
import { readNBTStream, NBTStreamReader } from '../src/nbtStream.js'
import { buildFaceGroups } from '../src/geometry.js'

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
  return b
}
const states = (d, clip) => [...d.blocks].flatMap(([k, i]) => {
  const x = d.bounds.minX + k % d.bounds.width, y = d.bounds.minY + Math.floor(k / (d.bounds.width * d.bounds.depth)), z = d.bounds.minZ + Math.floor(k / d.bounds.width) % d.bounds.depth
  if (clip && (x < clip.minX || x > clip.maxX || y < clip.minY || y > clip.maxY || z < clip.minZ || z > clip.maxZ)) return []
  return [[`${x},${y},${z}`, d.palette[i].key]]
}).sort(([a], [b]) => a.localeCompare(b))
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

for (let bits = 2; bits <= 16; bits++) {
  const values = Array.from({ length: 257 }, (_, i) => (i * 73 + 19) % (1 << bits)), packed = longArray(values, bits)
  for (const offset of [0, 1, 5, 21, 63, 129, 240]) assert.deepEqual([...decodePackedSpan(packed, bits, offset * bits, 17)], values.slice(offset, offset + 17))
}
console.log('PASS all bit widths, 32/64-bit crossings and packed endianness')

function fixture({ negative = false, overlap = false, width = 13, invalidIndex = false } = {}) {
  const values = Array.from({ length: width * 5 * 7 }, (_, i) => i % 5)
  if (invalidIndex) values[0] = 7
  const names = ['air', 'stone', 'water', 'oak_stairs', 'glass']
  const pos = negative ? [-11, 25, -7] : [-23, 21, -13], size = [width, 5, 7].map(v => negative ? -v : v)
  const minimum = pos.map((p, i) => Math.min(p, p + size[i] + 1))
  const entity = (x, y, z) => compound(tag(8, 'id', str('minecraft:pig')), tag(9, 'Pos', list(6, [x, y, z].map(double))))
  const region = compound(
    // Deliberately put packed data and entity lists before Size/Position/Palette.
    tag(12, 'BlockStates', Buffer.concat([int(Math.ceil(values.length * 3 / 64)), longArray(values, 3)])),
    tag(9, 'Entities', list(10, [entity(...minimum.map((v, i) => v - pos[i] + (i === 0 && width === 1 ? .123456789123 : 1.123456789123))), entity(999, 999, 999)])),
    tag(9, 'TileEntities', list(10, [compound(tag(8, 'id', str('minecraft:sign')), ...['x', 'y', 'z'].map(a => tag(3, a, int(a === 'x' && width === 1 ? 0 : 1))))])),
    tag(10, 'Size', vec(size)), tag(10, 'Position', vec(pos)),
    tag(9, 'BlockStatePalette', list(10, names.map(name => compound(tag(8, 'Name', str('minecraft:' + name)))))),
  )
  const second = compound(tag(10, 'Size', vec([1, 1, 1])), tag(10, 'Position', vec(minimum)),
    tag(9, 'BlockStatePalette', list(10, [compound(tag(8, 'Name', str('minecraft:gold_block')))])),
    tag(12, 'BlockStates', Buffer.concat([int(1), Buffer.alloc(8)])))
  return tag(10, '', compound(tag(10, 'Regions', compound(tag(10, '__proto__', region), ...(overlap ? [tag(10, 'second', second)] : []))),
    tag(10, 'Metadata', compound(tag(3, 'TotalBlocks', int(values.filter(Boolean).length)))), tag(3, 'Version', int(7))))
}
// The legacy parser uses a plain object and cannot preserve a region named __proto__;
// our independent expected coordinates cover that case. Other fixtures compare it too.
for (const negative of [false, true]) for (const width of [1, 3, 13]) for (const compress of [x => x, gzipSync, deflateSync]) {
  const raw = fixture({ negative, width, overlap: true }), file = new Blob([compress(raw)])
  const info = await inspectLitematica(file), all = await readLitematicaWindow(file, info)
  assert.equal(info.regions.length, 2)
  assert.equal(all.entities.length, 2, 'unclipped import retains entities outside region bounds')
  const b = info.bounds, selection = { minX: b.minX, maxX: Math.min(b.maxX, b.minX + 2), minY: b.minY, maxY: b.minY + 2, minZ: b.minZ, maxZ: b.minZ + 3 }
  const cropped = await readLitematicaWindow(file, info, selection)
  assert.deepEqual(states(cropped), states(all, selection))
  assert.equal(cropped.entities.length, 1)
  assert.equal(cropped.tileEntities.length, 1)
  assert.deepEqual(cropped.tileEntities[0].nbt, all.tileEntities[0].nbt)
  assert.equal(cropped.blocks.get(0), cropped.palette.findIndex(p => p.name === 'minecraft:gold_block'))
  assert.deepEqual(cropped.entities[0].pos, [b.minX + (width === 1 ? .123456789123 : 1.123456789123), b.minY + 1.123456789123, b.minZ + 1.123456789123])
}
console.log('PASS reordered fields, negative sizes, overlapping regions, thin rows, entity coordinates and gzip/zlib/raw inputs')

// A wide row is decoded in bounded spans, including a non-word-aligned crop start.
const wideValues = Array.from({ length: 70003 }, (_, i) => i % 3)
const wideRegion = compound(tag(10, 'Size', vec([70003, 1, 1])), tag(10, 'Position', vec([0, 0, 0])),
  tag(9, 'BlockStatePalette', list(10, ['air', 'stone', 'glass'].map(id => compound(tag(8, 'Name', str('minecraft:' + id)))))),
  tag(12, 'BlockStates', Buffer.concat([int(Math.ceil(wideValues.length * 2 / 64)), longArray(wideValues, 2)])))
const wideFile = new Blob([gzipSync(tag(10, '', compound(tag(10, 'Regions', compound(tag(10, 'wide', wideRegion))))))])
const wideInfo = await inspectLitematica(wideFile)
const wideData = await readLitematicaWindow(wideFile, wideInfo, { ...wideInfo.bounds, minX: 1 })
for (let x = 1; x < wideValues.length; x++) {
  const gi = wideData.blocks.get(x - 1)
  assert.equal(gi === undefined ? 'air' : wideData.palette[gi].name.slice(10), ['air', 'stone', 'glass'][wideValues[x]])
}
console.log('PASS wide rows split into bounded decode spans')

for (const fileName of ['samples/demo.litematic', ...readdirSync('schematics').filter(n => n.startsWith('投影预览测试')).map(n => 'schematics/' + n)]) {
  const b = readFileSync(fileName), file = new Blob([b]), info = await inspectLitematica(file)
  const actual = await readLitematicaWindow(file, info), reference = await parseLitematica(b)
  assert.deepEqual(states(actual), states(reference), fileName)
  assert.deepEqual(plain(actual.entities), plain(reference.entities), fileName)
  assert.deepEqual(plain(actual.tileEntities), plain(reference.tileEntities), fileName)
  console.log('PASS existing schematic', fileName, actual.blocks.size)
}

const raw = fixture(), file = new Blob([gzipSync(raw)]), info = await inspectLitematica(file)
for (const invalid of [{ ...info.bounds, minX: NaN }, { ...info.bounds, minX: info.bounds.minX - 1 }, { ...info.bounds, maxY: info.bounds.minY - 1 }]) assert.throws(() => validateWindow(invalid, info.bounds), { code: 'invalidWindow' })
const huge = { minX: 0, maxX: 1023, minY: 0, maxY: 1023, minZ: 0, maxZ: 1023 }
assert.throws(() => validateWindow(huge, huge), { code: 'windowTooLarge' })
assert.equal(MAX_WINDOW_VOLUME, 128 * 128 * 64)
await assert.rejects(readLitematicaWindow(file, { ...info, requiresWindow: true }), { code: 'windowRequired' })
await assert.rejects(inspectLitematica(new Blob([gzipSync(raw).subarray(0, -7)])))
const badCRC = Buffer.from(gzipSync(raw)); badCRC[badCRC.length - 8] ^= 1
await assert.rejects(inspectLitematica(new Blob([badCRC])))
const bad = new Blob([fixture({ invalidIndex: true })]), badInfo = await inspectLitematica(bad)
await assert.rejects(readLitematicaWindow(bad, badInfo), { code: 'invalidBlockStates' })
const signal = AbortSignal.abort()
await assert.rejects(inspectLitematica(file, { signal }), { name: 'AbortError' })

// Even a chunk that splits every scalar/word must parse correctly.
let offset = 0
const reader = new NBTStreamReader(new ReadableStream({ pull(c) { if (offset === raw.length) c.close(); else c.enqueue(raw.subarray(offset, ++offset)) } }))
assert.equal(await reader.number(1), 10); await reader.string(); const slowRoot = await reader.payload(10); await reader.finish()
assert.equal(slowRoot.Version, 7)
assert.equal(Object.getPrototypeOf(slowRoot.Regions), null)
const size = 8 * 1024 * 1024, skipNBT = Buffer.concat([tag(10, '', tag(7, 'unused', Buffer.concat([int(size), Buffer.alloc(size)]))), Buffer.from([0])])
let peakRead = 0
await readNBTStream(new Blob([gzipSync(skipNBT)]), { visit: async (r, t, path) => {
  peakRead = Math.max(peakRead, r.chunk.length)
  if (path[0] === 'unused') { await r.payload(t, path, false); return {} }
} })
assert.ok(peakRead <= 128 * 1024)
await assert.rejects(buildFaceGroups([{ name: 'minecraft:stone', baked: { quads: [{ texKey: 'block/stone' }], fullCube: true } }], new Map([[0, 0]]), { width: 1, height: 1, depth: 1, minX: 0, minY: 0, minZ: 0 }, null, null, 0), { code: 'windowTooComplex' })
console.log('PASS validation, corruption, cancellation, chunk boundaries and geometry budget')

// A virtual 550 MB NBT array tests offsets past 2^32 bits without allocating it.
// The last block is stone; every earlier block is air. Each import gets a fresh stream.
const farIndex = 1_100_000_000, wordCount = Math.ceil((farIndex + 1) * 4 / 64)
const prefix = tag(10, '', tag(10, 'Regions', tag(10, 'large', tag(12, 'BlockStates', int(wordCount)))))
const suffix = Buffer.concat([compound(tag(10, 'Size', vec([farIndex + 1, 1, 1])), tag(10, 'Position', vec([0, 0, 0])),
  tag(9, 'BlockStatePalette', list(10, Array.from({ length: 9 }, (_, i) => compound(tag(8, 'Name', str(i ? 'minecraft:stone' : 'minecraft:air'))))))), Buffer.from([0, 0])])
const virtual = {
  slice: (a, b) => new Blob([prefix.subarray(a, b)]),
  stream() {
    let phase = 0, remaining = wordCount * 8
    const zero = Buffer.alloc(65536)
    return new ReadableStream({ pull(controller) {
      if (phase === 0) { controller.enqueue(prefix); phase++; return }
      if (remaining) {
        const n = Math.min(remaining, zero.length), chunk = n === remaining ? Buffer.alloc(n) : zero
        remaining -= n
        if (!remaining) chunk.writeBigUInt64BE(1n, n - 8)
        controller.enqueue(chunk); return
      }
      if (phase === 1) { controller.enqueue(suffix); phase++; return }
      controller.close()
    } })
  },
}
const virtualInfo = await inspectLitematica(virtual)
const far = await readLitematicaWindow(virtual, virtualInfo, { minX: farIndex, maxX: farIndex, minY: 0, maxY: 0, minZ: 0, maxZ: 0 })
assert.equal(far.blocks.size, 1)
assert.equal(far.palette[far.blocks.get(0)].name, 'minecraft:stone')
assert.ok(virtualInfo.decompressedBytes > 512 * 1024 * 1024)
console.log('PASS 550 MB streamed array and palette offsets beyond 2^32 bits')

if (process.argv.includes('--large')) for (const name of readdirSync('schematics').filter(n => n.startsWith('完整海盗城') || n.startsWith('Parrots'))) {
  const started = performance.now(), file = new Blob([readFileSync('schematics/' + name)])
  const info = await inspectLitematica(file), data = await readLitematicaWindow(file, info, info.suggestedWindow)
  assert.ok(info.requiresWindow); assert.ok(data.blocks.size > 0); assert.ok(data.blocks.size <= MAX_WINDOW_VOLUME)
  console.log('PASS large source', JSON.stringify({ name, bytes: info.decompressedBytes, blocks: data.blocks.size, palette: data.palette.length, entities: data.entities.length, tileEntities: data.tileEntities.length, seconds: +(performance.now() - started).toFixed(0) / 1000, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }))
}
