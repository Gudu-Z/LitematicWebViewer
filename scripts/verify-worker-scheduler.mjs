import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { createWorkerScheduler } from '../src/workerScheduler.js'
import { createSchematicWorker } from '../src/schematicWorker.js'

async function checkTaskAndOrder(scheduler) {
  let finished = false
  const first = scheduler.yieldTask().then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false, 'Yield must reach a task, not just another microtask')
  await first
  const order = []
  await Promise.all(Array.from({ length: 8 }, (_, i) => scheduler.yieldTask().then(() => order.push(i))))
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7], 'Concurrent waits resume in FIFO order')
}

{
  const scheduler = createWorkerScheduler({ MessageChannel }), control = new MessageChannel()
  try {
    await checkTaskAndOrder(scheduler)
    const received = new Promise(resolve => control.port1.once('message', resolve))
    control.port2.postMessage('input')
    // Node batches one port's queued callbacks within a poll phase, unlike the
    // browser's per-message tasks. Await both sources without assuming their
    // relative ordering; the Chrome suite covers real worker command timing.
    const [message] = await Promise.all([received, scheduler.yieldTask()])
    assert.equal(message, 'input', 'Other message tasks remain runnable while yielding')
  } finally { scheduler.dispose(); control.port1.close(); control.port2.close() }
}
console.log('PASS MessageChannel yields to real tasks, preserves FIFO and permits independent messages')

let closed = 0
for (const Channel of [null, class { constructor() { throw new Error('Channel unavailable') } }, class {
  constructor() {
    this.port1 = { close() { closed++ } }
    this.port2 = { postMessage() { throw new Error('Port failed') }, close() { closed++ } }
  }
}]) {
  const scheduler = createWorkerScheduler({ MessageChannel: Channel })
  try { await checkTaskAndOrder(scheduler) } finally { scheduler.dispose() }
}
assert.equal(closed, 2, 'A failed channel closes both ports before falling back')
console.log('PASS unavailable, constructor-failed and send-failed channels retain the original timer fallback')

for (const Channel of [MessageChannel, null]) {
  const scheduler = createWorkerScheduler({ MessageChannel: Channel })
  const pending = [scheduler.yieldTask(), scheduler.yieldTask(), scheduler.yieldTask()]
  scheduler.dispose(); scheduler.dispose()
  await Promise.all(pending)
  await assert.rejects(scheduler.yieldTask(), { name: 'AbortError', code: 'ABORT_ERR' })
}
console.log('PASS disposal closes ports/timers and settles every pending wait without hanging')

const bounds = { minX: 0, minY: 0, minZ: 0, width: 131072, height: 1, depth: 1 }
const blocks = new Map(Array.from({ length: bounds.width }, (_, key) => [key, 0]))
const palette = [{ name: 'minecraft:stone', baked: null }]
const parse = async () => ({ blocks, bounds, palette })

{
  const messages = [], scheduler = createWorkerScheduler({ MessageChannel }), control = new MessageChannel()
  let yielded = 0, delivered
  const cancelled = new Promise(resolve => { delivered = resolve })
  const host = createSchematicWorker({ parse, postMessage: message => messages.push(message),
    yieldTask() {
      yielded++
      const waiting = scheduler.yieldTask()
      if (yielded === 1) {
        control.port2.postMessage('cancel')
        return Promise.all([waiting, cancelled])
      }
      return waiting
    },
    disposeScheduler: scheduler.dispose,
  })
  control.port1.on('message', async () => { await host.handle({ type: 'cancel', id: 2, session: 1 }); delivered() })
  try {
    await host.handle({ type: 'parse', id: 1, session: 1 })
    await host.handle({ type: 'build', id: 2, session: 1, palette })
    assert.ok(yielded > 0)
    assert.equal(messages.at(-1).type, 'error')
    assert.equal(messages.at(-1).error.name, 'AbortError')
    assert.ok(!messages.some(message => message.type === 'result' && message.id === 2))
  } finally { host.dispose(); control.port1.close(); control.port2.close() }
}

{
  let started, closed = 0
  const waiting = new Promise(resolve => { started = resolve })
  // Keep the port task pending until controller disposal. The real geometry
  // signal check must still resume and reject after pending waits are released.
  const scheduler = createWorkerScheduler({ MessageChannel: class {
    constructor() {
      this.port1 = { close() { closed++ } }
      this.port2 = { postMessage() {}, close() { closed++ } }
    }
  } })
  const messages = []
  const host = createSchematicWorker({ parse, postMessage: message => messages.push(message),
    yieldTask() { const pending = scheduler.yieldTask(); started(); return pending }, disposeScheduler: scheduler.dispose,
  })
  await host.handle({ type: 'parse', id: 1, session: 2 })
  const building = host.handle({ type: 'build', id: 2, session: 2, palette })
  await waiting
  host.dispose()
  await building
  assert.equal(closed, 2)
  assert.equal(messages.at(-1).error.name, 'AbortError')
}
console.log('PASS queued cancellation and controller disposal wake real geometry at its unchanged signal checkpoints')

{
  const original = globalThis.MessageChannel
  let constructed = 0, yielded
  globalThis.MessageChannel = class { constructor() { constructed++; throw new Error('Unexpected channel') } }
  const host = createSchematicWorker({ parse, postMessage() {}, build: async (...args) => {
    yielded = args[5].yieldTask
    return { groups: new Map(), emitted: 0 }
  } })
  try {
    await host.handle({ type: 'parse', id: 1, session: 3 })
    await host.handle({ type: 'build', id: 2, session: 3, palette })
    assert.equal(constructed, 0, 'Importing/creating a controller does not allocate active Node ports')
    assert.equal(yielded, undefined, 'Only the worker entry opts into the alternate scheduler')
  } finally { host.dispose(); globalThis.MessageChannel = original }
}
console.log('PASS default controller/main construction retains the original scheduling and creates no ports')
