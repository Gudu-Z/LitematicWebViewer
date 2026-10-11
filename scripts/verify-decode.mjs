// Independent BigInt reference, without requiring a huge private schematic.
// Optional: node scripts/verify-decode.mjs <file> checks slices of every region.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNBT, decompressNBT } from '../src/nbt.js'
import { decodeBlockStates } from '../src/litematica.js'

function reference(longs, bits, total, start = 0) {
  const mask = (1n << BigInt(bits)) - 1n
  return Uint32Array.from({ length: total }, (_, j) => {
    const bit = (start + j) * bits, word = Math.floor(bit / 64), offset = bit % 64
    let value = BigInt.asUintN(64, longs[word]) >> BigInt(offset)
    if (offset + bits > 64) value |= BigInt.asUintN(64, longs[word + 1]) << BigInt(64 - offset)
    return Number(value & mask)
  })
}

const storage = new BigInt64Array(2052)
for (let i = 0; i < storage.length; i++) {
  storage[i] = BigInt.asIntN(64, BigInt(i) * 0x9e3779b97f4a7c15n ^ 0xfedcba9876543210n)
}
storage[10] = -1n; storage[11] = 0n; storage[12] = -0x8000000000000000n
const longs = storage.subarray(2, -2) // Nonzero byteOffset must be respected.
for (let bits = 2; bits <= 32; bits++) {
  for (const start of [0, 1, 7, 17, 31, 32, 63, 64, 127, 1023]) {
    const count = 1025, expected = reference(longs, bits, count, start)
    assert.deepEqual(decodeBlockStates(longs, bits, count, start), expected, 'bits=' + bits + ', start=' + start)
    const scratch = new Uint32Array(count + 11).fill(0xdeadbeef)
    assert.equal(decodeBlockStates(longs, bits, count, start, scratch), scratch)
    assert.deepEqual(scratch.subarray(0, count), expected)
    assert.ok(scratch.subarray(count).every(n => n === 0xdeadbeef), 'Leave unused scratch space intact')
  }
  const end = Math.floor(longs.length * 64 / bits) - 5
  assert.deepEqual(decodeBlockStates(longs, bits, 5, end), reference(longs, bits, 5, end))
}
assert.deepEqual(decodeBlockStates([...longs], 5, 111, 7), reference(longs, 5, 111, 7))
assert.deepEqual(decodeBlockStates(new BigInt64Array(), 2, 0), new Uint32Array())
assert.throws(() => decodeBlockStates(new BigInt64Array(1), 5, 13), RangeError, 'Reject truncated input')
assert.throws(() => decodeBlockStates(longs, 5, 3, 0, new Uint32Array(2)), RangeError)
console.log('PASS packed states: 2–32 bits, signed longs, word boundaries, offsets, reusable buffers and truncated input')

if (process.argv[2]) {
  const root = parseNBT(await decompressNBT(readFileSync(process.argv[2])))
  for (const [name, region] of Object.entries(root.Regions || root.SubRegions || {})) {
    const { x, y, z } = region.Size, total = Math.abs(x * y * z)
    const bits = Math.max(2, Math.ceil(Math.log2(region.BlockStatePalette.length)))
    for (const start of new Set([0, 1, 63, Math.floor(total / 2), Math.max(0, total - 4096)])) {
      if (start >= total) continue
      const count = Math.min(4096, total - start)
      assert.deepEqual(decodeBlockStates(region.BlockStates, bits, count, start), reference(region.BlockStates, bits, count, start), name)
    }
  }
  console.log('PASS real schematic: sampled beginning, middle and end of every region')
}
