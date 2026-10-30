import assert from 'node:assert/strict'
import { GeometryReceiver } from '../src/geometryReceiver.js'

const bounds = { minX: -4, minY: -8, minZ: 2, width: 16, height: 16, depth: 16 }
const fields = [
  { name: 'positions', type: 'Float32Array', length: 24, stride: 12 },
  { name: 'uvs', type: 'Float32Array', length: 16, stride: 8 },
  { name: 'indices', type: 'Uint16Array', length: 12, stride: 6 },
  { name: 'blockKeys', type: 'Uint32Array', length: 2, stride: 1 },
]
const layout = { version: 1, bounds, emitted: 2, geometryBytes: 192,
  groups: [{ groupIndex: 0, key: 'block/water_still', kind: 'quads', count: 2, buffers: fields }] }
const batch = start => ({ parts: [{ groupIndex: 0, start, count: 1, buffers: Object.fromEntries(fields.map(field =>
  [field.name, new globalThis[field.type](field.stride).fill(start + 1)])) }] })
const tail = { streamed: true, version: 1, emitted: 2, geometryBytes: 192, batchCount: 2,
  tails: [{ groupIndex: 0, metadata: { v: 8, f: 12 } }] }

const ranges = [], receiver = new GeometryReceiver({ onRange: async (array, offset, count, spec, name) => {
  ranges.push({ array, offset, count, spec, name })
} })
await receiver.acceptLayout(structuredClone(layout))
const first = batch(0), second = batch(1)
await receiver.acceptBatch(first)
await receiver.acceptBatch(second)
// Simulate the worker reclaiming and overwriting every borrowed slab.
for (const packet of [first, second]) for (const array of Object.values(packet.parts[0].buffers)) array.fill(99)
const result = receiver.finish(tail), group = result.groups.get('block/water_still')
assert.equal(result.emitted, 2)
assert.equal(receiver.receivedBytes, 192)
for (const field of fields) {
  assert.deepEqual([...group[field.name]], [...Array(field.stride).fill(1), ...Array(field.stride).fill(2)])
  assert.ok(ranges.filter(range => range.name === field.name).every(range => range.array === group[field.name]))
}
await assert.rejects(receiver.acceptBatch(batch(2)), /Invalid streamed/)
assert.throws(() => receiver.finish(tail), /Invalid streamed/)

for (const mutate of [
  value => { value.groups[0].buffers[0].length++ },
  value => { value.groups[0].buffers[2].type = 'Uint32Array' },
  value => { value.groups[0].buffers[3].name = 'positions' },
  value => { value.groups[0].groupIndex = 1 },
  value => { value.emitted = 3 },
  value => { value.geometryBytes = 191 },
]) {
  const value = structuredClone(layout); mutate(value)
  await assert.rejects(new GeometryReceiver().acceptLayout(value))
}
await assert.rejects(new GeometryReceiver({ maxGeometryBytes: 191 }).acceptLayout(layout), error => error.code === 'FILE_TOO_LARGE')

for (const mutate of [
  value => { value.parts[0].start = 1 },
  value => { value.parts[0].count = 3 },
  value => { value.parts[0].groupIndex = 2 },
  value => { value.parts[0].buffers.indices = new Uint32Array(6) },
]) {
  const fresh = new GeometryReceiver(); await fresh.acceptLayout(layout)
  const value = batch(0); mutate(value)
  await assert.rejects(fresh.acceptBatch(value), /Invalid streamed/)
}
const incomplete = new GeometryReceiver(); await incomplete.acceptLayout(layout)
await incomplete.acceptBatch(batch(0))
assert.throws(() => incomplete.finish(tail), /Invalid streamed/)
await assert.rejects(incomplete.acceptBatch(batch(0)), /Invalid streamed/)

const abort = new AbortController()
let calls = 0
const cancelled = new GeometryReceiver({ signal: abort.signal, onRange: async () => { calls++; abort.abort() } })
await cancelled.acceptLayout(layout)
await assert.rejects(cancelled.acceptBatch(batch(0)), error => error.name === 'AbortError')
assert.equal(calls, 1, 'Cancellation stops copying/uploading the rest of the packet')
assert.throws(() => cancelled.finish(tail), error => error.name === 'AbortError')

const empty = new GeometryReceiver()
await empty.acceptLayout({ ...layout, groups: [], emitted: 0, geometryBytes: 0 })
assert.equal(empty.finish({ ...tail, tails: [], emitted: 0, geometryBytes: 0, batchCount: 0 }).groups.size, 0)
console.log('Stream receiver: exact retained arrays, ordering, validation, budget and cancellation passed')
