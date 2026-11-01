// Incremental binary NBT filter. Discarded payloads are scanned, never decoded
// into strings/objects or accumulated in the retained byte buffer.
import { MAX_NBT_BYTES, MAX_NBT_DEPTH, MAX_NBT_NODES, nbtLimitError, validateNbtLimit } from './nbt.js'
const decoder = new TextDecoder()
const widths = [0, 1, 2, 4, 8, 4, 8]

// Only tag headers and lengths use this path. Numeric payloads remain raw bytes
// for the NBT reader, including doubles and signed 64-bit block/entity values.
function readNumber(bytes, pos, size) {
  return size === 1 ? bytes[pos] : size === 2 ? bytes[pos] * 256 + bytes[pos + 1]
    : (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
}

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
  constructor(selectField, { maxBytes = MAX_NBT_BYTES, maxDepth = MAX_NBT_DEPTH, maxNodes = MAX_NBT_NODES, arraySink } = {}) {
    validateNbtLimit(maxBytes)
    this.selectField = selectField
    this.arraySink = arraySink
    this.maxBytes = maxBytes; this.maxDepth = maxDepth; this.maxNodes = maxNodes
    this.stats = { readBytes: 0, retainedBytes: 0, omittedFields: 0, bookPageFields: 0 }
    this.chunks = []; this.buffer = null; this.used = 0; this.nodes = 0
    this.headerBytes = new Uint8Array(4)
    this.parser = this.root()
    this.advance()
  }

  append(bytes, start = 0, length = bytes.length - start) {
    if (this.stats.retainedBytes + length > this.maxBytes) throw limitError()
    this.stats.retainedBytes += length
    const end = start + length
    for (let pos = start; pos < end;) {
      if (!this.buffer || this.used === this.buffer.length) {
        if (this.buffer) this.chunks.push(this.buffer)
        this.buffer = new Uint8Array(Math.min(64 * 1024, this.maxBytes - this.stats.retainedBytes + end - pos))
        this.used = 0
      }
      const count = Math.min(end - pos, this.buffer.length - this.used)
      // Most retained fields are tiny. Copy them without allocating a typed
      // view per field; larger payloads still use the native bulk copy.
      if (count <= 8) for (let i = 0; i < count; i++) this.buffer[this.used + i] = bytes[pos + i]
      else this.buffer.set(bytes.subarray(pos, pos + count), this.used)
      this.used += count; pos += count
    }
  }

  header(type, length) {
    const bytes = this.headerBytes
    bytes[0] = type; bytes[1] = length >>> 8; bytes[2] = length
    this.append(bytes, 0, 3)
  }

  int32(value) {
    const bytes = this.headerBytes
    bytes[0] = value >>> 24; bytes[1] = value >>> 16; bytes[2] = value >>> 8; bytes[3] = value
    this.append(bytes)
  }

  endCompound() { this.headerBytes[0] = 0; this.append(this.headerBytes, 0, 1) }

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
      if (request.keep && count) this.append(bytes, pos, count)
      if (request.write && count) request.write(bytes.subarray(pos, pos + count))
      let value
      if (request.read) {
        if (!this.filled && count === request.length) value = request.number ? readNumber(bytes, pos, request.length) : bytes.subarray(pos, pos + count)
        else {
          this.pending ||= new Uint8Array(request.length)
          this.pending.set(bytes.subarray(pos, pos + count), this.filled)
          value = request.number ? readNumber(this.pending, 0, request.length) : this.pending
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

  abort() { this.chunks = []; this.buffer = this.pending = this.parser = this.headerBytes = null }

  *number(size, keep = false) {
    return yield { length: size, read: true, keep, number: true }
  }

  bulkRequest(length, keep, write) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid NBT length')
    if (keep && this.stats.retainedBytes + length > this.maxBytes) throw limitError()
    return { length, keep, write }
  }

  *root() {
    if ((yield* this.number(1, true)) !== 10) throw new Error('Root NBT tag must be a compound')
    const length = yield* this.number(2, true)
    yield this.bulkRequest(length, true)
    yield* this.payload(10, true, [], 0)
  }

  *payload(type, keep, path, depth) {
    if (depth > this.maxDepth) throw complexityError()
    if (keep && ++this.nodes > this.maxNodes) throw complexityError()
    if (type >= 1 && type <= 6) { yield this.bulkRequest(widths[type], keep); return }
    if (type === 8) { const length = yield* this.number(2, keep); yield this.bulkRequest(length, keep); return }
    if (type === 7 || type === 11 || type === 12) {
      const length = yield* this.number(4)
      if (length < 0) throw new RangeError('Invalid NBT length')
      const sink = keep ? this.arraySink?.(path, type, length) : null
      if (keep) {
        const retained = sink ? 0 : length
        this.int32(retained)
      }
      yield this.bulkRequest(length * (type === 7 ? 1 : type === 11 ? 4 : 8), keep && !sink, sink && (bytes => sink.push(bytes)))
      sink?.finish?.()
      return
    }
    if (type === 9) {
      const child = yield* this.number(1, keep), length = yield* this.number(4, keep)
      if (length < 0 || child > 12 || child === 0 && length) throw new RangeError('Invalid NBT list')
      if (keep && length > this.maxNodes - this.nodes) throw complexityError()
      if (child >= 1 && child <= 6) {
        if (keep) this.nodes += length
        yield this.bulkRequest(length * widths[child], keep)
        return
      }
      for (let i = 0; i < length; i++) yield* this.payload(child, keep, path, depth + 1)
      return
    }
    if (type === 10) {
      for (;;) {
        const child = yield* this.number(1)
        if (child === 0) { if (keep) this.endCompound(); return }
        if (child > 12) throw new Error('Unknown NBT tag type: ' + child)
        const length = yield* this.number(2)
        if (!keep) { yield this.bulkRequest(length, false); yield* this.payload(child, false, path, depth + 1); continue }
        const nameBytes = yield { length, read: true }, name = decoder.decode(nameBytes)
        const bookPages = isBookPages(path, name)
        const selected = !bookPages && (!this.selectField || this.selectField(path, name))
        if (selected) { this.header(child, length); this.append(nameBytes) }
        else { this.stats.omittedFields++; if (bookPages) this.stats.bookPageFields++ }
        // Scalar payloads never inspect the path. Containers and array sinks
        // still receive the full field path, with the same depth/node checks.
        const nested = child === 7 || child >= 9
        yield* this.payload(child, selected, selected && nested ? [...path, name] : path, depth + 1)
      }
    }
    throw new Error('Unknown NBT tag type: ' + type)
  }
}
