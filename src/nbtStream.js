// Incremental binary NBT filter. Discarded payloads are scanned, never decoded
// into strings/objects or accumulated in the retained byte buffer.
import { MAX_NBT_BYTES, MAX_NBT_DEPTH, MAX_NBT_NODES, nbtLimitError, validateNbtLimit } from './nbt.js'
const decoder = new TextDecoder()
const widths = [0, 1, 2, 4, 8, 4, 8]

function limitError() {
  return nbtLimitError('retained')
}

function complexityError() {
  return nbtLimitError('complexity')
}

export function isBookPages(path, name) {
  if (name !== 'pages') return false
  const parent = path.at(-1)
  return parent === 'tag' || /^(?:minecraft:)?(?:written|writable)_book_content$/.test(parent || '')
}

export class NbtStreamFilter {
  constructor(selectField, { maxBytes = MAX_NBT_BYTES, maxDepth = MAX_NBT_DEPTH, maxNodes = MAX_NBT_NODES } = {}) {
    validateNbtLimit(maxBytes)
    this.selectField = selectField
    this.maxBytes = maxBytes; this.maxDepth = maxDepth; this.maxNodes = maxNodes
    this.stats = { readBytes: 0, retainedBytes: 0, omittedFields: 0, bookPageFields: 0 }
    this.chunks = []; this.buffer = null; this.used = 0; this.nodes = 0
    this.parser = this.root()
    this.advance()
  }

  append(bytes) {
    if (this.stats.retainedBytes + bytes.length > this.maxBytes) throw limitError()
    this.stats.retainedBytes += bytes.length
    for (let pos = 0; pos < bytes.length;) {
      if (!this.buffer || this.used === this.buffer.length) {
        if (this.buffer) this.chunks.push(this.buffer)
        this.buffer = new Uint8Array(Math.min(64 * 1024, this.maxBytes - this.stats.retainedBytes + bytes.length - pos))
        this.used = 0
      }
      const count = Math.min(bytes.length - pos, this.buffer.length - this.used)
      this.buffer.set(bytes.subarray(pos, pos + count), this.used)
      this.used += count; pos += count
    }
  }

  advance(value) {
    const step = this.parser.next(value)
    this.done = step.done; this.request = step.value
    this.pending = null; this.filled = 0
  }

  push(bytes) {
    this.stats.readBytes += bytes.length
    let pos = 0
    while (pos < bytes.length || !this.done && this.request.length === 0) {
      if (this.done) throw new Error('Unexpected data after root NBT compound')
      const request = this.request, count = Math.min(request.length - this.filled, bytes.length - pos)
      if (request.keep && count) this.append(bytes.subarray(pos, pos + count))
      let value
      if (request.read) {
        if (!this.filled && count === request.length) value = bytes.subarray(pos, pos + count)
        else {
          this.pending ||= new Uint8Array(request.length)
          this.pending.set(bytes.subarray(pos, pos + count), this.filled)
          value = this.pending
        }
      }
      this.filled += count; pos += count
      if (this.filled === request.length) this.advance(value)
    }
  }

  finish() {
    if (!this.done) throw new RangeError('Truncated NBT data')
    const bytes = new Uint8Array(this.stats.retainedBytes)
    let offset = 0
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length }
    if (this.buffer) bytes.set(this.buffer.subarray(0, this.used), offset)
    return { bytes, stats: { ...this.stats } }
  }

  abort() { this.chunks = []; this.buffer = this.pending = this.parser = null }

  *number(size, keep = false) {
    const bytes = yield { length: size, read: true, keep }
    return size === 1 ? bytes[0] : new DataView(bytes.buffer, bytes.byteOffset, size)[size === 2 ? 'getUint16' : 'getInt32'](0, false)
  }

  *bulk(length, keep) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid NBT length')
    if (keep && this.stats.retainedBytes + length > this.maxBytes) throw limitError()
    yield { length, keep }
  }

  *root() {
    if ((yield* this.number(1, true)) !== 10) throw new Error('Root NBT tag must be a compound')
    const length = yield* this.number(2, true)
    yield* this.bulk(length, true)
    yield* this.payload(10, true, [], 0)
  }

  *payload(type, keep, path, depth) {
    if (depth > this.maxDepth) throw complexityError()
    if (keep && ++this.nodes > this.maxNodes) throw complexityError()
    if (type >= 1 && type <= 6) { yield* this.bulk(widths[type], keep); return }
    if (type === 8) { const length = yield* this.number(2, keep); yield* this.bulk(length, keep); return }
    if (type === 7 || type === 11 || type === 12) {
      const length = yield* this.number(4, keep)
      yield* this.bulk(length * (type === 7 ? 1 : type === 11 ? 4 : 8), keep)
      return
    }
    if (type === 9) {
      const child = yield* this.number(1, keep), length = yield* this.number(4, keep)
      if (length < 0 || child > 12 || child === 0 && length) throw new RangeError('Invalid NBT list')
      if (keep && length > this.maxNodes - this.nodes) throw complexityError()
      if (child >= 1 && child <= 6) {
        if (keep) this.nodes += length
        yield* this.bulk(length * widths[child], keep)
        return
      }
      for (let i = 0; i < length; i++) yield* this.payload(child, keep, path, depth + 1)
      return
    }
    if (type === 10) {
      for (;;) {
        const child = yield* this.number(1)
        if (child === 0) { if (keep) this.append(Uint8Array.of(0)); return }
        if (child > 12) throw new Error('Unknown NBT tag type: ' + child)
        const length = yield* this.number(2)
        if (!keep) { yield* this.bulk(length, false); yield* this.payload(child, false, path, depth + 1); continue }
        const nameBytes = yield { length, read: true }, name = decoder.decode(nameBytes)
        const bookPages = isBookPages(path, name)
        const selected = !bookPages && (!this.selectField || this.selectField(path, name))
        if (selected) { this.append(Uint8Array.of(child, length >>> 8, length & 255)); this.append(nameBytes) }
        else { this.stats.omittedFields++; if (bookPages) this.stats.bookPageFields++ }
        yield* this.payload(child, selected, selected ? [...path, name] : path, depth + 1)
      }
    }
    throw new Error('Unknown NBT tag type: ' + type)
  }
}
