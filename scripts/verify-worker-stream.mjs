import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { SchematicWorkerClient } from '../src/workerClient.js'
import { createSchematicWorker } from '../src/schematicWorker.js'
import { GeometryReceiver } from '../src/geometryReceiver.js'
import { buildFaceGroups } from '../src/geometry.js'
import { bakeModel } from '../src/modelBaker.js'
import { filterFromDescriptor, GEOMETRY_STREAM_VERSION } from '../src/workerProtocol.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const workerSource = `import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
  addEventListener: (type, callback) => parentPort.on(type, data => callback({ data })) };
await import(${JSON.stringify(new URL('../src/schematicWorker.js', import.meta.url).href)});`
let transport
const client = new SchematicWorkerClient({ workerFactory() {
  const thread = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)))
  const current = transport = { received: [], sent: [], postMessage(message, transfer = []) {
    if (message.type !== 'ack') assert.equal(transfer.length, 0, 'Never detach main input/pages')
    else assert.deepEqual(transfer, message.slabs.map(slab => slab.buffer))
    this.sent.push({ type: message.type, seq: message.seq })
    thread.postMessage(message, transfer)
  }, terminate() { void thread.terminate() } }
  thread.on('message', data => { current.received.push({ type: data.type, seq: data.seq }); current.onmessage?.({ data }) })
  thread.on('error', error => current.onerror?.({ message: error.message }))
  return current
} })
const bytes = await readFile('schematics/投影预览测试.litematic')
try {
  const data = await client.parse(bytes, null, { compactBlocks: true, renderOnly: true })
  assert.ok(client.canStream(data))
  const cube = bakeModel({ textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
    faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])) }] })
  const palette = data.palette.map(entry => ({ ...entry, baked: cube }))
  const mid = data.bounds.minY + Math.floor(data.bounds.height / 2)
  const descriptors = [null, { mode: 'single', layerY: mid }, { mode: 'all', hiddenRegions: [{ minX: data.bounds.minX,
    maxX: data.bounds.minX + data.bounds.width - 1, minY: data.bounds.minY, maxY: data.bounds.minY + data.bounds.height - 1,
    minZ: data.bounds.minZ, maxZ: data.bounds.minZ + data.bounds.depth - 1 }] }]
  let checkedBackpressure = false
  for (const compactFaces of [false, true]) for (const descriptor of descriptors) {
    const receiver = new GeometryReceiver(), borrowed = []
    let batchCallbacks = 0, concurrent = 0, peakConcurrent = 0
    const start = transport.received.length
    const result = await client.buildStream(data, { palette, descriptor, compactFaces, trackBlocks: true }, {
      async onLayout(layout, context) {
        assert.ok(context.signal instanceof AbortSignal)
        await receiver.acceptLayout(layout, context.signal)
        await delay(8)
        assert.equal(transport.received.slice(start).filter(message => message.type === 'batch').length, 0, 'Layout ACK gates all face filling')
      },
      async onBatch(batch, context) {
        peakConcurrent = Math.max(peakConcurrent, ++concurrent); batchCallbacks++
        const packets = transport.received.slice(start).filter(message => message.type === 'batch').length
        const buffers = batch.slabs.map(slab => slab.buffer)
        borrowed.push(...buffers)
        await receiver.acceptBatch(batch, context.signal)
        if (!checkedBackpressure) {
          await delay(12)
          assert.equal(transport.received.slice(start).filter(message => message.type === 'batch').length, packets, 'Only one batch can remain unacknowledged')
          assert.ok(buffers.every(buffer => buffer.byteLength > 0), 'Slabs remain valid throughout the async callback')
          // Callback mutation must not let ACK accidentally transfer retained
          // main-thread arrays instead of the prevalidated worker-owned slabs.
          const retained = [...receiver.groups.values()][0].positions
          batch.slabs[0].buffer = retained.buffer
          checkedBackpressure = true
        }
        concurrent--
      },
    }, { batchBytes: 1024 })
    assert.ok(!Object.hasOwn(result, 'groups'), 'Final response only carries metadata')
    assert.equal(result.batchCount, batchCallbacks)
    if (batchCallbacks) assert.equal(peakConcurrent, 1)
    assert.ok(borrowed.every(buffer => buffer.byteLength === 0), 'Every ACK returns its borrowed slabs through transfer')
    const expected = await buildFaceGroups(palette, data.blocks, data.bounds, null, filterFromDescriptor(descriptor), { compactFaces, trackBlocks: true })
    assert.deepEqual(receiver.finish(result), structuredClone(expected))
    assert.ok(bytes.byteLength > 0)
  }
  let called = false
  await assert.rejects(client.buildStream(data, { palette }, { onLayout() { called = true }, onBatch() {} }, { maxGeometryBytes: 1 }), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
  assert.equal(called, false)
  console.log('PASS real Worker stream: ordinary/compact/layers/empty geometry, single-packet backpressure, ACK transfer, immutable main arrays and metadata-only completion')
} finally { client.dispose() }

const layout = { version: 1, bounds: { minX: 0, minY: 0, minZ: 0, width: 1, height: 1, depth: 1 }, emitted: 2, geometryBytes: 24,
  groups: [{ groupIndex: 0, key: 'particle/bubble', kind: 'points', count: 2,
    buffers: [{ name: 'positions', type: 'Float32Array', length: 6, stride: 3 }] }] }
const schematic = () => ({ blocks: new Map([[0, 0]]), bounds: layout.bounds, palette: [], entities: [], tileEntities: [], regions: [] })
function loopback({ change, changeAck, streamVersion = GEOMETRY_STREAM_VERSION } = {}) {
  let wire, controller
  const factory = () => {
    const current = wire = { terminated: false, sent: [], messages: [], postMessage(message, transfer = []) {
      this.sent.push(message.type)
      const copy = structuredClone(message, { transfer })
      if (copy.type === 'ack') changeAck?.(copy)
      queueMicrotask(() => { if (!this.terminated) void this.controller.handle(copy) })
    }, terminate() { this.terminated = true; this.controller.dispose() }, crash() { this.onerror?.({ message: 'Crash while awaiting ACK' }) } }
    controller = createSchematicWorker({ parse: async () => schematic(), postMessage(message, transfer = []) {
      const copy = structuredClone(message, { transfer })
      current.messages.push(copy)
      queueMicrotask(() => { if (!current.terminated) current.onmessage?.({ data: change?.(copy) || copy }) })
    }, buildStream: async (...args) => {
      const options = args[5]
      await options.onLayout(layout)
      const buffer = new ArrayBuffer(1024), positions = new Float32Array(buffer, 0, 6)
      positions.set([1, 2, 3, 4, 5, 6])
      const recycled = await options.onBatch({ parts: [{ groupIndex: 0, start: 0, count: 2, buffers: { positions } }], slabs: [{ slabId: 1, buffer }] })
      assert.equal(recycled.slabs[0].buffer.byteLength, 1024)
      return { emitted: 2, geometryBytes: 24, tails: [{ groupIndex: 0, metadata: { v: 6 } }] }
    } })
    current.controller = controller
    queueMicrotask(() => current.onmessage?.({ data: { type: 'ready', streamVersion } }))
    return current
  }
  const client = new SchematicWorkerClient({ workerFactory: factory })
  return { client, get wire() { return wire }, get controller() { return controller } }
}
const input = Uint8Array.of(1)
for (const where of ['layout', 'batch']) for (const reason of ['abort', 'reject', 'crash', 'cancel-message']) {
  const test = loopback(), data = await test.client.parse(input), gate = deferred(), entered = deferred(), abort = new AbortController()
  let context
  const sink = async (_value, ctx) => { context = ctx; entered.resolve(); await gate.promise }
  const job = test.client.buildStream(data, {}, { onLayout: where === 'layout' ? sink : () => {}, onBatch: where === 'batch' ? sink : () => {} }, { signal: abort.signal })
  const expected = reason === 'crash' ? { code: 'WORKER_CRASHED' } : reason === 'reject' ? /Sink failed/ : { name: 'AbortError' }
  const rejected = assert.rejects(job, expected)
  await entered.promise
  const acks = test.wire.sent.filter(type => type === 'ack').length
  if (reason === 'abort') abort.abort()
  else if (reason === 'reject') gate.reject(Error('Sink failed'))
  else if (reason === 'crash') test.wire.crash()
  else await test.controller.handle({ type: 'cancel', id: context.id, session: context.session })
  await rejected
  assert.equal(context.signal.aborted, true)
  assert.equal(test.wire.terminated, reason !== 'cancel-message')
  assert.equal(test.client.pending.size, 0)
  const oldWire = test.wire
  if (reason === 'cancel-message') {
    gate.resolve(); await delay(0)
    assert.ok(test.client.canStream(data), 'Cooperative cancellation retains the session')
    assert.equal(oldWire.sent.filter(type => type === 'ack').length, acks, 'A settled job never ACKs a late sink')
    await test.client.buildStream(data, {}, { onLayout() {}, onBatch() {} })
  } else {
    const newer = await test.client.parse(input)
    gate.reject(Error('Late sink failure from an obsolete file'))
    await delay(0)
    assert.equal(oldWire.sent.filter(type => type === 'ack').length, acks, 'An obsolete sink cannot return slabs to a newer worker')
    assert.ok(test.client.canStream(newer), 'Abort/crash/sink failure permits a fresh file')
    assert.equal(test.wire.terminated, false, 'A late callback rejection cannot tear down the new worker')
    await test.client.buildStream(newer, {}, { onLayout() {}, onBatch() {} })
  }
  test.client.dispose()
}
console.log('PASS stream layout/batch waits: abort, callback rejection, worker crash, queued cancel and late callback isolation never leave pending requests')

for (const corrupt of [message => { message.seq++ }, message => { message.batch.parts[0].start++ },
  message => { message.batch.parts[0].buffers.positions = new Float32Array(6) },
  message => { message.batch.slabs.push(message.batch.slabs[0]) }]) {
  const test = loopback({ change(message) { if (message.type === 'batch') corrupt(message); return message } })
  const data = await test.client.parse(input)
  await assert.rejects(test.client.buildStream(data, {}, { onLayout() {}, onBatch() { throw Error('Invalid packet reached consumer') } }), { code: 'WORKER_PROTOCOL' })
  assert.ok(test.wire.terminated); test.client.dispose()
}
const legacy = loopback({ streamVersion: 0 }), legacyData = await legacy.client.parse(input)
assert.ok(legacy.client.canBuild(legacyData)); assert.equal(legacy.client.canStream(legacyData), false)
await assert.rejects(legacy.client.buildStream(legacyData, {}, { onLayout() {}, onBatch() {} }), { code: 'WORKER_STREAM_UNAVAILABLE' })
legacy.client.dispose()
console.log('PASS stream version negotiation and malformed sequence/ranges/slab ownership rejection before consumer mutation')

for (const [seq, corrupt] of [[0, message => { message.seq = 100 }], [1, message => { message.slabs = [] }],
  [1, message => { message.slabs[0].buffer = new ArrayBuffer(1023) }], [1, message => { message.slabs[0].slabId = 99 }]]) {
  let once = false
  const test = loopback({ changeAck(message) { if (!once && message.seq === seq) { once = true; corrupt(message) } } })
  const data = await test.client.parse(input)
  await assert.rejects(test.client.buildStream(data, {}, { onLayout() {}, onBatch() {} }), { code: 'WORKER_PROTOCOL' })
  assert.equal(test.client.pending.size, 0)
  assert.ok(test.client.canStream(data))
  await test.client.buildStream(data, {}, { onLayout() {}, onBatch() {} })
  test.client.dispose()
}
console.log('PASS malformed ACK sequence/ownership/size settles the worker job and permits session reuse')
