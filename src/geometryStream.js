import { CompactFaceData, canCompactFaces } from './compactFaceData.js'
import { geometryLimit } from './geometryBudget.js'
import { throwIfAborted, withAbort } from './loadingTask.js'

export const MAX_GEOMETRY_BATCH_BYTES = 32 * 1024 ** 2
const SLAB_BYTES = 256 * 1024
const STREAM_STATE = Symbol('geometryStreamState')
const TYPES = { Float32Array, Float64Array, Uint16Array, Uint32Array }
const align = (value, size) => Math.ceil(value / size) * size
const fail = message => Object.assign(new Error(message), { code: 'WORKER_PROTOCOL', reason: 'geometry-stream' })

export function validateGeometryStream(options) {
  const bytes = options.batchBytes ?? MAX_GEOMETRY_BATCH_BYTES
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > MAX_GEOMETRY_BATCH_BYTES) throw new RangeError('Invalid geometry staging budget')
  if (typeof options.onLayout !== 'function' || typeof options.onBatch !== 'function') throw new TypeError('Geometry streaming requires layout and batch consumers')
  return bytes
}

function fieldsFor(kind, count, bounds, trackBlocks) {
  const field = (name, type, stride) => ({ name, type, stride, length: count * stride })
  const wide = bounds.width * bounds.height * bounds.depth > 2 ** 32
  if (kind === 'compact') return [field('cells', 'Uint32Array', 1), field('templateIds', 'Uint32Array', 1),
    ...(wide ? [field('cellYs', 'Uint32Array', 1)] : [])]
  if (kind === 'points') return [field('positions', 'Float32Array', 3)]
  return [field('positions', 'Float32Array', 12), field('uvs', 'Float32Array', 8),
    field('indices', count * 4 < 65536 ? 'Uint16Array' : 'Uint32Array', 6),
    ...(trackBlocks ? [field('blockKeys', wide ? 'Float64Array' : 'Uint32Array', 1)] : [])]
}

function segmentSize(fields, count) {
  let bytes = 0
  for (const field of fields) {
    const size = TYPES[field.type].BYTES_PER_ELEMENT
    bytes = align(bytes, size) + count * field.stride * size
  }
  return bytes
}

// Only face/point records use the slab pool. Global compact template interning
// and batch bounds persist until the tail, so segment boundaries never change
// IDs, Float32 corrections, source keys or the 4,096-face spatial batches.
export class GeometryStream {
  constructor(counts, bounds, options, emitted, geometryBytes) {
    const batchBytes = validateGeometryStream(options)
    this.options = options; this.bounds = bounds; this.geometryBytes = geometryBytes; this.emitted = emitted
    this.slabBytes = Math.min(SLAB_BYTES, batchBytes)
    this.maxSlabs = Math.floor(batchBytes / this.slabBytes)
    this.createdSlabs = 0; this.free = []; this.pending = []; this.active = new Set(); this.batchCount = 0
    this.groups = new Map(); this.states = []
    const specs = []
    for (const [key, count] of counts) {
      const kind = options.compactFaces && canCompactFaces(bounds, key) ? 'compact' : key === 'particle/bubble' ? 'points' : 'quads'
      const buffers = fieldsFor(kind, count, bounds, options.trackBlocks)
      const spec = { groupIndex: specs.length, key, kind, count, buffers }
      specs.push(spec)
      const recordBytes = buffers.reduce((bytes, field) => bytes + field.stride * TYPES[field.type].BYTES_PER_ELEMENT, 0)
      let capacity = Math.min(count, Math.floor(this.slabBytes / recordBytes))
      while (segmentSize(buffers, capacity) > this.slabBytes) capacity--
      if (!capacity) throw new RangeError('Geometry staging buffer cannot fit a record')
      const group = kind === 'compact' ? new CompactFaceData(count, bounds, { recordCapacity: 0 })
        : kind === 'points' ? { positions: null, v: 0 } : { positions: null, uvs: null, indices: null, v: 0, f: 0 }
      const state = { spec, group, capacity, start: 0, next: 0, slab: null }
      group.recordLimit = 0
      group[STREAM_STATE] = state
      this.groups.set(key, group); this.states.push(state)
    }
    this.layout = { version: 1, bounds, emitted, geometryBytes, groups: specs }
  }

  async start() {
    throwIfAborted(this.options.signal)
    await withAbort(this.options.onLayout(this.layout), this.options.signal)
    throwIfAborted(this.options.signal)
  }

  used(state) {
    return state.spec.kind === 'compact' ? state.group.cursor - state.start
      : state.group.v / (state.spec.kind === 'points' ? 3 : 4)
  }

  retire(state) {
    if (!state.slab) return
    const count = this.used(state), buffers = {}
    for (const field of state.spec.buffers) {
      buffers[field.name] = state.group[field.name].subarray(0, count * field.stride)
      state.group[field.name] = null
    }
    if (count) this.pending.push({ slab: state.slab, part: { groupIndex: state.spec.groupIndex, start: state.start, count, buffers } })
    else this.free.push(state.slab)
    state.next = state.start + count; state.slab = null; this.active.delete(state)
    state.group.recordLimit = 0
  }

  // Synchronous fast path per record. Only an exhausted pool causes the caller
  // to await flushFor; no promise is created for an ordinary emitted face.
  prepare(group) {
    const state = group[STREAM_STATE]
    if (state.slab && this.used(state) < state.capacity) return true
    this.retire(state)
    if (state.next >= state.spec.count) throw new Error('Streamed geometry exceeded its counted records')
    let slab = this.free.pop()
    if (!slab) {
      if (this.createdSlabs === this.maxSlabs) return false
      slab = { slabId: this.createdSlabs++, buffer: new ArrayBuffer(this.slabBytes) }
    }
    state.slab = slab; state.start = state.next
    let offset = 0
    for (const field of state.spec.buffers) {
      const Type = TYPES[field.type]
      offset = align(offset, Type.BYTES_PER_ELEMENT)
      group[field.name] = new Type(slab.buffer, offset, state.capacity * field.stride)
      offset += group[field.name].byteLength
    }
    if (state.spec.kind === 'compact') group.recordBase = state.start
    else {
      group.v = 0
      if (state.spec.kind === 'quads') { group.f = 0; group.vertexBase = state.start * 4 }
    }
    group.recordLimit = state.spec.kind === 'compact' ? state.start + state.capacity
      : state.capacity * (state.spec.kind === 'points' ? 3 : 4)
    this.active.add(state)
    return true
  }

  async flushFor(group) {
    await this.flush()
    if (!this.prepare(group)) throw new Error('Geometry staging buffer was not returned')
  }

  async flush() {
    throwIfAborted(this.options.signal)
    // Visit only resident segments (bounded by the slab pool), not every group.
    for (const state of this.active) this.retire(state)
    if (!this.pending.length) return
    const records = this.pending; this.pending = []
    const expected = new Map(records.map(({ slab }) => [slab.slabId, slab]))
    const batch = { parts: records.map(record => record.part), slabs: records.map(({ slab }) => ({ slabId: slab.slabId, buffer: slab.buffer })) }
    const reply = await withAbort(this.options.onBatch(batch), this.options.signal)
    throwIfAborted(this.options.signal)
    if (!Array.isArray(reply?.slabs) || reply.slabs.length !== expected.size) throw fail('Missing recycled geometry slabs')
    const seen = new Set(), buffers = new Set()
    for (const returned of reply.slabs) {
      const slab = expected.get(returned?.slabId)
      if (!slab || seen.has(returned.slabId) || !(returned.buffer instanceof ArrayBuffer)
        || returned.buffer.byteLength !== this.slabBytes || buffers.has(returned.buffer)) throw fail('Invalid recycled geometry slab')
      seen.add(returned.slabId); buffers.add(returned.buffer)
    }
    for (const returned of reply.slabs) {
      const slab = expected.get(returned.slabId)
      slab.buffer = returned.buffer; this.free.push(slab)
    }
    this.batchCount++
  }

  async finish() {
    await this.flush()
    const tails = []
    for (const state of this.states) {
      throwIfAborted(this.options.signal)
      const { spec, group } = state
      if (state.next !== spec.count) throw new Error('Streamed geometry count mismatch')
      let metadata
      if (spec.kind === 'compact') {
        group.finish()
        this.geometryBytes = geometryLimit(this.geometryBytes + group.templateData.byteLength, this.options.maxGeometryBytes)
        const body = new Set(spec.buffers.map(field => field.name))
        metadata = Object.fromEntries(Object.entries(group).filter(([name]) => !body.has(name) && name !== 'recordBase' && name !== 'recordLimit'))
      } else metadata = spec.kind === 'points' ? { v: spec.count * 3 } : { v: spec.count * 4, f: spec.count * 6 }
      tails.push({ groupIndex: spec.groupIndex, metadata })
    }
    this.free = []
    return { streamed: true, version: 1, emitted: this.emitted, geometryBytes: this.geometryBytes, batchCount: this.batchCount, tails }
  }

  dispose() {
    for (const state of this.active) {
      for (const field of state.spec.buffers) state.group[field.name] = null
      state.slab = null
    }
    this.active.clear(); this.pending = []; this.free = []
  }
}
