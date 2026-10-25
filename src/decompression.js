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
  // Loaded only after native gzip fails; normal projections/cards pay no extra
  // download or JS decompression cost. Low-level streaming bounds each step.
  const { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_NO_FLUSH, Z_OK, Z_STREAM_END } = await import('pako')
  async function decode(output) {
    const buffer = new Uint8Array(64 * 1024)
    let offset = 0, total = 0, yieldAt = performance.now() + 8
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
          total += stream.next_out
          if (total > maxBytes) throw sizeError()
          if (output) output.set(buffer.subarray(0, stream.next_out), total - stream.next_out)
          if (status !== Z_OK && status !== Z_STREAM_END || before === stream.next_in && !stream.next_out) {
            throw new Error('Invalid gzip data: ' + (stream.msg || 'incomplete stream'))
          }
          if (performance.now() >= yieldAt) {
            await new Promise(resolve => setTimeout(resolve, 0))
            yieldAt = performance.now() + 8
          }
          if (status === Z_STREAM_END) { offset = stream.next_in; break }
        }
      } finally {
        zlibInflateEnd(stream)
      }
    }
    return total
  }
  // First validate/count with one reusable 64 KiB buffer. A tiny compressed
  // file expanding to gigabytes is rejected without retaining 512 MiB of chunks.
  const size = await decode()
  const output = new Uint8Array(size)
  await decode(output)
  return output
}
