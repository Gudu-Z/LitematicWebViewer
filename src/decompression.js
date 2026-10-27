// Keep native decompression for ordinary files. Browser DecompressionStream
// rejects concatenated gzip members, although they are valid RFC 1952 files.
const MAX_DECOMPRESSED = 512 * 1024 * 1024

function sizeError() {
  const error = new Error('解压后数据过大')
  error.code = 'FILE_TOO_LARGE'
  error.reason = 'decompressed'
  return error
}

export async function decompressNBT(data, { maxBytes = MAX_DECOMPRESSED } = {}) {
  // Callers may lower the budget, but cannot disable the browser memory limit.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DECOMPRESSED) {
    throw new RangeError('Invalid decompression limit')
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const format = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip'
    : bytes.length >= 2 && bytes[0] === 0x78 ? 'deflate' : null
  if (!format) {
    if (bytes.byteLength > maxBytes) throw sizeError()
    return bytes
  }
  try {
    return await inflateNative(bytes, format, maxBytes)
  } catch (error) {
    if (format !== 'gzip' || error.code === 'FILE_TOO_LARGE') throw error
    // Do not depend on browser-specific error wording. The fallback validates
    // every header, CRC32, ISIZE and stream ending; it never ignores bad tails.
    return inflateGzipMembers(bytes, maxBytes)
  }
}

async function inflateNative(data, format, maxBytes) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw sizeError()
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
    return out
  } finally {
    chunks.length = 0
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function inflateGzipMembers(data, maxBytes) {
  async function decode(output) {
    let total = 0
    await visitGzipChunks(data, chunk => {
      total += chunk.length
      if (total > maxBytes) throw sizeError()
      if (output) output.set(chunk, total - chunk.length)
    })
    return total
  }
  // First validate/count with one reusable 64 KiB buffer. A tiny compressed
  // file expanding to gigabytes is rejected without retaining 512 MiB of chunks.
  const size = await decode()
  const output = new Uint8Array(size)
  await decode(output)
  return output
}

async function visitGzipChunks(data, onChunk, onProgress) {
  // Loaded only after native gzip fails; normal projections/cards pay no extra
  // download or JS decompression cost. Low-level streaming bounds each step.
  const { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_NO_FLUSH, Z_OK, Z_STREAM_END } = await import('pako')
  const buffer = new Uint8Array(64 * 1024)
  let offset = 0, yieldAt = performance.now() + 8
  while (offset < data.length) {
    const stream = new ZStream()
    if (zlibInflateInit2(stream, 31) !== Z_OK) throw new Error('Cannot initialize gzip decoder')
    stream.input = data
    stream.next_in = offset
    stream.avail_in = data.length - offset
    try {
      for (;;) {
        stream.output = buffer
        stream.next_out = 0
        stream.avail_out = buffer.length
        const before = stream.next_in
        const status = zlibInflate(stream, Z_NO_FLUSH)
        if (stream.next_out) onChunk(buffer.subarray(0, stream.next_out))
        if (status !== Z_OK && status !== Z_STREAM_END || before === stream.next_in && !stream.next_out) {
          throw new Error('Invalid gzip data: ' + (stream.msg || 'incomplete stream'))
        }
        if (performance.now() >= yieldAt) {
          onProgress?.(stream.next_in / data.length)
          await new Promise(resolve => setTimeout(resolve, 0))
          yieldAt = performance.now() + 8
        }
        if (status === Z_STREAM_END) { offset = stream.next_in; break }
      }
    } finally {
      zlibInflateEnd(stream)
    }
  }
}

// A fresh sink is required for each attempt: native gzip may have emitted valid
// prefix bytes before rejecting a second member. Never reuse that partial NBT.
export async function consumeDecompressed(data, createSink, { onProgress, maxExpandedBytes = 16 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 0 || maxExpandedBytes > 16 * 1024 ** 3) throw new RangeError('Invalid scan limit')
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const format = bytes[0] === 31 && bytes[1] === 139 ? 'gzip' : bytes[0] === 0x78 ? 'deflate' : null
  let lastError, progress = 0
  const report = value => { progress = Math.max(progress, value); onProgress?.(progress) }
  for (let attempt = 0; attempt < (format === 'gzip' ? 3 : 1); attempt++) {
    const sink = createSink()
    let expanded = 0
    const push = chunk => {
      expanded += chunk.length
      if (expanded > maxExpandedBytes) throw Object.assign(new Error('NBT scan limit exceeded'), { code: 'FILE_TOO_LARGE', reason: 'scan' })
      sink.push(chunk)
    }
    try {
      if (!format) push(bytes)
      else if (attempt === 0) await visitNative(bytes, format, push)
      else if (attempt === 1) {
        if (nextGzipHeader(bytes, 10) === bytes.length) throw lastError
        let start = 0, reportAt = 0
        while (start < bytes.length) {
          const end = nextGzipHeader(bytes, start + 10)
          await visitNative(bytes.subarray(start, end), 'gzip', push)
          start = end
          if (performance.now() >= reportAt) { report(start / bytes.length); reportAt = performance.now() + 16 }
        }
      } else await visitGzipChunks(bytes, push, report)
      const result = sink.finish()
      report(1)
      return result
    } catch (error) {
      lastError = error
      // A malformed NBT structure or exhausted budget is independent of the
      // decompressor. Retry only compressed-stream validation failures.
      if (error?.code !== 'INVALID_COMPRESSION' || attempt === 2 || format !== 'gzip') throw error
    } finally { sink.abort?.() }
  }
}

function compressionError(error) {
  return Object.assign(new Error(error.message || 'Invalid compressed data'), { code: 'INVALID_COMPRESSION', cause: error })
}

async function visitNative(data, format, onChunk) {
  let reader
  try { reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader() }
  catch (error) { throw compressionError(error) }
  try {
    for (;;) {
      let result
      try { result = await reader.read() } catch (error) { throw compressionError(error) }
      if (result.done) break
      onChunk(result.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Header signatures are candidate boundaries only. Each candidate must pass
// native CRC/ISIZE/end validation; a signature inside compressed data causes a
// restart with the exact streaming decoder above, never silent data loss.
function nextGzipHeader(bytes, start) {
  for (let i = bytes.indexOf(31, start); i >= 0; i = bytes.indexOf(31, i + 1)) {
    if (bytes[i + 1] === 139 && bytes[i + 2] === 8) return i
  }
  return bytes.length
}
