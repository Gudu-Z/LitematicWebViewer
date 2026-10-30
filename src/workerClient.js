import { parseLitematica } from './litematica.js'
import { deserializeSchematic, deserializeWorkerError, GEOMETRY_STREAM_VERSION, streamBatchBytes, streamProtocolError,
  validateStreamLayout, validateStreamBatch, validateStreamAck, validateStreamResult } from './workerProtocol.js'

function abortError(reason) {
  if (reason?.name === 'AbortError') return reason
  const error = new Error('Schematic loading was cancelled')
  error.name = 'AbortError'; error.code = 'ABORT_ERR'
  return error
}

function workerError(message, code = 'WORKER_UNAVAILABLE') {
  return Object.assign(new Error(message), { code })
}

const createWorker = () => {
  if (typeof Worker !== 'function') throw workerError('Workers are unavailable')
  return new Worker(new URL('./schematicWorker.js', import.meta.url), { type: 'module' })
}

/** One viewer, one worker and one retained block-store session. */
export class SchematicWorkerClient {
  constructor({ workerFactory = createWorker, parseFallback = parseLitematica, handshakeTimeout = 10000 } = {}) {
    if (!Number.isFinite(handshakeTimeout) || handshakeTimeout <= 0) throw new RangeError('Invalid worker startup timeout')
    this.workerFactory = workerFactory; this.parseFallback = parseFallback; this.handshakeTimeout = handshakeTimeout
    this.worker = null; this.ready = null; this.starting = null; this.pending = new Map()
    this.sessions = new WeakMap(); this.generation = 0; this.serial = 0; this.session = 0; this.operation = 0
    this.disabled = false; this.disposed = false; this.sessionAbort = null; this.streamVersion = 0
  }

  _check(signal, operation) {
    if (signal?.aborted || this.disposed || operation !== undefined && operation !== this.operation) throw abortError(signal?.reason)
  }

  _reset(error = abortError()) {
    this.sessionAbort?.(); this.sessionAbort = null
    const worker = this.worker
    this.worker = null; this.ready = null; this.generation++; this.sessions = new WeakMap(); this.streamVersion = 0
    if (this.starting) {
      clearTimeout(this.starting.timer); this.starting.reject(error); this.starting = null
    }
    for (const request of this.pending.values()) { request.cleanup(); request.stream?.controller.abort(error); request.reject(error) }
    this.pending.clear()
    worker?.terminate()
  }

  _start() {
    if (this.ready) return this.ready
    let worker
    try { worker = this.workerFactory() } catch (error) { return Promise.reject(error) }
    this.worker = worker
    const generation = this.generation
    const current = () => this.worker === worker && this.generation === generation
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (current() && this.starting) this._reset(workerError('Schematic worker startup timed out'))
      }, this.handshakeTimeout)
      this.starting = { resolve, reject, timer }
    })
    worker.onmessage = event => {
      if (!current()) return
      const message = event.data || {}
      if (message.type === 'ready') {
        if (this.starting) { this.streamVersion = message.streamVersion || 0; clearTimeout(this.starting.timer); this.starting.resolve(); this.starting = null }
        return
      }
      const request = this.pending.get(message.id)
      if (!request || request.session !== message.session) return
      if (message.type === 'progress') {
        try { request.onProgress?.(message.fraction, message) } catch (error) { this._reset(error) }
        return
      }
      if (message.type === 'layout' || message.type === 'batch') {
        void this._streamMessage(message, request)
        return
      }
      if (message.type !== 'result' && message.type !== 'error') return
      if (message.type === 'result' && request.stream) {
        try {
          const stream = request.stream
          if (stream.busy || !stream.layout) throw streamProtocolError('Geometry stream result arrived before callbacks completed')
          validateStreamResult(message.result, stream.layout, stream.cursors, stream.batchCount)
        } catch (error) { this._reset(error); return }
      }
      this.pending.delete(message.id); request.cleanup()
      if (message.type === 'error') {
        const error = deserializeWorkerError(message.error)
        request.stream?.controller.abort(error); request.reject(error)
      }
      else request.resolve(message.result)
    }
    const fail = event => {
      if (!current()) return
      event.preventDefault?.()
      this._reset(workerError(event.message || 'Schematic worker stopped unexpectedly', this.starting ? 'WORKER_UNAVAILABLE' : 'WORKER_CRASHED'))
    }
    worker.onerror = fail
    worker.onmessageerror = () => fail({ message: 'Schematic worker returned unreadable data' })
    return this.ready
  }

  _request(type, payload, onProgress, signal, streamHandlers) {
    this._check(signal)
    if (!this.worker || this.starting) return Promise.reject(workerError('Schematic worker session is unavailable', 'WORKER_SESSION_LOST'))
    if (this.pending.size) return Promise.reject(workerError('Schematic worker is already busy', 'WORKER_BUSY'))
    const id = ++this.serial, session = this.session
    return new Promise((resolve, reject) => {
      const abort = () => this._reset(abortError(signal.reason))
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const stream = streamHandlers ? { ...streamHandlers, controller: new AbortController(), nextSeq: 0, batchCount: 0, layout: null, cursors: [], busy: false } : null
      if (stream) stream.context = { signal: stream.controller.signal, id, session }
      this.pending.set(id, { session, resolve, reject, onProgress, cleanup, stream, worker: this.worker })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        // Never detach a caller-owned input or the main thread's block pages.
        // The worker transfers its newly created geometry buffers in the reply.
        this.worker.postMessage({ ...payload, type, id, session })
      } catch (error) { this._reset(error) }
    })
  }

  async _streamMessage(message, request) {
    const current = () => this.worker === request.worker && this.pending.get(message.id) === request
    if (!current()) return
    try {
      const stream = request.stream
      if (!stream || stream.busy || message.seq !== stream.nextSeq) throw streamProtocolError('Unexpected geometry stream packet')
      stream.busy = true
      let slabs = [], nextCursors
      if (message.type === 'layout') {
        if (stream.layout || message.seq !== 0) throw streamProtocolError('Repeated geometry stream layout')
        stream.layout = validateStreamLayout(message.layout)
        stream.cursors = stream.layout.groups.map(() => 0)
        await stream.onLayout(message.layout, stream.context)
      } else {
        if (!stream.layout) throw streamProtocolError('Geometry stream batch arrived without a layout')
        const snapshot = validateStreamBatch(message.batch, stream.layout, stream.cursors, stream.batchBytes)
        slabs = snapshot.slabs; nextCursors = snapshot.nextCursors
        // Views are borrowed until this promise settles. Capture their backing
        // buffers before consumer code can mutate any callback payload fields.
        await stream.onBatch(message.batch, stream.context)
      }
      if (!current() || stream.controller.signal.aborted) return
      const returned = validateStreamAck(slabs, slabs)
      if (nextCursors) { stream.cursors = nextCursors; stream.batchCount++ }
      stream.nextSeq++; stream.busy = false
      request.worker.postMessage({ type: 'ack', id: message.id, session: request.session, seq: message.seq, slabs: returned }, returned.map(slab => slab.buffer))
    } catch (error) {
      // Abort/crash can settle the request while its asynchronous sink still
      // runs. A late rejection must never tear down a newer file's worker.
      if (current()) this._reset(error)
    }
  }

  async parse(bytes, onProgress, { signal, ...options } = {}) {
    this._check(signal)
    const operation = ++this.operation
    this._reset(); this.session++
    if (!this.disabled) {
      const abort = () => this._reset(abortError(signal.reason))
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await this._start()
      } catch (error) {
        this._check(signal, operation)
        // Only failure before the ready handshake falls back. Runtime parsing
        // or geometry failures must not silently restart a huge job on the UI.
        this.disabled = true
        this._reset(error)
      } finally { signal?.removeEventListener('abort', abort) }
      this._check(signal, operation)
    }
    if (this.disabled) {
      let latestFraction = 0
      const data = await this.parseFallback(bytes, (fraction, detail) => {
        latestFraction = fraction
        this._check(signal, operation); onProgress?.(fraction, detail)
      }, { ...options, signal, onStage: detail => {
        // Native decompression may have no numeric progress until it finishes.
        // Its real output chunks provide cancellation checks and useful byte
        // counts without inventing a percentage or changing parser callbacks.
        this._check(signal, operation)
        options.onStage?.(detail)
        this._check(signal, operation)
        const phase = detail.phase || 'decompress'
        onProgress?.(latestFraction, {
          type: 'progress', id: operation, session: this.session, phase,
          fraction: latestFraction,
          stageFraction: Math.min(1, Math.max(0, phase === 'parse' ? latestFraction * 2 - 1 : latestFraction * 2)),
          detail,
        })
        this._check(signal, operation)
      } })
      this._check(signal, operation)
      return data
    }
    const result = await this._request('parse', { bytes, options }, onProgress, signal)
    this._check(signal, operation)
    let data
    try { data = deserializeSchematic(result) } catch (error) { this._reset(error); throw error }
    this.sessions.set(data, { generation: this.generation, session: this.session })
    if (signal) {
      const abort = () => this.cancel(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      this.sessionAbort = () => signal.removeEventListener('abort', abort)
    }
    return data
  }

  canBuild(data) {
    const session = this.sessions.get(data)
    return !!(this.worker && !this.starting && session?.generation === this.generation && session.session === this.session)
  }

  canStream(data) { return this.streamVersion === GEOMETRY_STREAM_VERSION && this.canBuild(data) }

  async build(data, { palette = data.palette, descriptor = null, ...options } = {}, onProgress, { signal, maxGeometryBytes } = {}) {
    this._check(signal)
    if (!this.canBuild(data)) throw workerError('Schematic worker session is unavailable', 'WORKER_SESSION_LOST')
    const operation = this.operation
    if (maxGeometryBytes !== undefined) options.maxGeometryBytes = maxGeometryBytes
    const result = await this._request('build', { palette, descriptor, options }, onProgress, signal)
    this._check(signal, operation)
    return result
  }

  /** onBatch views are borrowed and detached after its async callback finishes. */
  async buildStream(data, { palette = data.palette, descriptor = null, ...options } = {},
    { onProgress, onLayout, onBatch } = {}, { signal, maxGeometryBytes, batchBytes } = {}) {
    this._check(signal)
    if (!this.canStream(data)) throw workerError('Schematic worker streaming is unavailable', 'WORKER_STREAM_UNAVAILABLE')
    if (typeof onLayout !== 'function' || typeof onBatch !== 'function') throw new TypeError('Geometry stream requires layout and batch callbacks')
    const operation = this.operation, budget = streamBatchBytes(batchBytes)
    if (maxGeometryBytes !== undefined) options.maxGeometryBytes = maxGeometryBytes
    options.batchBytes = budget
    const result = await this._request('build-stream', { palette, descriptor, options }, onProgress, signal,
      { onLayout, onBatch, batchBytes: budget })
    this._check(signal, operation)
    return result
  }

  release(data) {
    const active = this.canBuild(data)
    this.sessions.delete(data)
    if (active) { this.operation++; this._reset() }
  }

  cancel(reason) { this.operation++; this._reset(abortError(reason)) }
  dispose() { this.disposed = true; this.cancel() }
}
