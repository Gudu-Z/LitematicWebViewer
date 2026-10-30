import { geometryLimit } from './geometryBudget.js'
import { FACE_BATCH_SIZE } from './compactFaceData.js'
import { throwIfAborted } from './loadingTask.js'

const types = { Float32Array, Float64Array, Uint16Array, Uint32Array }
const yieldThread = () => new Promise(resolve => setTimeout(resolve, 0))
const invalid = () => { throw new Error('Invalid streamed geometry') }

// Retain one final array per original texture group. Incoming slabs are borrowed
// until acceptBatch resolves, then transferred back to the worker for reuse.
// Neither mesh order nor face order depends on when a packet reaches this side.
export class GeometryReceiver {
  constructor({ signal, maxGeometryBytes, onRange, yieldTask = yieldThread } = {}) {
    Object.assign(this, { signal, maxGeometryBytes, onRange, yieldTask })
    this.groups = new Map()
    this.records = []
    this.batchCount = 0
    this.receivedBytes = 0
    this.bodyBytes = 0
    this.finished = false
  }

  async acceptLayout(layout, signal = this.signal) {
    throwIfAborted(signal)
    if (this.layout || layout?.version !== 1 || !Array.isArray(layout.groups)) invalid()
    geometryLimit(layout.geometryBytes, this.maxGeometryBytes)
    const b = layout.bounds
    if (!b || !['width', 'height', 'depth'].every(k => Number.isSafeInteger(b[k]) && b[k] > 0)) invalid()
    const wide = b.width * b.height * b.depth > 2 ** 32
    let count = 0
    // Validate the complete layout before allocating anything.
    const keys = new Set()
    for (const [index, group] of layout.groups.entries()) {
      if (group.groupIndex !== index || typeof group.key !== 'string' || keys.has(group.key)
        || !Number.isSafeInteger(group.count) || group.count < 0 || !Array.isArray(group.buffers)) invalid()
      keys.add(group.key); count += group.count
      const fields = group.kind === 'compact'
        ? { cells: ['Uint32Array', 1], templateIds: ['Uint32Array', 1], ...(wide ? { cellYs: ['Uint32Array', 1] } : {}) }
        : group.kind === 'points' ? { positions: ['Float32Array', 3] }
          : group.kind === 'quads' ? { positions: ['Float32Array', 12], uvs: ['Float32Array', 8],
            indices: [group.count * 4 < 65536 ? 'Uint16Array' : 'Uint32Array', 6],
            ...(group.buffers.some(field => field.name === 'blockKeys') ? { blockKeys: [wide ? 'Float64Array' : 'Uint32Array', 1] } : {}) }
            : invalid()
      if (group.buffers.length !== Object.keys(fields).length) invalid()
      const names = new Set()
      for (const field of group.buffers) {
        const expected = fields[field.name]
        if (!expected || names.has(field.name) || field.type !== expected[0] || field.stride !== expected[1]
          || !Number.isSafeInteger(field.length) || field.length !== group.count * field.stride) invalid()
        const bytes = field.length * types[field.type].BYTES_PER_ELEMENT
        if (bytes > 2 ** 31 - 1) invalid()
        this.bodyBytes += bytes; names.add(field.name)
      }
    }
    geometryLimit(this.bodyBytes, this.maxGeometryBytes)
    if (count !== layout.emitted || this.bodyBytes > layout.geometryBytes) invalid()
    this.layout = layout
    let yieldAt = performance.now() + 8
    for (const spec of layout.groups) {
      throwIfAborted(signal)
      const data = {}
      for (const field of spec.buffers) data[field.name] = new types[field.type](field.length)
      this.groups.set(spec.key, data)
      this.records.push({ spec, data, received: 0 })
      if (performance.now() >= yieldAt) {
        await this.yieldTask(); yieldAt = performance.now() + 8
      }
    }
    throwIfAborted(signal)
  }

  async acceptBatch(batch, signal = this.signal) {
    throwIfAborted(signal)
    if (!this.layout || this.finished || !Array.isArray(batch?.parts)) invalid()
    for (const part of batch.parts) {
      throwIfAborted(signal)
      const record = this.records[part.groupIndex]
      if (!record || part.start !== record.received || !Number.isSafeInteger(part.count) || part.count <= 0
        || part.start + part.count > record.spec.count || !part.buffers
        || Object.keys(part.buffers).length !== record.spec.buffers.length) invalid()
      for (const field of record.spec.buffers) {
        const source = part.buffers[field.name]
        if (!(source instanceof types[field.type]) || source.length !== part.count * field.stride) invalid()
      }
      for (const field of record.spec.buffers) {
        throwIfAborted(signal)
        const source = part.buffers[field.name], target = record.data[field.name]
        const offset = part.start * field.stride
        target.set(source, offset)
        this.receivedBytes += source.byteLength
        // The consumer receives the retained array, never a soon-detached slab.
        await this.onRange?.(target, offset, source.length, record.spec, field.name, signal)
      }
      record.received += part.count
    }
    throwIfAborted(signal)
    this.batchCount++
  }

  finish(result) {
    throwIfAborted(this.signal)
    if (!this.layout || this.finished || result?.streamed !== true || result.version !== 1
      || result.emitted !== this.layout.emitted || result.batchCount !== this.batchCount
      || !Array.isArray(result.tails) || result.tails.length !== this.records.length
      || this.receivedBytes !== this.bodyBytes) invalid()
    geometryLimit(result.geometryBytes, this.maxGeometryBytes)
    if (result.geometryBytes < this.layout.geometryBytes) invalid()
    const seen = new Set(), buffers = new Set()
    let tailBytes = 0
    for (const tail of result.tails) {
      const record = this.records[tail.groupIndex], metadata = tail.metadata
      if (!record || seen.has(tail.groupIndex) || record.received !== record.spec.count || !metadata
        || record.spec.buffers.some(field => Object.hasOwn(metadata, field.name))) invalid()
      seen.add(tail.groupIndex)
      if (record.spec.kind === 'compact') {
        const n = Math.ceil(record.spec.count / FACE_BATCH_SIZE) * 6
        if (!metadata.isCompactFaceData || metadata.count !== record.spec.count || metadata.cursor !== record.spec.count
          || !(metadata.cellBounds instanceof Float64Array) || metadata.cellBounds.length !== n
          || !(metadata.faceBounds instanceof Float32Array) || metadata.faceBounds.length !== n
          || !(metadata.worldBounds instanceof Float64Array) || metadata.worldBounds.length !== 6
          || !(metadata.offset instanceof Float64Array) || metadata.offset.length !== 3
          || !(metadata.templateData instanceof Float32Array)
          || metadata.templateData.length !== metadata.textureWidth * metadata.textureHeight * 4) invalid()
      } else if (metadata.v !== record.spec.count * (record.spec.kind === 'points' ? 3 : 4)
        || record.spec.kind === 'quads' && metadata.f !== record.spec.count * 6) invalid()
      for (const value of Object.values(metadata)) if (ArrayBuffer.isView(value) && !buffers.has(value.buffer)) {
        buffers.add(value.buffer); tailBytes += value.buffer.byteLength
      }
      Object.assign(record.data, metadata)
    }
    if (this.bodyBytes + tailBytes > result.geometryBytes) invalid()
    this.finished = true
    return { groups: this.groups, emitted: result.emitted, geometryBytes: result.geometryBytes }
  }
}
