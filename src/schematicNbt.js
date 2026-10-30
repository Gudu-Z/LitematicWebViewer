import { consumeDecompressed } from './decompression.js'
import { NbtStreamFilter, isBookPages } from './nbtStream.js'
import { MAX_NBT_BYTES, parseNBT, validateNbtLimit } from './nbt.js'
import { selectRenderNbtField } from './renderNbt.js'
import { BlockStatePageWriter, createBlockPageBudget } from './pagedBlocks.js'

// Most schematics fit in this bounded buffer. Parse those once, without a second
// field-by-field streaming pass. Larger inputs transition to filtering while the
// remaining data is still being decompressed, regardless of the compressed size.
const FAST_BUFFER_BYTES = 32 * 1024 * 1024

export async function readSchematicNBT(data, { renderOnly = false, onProgress, onStage, maxBytes = MAX_NBT_BYTES, maxExpandedBytes, streamThreshold = FAST_BUFFER_BYTES, compactBlocks = false } = {}) {
  validateNbtLimit(maxBytes)
  // Large storage builds legitimately contain millions of small block-entity
  // fields. Compact callers retain the same byte/depth limits and a bounded,
  // larger object budget now that the enormous block arrays are paged out.
  const maxNodes = compactBlocks ? 16_000_000 : undefined
  if (!Number.isSafeInteger(streamThreshold) || streamThreshold < 0 || streamThreshold > FAST_BUFFER_BYTES) throw new RangeError('Invalid streaming threshold')
  let progress = -1
  const reportProgress = value => {
    // A native gzip attempt can fail after emitting a valid prefix. Its retry
    // starts a fresh sink, but the displayed progress must not move backwards.
    if (value > progress) { progress = value; onProgress?.(value) }
  }
  const result = await consumeDecompressed(data, () => {
    let chunks = [], total = 0, filter, keptBlockBytes = 0
    const extracted = new Map()
    const selector = renderOnly ? selectRenderNbtField : undefined
    return {
      push(chunk) {
        total += chunk.length
        if (!filter && total <= streamThreshold) { chunks.push(Uint8Array.from(chunk)); return }
        if (!filter) {
          filter = new NbtStreamFilter(selector, { maxBytes, maxNodes, arraySink(path, type, length) {
            if (!compactBlocks || !blockStatePath(path, type)) return null
            const key = JSON.stringify(path)
            extracted.delete(key)
            if (length * 8 < 8 * 1024 * 1024 && keptBlockBytes + length * 8 <= FAST_BUFFER_BYTES) {
              keptBlockBytes += length * 8; return null
            }
            extracted.set(key, { path, length })
            return { push() {} }
          } })
          for (const buffered of chunks) filter.push(buffered)
          chunks = []
        }
        filter.push(chunk)
      },
      finish() {
        if (filter) {
          const { bytes, stats } = filter.finish()
          return { root: parseNBT(bytes, undefined, { maxNodes }), stats, extracted }
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
        }, { maxBytes, stats, maxNodes })
        return { root, stats, extracted }
      },
      abort() { chunks = []; filter?.abort() },
    }
  }, { onProgress: compactBlocks ? value => reportProgress(value * .5) : onProgress, onStage, maxExpandedBytes })
  const { root, stats, extracted } = result
  if (extracted.size) {
    const totalBlockBytes = [...extracted.values()].reduce((sum, record) => sum + record.length * 8, 0)
    let reportAt = 0
    // Region headers may follow BlockStates in arbitrary NBT field order. A
    // second bounded pass decodes directly into pages after all headers are known;
    // neither pass retains the multi-gigabyte packed LongArray.
    const paged = await consumeDecompressed(data, () => {
      const regions = new Map(), budget = createBlockPageBudget()
      let decodedBlockBytes = 0
      const parser = new NbtStreamFilter((path, name) => path.length === 0 ? name === 'Regions' || name === 'SubRegions'
        : path.length === 1 || path.length === 2 && name === 'BlockStates', {
        arraySink(path, type, length) {
          const key = JSON.stringify(path), record = extracted.get(key)
          if (!record || !blockStatePath(path, type)) return null
          if (length !== record.length) throw new Error('BlockStates changed between decoding passes')
          const region = root[path[0]][path[1]], size = region.Size
          const dimensions = Array.isArray(size) ? size : [size?.x, size?.y, size?.z]
          const writer = new BlockStatePageWriter(region.BlockStatePalette || [], Math.abs(dimensions[0] * dimensions[1] * dimensions[2]), length, budget)
          return {
            push(bytes) {
              writer.push(bytes); decodedBlockBytes += bytes.length
              const now = performance.now()
              if (now >= reportAt) {
                reportProgress(.5 + .5 * decodedBlockBytes / totalBlockBytes)
                reportAt = now + 16
              }
            },
            finish() { regions.set(key, writer.finish()) },
          }
        },
      })
      return {
        push: bytes => parser.push(bytes),
        finish() { parser.finish(); return regions },
        abort() { parser.abort() },
      }
    }, { onProgress: value => { if (value === 1) reportProgress(1) }, maxExpandedBytes })
    stats.blockStateBytes = 0; stats.compactBlockBytes = 0
    for (const [key, { path, length }] of extracted) {
      const states = paged.get(key)
      if (!states) throw new RangeError('Missing streamed BlockStates')
      root[path[0]][path[1]].BlockStates = states
      stats.blockStateBytes += length * 8; stats.compactBlockBytes += states.bytes
    }
  }
  if (compactBlocks) reportProgress(1)
  return { root, stats }
}

function blockStatePath(path, type) {
  return type === 12 && path.length === 3 && (path[0] === 'Regions' || path[0] === 'SubRegions') && path[2] === 'BlockStates'
}
