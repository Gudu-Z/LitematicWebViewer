import { consumeDecompressed } from './decompression.js'
import { NbtStreamFilter, isBookPages } from './nbtStream.js'
import { MAX_NBT_BYTES, parseNBT, validateNbtLimit } from './nbt.js'
import { selectRenderNbtField } from './renderNbt.js'

// Most schematics fit in this bounded buffer. Parse those once, without a second
// field-by-field streaming pass. Larger inputs transition to filtering while the
// remaining data is still being decompressed, regardless of the compressed size.
const FAST_BUFFER_BYTES = 32 * 1024 * 1024

export async function readSchematicNBT(data, { renderOnly = false, onProgress, maxBytes = MAX_NBT_BYTES, maxExpandedBytes, streamThreshold = FAST_BUFFER_BYTES } = {}) {
  validateNbtLimit(maxBytes)
  if (!Number.isSafeInteger(streamThreshold) || streamThreshold < 0 || streamThreshold > FAST_BUFFER_BYTES) throw new RangeError('Invalid streaming threshold')
  return consumeDecompressed(data, () => {
    let chunks = [], total = 0, filter
    const selector = renderOnly ? selectRenderNbtField : undefined
    return {
      push(chunk) {
        total += chunk.length
        if (!filter && total <= streamThreshold) { chunks.push(Uint8Array.from(chunk)); return }
        if (!filter) {
          filter = new NbtStreamFilter(selector, { maxBytes })
          for (const buffered of chunks) filter.push(buffered)
          chunks = []
        }
        filter.push(chunk)
      },
      finish() {
        if (filter) {
          const { bytes, stats } = filter.finish()
          return { root: parseNBT(bytes), stats }
        }
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        chunks = []
        const stats = { readBytes: total, retainedBytes: total, omittedFields: 0, bookPageFields: 0 }
        const root = parseNBT(bytes, (path, name) => {
          const bookPages = isBookPages(path, name)
          const selected = !bookPages && (!selector || selector(path, name))
          if (!selected) { stats.omittedFields++; if (bookPages) stats.bookPageFields++ }
          return selected
        }, { maxBytes, stats })
        return { root, stats }
      },
      abort() { chunks = []; filter?.abort() },
    }
  }, { onProgress, maxExpandedBytes })
}
