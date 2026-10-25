// Real zlib fixtures exercise browser-compatible gzip members and bounded output.
import assert from 'node:assert/strict'
import { gzipSync, deflateSync } from 'node:zlib'
import { decompressNBT, parseNBT } from '../src/nbt.js'

const payload = Buffer.from([10, 0, 0, 8, 0, 4, 110, 97, 109, 101, 0, 3, 111, 110, 101, 0])
const single = gzipSync(payload)
const members = Buffer.concat([gzipSync(payload.subarray(0, 7)), gzipSync(Buffer.alloc(0)), gzipSync(payload.subarray(7))])
for (const input of [payload, single, deflateSync(payload)]) {
  assert.deepEqual(parseNBT(await decompressNBT(input)), { name: 'one' })
  await assert.rejects(decompressNBT(input, { maxBytes: payload.length - 1 }), { code: 'FILE_TOO_LARGE', reason: 'decompressed' })
  assert.deepEqual(Buffer.from(await decompressNBT(input, { maxBytes: payload.length })), payload)
}
for (const maxBytes of [-1, 1.5, Infinity, 512 * 1024 * 1024 + 1]) {
  await assert.rejects(decompressNBT(single, { maxBytes }), RangeError)
}
console.log('PASS native gzip/zlib/raw decoding and exact output limits')

// Node versions differ from browsers on concatenated gzip, so explicitly force
// native failure. The separate Chrome check uses the real DecompressionStream.
const NativeDecompressionStream = globalThis.DecompressionStream
let calls = 0
try {
  globalThis.DecompressionStream = class {
    constructor(format) {
      calls++
      if (format !== 'gzip') return new NativeDecompressionStream(format)
      return new TransformStream({ transform() { throw new TypeError('Browser rejects concatenated gzip') } })
    }
  }
  const offsetView = Buffer.concat([Buffer.alloc(3), members, Buffer.alloc(8)]).subarray(3, 3 + members.length)
  for (const bytes of [single, members, offsetView]) {
    assert.deepEqual(parseNBT(await decompressNBT(bytes)), { name: 'one' })
    assert.deepEqual(Buffer.from(await decompressNBT(bytes, { maxBytes: payload.length })), payload)
    await assert.rejects(decompressNBT(bytes, { maxBytes: payload.length - 1 }), { code: 'FILE_TOO_LARGE' })
  }
  assert.equal((await decompressNBT(gzipSync(Buffer.alloc(0)), { maxBytes: 0 })).length, 0)

  // Optional gzip fields, including a valid FHCRC, must survive fallback too.
  const header = Buffer.concat([single.subarray(0, 10), Buffer.from([3, 0, 7, 8, 9]), Buffer.from('fixture.litematic\0header test\0')])
  header[3] = 2 | 4 | 8 | 16
  let crc = -1
  for (const byte of header) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const hcrc = Buffer.alloc(2); hcrc.writeUInt16LE((crc ^ -1) & 0xffff)
  const customHeader = Buffer.concat([header, hcrc, single.subarray(10)])
  assert.deepEqual(Buffer.from(await decompressNBT(Buffer.concat([customHeader, gzipSync(Buffer.alloc(0))]))), payload)

  // Both members' CRC/ISIZE are checked, and neither junk nor a truncated final
  // member can turn a partial NBT result into a successful load.
  const corruptCRC = Buffer.from(single); corruptCRC[corruptCRC.length - 8] ^= 1
  const corruptSize = Buffer.from(single); corruptSize[corruptSize.length - 4] ^= 1
  const corruptHeader = Buffer.from(single); corruptHeader[3] = 0xe0
  const badHeaderCRC = Buffer.from(customHeader); badHeaderCRC[4] ^= 1
  for (const bad of [corruptCRC, corruptSize, corruptHeader, badHeaderCRC, single.subarray(0, 7), single.subarray(0, -1), single.subarray(0, -8)]) {
    await assert.rejects(decompressNBT(bad), /Invalid gzip/)
    await assert.rejects(decompressNBT(Buffer.concat([single, bad])), /Invalid gzip/)
  }
  for (const tail of [Buffer.from([0]), Buffer.from('junk'), Buffer.from([31, 139]), deflateSync(payload)]) {
    await assert.rejects(decompressNBT(Buffer.concat([single, tail])), /Invalid gzip/)
  }
  assert.equal(calls > 0, true)
  console.log('PASS concatenated gzip, empty members, byte offsets, optional headers, checksums, truncation and trailing data')

  // Similar to the reported file: a tiny compressed input with huge repetitive
  // contents. Validation must stop at the cumulative budget, without allocating
  // the decompressed result or using the final member's ISIZE as its total size.
  const bomb = Buffer.concat([gzipSync(Buffer.alloc(96 * 1024, 1)), gzipSync(Buffer.alloc(4 * 1024 * 1024, 1))])
  const OriginalUint8Array = globalThis.Uint8Array
  let biggest = 0
  try {
    globalThis.Uint8Array = new Proxy(OriginalUint8Array, { construct(target, args, newTarget) {
      if (typeof args[0] === 'number') biggest = Math.max(biggest, args[0])
      return Reflect.construct(target, args, newTarget)
    } })
    await assert.rejects(decompressNBT(bomb, { maxBytes: 128 * 1024 }), { code: 'FILE_TOO_LARGE', reason: 'decompressed' })
  } finally { globalThis.Uint8Array = OriginalUint8Array }
  assert.ok(biggest <= 64 * 1024, 'Over-budget gzip must use only bounded scratch buffers')

  // Enough members to require yielding; an input/render task must run before
  // fallback finishes, while the output remains byte-for-byte intact.
  const chunk = Buffer.alloc(64 * 1024, 37)
  const many = Buffer.concat(Array.from({ length: 64 }, () => gzipSync(chunk)))
  let ticked = false
  const timer = setTimeout(() => { ticked = true }, 0)
  const decoded = await decompressNBT(many)
  clearTimeout(timer)
  assert.equal(ticked, true, 'Long fallback keeps the page responsive')
  assert.equal(decoded.length, chunk.length * 64)
  assert.equal(decoded.every(value => value === 37), true)
  console.log('PASS cumulative expansion limit, bounded preflight memory and responsive member decoding')
} finally {
  globalThis.DecompressionStream = NativeDecompressionStream
}
