import assert from 'node:assert/strict'
import { gzipSync, deflateSync } from 'node:zlib'
import { MessageChannel } from 'node:worker_threads'
import { consumeDecompressed } from '../src/decompression.js'
import { readSchematicNBT } from '../src/schematicNbt.js'
import { parseLitematica, parseLitematicaRaw } from '../src/litematica.js'
import { createWorkerScheduler } from '../src/workerScheduler.js'
import { createSchematicWorker } from '../src/schematicWorker.js'

const Native = globalThis.DecompressionStream, originalTimer = globalThis.setTimeout
const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
let clock = 0, timers = 0, yields = 0
// Make every existing 8/12 ms checkpoint due without spending CPU on a large
// schematic. Scheduling and compressed bytes still use real implementations.
Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += 20) })
globalThis.setTimeout = (callback, delay, ...args) => { if (delay === 0) timers++; return originalTimer(callback, delay, ...args) }
const scheduler = createWorkerScheduler({ MessageChannel })
const yieldTask = () => { yields++; return scheduler.yieldTask() }
const collect = () => {
  let chunks = []
  return { push: bytes => chunks.push(Buffer.from(bytes)), finish: () => Buffer.concat(chunks), abort() { chunks = [] } }
}
const limited = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = originalTimer(() => reject(new Error('Cancellation did not settle')), 1500) })]) }
  finally { clearTimeout(timer) }
}
const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes }
const string = value => { const bytes = Buffer.from(value), size = Buffer.alloc(2); size.writeUInt16BE(bytes.length); return Buffer.concat([size, bytes]) }
const tag = (type, name, payload) => Buffer.concat([Buffer.from([type]), string(name), payload])
const compound = (...fields) => Buffer.concat([...fields, Buffer.from([0])])
const vector = (name, values) => tag(10, name, compound(...['x', 'y', 'z'].map((key, i) => tag(3, key, int(values[i])))))
function schematic(volume, packedBytes = Math.ceil(volume / 32) * 8) {
  const states = Buffer.alloc(packedBytes, 0x55)
  const palette = tag(9, 'BlockStatePalette', Buffer.concat([Buffer.from([10]), int(2), ...['air', 'stone'].map(name => compound(tag(8, 'Name', string('minecraft:' + name))))]))
  return tag(10, '', compound(tag(10, 'Regions', compound(tag(10, 'R', compound(
    // Deliberately precede Size/palette: the second streaming pass remains
    // necessary even though its scheduling changes.
    tag(12, 'BlockStates', Buffer.concat([int(states.length / 8), states])),
    vector('Position', [0, 0, 0]), vector('Size', [volume, 1, 1]), palette,
  ))))))
}

try {
  const payload = Buffer.alloc(256 * 1024, 37), first = payload.subarray(0, payload.length / 2)
  const joined = Buffer.concat([gzipSync(first), gzipSync(first)])
  for (const mode of ['raw', 'native', 'zlib', 'members', 'exact']) {
    let calls = 0, sinks = 0, aborted = 0
    globalThis.DecompressionStream = class {
      constructor(format) {
        calls++
        if (mode === 'exact') throw new TypeError('Force exact fallback')
        const native = new Native(format)
        if (mode !== 'members' || calls !== 1) return native
        let bytes = 0
        return { writable: native.writable, readable: native.readable.pipeThrough(new TransformStream({ transform(chunk, controller) {
          bytes += chunk.length
          if (bytes > 192 * 1024) throw new TypeError('Reject second member')
          controller.enqueue(chunk)
        } })) }
      }
    }
    const input = mode === 'raw' ? payload : mode === 'zlib' ? deflateSync(payload) : mode === 'members' || mode === 'exact' ? joined : gzipSync(payload)
    const fractions = [], stages = [], beforeYield = yields, beforeTimer = timers
    const result = await consumeDecompressed(input, () => {
      sinks++; const sink = collect(), close = sink.abort
      sink.abort = () => { aborted++; close() }; return sink
    }, { yieldTask, onProgress: value => fractions.push(value), onStage: detail => stages.push(detail) })
    assert.deepEqual(result, payload, mode)
    assert.ok(yields > beforeYield, mode + ': injected real-task scheduler reached')
    assert.equal(timers, beforeTimer, mode + ': no timer delay added to Worker scheduling')
    assert.equal(sinks, aborted); assert.equal(fractions.at(-1), 1)
    assert.ok(fractions.every((n, i) => n >= 0 && n <= 1 && (!i || n >= fractions[i - 1])))
    assert.ok(stages.every((s, i) => s.phase === 'decompress' && (!i || s.processedBytes >= stages[i - 1].processedBytes)))
    assert.equal(stages.at(-1).processedBytes, payload.length)
    if (mode === 'native' || mode === 'zlib') assert.deepEqual(fractions, [1], 'Native numeric progress stays unchanged')
    if (mode === 'members') { assert.equal(sinks, 2); assert.equal(calls, 3) }
    if (mode === 'exact') { assert.equal(sinks, 3); assert.equal(calls, 2) }
  }
  console.log('PASS raw/native/zlib/member/exact decoding uses injected task boundaries, preserving bytes, retries and progress')

  globalThis.DecompressionStream = Native
  const beforeTimer = timers
  assert.deepEqual(await consumeDecompressed(payload, collect), payload)
  assert.ok(timers > beforeTimer, 'Uninjected main/fallback retains the original timer scheduler')
  for (const field of ['CRC', 'ISIZE']) {
    const bad = Buffer.from(gzipSync(payload)); bad[bad.length - (field === 'CRC' ? 8 : 4)] ^= 1
    await assert.rejects(consumeDecompressed(bad, collect, { yieldTask }), error => error.name !== 'AbortError')
  }
  for (const input of [joined.subarray(0, -1), Buffer.concat([joined, Buffer.from([0])])]) await assert.rejects(consumeDecompressed(input, collect, { yieldTask }))
  console.log('PASS main-thread timer fallback and unchanged CRC/ISIZE/truncation/trailing-data rejection')

  // 8 MiB crosses extraction threshold; a tiny valid region with extra packed
  // padding keeps this a focused scheduling check instead of a huge-world test.
  const large = gzipSync(schematic(32, 8 * 1024 * 1024)), passYields = [0, 0]
  let pass = 0, calls = 0
  globalThis.DecompressionStream = class { constructor(format) { calls++; return new Native(format) } }
  const expected = await readSchematicNBT(large, { compactBlocks: true, streamThreshold: 0, yieldTask: () => Promise.resolve() })
  calls = 0
  const result = await readSchematicNBT(large, { compactBlocks: true, streamThreshold: 0,
    onProgress: value => { if (value >= .5) pass = 1 },
    yieldTask: () => { passYields[pass]++; return yieldTask() },
  })
  assert.equal(calls, 2); assert.ok(passYields.every(n => n > 0)); assert.deepEqual(result, expected)
  assert.equal(result.root.Regions.R.BlockStates.count, 32)
  console.log('PASS both compact NBT scans preserve out-of-order headers, exact pages and injected scheduling')

  globalThis.DecompressionStream = Native
  const raw = schematic(131072)
  for (const compactBlocks of [false, true]) {
    const expected = await parseLitematica(raw, null, { compactBlocks, yieldTask: () => Promise.resolve() })
    let rootYields = 0, rootStarted = false
    const result = await parseLitematica(raw, fraction => { if (fraction >= .5) rootStarted = true }, { compactBlocks,
      yieldTask: () => { if (rootStarted) rootYields++; return yieldTask() },
    })
    assert.ok(rootYields > 0, 'Block decode phase uses scheduler for Map and retained packed-array paths')
    assert.deepEqual([...result.blocks], [...expected.blocks])
    for (const field of ['bounds', 'palette', 'metadata', 'tileEntities', 'entities', 'regions', 'nbtInfo']) assert.deepEqual(result[field], expected[field])
    const rawResult = await parseLitematicaRaw(raw, null, { compactBlocks, yieldTask })
    assert.deepEqual([...rawResult.blocks], [...expected.blocks])
  }
  console.log('PASS Map and paged root conversion plus raw entry point preserve every block and parsed field')

  {
    const controller = new AbortController(); controller.abort()
    let sinks = 0
    await assert.rejects(consumeDecompressed(gzipSync(payload), () => { sinks++; return collect() }, { signal: controller.signal, yieldTask }), { name: 'AbortError' })
    assert.equal(sinks, 0)
  }
  {
    const controller = new AbortController(); let started, release, pushes = 0, closes = 0, finished = false
    const waiting = new Promise(resolve => { started = resolve })
    const task = consumeDecompressed(payload, () => ({ push() { pushes++ }, finish() { finished = true }, abort() { closes++ } }), {
      signal: controller.signal, yieldTask() { started(); return new Promise(resolve => { release = resolve }) },
    })
    await waiting; controller.abort()
    await assert.rejects(limited(task), { name: 'AbortError' }); release(); await Promise.resolve()
    assert.equal(pushes, 1); assert.equal(closes, 1); assert.equal(finished, false)
  }
  {
    let readStarted, cancels = 0, attempts = 0, closes = 0
    const reading = new Promise(resolve => { readStarted = resolve })
    globalThis.DecompressionStream = class { constructor() {
      attempts++
      return { writable: new WritableStream(), readable: new ReadableStream({
        pull() { readStarted(); return new Promise(() => {}) }, cancel() { cancels++ },
      }) }
    } }
    const controller = new AbortController()
    const task = consumeDecompressed(gzipSync(payload), () => ({ push() { assert.fail('No late chunks') }, finish() { assert.fail('No partial result') }, abort() { closes++ } }), { signal: controller.signal, yieldTask })
    await reading; controller.abort()
    await assert.rejects(limited(task), { name: 'AbortError' })
    assert.equal(attempts, 1); assert.equal(cancels, 1); assert.equal(closes, 1)
  }
  globalThis.DecompressionStream = Native
  console.log('PASS pre-abort, held task and pending native read cancel promptly, close resources and never retry as compression errors')

  {
    const messages = []; let entered, held
    const waiting = new Promise(resolve => { entered = resolve })
    const workerYield = () => { entered(); return new Promise(resolve => { held = resolve }) }
    const host = createSchematicWorker({ postMessage: message => messages.push(message), yieldTask: workerYield })
    try {
      const task = host.handle({ type: 'parse', id: 1, session: 1, bytes: raw,
        options: { signal: 'cannot override job signal', yieldTask: 'cannot override local function' } })
      await waiting; await host.handle({ type: 'cancel', id: 1, session: 1 })
      await limited(task); held(); await Promise.resolve()
      assert.equal(messages.at(-1).error.name, 'AbortError')
      assert.ok(!messages.some(m => m.type === 'result' && m.id === 1))
      await host.handle({ type: 'build', id: 2, session: 1, palette: [] })
      assert.equal(messages.at(-1).error.code, 'WORKER_SESSION')
    } finally { host.dispose() }
  }
  console.log('PASS real Worker parse receives authoritative local scheduler/signal; queued cancellation leaves no usable partial session')
} finally {
  scheduler.dispose(); globalThis.DecompressionStream = Native; globalThis.setTimeout = originalTimer
  if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor)
  else delete performance.now
}
