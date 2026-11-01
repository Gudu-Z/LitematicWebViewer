import assert from 'node:assert/strict'
import { BLOCK_PAGE_SIZE, BlockStatePageWriter, createBlockPageBudget, encodeBlockPage } from '../src/pagedBlocks.js'

// Independent format oracle: collect runs from values and pack their palette
// IDs using BigInt, rather than the writer's reusable indices/32-bit shifts.
function pageOracle(values) {
  const palette = [...new Set(values)]
  if (palette.length === 1) return palette[0]
  const ids = new Map(palette.map((value, i) => [value, i]))
  const bits = Math.ceil(Math.log2(palette.length)), wordCount = Math.ceil(values.length * bits / 32)
  const page = { palette: Uint32Array.from(palette), length: values.length, count: values.filter(Boolean).length, bits }
  const runs = []
  for (let end = 1; end <= values.length; end++) if (end === values.length || values[end] !== values[end - 1]) runs.push(end, ids.get(values[end - 1]))
  if (runs.length / 2 < wordCount) page.runs = Uint16Array.from(runs)
  else {
    const words = Array(wordCount).fill(0n)
    for (let i = 0; i < values.length; i++) {
      const position = i * bits, index = Math.floor(position / 32), shift = position % 32
      const value = BigInt(ids.get(values[i])) << BigInt(shift)
      words[index] |= value & 0xffffffffn
      if (index + 1 < words.length) words[index + 1] |= value >> 32n
    }
    page.words = Uint32Array.from(words, Number)
  }
  return page
}
function packSource(values, bits, extraLongs = 0) {
  const count = Math.ceil(values.length * bits / 64), words = Array(count + extraLongs).fill(0n)
  for (let i = 0; i < values.length; i++) {
    const position = i * bits, index = Math.floor(position / 64), shift = position % 64
    const value = BigInt(values[i]) << BigInt(shift)
    words[index] |= BigInt.asUintN(64, value)
    if (index + 1 < words.length) words[index + 1] |= value >> 64n
  }
  // Padding is deliberately nonzero: the decoder must stop at region volume.
  const remaining = values.length * bits % 64
  if (remaining) words[count - 1] |= BigInt.asUintN(64, -1n << BigInt(remaining))
  for (let i = count; i < words.length; i++) words[i] = 0xffffffffffffffffn
  const bytes = Buffer.alloc(words.length * 8)
  words.forEach((word, i) => bytes.writeBigUInt64BE(word, i * 8))
  return bytes
}
const omitted = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])
function statesOracle(palette, values) {
  const counts = new Float64Array(palette.length)
  const stored = Array.from(values, source => {
    const value = source < palette.length ? source : 0
    const name = palette[value].Name.replace(/^minecraft:/, '')
    if (omitted.has(name)) return 0
    counts[value]++; return value + 1
  })
  const pages = []
  for (let i = 0; i < stored.length; i += BLOCK_PAGE_SIZE) pages.push(pageOracle(stored.slice(i, i + BLOCK_PAGE_SIZE)))
  return { isPagedBlockStates: true, pages, volume: values.length, count: counts.reduce((sum, count) => sum + count, 0), counts,
    bytes: pages.reduce((sum, page) => sum + (typeof page === 'number' ? 8 : 32 + page.palette.byteLength + (page.runs || page.words).byteLength), 0) }
}
function readChunks(palette, values, bits, chunks, extraLongs = 0) {
  const source = packSource(values, bits, extraLongs), budget = createBlockPageBudget()
  const writer = new BlockStatePageWriter(palette, values.length, source.length / 8, budget)
  // Isolate all 2..32-bit word/carry cases without allocating a >2^31-entry
  // palette for 32 bits. The normal constructor-derived widths are tested too.
  writer.bits = bits; writer.mask = bits === 32 ? 0xffffffff : (1 << bits) - 1
  const sizes = chunks || [source.length], reused = Buffer.alloc(Math.max(...sizes)), snapshots = []
  let position = 0, part = 0
  while (position < source.length) {
    const length = Math.min(sizes[part++ % sizes.length], source.length - position)
    source.copy(reused, 0, position, position + length)
    writer.push(reused.subarray(0, length)); reused.fill(0xcc); position += length
    for (let i = snapshots.length; i < writer.result.pages.length; i++) snapshots.push(structuredClone(writer.result.pages[i]))
  }
  const result = writer.finish()
  assert.deepEqual(result, statesOracle(palette, values), `bits=${bits}, chunks=${sizes}`)
  assert.equal(result.bytes, budget.bytes)
  assert.deepEqual(result.pages.slice(0, snapshots.length), snapshots, 'Later pages and input reuse cannot mutate emitted pages')
  for (const page of result.pages) if (typeof page !== 'number') {
    assert.notEqual(page.palette.buffer, writer.indices.buffer)
    assert.notEqual((page.words || page.runs).buffer, writer.indices.buffer)
  }
  assert.equal(writer.finish(), result, 'Finishing twice does not emit a stale scratch page')
  return result
}

const names = ['minecraft:air', 'minecraft:stone', 'barrier', 'minecraft:glass', 'light', 'minecraft:cave_air', 'void_air', 'minecraft:structure_void']
for (let bits = 2; bits <= 32; bits++) {
  const length = bits <= 12 ? 2 ** (bits - 1) + 1 : 9
  for (const firstName of ['minecraft:air', 'minecraft:stone']) {
    const palette = Array.from({ length }, (_, i) => ({ Name: i ? names[i % names.length] : firstName }))
    const choices = [0, 1, 2, length - 1, 2 ** bits - 1, 2 ** (bits - 1)]
    const values = Uint32Array.from({ length: BLOCK_PAGE_SIZE * 2 + 29 }, (_, i) =>
      i % 193 === 0 ? choices[(i >>> 3) % choices.length] : i % 47 < 40 ? 0 : choices[i % choices.length])
    readChunks(palette, values, bits, null, 2)
    readChunks(palette, values, bits, [0, 1, 7, 3, 31, 4095, 9])
    if ([2, 3, 17, 31, 32].includes(bits)) readChunks(palette, values, bits, [1])
    // Entire zero words are also valid visible blocks when palette[0] is solid.
    readChunks(palette, new Uint32Array(BLOCK_PAGE_SIZE + 3), bits, [7, 1, 8, 11])
  }
}
console.log('PASS page writer: 2–32-bit carry, zero words, visible/omitted palette zero, invalid indices, padding, arbitrary reused chunks and exact page bytes')

for (const values of [new Uint32Array(BLOCK_PAGE_SIZE), new Uint32Array(BLOCK_PAGE_SIZE).fill(70000),
  Uint32Array.from({ length: 64 }, (_, i) => i < 32 ? 5 : 2),
  Uint32Array.from({ length: 65 }, (_, i) => i < 32 ? 5 : 2),
  Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, i) => i < 2048 ? 0 : i < 4000 ? 70000 : 3),
  Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, i) => i % 17),
  Uint32Array.from({ length: BLOCK_PAGE_SIZE }, (_, i) => 90000 - i)]) {
  assert.deepEqual(encodeBlockPage(values), pageOracle([...values]))
  assert.deepEqual(encodeBlockPage(values, 1), pageOracle([values[0]]))
}
assert.ok(encodeBlockPage(Uint32Array.from({ length: 64 }, (_, i) => i < 32 ? 5 : 2)).words, 'RLE/words ties retain packed words')
assert.ok(encodeBlockPage(Uint32Array.from({ length: 65 }, (_, i) => i < 32 ? 5 : 2)).runs)

const palette = [{ Name: 'minecraft:stone' }, { Name: 'minecraft:air' }]
const source = packSource(new Uint32Array(BLOCK_PAGE_SIZE + 1), 2)
for (const bytes of [source.subarray(0, source.length - 1), Buffer.concat([source, Buffer.alloc(1)]), Buffer.concat([source, Buffer.alloc(8)])]) {
  const writer = new BlockStatePageWriter(palette, BLOCK_PAGE_SIZE + 1, source.length / 8)
  writer.push(bytes); assert.throws(() => writer.finish(), /Truncated/)
}
const budget = createBlockPageBudget(8), writer = new BlockStatePageWriter(palette, BLOCK_PAGE_SIZE + 1, source.length / 8, budget)
writer.push(source)
assert.deepEqual(writer.result.pages, [1])
assert.throws(() => writer.finish(), { code: 'FILE_TOO_LARGE', reason: 'blocks' })
assert.deepEqual(writer.result.pages, [1], 'Over-budget page must not replace a completed page')
assert.deepEqual(new BlockStatePageWriter([], 0, 0).finish().pages, [])
console.log('PASS exact first-occurrence palettes, RLE/packed selection including ties, scratch ownership, partial pages, truncation and budget failures')
