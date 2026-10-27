import assert from 'node:assert/strict'
import { gzipSync, gunzipSync, inflateRawSync, deflateSync } from 'node:zlib'
import { parseNBT } from '../src/nbt.js'
import { NbtStreamFilter, isBookPages } from '../src/nbtStream.js'
import { readSchematicNBT } from '../src/schematicNbt.js'
import { selectRenderNbtField } from '../src/renderNbt.js'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const string = value => { const b = Buffer.from(value), h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]) }
const tag = (type, name, data) => Buffer.concat([Buffer.from([type]), string(name), data])
const compound = (...fields) => Buffer.concat([...fields, Buffer.from([0])])
const list = (type, values) => Buffer.concat([Buffer.from([type]), int(values.length), ...values])
const text = (name, value) => tag(8, name, string(value))
const pages = tag(9, 'pages', list(8, [string('PAGE_CONTENT_NEVER_DECODED'), string('x'.repeat(600))]))
const legacyBook = compound(text('id', 'minecraft:written_book'), tag(1, 'Count', Buffer.from([1])), tag(1, 'Slot', Buffer.from([4])),
  tag(10, 'tag', compound(pages, text('title', '一本书 🦜'), text('author', 'Author'))))
const modernBook = compound(text('id', 'minecraft:written_book'), tag(3, 'count', int(2)),
  tag(10, 'components', compound(tag(10, 'minecraft:written_book_content', compound(text('title', 'Modern'), pages, text('author', 'Writer'))),
    text('minecraft:custom_name', 'Still visible'), tag(3, 'minecraft:dyed_color', int(0x123456)))))
const fields = [
  ...[1, 2, 3, 4, 5, 6].map((type, i) => tag(type, 'n' + type, Buffer.alloc([1, 2, 4, 8, 4, 8][i], 1))),
  text('名字', 'UTF-8 🦜'), tag(7, 'bytes', Buffer.concat([int(4), Buffer.from([1, 31, 139, 8])])),
  tag(11, 'ints', Buffer.concat([int(2), int(-1), int(2147483647)])), tag(12, 'longs', Buffer.concat([int(1), Buffer.alloc(8, 255)])),
  tag(9, 'lists', list(9, [list(0, []), list(10, [compound(text('a', 'b'))])])),
  tag(9, 'numbers', list(3, [int(-1), int(7)])),
  // A generic field named pages is not automatically treated as a book.
  text('pages', 'ordinary field'), tag(10, 'Item', legacyBook), tag(10, 'Modern', modernBook), text('after', 'sentinel'),
]
const raw = tag(10, '', compound(...fields))
const expected = parseNBT(raw, (path, name) => !isBookPages(path, name))
const nativeDecode = TextDecoder.prototype.decode
try {
  TextDecoder.prototype.decode = function(...args) {
    const text = nativeDecode.apply(this, args)
    assert.ok(!text.includes('PAGE_CONTENT_NEVER_DECODED'), 'Skipped page values are never decoded')
    return text
  }
  for (const size of [1, 2, 3, 7, 64, 257, raw.length]) {
    const filter = new NbtStreamFilter()
    const scratch = new Uint8Array(size)
    for (let pos = 0; pos < raw.length; pos += size) {
      const input = raw.subarray(pos, pos + size); scratch.set(input)
      filter.push(scratch.subarray(0, input.length)); scratch.fill(0)
    }
    const result = filter.finish()
    assert.deepEqual(parseNBT(result.bytes), expected, 'Reusable output buffers and every field boundary preserve NBT')
    assert.equal(result.stats.readBytes, raw.length)
    assert.equal(result.stats.bookPageFields, 2)
    filter.abort()
  }
} finally { TextDecoder.prototype.decode = nativeDecode }
console.log('PASS all NBT tag types, split headers/Unicode, reused buffers and legacy/component book filtering')

const regionRaw = tag(10, '', compound(tag(10, 'Regions', compound(tag(10, 'R', compound(
  tag(9, 'TileEntities', list(10, [compound(text('id', 'minecraft:barrel'), tag(9, 'Items', list(10, [legacyBook, modernBook])))])),
  tag(9, 'Entities', list(10, [compound(text('id', 'minecraft:armor_stand'), tag(10, 'Item', modernBook), tag(10, 'Brain', compound(pages)))])),
  tag(9, 'PendingBlockTicks', list(0, [])),
))))))
for (const renderOnly of [false, true]) {
  const expectedRegion = parseNBT(regionRaw, (path, name) => !isBookPages(path, name) && (!renderOnly || selectRenderNbtField(path, name)))
  const baseline = await readSchematicNBT(regionRaw, { renderOnly, streamThreshold: 0 })
  for (const input of [regionRaw, gzipSync(regionRaw), deflateSync(regionRaw), Buffer.concat([gzipSync(regionRaw.subarray(0, 13)), gzipSync(regionRaw.subarray(13))])]) {
    for (const streamThreshold of [undefined, 0, 100]) {
      const result = await readSchematicNBT(input, { renderOnly, streamThreshold })
      assert.deepEqual(result.root, expectedRegion)
      assert.deepEqual(result, baseline, 'Fast, adaptive and streaming paths preserve identical data and omission statistics')
    }
  }
}
console.log('PASS full inventory and equipped item metadata; cards retain visual fields and omit inspection data')

// Model browser-only single-member behavior on Node. Header-like bytes inside a
// stored DEFLATE block must trigger exact fallback, not an incorrect split.
const Native = globalThis.DecompressionStream
try {
  globalThis.DecompressionStream = class {
    constructor(format) {
      if (format !== 'gzip') return new Native(format)
      const chunks = []
      return new TransformStream({ transform(chunk) { chunks.push(chunk) }, flush(controller) {
        const bytes = Buffer.concat(chunks), first = inflateRawSync(bytes.subarray(10), { info: true })
        const end = first.engine.bytesWritten + 18
        if (end !== bytes.length) { controller.enqueue(first.buffer.subarray(0, 3)); throw new TypeError('Extra member') }
        controller.enqueue(gunzipSync(bytes))
      } })
    }
  }
  const ordinary = Buffer.concat([gzipSync(raw.subarray(0, 9)), gzipSync(raw.subarray(9))])
  const ambiguous = Buffer.concat([gzipSync(raw, { level: 0 }), gzipSync(Buffer.alloc(0))])
  for (const streamThreshold of [undefined, 0, 100]) for (const input of [ordinary, ambiguous]) assert.deepEqual((await readSchematicNBT(input, { streamThreshold })).root, expected)
  const wrongCRC = Buffer.from(ordinary); wrongCRC[wrongCRC.length - 8] ^= 1
  for (const bad of [wrongCRC, ordinary.subarray(0, -1), Buffer.concat([ordinary, Buffer.from([0])])]) {
    await assert.rejects(readSchematicNBT(bad))
  }
} finally { globalThis.DecompressionStream = Native }
console.log('PASS checked native member boundaries, ambiguous gzip signatures, clean retries and integrity checks')

const hugePages = tag(10, '', compound(tag(10, 'Item', compound(tag(10, 'tag', compound(
  tag(9, 'pages', list(8, Array.from({ length: 40 }, () => string('1'.repeat(32764))))), text('title', 'kept'),
))))))
for (const streamThreshold of [undefined, 0, 100]) {
  const filtered = await readSchematicNBT(gzipSync(hugePages), { maxBytes: 1024, streamThreshold })
  assert.equal(filtered.root.Item.tag.title, 'kept')
  assert.ok(filtered.stats.readBytes > 1024 * 1024 && filtered.stats.retainedBytes < 100)
  assert.deepEqual(await readSchematicNBT(hugePages, { maxBytes: filtered.stats.retainedBytes, streamThreshold }), filtered)
  await assert.rejects(readSchematicNBT(hugePages, { maxBytes: filtered.stats.retainedBytes - 1, streamThreshold }), { code: 'FILE_TOO_LARGE', reason: 'retained' })
  await assert.rejects(readSchematicNBT(gzipSync(hugePages), { maxExpandedBytes: 128 * 1024, streamThreshold }), { code: 'FILE_TOO_LARGE', reason: 'scan' })
  await assert.rejects(readSchematicNBT(gzipSync(raw), { maxBytes: 10, streamThreshold }), { code: 'FILE_TOO_LARGE', reason: 'retained' })
  await assert.rejects(readSchematicNBT(hugePages.subarray(0, -15), { streamThreshold }), RangeError)
  const invalidList = tag(10, '', compound(tag(9, 'list', Buffer.concat([Buffer.from([8]), int(-1)]))))
  await assert.rejects(readSchematicNBT(invalidList, { streamThreshold }), /Invalid NBT list/)
  const nested = count => count ? tag(10, 'nested', compound(nested(count - 1))) : text('leaf', 'x')
  await assert.rejects(readSchematicNBT(tag(10, '', compound(nested(260))), { streamThreshold }), { code: 'FILE_TOO_LARGE', reason: 'complexity' })
  const emptyObjects = tag(10, '', compound(tag(9, 'list', Buffer.concat([Buffer.from([10]), int(2_000_001)]))))
  await assert.rejects(readSchematicNBT(emptyObjects, { streamThreshold }), { code: 'FILE_TOO_LARGE', reason: 'complexity' })
}
console.log('PASS retained-data, scan and structural budgets; huge skipped pages and malformed/truncated NBT')
