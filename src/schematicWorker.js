import { parseLitematica } from './litematica.js'
import { buildFaceGroups, buildFaceGroupsStream } from './geometry.js'
import { serializeSchematic, filterFromDescriptor, transferBuffers, serializeWorkerError,
  GEOMETRY_STREAM_VERSION, streamBatchBytes, snapshotStreamSlabs, validateStreamAck } from './workerProtocol.js'
import { createWorkerScheduler } from './workerScheduler.js'

function abortError() { return Object.assign(new Error('Background task cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }) }
function protocolError(message, code = 'WORKER_PROTOCOL') { return Object.assign(new Error(message), { code }) }
const validId = value => Number.isSafeInteger(value) || typeof value === 'string' && value.length > 0 && value.length <= 256

// The controller is independent of WorkerGlobalScope so the exact protocol can
// also be exercised with real structuredClone/transfer in Node regressions.
export function createSchematicWorker({ postMessage, parse = parseLitematica, build = buildFaceGroups,
  buildStream = buildFaceGroupsStream, yieldTask, disposeScheduler }) {
  let session = null, active = null
  const post = (job, type, values = {}, transfers = []) => postMessage({ type, id: job.id, session: job.session, ...values }, transfers)
  const check = job => { if (job.failure) throw job.failure; if (job.cancelled || active !== job) throw abortError() }
  const settleAck = (job, error, slabs) => {
    const waiting = job.waitingAck
    if (!waiting) return
    job.waitingAck = null; waiting.cleanup()
    if (error) waiting.reject(error)
    else waiting.resolve({ slabs })
  }
  const exchange = async (job, type, payload, slabs = []) => {
    check(job)
    if (job.waitingAck) throw protocolError('Geometry stream already awaits an ACK')
    const seq = job.nextSeq++
    const promise = new Promise((resolve, reject) => {
      const abort = () => settleAck(job, job.failure || abortError())
      job.waitingAck = { seq, slabs, resolve, reject, cleanup: () => job.controller.signal.removeEventListener('abort', abort) }
      job.controller.signal.addEventListener('abort', abort, { once: true })
    })
    try { post(job, type, { seq, ...payload }, slabs.map(slab => slab.buffer)) }
    catch (error) { settleAck(job, error) }
    const result = await promise
    check(job)
    return result
  }
  const progress = (job, value, phase, detail) => {
    check(job)
    const fraction = Math.max(job.fraction, Math.min(1, Math.max(0, value)))
    job.fraction = fraction
    const now = performance.now()
    if (phase === job.phase && now < job.reportAt && fraction < 1 && !detail?.groups) return
    job.phase = phase; job.reportAt = now + 16
    const second = phase === 'parse' || phase === 'fill'
    const stageFraction = phase === 'allocate' ? 0 : Math.min(1, Math.max(0, second ? fraction * 2 - 1 : fraction * 2))
    post(job, 'progress', { phase, fraction, stageFraction, ...(detail ? { detail } : {}) })
  }

  async function handle(message) {
    if (!message || !validId(message.id) || !validId(message.session)) return
    const { type, id } = message
    if (type === 'ack') {
      const job = active
      if (!job || job.id !== id || job.session !== message.session) return
      const waiting = job.waitingAck
      // Already-consumed ACKs can arrive after cancellation; they never advance
      // another packet or return transferred buffers into a different job.
      if (Number.isSafeInteger(message.seq) && message.seq < (waiting?.seq ?? job.nextSeq)) return
      try {
        if (!waiting || message.seq !== waiting.seq) throw protocolError('Unexpected geometry stream ACK sequence')
        settleAck(job, null, validateStreamAck(message.slabs || [], waiting.slabs))
      } catch (error) {
        job.failure = error
        settleAck(job, error); job.controller.abort(error)
      }
      return
    }
    if (type === 'cancel') {
      if (active?.id === id && active.session === message.session) { active.cancelled = true; active.controller.abort() }
      return
    }
    if (type === 'release') {
      if (active?.session === message.session) { active.cancelled = true; active.controller.abort() }
      if (session?.id === message.session) session = null
      post(message, 'result', { result: null }); return
    }
    if (active) { post(message, 'error', { error: serializeWorkerError(protocolError('Background worker is busy', 'WORKER_BUSY')) }); return }
    const job = { id, session: message.session, cancelled: false, controller: new AbortController(), fraction: 0, phase: '', reportAt: 0,
      nextSeq: 0, waitingAck: null }
    active = job
    try {
      if (type === 'parse') {
        session = null
        progress(job, 0, 'decompress')
        const data = await parse(message.bytes, fraction => progress(job, fraction, fraction < .5 ? 'decompress' : 'parse'), {
          ...message.options,
          onStage: detail => progress(job, job.fraction, 'decompress', detail),
        })
        check(job)
        const result = serializeSchematic(data)
        // Retain only the store needed for neighbour queries. In particular,
        // hundreds of thousands of block-entity NBT objects stay only on main.
        session = { id: message.session, blocks: data.blocks, bounds: data.bounds }
        const retained = new Set(transferBuffers(result.blocks))
        const transfers = transferBuffers(result, retained)
        progress(job, 1, 'parse')
        post(job, 'result', { result }, transfers)
      } else if (type === 'build' || type === 'build-stream') {
        if (!session || session.id !== message.session) throw protocolError('Background schematic session expired', 'WORKER_SESSION')
        if (!Array.isArray(message.palette)) throw protocolError('Missing baked block palette')
        const filter = filterFromDescriptor(message.descriptor)
        const input = message.options || {}, include = input.includeGroups == null ? null : new Set(input.includeGroups)
        if (input.keys != null && !Array.isArray(input.keys) && !ArrayBuffer.isView(input.keys)) throw protocolError('Invalid block keys')
        if (input.includeGroups != null && !Array.isArray(input.includeGroups)) throw protocolError('Invalid texture group filter')
        const streaming = type === 'build-stream', batchBytes = streaming ? streamBatchBytes(input.batchBytes) : undefined
        let batchCount = 0
        progress(job, 0, 'count')
        const result = await (streaming ? buildStream : build)(message.palette, session.blocks, session.bounds,
          fraction => {
            check(job)
            // Once geometry emits detailed stages, let those own reporting so
            // a preceding scalar callback cannot throttle away block counts.
            if (!job.detailedProgress) progress(job, fraction, fraction < .5 ? 'count' : 'fill')
          }, filter, {
            keys: input.keys,
            includeGroup: include ? key => include.has(key) : undefined,
            compactFaces: input.compactFaces ?? session.blocks.isPagedBlockStore,
            trackBlocks: !!input.trackBlocks,
            maxGeometryBytes: input.maxGeometryBytes,
            signal: job.controller.signal,
            yieldTask,
            ...(streaming ? {
              batchBytes,
              onLayout: layout => exchange(job, 'layout', { layout }),
              onBatch: async batch => {
                const slabs = snapshotStreamSlabs(batch.slabs, batchBytes)
                const result = await exchange(job, 'batch', { batch }, slabs)
                batchCount++
                return result
              },
            } : {}),
            onStage: detail => {
              job.detailedProgress = true
              progress(job, detail.fraction ?? job.fraction, detail.phase, detail)
            },
          })
        check(job)
        progress(job, 1, 'fill')
        const output = streaming ? { ...result, streamed: true, version: GEOMETRY_STREAM_VERSION, batchCount } : result
        post(job, 'result', { result: output }, transferBuffers(output))
      } else throw protocolError('Unknown background worker command')
    } catch (error) {
      if (type === 'parse' && session?.id === message.session) session = null
      post(job, 'error', { error: serializeWorkerError(job.failure || error) })
    } finally {
      settleAck(job, job.failure || abortError())
      if (active === job) active = null
    }
  }
  return { handle, dispose() {
    if (active) { active.cancelled = true; active.controller.abort() }
    session = null
    disposeScheduler?.()
  } }
}

if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  const scheduler = createWorkerScheduler()
  const controller = createSchematicWorker({ postMessage: (message, transfers) => self.postMessage(message, transfers),
    yieldTask: scheduler.yieldTask, disposeScheduler: scheduler.dispose })
  self.addEventListener('message', event => { void controller.handle(event.data) })
  self.postMessage({ type: 'ready', streamVersion: GEOMETRY_STREAM_VERSION })
}
