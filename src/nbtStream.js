// Bounded-memory NBT reader. Large arrays can be consumed or skipped by a visitor;
// gzip is read sequentially, never accumulated into a decompressed ArrayBuffer.
const decoder = new TextDecoder()
const widths = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 }
const MAX_VALUE_BYTES = 16 * 1024 * 1024

export class NBTStreamReader {
  constructor(stream, { onProgress, signal, visit } = {}) {
    this.reader = stream.getReader()
    this.chunk = new Uint8Array(0)
    this.cursor = 0
    this.position = 0
    this.onProgress = onProgress
    this.signal = signal
    this.visit = visit
    this.lastProgress = 0
  }

  async fill() {
    this.signal?.throwIfAborted()
    while (this.cursor === this.chunk.length) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('Unexpected end of NBT data')
      this.chunk = value
      this.cursor = 0
      const now = performance.now()
      if (now - this.lastProgress > 100) {
        this.onProgress?.(this.position)
        this.lastProgress = now
      }
    }
  }

  async bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_VALUE_BYTES) throw new Error('NBT value is too large')
    if (!length) return new Uint8Array(0)
    await this.fill()
    if (this.cursor + length <= this.chunk.length) {
      const value = this.chunk.subarray(this.cursor, this.cursor + length)
      this.cursor += length
      this.position += length
      return value
    }
    const out = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      await this.fill()
      const n = Math.min(length - offset, this.chunk.length - this.cursor)
      out.set(this.chunk.subarray(this.cursor, this.cursor + n), offset)
      this.cursor += n
      this.position += n
      offset += n
    }
    return out
  }

  async skip(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid NBT length')
    while (length) {
      await this.fill()
      const n = Math.min(length, this.chunk.length - this.cursor)
      this.cursor += n
      this.position += n
      length -= n
    }
  }

  async number(type) {
    const b = await this.bytes(widths[type])
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    switch (type) {
      case 1: return view.getInt8(0)
      case 2: return view.getInt16(0)
      case 3: return view.getInt32(0)
      case 4: return view.getBigInt64(0)
      case 5: return view.getFloat32(0)
      case 6: return view.getFloat64(0)
    }
  }

  async length() {
    const n = await this.number(3)
    if (n < 0) throw new Error('Negative NBT length')
    return n
  }

  async string(keep = true) {
    const b = await this.bytes(2)
    const length = b[0] * 256 + b[1]
    return keep ? decoder.decode(await this.bytes(length)) : this.skip(length)
  }

  async payload(type, path = [], keep = true, depth = 0, visit = true) {
    if (depth > 64) throw new Error('NBT nesting is too deep')
    if (keep && visit && this.visit) {
      const result = await this.visit(this, type, path)
      if (result) return result.value
    }
    if (widths[type]) return keep ? this.number(type) : this.skip(widths[type])
    if (type === 8) return this.string(keep)
    if (type === 7 || type === 11 || type === 12) {
      const n = await this.length(), width = { 7: 1, 11: 4, 12: 8 }[type]
      if (!keep) return this.skip(n * width)
      if (n * width > MAX_VALUE_BYTES) throw new Error('NBT array is too large to retain')
      const b = await this.bytes(n * width), view = new DataView(b.buffer, b.byteOffset, b.byteLength)
      if (type === 7) return new Int8Array(b.slice().buffer)
      const out = type === 11 ? new Int32Array(n) : new BigInt64Array(n)
      for (let i = 0; i < n; i++) out[i] = type === 11 ? view.getInt32(i * width) : view.getBigInt64(i * width)
      return out
    }
    if (type === 9) {
      const sub = await this.number(1), n = await this.length()
      if (n && (sub < 1 || sub > 12)) throw new Error('Invalid NBT list type')
      if (keep && n > 65536) throw new Error('NBT list is too large to retain')
      const out = keep ? [] : undefined
      for (let i = 0; i < n; i++) {
        const value = await this.payload(sub, path, keep, depth + 1, visit)
        if (keep) out.push(value)
      }
      return out
    }
    if (type === 10) {
      const out = keep ? Object.create(null) : undefined
      let count = 0
      for (;;) {
        const sub = await this.number(1)
        if (sub === 0) return out
        if (++count > 65536) throw new Error('Too many NBT fields')
        const key = await this.string(keep)
        const value = await this.payload(sub, keep ? [...path, key] : path, keep, depth + 1, visit)
        if (keep) out[key] = value
      }
    }
    throw new Error('Unknown NBT tag: ' + type)
  }

  async finish() {
    // Read to EOF so DecompressionStream also validates the gzip checksum.
    if (this.cursor !== this.chunk.length) throw new Error('Trailing NBT data')
    for (;;) {
      this.signal?.throwIfAborted()
      const { done, value } = await this.reader.read()
      if (done) break
      if (value.length) throw new Error('Trailing NBT data')
    }
    this.onProgress?.(this.position)
  }
}

export async function readNBTStream(file, options = {}) {
  const header = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  let stream = file.stream()
  if (header[0] === 0x1f && header[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream('gzip'))
  else if (header[0] === 0x78) stream = stream.pipeThrough(new DecompressionStream('deflate'))
  const r = new NBTStreamReader(stream, options)
  try {
    if (await r.number(1) !== 10) throw new Error('Root NBT tag must be a compound')
    await r.string(false)
    const root = await r.payload(10)
    await r.finish()
    return { root, bytes: r.position }
  } finally {
    await r.reader.cancel().catch(() => {})
    r.reader.releaseLock()
  }
}
