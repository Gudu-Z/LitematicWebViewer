// Lossless, region-local pages. Zero represents the same invisible cells that
// the legacy blocks Map omitted; other values are local palette indices + 1.
// Pages stay in file order so transparent/coplanar faces keep their draw order.
export const BLOCK_PAGE_SIZE = 4096
export const MAX_CACHED_BLOCK_PAGES = 512
const SKIP = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])
const MAX_PAGE_BYTES = 1024 * 1024 * 1024
const skip = name => SKIP.has((name || '').replace(/^minecraft:/, ''))

export function encodeBlockPage(values, length = values.length) {
  const palette = [], lookup = new Map(), indices = new Uint16Array(length)
  let runs = 0, previous = -1, count = 0
  for (let i = 0; i < length; i++) {
    const value = values[i]
    if (value) count++
    let id = lookup.get(value)
    if (id === undefined) { id = palette.length; lookup.set(value, id); palette.push(value) }
    indices[i] = id
    if (value !== previous) { previous = value; runs++ }
  }
  if (palette.length === 1) return palette[0]
  const bits = Math.ceil(Math.log2(palette.length)), words = Math.ceil(length * bits / 32)
  const page = { palette: Uint32Array.from(palette), length, count, bits }
  if (runs * 4 < words * 4) {
    page.runs = new Uint16Array(runs * 2)
    let end = 0
    for (let i = 1; i <= length; i++) if (i === length || indices[i] !== indices[i - 1]) {
      page.runs[end++] = i; page.runs[end++] = indices[i - 1]
    }
  } else {
    page.words = new Uint32Array(words)
    for (let i = 0; i < length; i++) {
      const bit = i * bits, word = Math.floor(bit / 32), shift = bit & 31
      page.words[word] |= indices[i] << shift
      if (shift + bits > 32) page.words[word + 1] |= indices[i] >>> (32 - shift)
    }
  }
  return page
}

export function decodeBlockPage(page, out = new Uint32Array(page.length)) {
  if (page.runs) {
    let start = 0
    for (let i = 0; i < page.runs.length; i += 2) {
      const end = page.runs[i]
      out.fill(page.palette[page.runs[i + 1]], start, end); start = end
    }
  } else {
    const { bits, words, palette, length } = page, mask = (1 << bits) - 1
    for (let i = 0; i < length; i++) {
      const bit = i * bits, word = Math.floor(bit / 32), shift = bit & 31
      let value = words[word] >>> shift
      if (shift + bits > 32) value |= words[word + 1] << (32 - shift)
      out[i] = palette[value & mask]
    }
  }
  return out
}

export const blockPageBytes = page => typeof page === 'number' ? 8
  : page.palette.byteLength + (page.words || page.runs).byteLength + 32

export function createBlockPageBudget(maxBytes = MAX_PAGE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PAGE_BYTES) throw new RangeError('Invalid block page budget')
  return { bytes: 0, add(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid block page size')
    this.bytes += bytes
    if (this.bytes > maxBytes) throw Object.assign(new Error('Compact block data exceeds the memory budget'), { code: 'FILE_TOO_LARGE', reason: 'blocks' })
  } }
}

// Accepts arbitrary byte boundaries, including split big-endian longs. Only one
// small decoded page and at most seven unfinished input bytes are retained.
export class BlockStatePageWriter {
  constructor(palette, volume, longCount, budget = createBlockPageBudget()) {
    this.bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
    if (!Number.isSafeInteger(volume) || volume < 0 || this.bits > 32 || !Number.isSafeInteger(volume * this.bits)
      || !Number.isSafeInteger(longCount) || longCount < 0 || !Number.isSafeInteger(longCount * 8)
      || volume && !palette.length || longCount * 64 < volume * this.bits) {
      throw new RangeError('BlockStates data or region dimensions are invalid')
    }
    this.mask = this.bits === 32 ? 0xffffffff : (1 << this.bits) - 1
    this.skip = Uint8Array.from(palette, p => skip(p.Name) ? 1 : 0)
    this.result = { isPagedBlockStates: true, pages: [], volume, count: 0, counts: new Float64Array(palette.length), bytes: 0 }
    this.budget = budget; this.output = new Uint32Array(BLOCK_PAGE_SIZE)
    this.position = 0; this.used = 0; this.carry = 0; this.carryBits = 0
    this.tail = new Uint8Array(8); this.tailSize = 0; this.inputBytes = 0; this.expectedBytes = longCount * 8
  }

  emit(value) {
    if (this.position >= this.result.volume) return
    // Match the original decoder's fallback for an out-of-palette index.
    if (value >= this.skip.length) value = 0
    const stored = this.skip[value] ? 0 : value + 1
    this.output[this.used++] = stored; this.position++
    if (stored) { this.result.count++; this.result.counts[value]++ }
    if (this.used === BLOCK_PAGE_SIZE) this.flush()
  }

  word(word) {
    const bits = this.bits
    if (bits === 32) { this.emit(word >>> 0); return }
    let available = 32
    if (this.carryBits) {
      const needed = bits - this.carryBits
      this.emit((this.carry | (word << this.carryBits)) & this.mask)
      word >>>= needed; available -= needed; this.carryBits = 0
    }
    while (available >= bits) {
      this.emit(word & this.mask); word >>>= bits; available -= bits
    }
    this.carry = word; this.carryBits = available
  }

  push(bytes) {
    this.inputBytes += bytes.length
    let offset = 0
    if (this.tailSize) {
      const count = Math.min(8 - this.tailSize, bytes.length)
      this.tail.set(bytes.subarray(0, count), this.tailSize); this.tailSize += count; offset += count
      if (this.tailSize === 8) {
        const view = new DataView(this.tail.buffer)
        this.word(view.getUint32(4)); this.word(view.getUint32(0)); this.tailSize = 0
      }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (; offset + 8 <= bytes.length; offset += 8) {
      this.word(view.getUint32(offset + 4)); this.word(view.getUint32(offset))
    }
    if (offset < bytes.length) { this.tail.set(bytes.subarray(offset)); this.tailSize = bytes.length - offset }
  }

  flush() {
    if (!this.used) return
    const page = encodeBlockPage(this.output, this.used), bytes = blockPageBytes(page)
    this.budget.add(bytes); this.result.bytes += bytes; this.result.pages.push(page); this.used = 0
  }

  finish() {
    if (this.tailSize || this.inputBytes !== this.expectedBytes || this.position !== this.result.volume) throw new RangeError('Truncated BlockStates')
    this.flush(); return this.result
  }
}

// A bounded decoded-page cache is shared by every region in one schematic.
// Sequential iteration and six-neighbour queries do not expand the whole world.
// Keep up to 8 MiB: a 585 × 585 layer spans 84 pages, so 128 entries evict
// neighbours before the next layer visits them. FIFO needs no per-hit mutation.
class PageCache {
  constructor() { this.pages = new Map() }
  get(page) {
    if (this.last === page) return this.values
    let values = this.pages.get(page)
    if (!values) {
      values = decodeBlockPage(page)
      if (this.pages.size >= MAX_CACHED_BLOCK_PAGES) this.pages.delete(this.pages.keys().next().value)
      this.pages.set(page, values)
    }
    this.last = page; this.values = values
    return values
  }
}

// Lookups usually hit one region. A bounded coarse grid avoids scanning every
// region for each of the six neighbour queries, without changing block range.
function indexRegions(regions, bounds) {
  const maxCells = 262144
  if (regions.length < 2 || regions.length > maxCells) return null
  let cellSize = 128, ranges
  for (;;) {
    let references = 0
    ranges = []
    for (const r of regions) {
      const range = [Math.floor(r.lx / cellSize), Math.floor((r.lx + r.width - 1) / cellSize),
        Math.floor(r.ly / cellSize), Math.floor((r.ly + r.height - 1) / cellSize),
        Math.floor(r.lz / cellSize), Math.floor((r.lz + r.depth - 1) / cellSize)]
      references += (range[1] - range[0] + 1) * (range[3] - range[2] + 1) * (range[5] - range[4] + 1)
      ranges.push(range)
      if (references > maxCells) break
    }
    if (references <= maxCells) break
    cellSize *= 2
  }
  const width = Math.ceil(bounds.width / cellSize), depth = Math.ceil(bounds.depth / cellSize)
  if (!Number.isSafeInteger(width * depth * Math.ceil(bounds.height / cellSize))) return null
  const cells = new Map(), stride = width * depth
  for (let i = 0; i < regions.length; i++) {
    const [x0, x1, y0, y1, z0, z1] = ranges[i]
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const key = x + z * width + y * stride
      let candidates = cells.get(key)
      if (!candidates) { candidates = []; cells.set(key, candidates) }
      candidates.push(regions[i])
    }
  }
  return { cellSize, width, stride, cells }
}

export class PagedBlockStore {
  constructor(regions, bounds, paletteSize) {
    this.isPagedBlockStore = true; this.regions = regions; this.bounds = bounds; this.cache = new PageCache()
    this.size = 0; this.paletteCounts = new Float64Array(paletteSize)
    this.storageBytes = regions.reduce((sum, r) => sum + r.states.bytes, 0)
    for (const r of regions) {
      r.lx = r.minX - bounds.minX; r.ly = r.minY - bounds.minY; r.lz = r.minZ - bounds.minZ
      r.overlaps = regions.filter(other => other !== r && other.minX <= r.maxX && other.maxX >= r.minX
        && other.minY <= r.maxY && other.maxY >= r.minY && other.minZ <= r.maxZ && other.maxZ >= r.minZ)
      r.before = r.overlaps.filter(other => regions.indexOf(other) < regions.indexOf(r))
      r.after = r.overlaps.filter(other => regions.indexOf(other) > regions.indexOf(r)).reverse()
    }
    this.regionGrid = indexRegions(regions, bounds)
    this.lastRegionCell = -1; this.lastRegionCandidates = undefined
    const first = regions[0]
    this.onlyRegion = regions.length === 1 && first.lx === 0 && first.ly === 0 && first.lz === 0
      && first.width === bounds.width && first.height === bounds.height && first.depth === bounds.depth ? first : null
    if (regions.every(r => !r.overlaps.length)) {
      for (const r of regions) {
        this.size += r.states.count
        for (let i = 0; i < r.states.counts.length; i++) this.paletteCounts[r.localToGlobal[i]] += r.states.counts[i]
      }
    } else {
      for (const [, gi] of this) { this.size++; this.paletteCounts[gi]++ }
    }
    const store = this
    this.keyView = { length: this.size, [Symbol.iterator]: () => store.keys() }
  }

  local(r, index) {
    const page = r.states.pages[Math.floor(index / BLOCK_PAGE_SIZE)]
    const value = typeof page === 'number' ? page : this.cache.get(page)[index % BLOCK_PAGE_SIZE]
    return value ? r.localToGlobal[value - 1] : undefined
  }

  at(r, x, y, z) {
    x -= r.lx; y -= r.ly; z -= r.lz
    if (x < 0 || y < 0 || z < 0 || x >= r.width || y >= r.height || z >= r.depth) return undefined
    return this.local(r, x + r.width * (z + r.depth * y))
  }

  get(key) {
    const b = this.bounds, stride = b.width * b.depth
    if (!Number.isSafeInteger(key) || key < 0 || key >= stride * b.height) return undefined
    if (this.onlyRegion) return this.local(this.onlyRegion, key)
    const x = key % b.width, z = Math.floor(key / b.width) % b.depth, y = Math.floor(key / stride)
    return this.getAtUnchecked(x, y, z)
  }

  // Bounds-local coordinates let geometry reuse the neighbour coordinates it
  // already checked, instead of encoding a global key and immediately decoding
  // it again. Palette masks never apply here: hidden/renderless cells can still
  // affect their neighbours, and overlapping air must fall through as before.
  getAt(x, y, z) {
    const b = this.bounds
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)
      || x < 0 || y < 0 || z < 0 || x >= b.width || y >= b.height || z >= b.depth) return undefined
    if (this.onlyRegion) return this.local(this.onlyRegion, x + b.width * (z + b.depth * y))
    return this.getAtUnchecked(x, y, z)
  }

  getAtUnchecked(x, y, z) {
    const grid = this.regionGrid
    let candidates = this.regions
    if (grid) {
      const cell = Math.floor(x / grid.cellSize) + Math.floor(z / grid.cellSize) * grid.width
        + Math.floor(y / grid.cellSize) * grid.stride
      if (cell !== this.lastRegionCell) {
        this.lastRegionCell = cell
        this.lastRegionCandidates = grid.cells.get(cell)
      }
      candidates = this.lastRegionCandidates
    }
    if (!candidates) return undefined
    for (let i = candidates.length - 1; i >= 0; i--) {
      const value = this.at(candidates[i], x, y, z)
      if (value !== undefined) return value
    }
  }

  has(key) { return this.get(key) !== undefined }

  *entriesForPalette(wanted) {
    const b = this.bounds, stride = b.width * b.depth
    for (let ri = 0; ri < this.regions.length; ri++) {
      const r = this.regions[ri], row = r.width * r.depth
      const selected = value => value && (!wanted || r.overlaps.length || wanted[r.localToGlobal[value - 1]])
      for (let pi = 0; pi < r.states.pages.length; pi++) {
        const page = r.states.pages[pi]
        if (typeof page === 'number' ? !selected(page) : wanted && !page.palette.some(selected)) continue
        const base = pi * BLOCK_PAGE_SIZE, length = Math.min(BLOCK_PAGE_SIZE, r.states.volume - base)
        const values = typeof page === 'number' ? null : this.cache.get(page)
        if (this.onlyRegion) {
          // A full-bounds region's local index already is the global Map key.
          // Keep independent entry tuples and their exact original order.
          for (let j = 0; j < length; j++) {
            const value = values ? values[j] : page
            if (!value) continue
            const gi = r.localToGlobal[value - 1]
            if (!wanted || wanted[gi]) yield [base + j, gi]
          }
          continue
        }
        for (let j = 0; j < length; j++) {
          const value = values ? values[j] : page
          if (!value) continue
          const index = base + j, x = index % r.width + r.lx
          const y = Math.floor(index / row) + r.ly, z = Math.floor(index / r.width) % r.depth + r.lz
          let gi = r.localToGlobal[value - 1]
          if (r.overlaps.length) {
            // Map.set updates a value without moving its original insertion slot.
            if (r.before.some(other => this.at(other, x, y, z) !== undefined)) continue
            for (const later of r.after) {
              const override = this.at(later, x, y, z)
              if (override !== undefined) { gi = override; break }
            }
          }
          if (!wanted || wanted[gi]) yield [x + z * b.width + y * stride, gi]
        }
      }
    }
  }

  [Symbol.iterator]() { return this.entriesForPalette() }
  entries() { return this[Symbol.iterator]() }
  *keys() { for (const [key] of this) yield key }
  *values() { for (const [, value] of this) yield value }
  forEach(callback, receiver) { for (const [key, value] of this) callback.call(receiver, value, key, this) }
}
