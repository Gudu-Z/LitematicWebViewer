import { Box3, Sphere, Vector3 } from 'three'
import { throwIfAborted, withAbort } from './loadingTask.js'
import { createWorkerScheduler } from './workerScheduler.js'

const MAX_FRAME_BYTES = 8 * 1024 ** 2
const adapters = new WeakMap()
let activeUploader = null
const abortError = () => Object.assign(new Error('GPU preparation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })
const source = attribute => attribute?.isInterleavedBufferAttribute ? attribute.data : attribute
const waitForGPU = () => new Promise(resolve => setTimeout(resolve, 4))

function typeOf(gl, array, half = false) {
  if (half) return gl.HALF_FLOAT
  if (array instanceof Float32Array) return gl.FLOAT
  if (array instanceof Uint32Array) return gl.UNSIGNED_INT
  if (array instanceof Int32Array) return gl.INT
  if (array instanceof Uint16Array) return gl.UNSIGNED_SHORT
  if (array instanceof Int16Array) return gl.SHORT
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return gl.UNSIGNED_BYTE
  if (array instanceof Int8Array) return gl.BYTE
  throw new TypeError('Unsupported GPU attribute array')
}

// Only the renderer currently inside its synchronous draw sees native buffers.
// CPU picking/cloning and another renderer (the image exporter) retain normal
// BufferAttribute/InterleavedBuffer behavior and their own context's VBO cache.
function adapt(data, uploader, record) {
  let adapter = adapters.get(data)
  if (!adapter) {
    const descriptors = new Map(['isGLBufferAttribute', 'buffer', 'type', 'elementSize', 'version']
      .map(key => [key, Object.getOwnPropertyDescriptor(data, key)]))
    const managers = new Map()
    let version = data.version
    const current = () => managers.get(activeUploader)
    adapter = { data, descriptors, managers, getVersion: () => version }
    for (const [key, get] of Object.entries({
      isGLBufferAttribute: () => !!current(),
      buffer: () => current()?.buffer,
      type: () => current()?.type,
      elementSize: () => data.array.BYTES_PER_ELEMENT,
    })) Object.defineProperty(data, key, { configurable: true, get })
    Object.defineProperty(data, 'version', {
      configurable: true, enumerable: true, get: () => version,
      set(value) {
        if (version === value) return
        version = value
        for (const [manager, value] of managers) manager._markDirty(value)
      },
    })
    adapters.set(data, adapter)
  }
  adapter.managers.set(uploader, record)
  record.bindings.add(data)
  return adapter
}

function unadapt(data, uploader) {
  const adapter = adapters.get(data)
  if (!adapter) return
  adapter.managers.delete(uploader)
  if (adapter.managers.size) return
  for (const [key, descriptor] of adapter.descriptors) {
    if (descriptor) Object.defineProperty(data, key, key === 'version' ? { ...descriptor, value: adapter.getVersion() } : descriptor)
    else delete data[key]
  }
  adapters.delete(data)
}

function addRange(ranges, start, end) {
  if (start >= end) return
  const last = ranges.at(-1)
  if (!last || start > last[1]) { ranges.push([start, end]); return }
  if (start >= last[0]) { last[1] = Math.max(last[1], end); return }
  let first = 0
  while (first < ranges.length && ranges[first][1] < start) first++
  let next = first
  while (next < ranges.length && ranges[next][0] <= end) {
    start = Math.min(start, ranges[next][0]); end = Math.max(end, ranges[next][1]); next++
  }
  ranges.splice(first, next - first, [start, end])
}

/** Lossless, context-local staging for immutable block geometry. Offsets/counts
 * are typed-array elements. The caller retains the final CPU arrays throughout.
 * Clear the scene's geometries before clear(); releaseUnused() frees unattached
 * layouts, while geometry.dispose() releases attached buffers automatically. */
export class GPUUpload {
  constructor(renderer, { onReady, onPending, onError, frameBytes = MAX_FRAME_BYTES, frameMilliseconds = 8, yieldFrame, now = () => performance.now() } = {}) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 4 || frameBytes > MAX_FRAME_BYTES) throw new RangeError('Invalid GPU upload budget')
    this.renderer = renderer; this.gl = renderer.getContext()
    this.onReady = onReady; this.onPending = onPending; this.onError = onError
    this._scheduler = yieldFrame ? null : createWorkerScheduler()
    this.frameBytes = frameBytes; this.frameMilliseconds = frameMilliseconds; this.yieldFrame = yieldFrame ?? this._scheduler.yieldTask; this.now = now
    this.records = new Map(); this.geometries = new Map(); this.signalRecords = new Map()
    this.dirty = new Set(); this.fences = new Set(); this._tail = Promise.resolve()
    this._lifetime = new AbortController(); this._epoch = 0; this._generation = 0
    this._frameBytes = 0; this._frameCPU = 0; this._boundsCPU = 0; this._queued = 0; this._disposed = false
    this._lost = false; this._automatic = null; this._automaticPending = false; this._failed = null; this._uncheckedAllocation = false
    this._originalRender = renderer.render
    const uploader = this
    this._render = function (...args) {
      if (uploader.pending) return
      const previous = activeUploader
      activeUploader = uploader
      try { return uploader._originalRender.apply(this, args) }
      finally { activeUploader = previous }
    }
    renderer.render = this._render
    this._onLost = () => {
      if (this._lost || this._disposed) return
      this._lost = true; this._generation++
      this._uncheckedAllocation = false
      this._restored = new Promise(resolve => { this._restore = resolve })
      for (const record of this.records.values()) {
        record.buffer = null
        if (record.owners.size) this.dirty.add(record)
      }
      this._scheduleRefresh()
    }
    this._onRestored = () => { this._lost = false; this._restore?.(); this._restore = null; this._scheduleRefresh() }
    renderer.domElement?.addEventListener('webglcontextlost', this._onLost)
    renderer.domElement?.addEventListener('webglcontextrestored', this._onRestored)
    if (this.gl.isContextLost?.()) this._onLost()
  }

  get pending() { return this._lost || this._queued > 0 || this._automaticPending }

  _check(signal, epoch = this._epoch) {
    throwIfAborted(signal)
    if (this._disposed || epoch !== this._epoch) throw abortError()
  }

  async _wait(promise, signal) {
    return withAbort(withAbort(promise, this._lifetime.signal), signal)
  }

  async _context(signal, epoch = this._epoch) {
    if (!this._lost && this.gl.isContextLost?.()) this._onLost()
    if (this._lost) await this._wait(this._restored, signal)
    this._check(signal, epoch)
  }

  _record(array, index = false) {
    let record = this.records.get(array)
    if (record && record.index !== index) throw new Error('GPU array cannot be shared by index and vertex attributes')
    if (!record) {
      if (!ArrayBuffer.isView(array) || !array.BYTES_PER_ELEMENT) throw new TypeError('GPU upload requires a typed array')
      record = { array, index, buffer: null, type: typeOf(this.gl, array), ranges: [], owners: new Set(), bindings: new Set(), signals: new Set() }
      this.records.set(array, record)
    }
    return record
  }

  _trackSignal(record, signal) {
    if (!signal || record.signals.has(signal)) return
    let entry = this.signalRecords.get(signal)
    if (!entry) {
      const records = new Set(), abort = () => { for (const record of [...records]) this.releaseArray(record.array) }
      entry = { records, abort }; this.signalRecords.set(signal, entry)
      signal.addEventListener('abort', abort, { once: true })
    }
    entry.records.add(record); record.signals.add(signal)
  }

  async _boundary(signal, epoch = this._epoch) {
    const gl = this.gl, generation = this._generation
    let sync, waited = false, polls = 0
    try {
      if (!this._lost && gl.fenceSync) {
        sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
        if (sync) this.fences.add(sync)
        gl.flush()
        while (sync && generation === this._generation && !this._lost) {
          const status = gl.clientWaitSync(sync, 0, 0)
          if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
          if (status === gl.WAIT_FAILED) throw new Error('GPU upload fence failed')
          // Give input/paint/worker replies a real task boundary without paying
          // a display frame for every small transfer. Back off if the driver is
          // still busy; a short timer also works when a background tab stops RAF.
          await this._wait(polls++ < 2 ? this.yieldFrame() : waitForGPU(), signal); waited = true
        }
      }
      if (!waited) await this._wait(this.yieldFrame(), signal)
      this._check(signal, epoch)
      this._frameBytes = 0; this._frameCPU = 0
      if (generation === this._generation && !this._lost) this._readErrors()
    } finally {
      if (sync) {
        this.fences.delete(sync)
        if (generation === this._generation && !this._lost) gl.deleteSync(sync)
      }
    }
  }

  _readErrors() {
    if (!this._uncheckedAllocation) return
    this._uncheckedAllocation = false
    const began = performance.now(), error = this.gl.getError()
    this._frameCPU += performance.now() - began
    if (error && error !== this.gl.CONTEXT_LOST_WEBGL) {
      // Clear additional errors from the failed allocation/copy commands so a
      // subsequent reload does not inherit them. Normal batches query once.
      for (let n = 0; n < 16 && this.gl.getError(); n++) { /* Drain failure only. */ }
      throw new Error('GPU buffer allocation failed: ' + error)
    }
  }

  async _validate(signal, epoch = this._epoch) {
    this._check(signal, epoch)
    if (this._uncheckedAllocation) await this._boundary(signal, epoch)
  }

  async _copy(record, start, end, signal, remember = true, epoch = this._epoch) {
    const gl = this.gl, array = record.array, bytes = array.BYTES_PER_ELEMENT
    while (start < end) {
      this._check(signal, epoch)
      await this._context(signal, epoch)
      if (!record.buffer) await this._allocate(record, signal, epoch)
      if (this._frameBytes + bytes > this.frameBytes || this._frameCPU >= this.frameMilliseconds) await this._boundary(signal, epoch)
      this._check(signal, epoch)
      if (this._lost || !record.buffer) continue
      const count = Math.min(end - start, Math.floor((this.frameBytes - this._frameBytes) / bytes))
      const began = performance.now()
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, record.buffer)
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, start * bytes, array, start, count)
      // Later slices and dirty updates can fail even when allocation passed.
      // Keep validation pending for both allocation and copy commands.
      this._uncheckedAllocation = true
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, null)
      this._frameCPU += performance.now() - began; this._frameBytes += count * bytes
      if (this._lost || gl.isContextLost?.()) { await this._context(signal, epoch); continue }
      if (remember) addRange(record.ranges, start, start + count)
      start += count
    }
  }

  async _allocate(record, signal, epoch = this._epoch) {
    await this._context(signal, epoch)
    this._check(signal, epoch)
    if (record.buffer) return
    const gl = this.gl, buffer = gl.createBuffer()
    if (!buffer) throw new Error('Cannot allocate GPU buffer')
    if (record.index) {
      // WebGL fixes a buffer's element/non-element kind at its first binding.
      // COPY_WRITE first would make subsequent index draws invalid. A private
      // VAO labels indices without touching Three's cached VAO element binding.
      const previous = gl.getParameter(gl.VERTEX_ARRAY_BINDING), vao = gl.createVertexArray()
      if (!vao) { gl.deleteBuffer(buffer); throw new Error('Cannot prepare GPU index buffer') }
      try { gl.bindVertexArray(vao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer) }
      finally { gl.bindVertexArray(previous); gl.deleteVertexArray(vao) }
    }
    const began = performance.now()
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer)
    gl.bufferData(gl.COPY_WRITE_BUFFER, record.array.byteLength, gl.STATIC_DRAW)
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null)
    this._frameCPU += performance.now() - began
    // getError can synchronize with the GPU process. Validate a whole batch
    // after its fence instead of issuing thousands of per-attribute round trips.
    this._uncheckedAllocation = true
    if (this._lost || gl.isContextLost?.()) { await this._context(signal, epoch); return this._allocate(record, signal, epoch) }
    record.buffer = buffer
    // Context restoration replays only bytes actually received by a streaming
    // layout. Unfilled tail cells must not become a substitute for later batches.
    for (const [start, end] of record.ranges) await this._copy(record, start, end, signal, false, epoch)
  }

  uploadRange(array, offset, count, { signal, index = false } = {}) {
    this._check(signal)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset + count > array.length) throw new RangeError('Invalid GPU upload range')
    if (!count) return Promise.resolve()
    const epoch = this._epoch
    this._queued++
    const task = this._tail.then(async () => {
      this._check(signal, epoch)
      const record = this._record(array, index)
      this._trackSignal(record, signal)
      await this._copy(record, offset, offset + count, signal, true, epoch)
      this._check(signal, epoch)
    }).finally(() => { this._queued-- })
    this._tail = task.catch(() => {})
    return task
  }

  _markDirty(record) {
    if (this._disposed || !this.records.has(record.array)) return
    for (const data of record.bindings) if (data.array !== record.array) throw new Error('Reattach GPU attributes after replacing their arrays')
    this.dirty.add(record); this._scheduleRefresh()
  }

  _scheduleRefresh() {
    if (this._automatic || this._disposed || this._failed) return
    this._automaticPending = true; this.onPending?.()
    const epoch = this._epoch
    const task = Promise.resolve().then(async () => {
      await this._context(undefined, epoch)
      while (this.dirty.size) {
        this._check(undefined, epoch)
        const record = this.dirty.values().next().value
        this.dirty.delete(record)
        if (!record.owners.size || !this.records.has(record.array)) continue
        await this.uploadRange(record.array, 0, record.array.length, { index: record.index })
      }
      await this._validate(undefined, epoch)
    }).catch(error => {
      if (error.name !== 'AbortError' && epoch === this._epoch) { this._failed = error; this.onError?.(error) }
    }).finally(() => {
      if (this._automatic !== task) return
      this._automatic = null
      if (epoch !== this._epoch || this._disposed) return
      if (this._failed) return // Never expose a partially restored scene.
      this._automaticPending = false
      if (this.dirty.size) this._scheduleRefresh()
      else if (!this._lost) this.onReady?.()
    })
    this._automatic = task
  }

  attachGeometry(geometry, { skipIndex = false } = {}) {
    this._check()
    let entry = this.geometries.get(geometry)
    if (!entry) {
      const dispose = () => this._detachGeometry(geometry)
      entry = { records: new Set(), dispose }; this.geometries.set(geometry, entry)
      geometry.addEventListener('dispose', dispose)
    }
    for (const attribute of [...Object.values(geometry.attributes), ...(!skipIndex && geometry.index ? [geometry.index] : [])]) {
      const data = source(attribute)
      if (!data?.array?.byteLength) continue
      const record = this.records.get(data.array)
      if (!record?.buffer || record.ranges.length !== 1 || record.ranges[0][0] !== 0 || record.ranges[0][1] !== data.array.length) {
        throw new Error('GPU attribute must be completely uploaded before attachment')
      }
      record.type = typeOf(this.gl, data.array, data.isFloat16BufferAttribute)
      record.owners.add(geometry); entry.records.add(record)
      adapt(data, this, record)
    }
  }

  async _bounds(geometry, signal) {
    const epoch = this._epoch
    this._check(signal, epoch)
    const position = geometry.attributes.position
    if (!position || geometry.boundingBox && geometry.boundingSphere || geometry.morphAttributes?.position?.length) return
    const box = new Box3(), point = new Vector3(), center = new Vector3()
    // Preserve Three's vertex order and exact box-centered sphere. Small scans
    // share a CPU budget rather than each paying an unconditional RAF wait.
    let began = this.now()
    const exhausted = () => this._boundsCPU + this.now() - began >= this.frameMilliseconds
    const pause = async () => {
      await this._wait(this.yieldFrame(), signal); this._check(signal, epoch)
      this._boundsCPU = 0; began = this.now()
    }
    if (this._boundsCPU >= this.frameMilliseconds) await pause()
    let sinceYield = 0
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i); box.expandByPoint(point)
      if ((++sinceYield & 32767) === 0) {
        this._check(signal, epoch)
        if (exhausted()) await pause()
      }
    }
    if (!geometry.boundingBox) geometry.boundingBox = box
    if (!geometry.boundingSphere) {
      box.getCenter(center)
      let radiusSq = 0
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i); radiusSq = Math.max(radiusSq, center.distanceToSquared(point))
        if ((++sinceYield & 32767) === 0) {
          this._check(signal, epoch)
          if (exhausted()) await pause()
        }
      }
      geometry.boundingSphere = new Sphere(center, Math.sqrt(radiusSq))
    }
    this._boundsCPU += this.now() - began
  }

  async prepareObject(root, { signal, onProgress, skipIndex } = {}) {
    this._check(signal)
    const epoch = this._epoch
    const geometries = new Map()
    root.traverse(object => {
      if (!object.geometry) return
      const dynamic = typeof skipIndex === 'function' ? skipIndex(object) : skipIndex ?? [object.material].flat().some(mat => mat?.translucentMaps)
      geometries.set(object.geometry, !!dynamic || geometries.get(object.geometry) === true)
    })
    const arrays = new Map()
    for (const [geometry, skip] of geometries) for (const attribute of [...Object.values(geometry.attributes), ...(!skip && geometry.index ? [geometry.index] : [])]) {
      const array = source(attribute)?.array
      if (array?.byteLength) arrays.set(array, attribute === geometry.index)
    }
    const total = [...arrays.keys()].reduce((bytes, array) => bytes + array.byteLength, 0)
    let complete = 0
    for (const [array, index] of arrays) {
      const record = this.records.get(array)
      if (!record?.buffer || record.ranges.length !== 1 || record.ranges[0][0] !== 0 || record.ranges[0][1] !== array.length) await this.uploadRange(array, 0, array.length, { signal, index })
      complete += array.byteLength; onProgress?.(total ? complete / total : 1)
    }
    await this._validate(signal, epoch)
    for (const [geometry, skip] of geometries) {
      await this._bounds(geometry, signal)
      // Bounds can yield before this geometry has an owner. A context loss in
      // that interval cannot rely on the attached-scene restoration queue.
      await this._context(signal, epoch)
      for (const attribute of [...Object.values(geometry.attributes), ...(!skip && geometry.index ? [geometry.index] : [])]) {
        const array = source(attribute)?.array
        if (array?.byteLength && !this.records.get(array)?.buffer) await this.uploadRange(array, 0, array.length, { signal, index: attribute === geometry.index })
      }
      this._check(signal, epoch); this.attachGeometry(geometry, { skipIndex: skip })
    }
    await this._validate(signal, epoch)
    onProgress?.(1)
  }

  _detachGeometry(geometry) {
    const entry = this.geometries.get(geometry)
    if (!entry) return
    geometry.removeEventListener('dispose', entry.dispose); this.geometries.delete(geometry)
    for (const record of entry.records) {
      record.owners.delete(geometry)
      if (!record.owners.size) this._release(record)
    }
  }

  _release(record) {
    this.dirty.delete(record)
    for (const data of record.bindings) unadapt(data, this)
    record.bindings.clear()
    if (record.buffer && !this._lost) this.gl.deleteBuffer(record.buffer)
    record.buffer = null; this.records.delete(record.array)
    for (const signal of record.signals) {
      const entry = this.signalRecords.get(signal)
      entry?.records.delete(record)
      if (entry && !entry.records.size) { signal.removeEventListener('abort', entry.abort); this.signalRecords.delete(signal) }
    }
    record.signals.clear()
  }

  releaseArray(array) { const record = this.records.get(array); if (record && !record.owners.size) this._release(record) }
  releaseUnused() { for (const record of [...this.records.values()]) if (!record.owners.size) this._release(record) }

  clear() {
    this._epoch++; this._lifetime.abort(); this._lifetime = new AbortController()
    // Geometry ownership belongs to the viewer; do not dispose a shared scene
    // merely because one context (e.g. an export renderer) is going away.
    for (const geometry of [...this.geometries.keys()]) this._detachGeometry(geometry)
    for (const record of [...this.records.values()]) this._release(record)
    this.dirty.clear(); this._automatic = null; this._automaticPending = false; this._failed = null; this._uncheckedAllocation = false; this._frameBytes = 0; this._frameCPU = 0; this._boundsCPU = 0
  }

  dispose() {
    if (this._disposed) return
    this.clear(); this._disposed = true; this._lifetime.abort()
    this._scheduler?.dispose()
    this.renderer.domElement?.removeEventListener('webglcontextlost', this._onLost)
    this.renderer.domElement?.removeEventListener('webglcontextrestored', this._onRestored)
    if (this.renderer.render === this._render) this.renderer.render = this._originalRender
  }
}
