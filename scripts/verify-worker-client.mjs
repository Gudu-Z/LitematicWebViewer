import assert from 'node:assert/strict'
import { SchematicWorkerClient } from '../src/workerClient.js'
import { serializeSchematic } from '../src/workerProtocol.js'
import { PARSE_HANDOFF_VERSION, planParseHandoff } from '../src/parseHandoff.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const schematic = () => ({
  metadata: { name: 'test' }, palette: [{ name: 'minecraft:stone' }], blocks: new Map([[7, 0]]),
  bounds: { minX: 0, minY: 0, minZ: 0, width: 8, height: 1, depth: 1 }, regions: [], tileEntities: [], entities: [],
})
class FakeWorker {
  constructor(handler, ready = true) {
    this.handler = handler; this.messages = []; this.terminated = false
    if (ready) queueMicrotask(() => this.emit({ type: 'ready' }))
  }
  postMessage(message, transfer) {
    assert.ok(!transfer?.length, 'Caller-owned buffers are never detached')
    this.messages.push(structuredClone(message))
    queueMicrotask(() => { if (!this.terminated) this.handler?.(this, this.messages.at(-1)) })
  }
  emit(message, transfer = []) { this.onmessage?.({ data: structuredClone(message, { transfer }) }) }
  reply(message, result, transfer) { this.emit({ type: 'result', id: message.id, session: message.session, result }, transfer) }
  fail(message) { this.onerror?.({ message, preventDefault() {} }) }
  terminate() { this.terminated = true }
}
function successful(worker, message) {
  if (message.type === 'parse') {
    worker.emit({ type: 'progress', id: message.id, session: message.session, fraction: .5, phase: 'parse', stageFraction: 0 })
    worker.reply(message, serializeSchematic(schematic()))
  } else {
    const positions = Float32Array.from([1, 2, 3])
    worker.emit({ type: 'progress', id: message.id, session: message.session, fraction: .5, phase: 'allocate',
      stageFraction: 0, detail: { groups: ['block/stone'], bytes: 12 } })
    worker.reply(message, { groups: new Map([['block/stone', { positions }]]), emitted: 1 }, [positions.buffer])
    assert.equal(positions.byteLength, 0, 'The worker transfers geometry ownership')
  }
}
const workers = [], factory = (handler = successful, ready = true) => () => {
  const worker = new FakeWorker(handler, ready); workers.push(worker); return worker
}
let fallbackCalls = 0
const fallback = async (bytes, progress, options) => {
  fallbackCalls++; assert.ok(bytes.byteLength > 0); progress(.5, { phase: 'parse' }); return schematic()
}

const client = new SchematicWorkerClient({ workerFactory: factory(), parseFallback: fallback })
const input = Uint8Array.of(1, 2, 3), progress = []
const data = await client.parse(input, (fraction, detail) => progress.push([fraction, detail]), { renderOnly: true })
assert.equal(input.byteLength, 3); assert.equal(data.blocks.get(7), 0); assert.ok(client.canBuild(data))
assert.equal(progress[0][1].phase, 'parse'); assert.equal(progress[0][1].stageFraction, 0)
assert.equal(workers[0].messages[0].options.renderOnly, true)
assert.equal(workers[0].messages[0].parseHandoffVersion, PARSE_HANDOFF_VERSION, 'Opt in without requiring a new ready handshake')
const buildProgress = [], hiddenRegions = [{ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 0 }]
const result = await client.build(data, { descriptor: { mode: 'single', layerY: 0, hiddenRegions }, trackBlocks: true,
  keys: [7], includeGroups: ['block/stone'], compactFaces: true }, (f, detail) => buildProgress.push(detail), { maxGeometryBytes: 1024 })
assert.deepEqual(result.groups.get('block/stone').positions, Float32Array.from([1, 2, 3]))
assert.deepEqual(buildProgress[0].detail, { groups: ['block/stone'], bytes: 12 })
assert.equal(workers[0].messages[1].options.maxGeometryBytes, 1024)
assert.deepEqual(workers[0].messages[1].descriptor.hiddenRegions, hiddenRegions)
assert.deepEqual(workers[0].messages[1].options.includeGroups, ['block/stone'])
await client.build(data, {}, undefined)
assert.equal(workers.length, 1); assert.equal(fallbackCalls, 0)
assert.equal(workers[0].messages[1].session, workers[0].messages[2].session)
console.log('PASS worker client: ready handshake, retained session, complete stage metadata, transfer ownership and immutable caller input')

let pendingBuild
workers[0].handler = (worker, message) => { pendingBuild = message }
const controller = new AbortController(), pending = client.build(data, {}, undefined, { signal: controller.signal })
await tick()
await assert.rejects(client.build(data), { code: 'WORKER_BUSY' })
controller.abort()
await assert.rejects(pending, { name: 'AbortError' })
assert.ok(workers[0].terminated); assert.equal(client.canBuild(data), false)
assert.equal(data.blocks.get(7), 0, 'Cancelling leaves the main-thread data intact')
workers[0].reply(pendingBuild, { groups: new Map(), emitted: -1 }) // Stale replies cannot revive an invalid session.
await assert.rejects(client.build(data), { code: 'WORKER_SESSION_LOST' })
const current = await client.parse(input)
assert.equal(workers.length, 2); assert.ok(client.canBuild(current))
client.release(data); assert.ok(client.canBuild(current), 'Releasing old data does not terminate a newer file')
client.release(current); assert.equal(client.canBuild(current), false); assert.ok(workers[1].terminated)

const bakeCancel = new AbortController(), baked = await client.parse(input, undefined, { signal: bakeCancel.signal })
bakeCancel.abort()
assert.equal(client.canBuild(baked), false, 'Cancel during model baking releases the worker session')
client.dispose()
await assert.rejects(client.parse(input), { name: 'AbortError' })
console.log('PASS worker client: busy requests, immediate cancellation, stale replies, retained main data, release and disposal')

for (const startupFactory of [() => { throw new Error('CSP blocked Worker') }, factory(undefined, false), () => {
  const worker = new FakeWorker(null, false); queueMicrotask(() => worker.fail('Module load failed')); return worker
}]) {
  const fallbackClient = new SchematicWorkerClient({ workerFactory: startupFactory, parseFallback: fallback, handshakeTimeout: 10 })
  const fallbackData = await fallbackClient.parse(input)
  assert.equal(fallbackClient.canBuild(fallbackData), false)
  assert.equal(input.byteLength, 3)
  const before = fallbackCalls
  await fallbackClient.parse(input)
  assert.equal(fallbackCalls, before + 1, 'Future files use the established startup fallback')
  fallbackClient.dispose()
}
const startedAborted = new AbortController(); startedAborted.abort()
let started = false
const abortedClient = new SchematicWorkerClient({ workerFactory: () => { started = true }, parseFallback: fallback })
await assert.rejects(abortedClient.parse(input, undefined, { signal: startedAborted.signal }), { name: 'AbortError' })
assert.equal(started, false)
let startupWorker
const startupClient = new SchematicWorkerClient({ workerFactory: () => (startupWorker = new FakeWorker(null, false)), parseFallback: fallback })
const startupCancel = new AbortController(), beforeCancelFallbacks = fallbackCalls
const startup = startupClient.parse(input, undefined, { signal: startupCancel.signal })
startupCancel.abort()
await assert.rejects(startup, { name: 'AbortError' }); assert.ok(startupWorker.terminated)
assert.equal(fallbackCalls, beforeCancelFallbacks)
startupClient.dispose()
console.log('PASS worker client: unsupported/CSP/module/timeout startup fallback and cancellation before ready')

let runtimeWorker
const runtime = new SchematicWorkerClient({ workerFactory: () => (runtimeWorker = new FakeWorker((worker, message) => {
  if (message.type === 'parse') successful(worker, message)
  else worker.emit({ type: 'error', id: message.id, session: message.session,
    error: { name: 'RangeError', message: 'Geometry budget exceeded', code: 'FILE_TOO_LARGE', reason: 'geometry', bytes: 2048, maxBytes: 1024 } })
})), parseFallback: fallback })
const runtimeData = await runtime.parse(input), beforeErrors = fallbackCalls
await assert.rejects(runtime.build(runtimeData), { name: 'RangeError', code: 'FILE_TOO_LARGE', reason: 'geometry', bytes: 2048, maxBytes: 1024 })
assert.equal(fallbackCalls, beforeErrors, 'Geometry failure does not restart on the main thread')
runtimeWorker.handler = (worker) => worker.fail('Unexpected crash')
await assert.rejects(runtime.build(runtimeData), { code: 'WORKER_CRASHED' })
assert.equal(runtime.canBuild(runtimeData), false); assert.equal(fallbackCalls, beforeErrors)
runtime.dispose()

let parseMessages = []
const supersededWorkers = []
const superseded = new SchematicWorkerClient({ workerFactory: () => {
  const worker = new FakeWorker((worker, message) => parseMessages.push([worker, message])); supersededWorkers.push(worker); return worker
}, parseFallback: fallback })
const first = superseded.parse(input), rejected = assert.rejects(first, { name: 'AbortError' })
await tick()
const second = superseded.parse(input)
await tick()
await rejected
assert.ok(supersededWorkers[0].terminated)
parseMessages[0][0].reply(parseMessages[0][1], serializeSchematic(schematic()))
parseMessages[1][0].reply(parseMessages[1][1], serializeSchematic(schematic()))
assert.ok(superseded.canBuild(await second))
superseded.dispose()
console.log('PASS worker client: structured budget errors, runtime crashes without fallback and superseded file isolation')

const cooperative = new SchematicWorkerClient({ workerFactory: () => { throw Error('Unavailable') },
  parseFallback: async (bytes, progress, options) => {
    assert.equal(options.signal, fallbackAbort.signal)
    await tick(); progress(.5); return schematic()
  } })
const fallbackAbort = new AbortController(), fallbackJob = cooperative.parse(input, undefined, { signal: fallbackAbort.signal })
await Promise.resolve(); fallbackAbort.abort()
await assert.rejects(fallbackJob, { name: 'AbortError' })
cooperative.dispose()
console.log('PASS fallback cancellation checks before, during and after cooperative main-thread parsing')

const fallbackStages = [], fallbackEvents = []
const stagedFallback = new SchematicWorkerClient({ workerFactory: () => { throw Error('Unavailable') },
  parseFallback: async (_bytes, progress, options) => {
    options.onStage({ phase: 'decompress', processedBytes: 65536 })
    progress(.25)
    options.onStage({ phase: 'decompress', processedBytes: 131072 })
    progress(1)
    return schematic()
  } })
await stagedFallback.parse(input, (fraction, message) => fallbackEvents.push({ fraction, message }), {
  onStage: detail => fallbackStages.push(detail),
})
assert.deepEqual(fallbackEvents.map(event => event.fraction), [0, .25, .25, 1])
assert.deepEqual(fallbackStages.map(stage => stage.processedBytes), [65536, 131072])
assert.deepEqual(fallbackEvents.filter(event => event.message).map(event => event.message.detail), fallbackStages)
assert.equal(fallbackEvents[2].message.stageFraction, .5)
stagedFallback.dispose()
console.log('PASS fallback byte stages preserve latest numeric fraction, Worker-shaped metadata and explicit observer')

let errorWorker
const errors = new SchematicWorkerClient({ workerFactory: () => (errorWorker = new FakeWorker((worker, message) => {
  worker.emit({ type: 'error', id: message.id, session: message.session, error: { name: 'TypeError', message: 'Invalid NBT', code: 'BAD_FILE' } })
})), parseFallback: fallback })
await assert.rejects(errors.parse(input), { name: 'TypeError', code: 'BAD_FILE' })
assert.equal(fallbackCalls, beforeErrors)
errors.workerFactory = () => (errorWorker = new FakeWorker(successful))
await assert.rejects(errors.parse(input, () => { throw Error('UI callback failed') }), /UI callback failed/)
assert.ok(errorWorker.terminated)
const errorData = await errors.parse(input)
errorWorker.postMessage = () => { throw Object.assign(new Error('Cannot clone input'), { name: 'DataCloneError' }) }
await assert.rejects(errors.build(errorData), { name: 'DataCloneError' })
assert.ok(errorWorker.terminated); assert.equal(errorData.blocks.get(7), 0)
errors.workerFactory = () => (errorWorker = new FakeWorker((worker, message) => worker.reply(message, { blocks: {} })))
await assert.rejects(errors.parse(input), /Invalid worker block pages/)
assert.ok(errorWorker.terminated)
errors.workerFactory = () => (errorWorker = new FakeWorker((worker) => worker.onmessageerror()))
await assert.rejects(errors.parse(input), { code: 'WORKER_CRASHED' })
assert.equal(fallbackCalls, beforeErrors)
errors.workerFactory = () => (errorWorker = new FakeWorker(successful))
const lateData = await errors.parse(input)
errorWorker.handler = (worker, message) => { successful(worker, message); errors.cancel() }
await assert.rejects(errors.build(lateData), { name: 'AbortError' })
errors.dispose()
console.log('PASS worker client: corrupt input, callback/clone/protocol/message errors and late cancellation never leave pending jobs')

// Use the real planner/receiver and independent native clones for every packet.
// These ordinary parser-shaped records include raw NBT BigInts/typed arrays,
// the same tile coordinates multiple times, and non-integer entity positions.
const large = schematic()
large.tileEntities = Array.from({ length: 20000 }, (_, i) => ({ id: 'minecraft:chest', x: i % 8, y: 0, z: 0, region: 'A',
  nbt: i % 2048 ? { x: i, Items: [] } : { x: i, Items: [{ Slot: 2, count: 64, long: -3n }], bytes: Int8Array.of(-7, 2), longs: BigInt64Array.of(-9n, 4n) } }))
large.entities.push({ id: 'minecraft:pig', pos: [.125, .25, -.5], rotation: [30, -2], region: 'A', nbt: { Pos: [-2.75, 0, 3.5], Passengers: [{ id: 'minecraft:parrot' }] } })
const plan = planParseHandoff(serializeSchematic(large)), packets = [...plan.packets]
assert.ok(packets.length > 2); assert.equal(packets.length, plan.header.partCount)
const completion = { parseHandoffVersion: PARSE_HANDOFF_VERSION, partCount: packets.length }
async function beginHandoff(signal) {
  let worker
  const client = new SchematicWorkerClient({ workerFactory: () => (worker = new FakeWorker(() => {})), parseFallback: () => assert.fail('Do not retry protocol failures on main') })
  const result = client.parse(input, undefined, { signal })
  await tick()
  const message = worker.messages[0], send = body => worker.emit({ id: message.id, session: message.session, ...body })
  return { client, worker, message, result, send, header: () => send({ type: 'parse-header', header: plan.header }),
    part: seq => send({ type: 'parse-part', seq, packet: packets[seq] }), end: () => send({ type: 'result', result: completion }) }
}
{
  const job = await beginHandoff(); let done = false
  const ready = job.result.then(value => { done = true; return value })
  job.header(); assert.equal(job.worker.messages.length, 1, 'The header does not consume or receive a packet ACK')
  for (let seq = 0; seq < packets.length; seq++) {
    job.part(seq)
    assert.deepEqual(job.worker.messages.at(-1), { type: 'parse-ack', id: job.message.id, session: job.message.session, seq })
    if (!seq) {
      await tick(); assert.equal(done, false, 'No partial result is published')
      job.send({ type: 'parse-part', seq: -1, id: job.message.id + 1, packet: {} })
      job.send({ type: 'parse-header', session: job.message.session + 1, header: {} })
      assert.equal(job.worker.messages.length, 2, 'Wrong request/session packets receive no ACK')
    }
  }
  await tick(); assert.equal(done, false, 'Wait for the matching final result even if all rows arrived')
  job.end(); const restored = await ready
  assert.deepEqual(restored, large); assert.ok(Array.isArray(restored.tileEntities)); assert.ok(job.client.canBuild(restored)); job.client.dispose()
}
for (const invalid of [
  job => job.part(0), job => job.end(), job => { job.header(); job.header() },
  job => { job.header(); job.part(1) }, job => { job.header(); job.part(0); job.part(0) },
  job => { job.header(); job.send({ type: 'parse-part', seq: 0, packet: { ...packets[0], start: 1 } }) },
  job => { job.header(); job.send({ type: 'result', result: serializeSchematic(schematic()) }) },
  job => { job.header(); job.part(0); job.send({ type: 'result', result: { ...completion, partCount: 1 } }) },
  job => { job.header(); job.end() },
  job => { job.header(); packets.forEach((_, i) => job.part(i)); job.send({ type: 'result', result: { ...completion, parseHandoffVersion: -1 } }) },
]) {
  const job = await beginHandoff(), rejected = assert.rejects(job.result, { code: 'WORKER_PROTOCOL' })
  invalid(job); await rejected; assert.ok(job.worker.terminated); assert.equal(job.client.pending.size, 0); job.client.dispose()
}
{
  const job = await beginHandoff(), rejected = assert.rejects(job.result, /ACK clone failed/)
  job.header(); job.worker.postMessage = () => { throw Error('ACK clone failed') }; job.part(0)
  await rejected; assert.ok(job.worker.terminated); job.client.dispose()
}
for (const action of ['abort', 'crash', 'supersede']) {
  const ctrl = new AbortController(), job = await beginHandoff(ctrl.signal)
  job.header(); job.part(0)
  const rejected = assert.rejects(job.result, action === 'crash' ? { code: 'WORKER_CRASHED' } : { name: 'AbortError' })
  if (action === 'abort') ctrl.abort()
  if (action === 'crash') job.worker.fail('Crashed between packets')
  let fresh
  job.client.workerFactory = () => (fresh = new FakeWorker(() => {}))
  const reopened = job.client.parse(input); await rejected; await tick()
  assert.ok(job.worker.terminated); const oldAcks = job.worker.messages.length
  job.part(1); job.end(); assert.equal(job.worker.messages.length, oldAcks)
  fresh.reply(fresh.messages[0], serializeSchematic(schematic()))
  const data = await reopened; assert.ok(job.client.canBuild(data)); assert.deepEqual(data.tileEntities, []); assert.ok(!fresh.terminated)
  job.client.dispose()
}
{
  let worker
  const client = new SchematicWorkerClient({ workerFactory: () => (worker = new FakeWorker(successful)) })
  const data = await client.parse(input)
  worker.handler = (w, msg) => w.emit({ id: msg.id, session: msg.session, type: 'parse-header', header: plan.header })
  await assert.rejects(client.build(data), { code: 'WORKER_PROTOCOL' }); assert.ok(worker.terminated)
  assert.equal(data.blocks.get(7), 0); client.dispose()
}
console.log('PASS segmented parse client: per-packet ACKs, exact ordered NBT, legacy results, invalid/missing packets, crash/abort/supersession and late-message isolation')
