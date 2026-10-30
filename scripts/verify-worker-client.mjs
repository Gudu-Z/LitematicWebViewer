import assert from 'node:assert/strict'
import { SchematicWorkerClient } from '../src/workerClient.js'
import { serializeSchematic } from '../src/workerProtocol.js'

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
