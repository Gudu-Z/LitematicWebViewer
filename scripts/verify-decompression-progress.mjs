import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { consumeDecompressed } from '../src/decompression.js'
import { readSchematicNBT } from '../src/schematicNbt.js'
import { SchematicWorkerClient } from '../src/workerClient.js'

const Native = globalThis.DecompressionStream
const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
let clock = 0
// Force report/yield boundaries independently of machine speed. Actual bytes
// still pass through the native DecompressionStream or the real gzip fallback.
Object.defineProperty(performance, 'now', { configurable: true, value: () => clock })
try {
  const first = Buffer.alloc(2 * 1024 * 1024, 37), second = Buffer.alloc(2 * 1024 * 1024, 91)
  const output = Buffer.concat([first, second]), single = gzipSync(output)
  const joined = Buffer.concat([gzipSync(first), gzipSync(second)])
  for (const mode of ['native', 'members', 'exact']) {
    let calls = 0, attempts = 0, aborts = 0, finished = false
    globalThis.DecompressionStream = class {
      constructor(format) {
        calls++
        if (mode === 'exact') throw new TypeError('Force exact gzip fallback')
        const native = new Native(format)
        if (mode !== 'members' || calls !== 1) return native
        let expanded = 0
        // Let the genuine native decoder emit a large prefix, then model the
        // browser rejecting a later member. The retry must use a fresh sink.
        return { writable: native.writable, readable: native.readable.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            expanded += chunk.length
            if (expanded > 3 * 1024 * 1024) throw new TypeError('Native rejected later gzip member')
            controller.enqueue(chunk)
          },
        })) }
      }
    }
    const stages = [], numeric = []
    const decoded = await consumeDecompressed(mode === 'native' ? single : joined, () => {
      attempts++
      let chunks = []
      return {
        push(chunk) { chunks.push(Buffer.from(chunk)); clock += 20 },
        finish() { finished = true; return Buffer.concat(chunks) },
        abort() { chunks = []; aborts++ },
      }
    }, {
      onProgress: value => numeric.push(value),
      onStage: detail => stages.push({ ...detail, finished }),
    })
    assert.deepEqual(decoded, output, mode + ': progress preserves every decompressed byte')
    assert.equal(stages.at(-1).processedBytes, output.length, mode + ': retries do not double-count output')
    assert.ok(stages.filter(stage => !stage.finished && stage.processedBytes < output.length).length > 3,
      mode + ': real intermediate output must be reported before completion')
    assert.ok(stages.every((stage, i) => stage.phase === 'decompress' && (!i || stage.processedBytes >= stages[i - 1].processedBytes)),
      mode + ': byte progress never moves backwards on a retry')
    assert.equal(numeric.at(-1), 1)
    assert.ok(numeric.every((value, i) => value >= 0 && value <= 1 && (!i || value >= numeric[i - 1])))
    assert.equal(aborts, attempts, 'Every attempt closes its sink')
    if (mode === 'native') {
      assert.equal(calls, 1); assert.equal(attempts, 1)
      assert.deepEqual(numeric, [1], 'Native numeric progress semantics remain unchanged')
    } else if (mode === 'members') { assert.equal(calls, 3); assert.equal(attempts, 2) }
    else { assert.equal(calls, 2); assert.equal(attempts, 3) }
  }
  console.log('PASS real native single-member and member retry/exact fallback byte progress, monotonic retries and identical output')

  globalThis.DecompressionStream = Native
  const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes }
  const string = value => { const bytes = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]) }
  const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes])
  const compound = (...fields) => Buffer.concat([...fields, Buffer.from([0])])
  const vector = (name, values) => tag(10, name, compound(...['x', 'y', 'z'].map((axis, i) => tag(3, axis, int(values[i])))))
  const palette = tag(9, 'BlockStatePalette', Buffer.concat([Buffer.from([10]), int(2),
    ...['air', 'stone'].map(name => compound(tag(8, 'Name', string('minecraft:' + name))))]))
  // The packed array crosses the 8 MiB extraction threshold. It is all air,
  // covering 33,554,432 cells without creating an enormous Map or NBT tree.
  const raw = tag(10, '', compound(tag(10, 'Regions', compound(tag(10, 'R', compound(
    vector('Position', [0, 0, 0]), vector('Size', [1024, 32, 1024]), palette,
    tag(12, 'BlockStates', Buffer.concat([int(1024 * 1024), Buffer.alloc(8 * 1024 * 1024)])),
  ))))))
  const compressed = gzipSync(raw), baseline = await readSchematicNBT(compressed, { compactBlocks: true, streamThreshold: 0 })
  let firstPassDone = false, samples = 0, maximum = 0
  const numeric = []
  const result = await readSchematicNBT(compressed, { compactBlocks: true, streamThreshold: 0,
    onProgress(value) { numeric.push(value); if (value >= .5) firstPassDone = true },
    onStage(detail) {
      assert.equal(firstPassDone, false, 'Expanded-byte stages belong only to the first scan')
      assert.equal(detail.phase, 'decompress')
      assert.ok(detail.processedBytes >= maximum)
      maximum = detail.processedBytes; samples++; clock += 20
    },
  })
  assert.deepEqual(result, baseline, 'Adding stage progress preserves NBT, compact pages and statistics')
  assert.equal(maximum, raw.length)
  assert.ok(samples > 3)
  assert.ok(result.stats.blockStateBytes >= 8 * 1024 * 1024)
  assert.ok(numeric.includes(.5)); assert.equal(numeric.at(-1), 1)
  console.log('PASS two-pass compact NBT reports first-pass bytes only, preserves percentage phases and identical parsed pages')

  let nativeAttempts = 0, bytesBeforeAbort = 0, fractionsBeforeAbort = []
  globalThis.DecompressionStream = class {
    constructor(format) { nativeAttempts++; return new Native(format) }
  }
  const controller = new AbortController()
  const client = new SchematicWorkerClient({ workerFactory: () => { throw new Error('Worker unavailable') } })
  try {
    await assert.rejects(client.parse(compressed, (fraction, message) => {
      fractionsBeforeAbort.push(fraction)
      if (message?.detail?.processedBytes > 0) {
        bytesBeforeAbort = message.detail.processedBytes
        assert.equal(message.phase, 'decompress')
        controller.abort()
      }
    }, { signal: controller.signal, streamThreshold: 0 }), { name: 'AbortError' })
    assert.ok(bytesBeforeAbort > 0 && bytesBeforeAbort < raw.length, 'Fallback cancels on a real early native output chunk')
    assert.deepEqual(fractionsBeforeAbort, [0], 'Cancellation occurs before native numeric progress has advanced')
    assert.equal(nativeAttempts, 1, 'Cancellation never retries compressed data')
    assert.ok(compressed.byteLength > 0, 'Fallback retains caller-owned bytes')
  } finally { client.dispose() }
  console.log('PASS unavailable-Worker fallback reports real bytes and aborts native decompression before first numeric progress')
} finally {
  globalThis.DecompressionStream = Native
  if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor)
  else delete performance.now
}
