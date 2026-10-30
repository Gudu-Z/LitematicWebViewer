import assert from 'node:assert/strict'
import { CullMaskCache } from '../src/cullMaskCache.js'

function check(sequence, budget, label) {
  const cache = new CullMaskCache(budget)
  for (const mask of sequence) {
    cache.append(mask)
    assert.ok(cache.bytes + (cache.raw?.byteLength || 0) <= cache.maxBytes, label + ': live buffers stay within budget')
    assert.ok(cache.peakBytes <= cache.maxBytes, label + ': compression scratch stays within budget')
  }
  cache.finish()
  const length = cache.length, formats = new Set(cache.pages.map(page => page.rle ? 'rle' : 'raw'))
  assert.ok(length <= sequence.length)
  for (let i = 0; i < length; i++) assert.equal(cache.read(), sequence[i], label + ': same mask at ' + i)
  for (let i = 0; i < 3; i++) assert.equal(cache.read(), undefined, label + ': no fabricated suffix')
  cache.append(31); cache.finish(); assert.equal(cache.read(), undefined, label + ': finished cache stays closed')
  cache.dispose(); cache.dispose()
  assert.equal(cache.pages.length, 0); assert.equal(cache.bytes, 0); assert.equal(cache.raw, null); assert.equal(cache.read(), undefined)
  return { length, formats }
}

for (const invalid of [-1, 1.5, Infinity, NaN, 64 * 1024 * 1024 + 1, '64']) assert.throws(() => new CullMaskCache(invalid), RangeError)
for (const budget of [0, 1, 2, 3, 4, 7, 63, 64, 127, 4096, 65536, 65540, 128 * 1024, undefined]) {
  check([], budget, 'empty/' + budget)
  check(Uint8Array.from({ length: 259 }, (_, i) => i & 63), budget, 'alternating/' + budget)
  check(new Uint8Array(259).fill(63), budget, 'solid/' + budget)
}
const sequence = new Uint8Array(65536 * 5 + 37)
sequence.fill(63, 0, 65536)
for (let i = 65536; i < 2 * 65536; i++) sequence[i] = i & 63
sequence.fill(0, 2 * 65536, 3 * 65536)
for (let i = 3 * 65536; i < 4 * 65536; i++) sequence[i] = (i >>> 4) & 63
sequence.fill(21, 4 * 65536)
const mixed = check(sequence, 512 * 1024, 'mixed pages')
assert.equal(mixed.length, sequence.length); assert.deepEqual(mixed.formats, new Set(['rle', 'raw']))
const prefix = check(sequence, 65540, 'compressed prefix then raw capacity cutoff')
assert.ok(prefix.length > 65536 && prefix.length < sequence.length)
const allRaw = check(sequence.subarray(65536, 2 * 65536), 64, 'exact raw prefix')
assert.equal(allRaw.length, 64)
const repeated = check(new Uint8Array(65536 * 8 + 3).fill(63), 128 * 1024, 'reused scratch')
assert.equal(repeated.length, 65536 * 8 + 3); assert.deepEqual(repeated.formats, new Set(['rle', 'raw']), 'Three final masks are smaller as raw data than one four-byte run')
const partial = new CullMaskCache(65540)
partial.append(2); partial.dispose(); partial.append(3)
assert.equal(partial.read(), undefined); assert.equal(partial.bytes, 0)
const pageLimited = new CullMaskCache(256 * 1024, { maxPages: 2 })
for (let i = 0; i < 65536 * 3; i++) pageLimited.append((i >>> 16) + 1)
pageLimited.finish(); assert.equal(pageLimited.pages.length, 2); assert.equal(pageLimited.length, 65536 * 2)
for (let i = 0; i < 65536 * 2; i++) assert.equal(pageLimited.read(), (i >>> 16) + 1)
assert.equal(pageLimited.read(), undefined); pageLimited.dispose()
for (const maxPages of [0, -1, 1.1, 65537, Infinity]) assert.throws(() => new CullMaskCache(1024, { maxPages }), RangeError)
console.log('PASS bounded adaptive cull masks: raw/RLE cross-page reads, exact prefixes, transient budgets, scratch reuse, empty/disabled and disposal')
