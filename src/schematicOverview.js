import { readNBTStream } from './nbtStream.js'
import { decodePackedSpan, intersectBounds, loadError, MAX_LOADED_BLOCKS, MAX_WINDOW_FACES, readLitematicaWindow, validateWindow } from './litematicaWindow.js'

// The overview and the seekable archive are both bounded independently of the
// decompressed source size. Only compressed segments survive the streaming pass.
const DEFAULT_VOXELS = 2_200_000
const DEFAULT_FACES = 500_000
const SEGMENT_BYTES = 1024 * 1024
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024
const ENTITY_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_ENTITIES = 4096
const SKIP = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])
const ROOTS = new Set(['Regions', 'SubRegions'])
const encoder = new TextEncoder(), decoder = new TextDecoder()
const typedArrays = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array }

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return { $nbtBigInt: String(value) }
  if (ArrayBuffer.isView(value)) return { $nbtArray: value.constructor.name, values: Array.from(value, v => typeof v === 'bigint' ? String(v) : v) }
  return value
}
function jsonReviver(_key, value) {
  if (value && typeof value === 'object') {
    if (typeof value.$nbtBigInt === 'string' && Object.keys(value).length === 1) return BigInt(value.$nbtBigInt)
    if (Object.hasOwn(typedArrays, value.$nbtArray) && Array.isArray(value.values)) {
      const values = value.$nbtArray.startsWith('Big') ? value.values.map(BigInt) : value.values
      return new typedArrays[value.$nbtArray](values)
    }
  }
  return value
}
async function transform(bytes, decompress, signal) {
  signal?.throwIfAborted()
  // Feed the existing segment directly. Creating thousands of temporary Blobs
  // would duplicate their buffers in native memory until the next garbage pass.
  const source = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
  const stream = source.pipeThrough(decompress ? new DecompressionStream('deflate') : new CompressionStream('deflate'))
  const reader = stream.getReader(), chunks = []
  let length = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value); length += value.length
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

function gridSize(bounds, step) {
  return { step, width: Math.ceil(bounds.width / step), height: Math.ceil(bounds.height / step), depth: Math.ceil(bounds.depth / step) }
}
function exposedFaces(grid) {
  const { states, width: w, height: h, depth: d } = grid, plane = w * d
  let faces = 0, occupied = 0
  for (let y = 0, i = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++, i++) {
    if (!states[i]) continue
    occupied++
    if (!x || !states[i - 1]) faces++
    if (x === w - 1 || !states[i + 1]) faces++
    if (!z || !states[i - w]) faces++
    if (z === d - 1 || !states[i + w]) faces++
    if (!y || !states[i - plane]) faces++
    if (y === h - 1 || !states[i + plane]) faces++
  }
  return { occupied, exposedFaces: faces }
}
function simplify(grid, bounds, maxFaces) {
  let stats = exposedFaces(grid)
  while (stats.exposedFaces > maxFaces) {
    const next = gridSize(bounds, grid.step * 2)
    next.states = new Uint32Array(next.width * next.height * next.depth)
    // Increasing Y preserves an upper surface representative when cells merge.
    for (let y = 0, i = 0; y < grid.height; y++) for (let z = 0; z < grid.depth; z++) {
      const row = (Math.floor(y / 2) * next.depth + Math.floor(z / 2)) * next.width
      for (let x = 0; x < grid.width; x++, i++) if (grid.states[i]) next.states[row + Math.floor(x / 2)] = grid.states[i]
    }
    grid = next; stats = exposedFaces(grid)
  }
  return Object.assign(grid, stats)
}

function makePalette(info) {
  const palette = [], byKey = new Map(), plans = new Map()
  for (const region of info.regions) {
    const local = new Int32Array(region.palette.length)
    for (let i = 0; i < local.length; i++) {
      const entry = region.palette[i]
      if (!entry || typeof entry.Name !== 'string') throw loadError('invalidBlockStates')
      if (SKIP.has(entry.Name.replace(/^minecraft:/, ''))) { local[i] = -1; continue }
      const properties = entry.Properties || {}, keys = Object.keys(properties).sort()
      const key = entry.Name + (keys.length ? '[' + keys.map(k => k + '=' + properties[k]).join(',') + ']' : '')
      if (!byKey.has(key)) { byKey.set(key, palette.length); palette.push({ name: entry.Name, properties, key }) }
      local[i] = byKey.get(key)
    }
    plans.set(region.name, { region, local, segments: [] })
  }
  return { palette, plans }
}

function createArchive(file, info, palette, plans, maxCacheBytes) {
  let mode = typeof CompressionStream === 'function' && maxCacheBytes > 0 ? 'memory' : 'stream'
  let cacheBytes = 0, disposed = false, entityOrder = 0
  const entityBatches = [], pendingEntities = new Map()
  let pendingBytes = 0
  function disableCache() {
    mode = 'stream'; cacheBytes = 0; pendingBytes = 0
    entityBatches.length = 0; pendingEntities.clear()
    for (const plan of plans.values()) plan.segments.length = 0
  }
  function check(signal) { signal?.throwIfAborted(); if (disposed) throw new DOMException('Archive disposed', 'AbortError') }
  async function store(bytes, signal) {
    check(signal)
    if (mode !== 'memory') return null
    const data = await transform(bytes, false, signal)
    check(signal)
    if (cacheBytes + data.length > maxCacheBytes) { disableCache(); return null }
    cacheBytes += data.length
    return data
  }
  async function flushEntity(key, signal) {
    const batch = pendingEntities.get(key)
    if (!batch) return
    pendingEntities.delete(key); pendingBytes -= batch.bytes
    const data = await store(encoder.encode('[' + batch.values.join(',') + ']'), signal)
    if (data) entityBatches.push({ data, bounds: batch.bounds })
  }
  const archive = {
    get mode() { return mode }, get cacheBytes() { return cacheBytes },
    dispose() {
      disposed = true; disableCache(); file = null; info = null; palette = null; plans.clear()
    },
    async addSegment(plan, bytes, signal) {
      const data = await store(bytes, signal)
      if (data) plan.segments.push(data)
    },
    async addEntity(value, signal) {
      check(signal)
      if (mode !== 'memory') return
      const p = value.kind === 'tile' ? [value.x, value.y, value.z] : value.pos
      if (!p.every(Number.isFinite)) return
      // Batches share a 64-cube spatial cell; random window access never needs
      // to expand all of a city's entities merely to find the nearby ones.
      const key = p.map(v => Math.floor(v / 64)).join(',')
      let batch = pendingEntities.get(key)
      if (!batch) {
        batch = { values: [], bytes: 0, bounds: { minX: p[0], maxX: p[0], minY: p[1], maxY: p[1], minZ: p[2], maxZ: p[2] } }
        pendingEntities.set(key, batch)
      }
      const json = JSON.stringify({ order: entityOrder++, ...value }, jsonReplacer), size = json.length * 2
      batch.values.push(json); batch.bytes += size; pendingBytes += size
      for (let i = 0; i < 3; i++) {
        const axis = 'XYZ'[i]
        batch.bounds['min' + axis] = Math.min(batch.bounds['min' + axis], p[i])
        batch.bounds['max' + axis] = Math.max(batch.bounds['max' + axis], p[i])
      }
      if (batch.values.length >= 256 || batch.bytes >= 512 * 1024) await flushEntity(key, signal)
      while (pendingBytes > ENTITY_BUFFER_BYTES && pendingEntities.size) await flushEntity(pendingEntities.keys().next().value, signal)
    },
    async finish(signal) {
      for (const key of pendingEntities.keys()) await flushEntity(key, signal)
    },
    async readWindow(selection, options = {}) {
      const { signal, onProgress } = options
      check(signal)
      const bounds = validateWindow(selection, info.bounds)
      if (mode !== 'memory') return readLitematicaWindow(file, info, bounds, options)
      const blocks = new Map(), entities = [], tileEntities = [], regions = []
      const expanded = new Map(), segmentsPerRegion = SEGMENT_BYTES / 8
      let completed = 0
      const volume = bounds.width * bounds.height * bounds.depth
      async function segment(plan, index) {
        check(signal)
        const packed = plan.segments[index]
        if (!packed) throw loadError('invalidBlockStates')
        if (expanded.has(packed)) {
          const bytes = expanded.get(packed); expanded.delete(packed); expanded.set(packed, bytes); return bytes
        }
        const bytes = await transform(packed, true, signal)
        expanded.set(packed, bytes)
        if (expanded.size > 8) expanded.delete(expanded.keys().next().value)
        return bytes
      }
      async function span(plan, first, end) {
        const firstSegment = Math.floor(first / segmentsPerRegion), lastSegment = Math.floor((end - 1) / segmentsPerRegion)
        const offset = (first % segmentsPerRegion) * 8
        if (firstSegment === lastSegment) return (await segment(plan, firstSegment)).subarray(offset, offset + (end - first) * 8)
        const bytes = new Uint8Array((end - first) * 8)
        let written = 0
        for (let i = firstSegment; i <= lastSegment; i++) {
          const chunk = await segment(plan, i), start = i === firstSegment ? offset : 0
          const take = Math.min(chunk.length - start, bytes.length - written)
          bytes.set(chunk.subarray(start, start + take), written); written += take
        }
        return bytes
      }
      for (const plan of plans.values()) {
        const { region, local } = plan, clip = intersectBounds(region, bounds)
        if (!clip) continue
        regions.push({ name: region.name, ...clip })
        for (let y = clip.minY; y <= clip.maxY; y++) for (let z = clip.minZ; z <= clip.maxZ; z++) for (let x = clip.minX; x <= clip.maxX; x += 65536) {
          check(signal)
          const count = Math.min(65536, clip.maxX - x + 1)
          const cell = (y - region.minY) * region.width * region.depth + (z - region.minZ) * region.width + x - region.minX
          const first = Math.floor(cell * region.bits / 64), end = Math.ceil((cell + count) * region.bits / 64)
          const values = decodePackedSpan(await span(plan, first, end), region.bits, cell * region.bits - first * 64, count)
          const row = (y - bounds.minY) * bounds.width * bounds.depth + (z - bounds.minZ) * bounds.width + x - bounds.minX
          for (let j = 0; j < count; j++) {
            if (values[j] >= local.length) throw loadError('invalidBlockStates')
            const gi = local[values[j]]
            if (gi >= 0) blocks.set(row + j, gi)
          }
          if (blocks.size > MAX_LOADED_BLOCKS) throw loadError('windowTooLarge')
          completed += count; onProgress?.(Math.min(1, completed / volume))
        }
      }
      for (const batch of entityBatches) {
        if (['X', 'Y', 'Z'].some(a => batch.bounds['max' + a] < bounds['min' + a] || batch.bounds['min' + a] >= bounds['max' + a] + 1)) continue
        const entries = JSON.parse(decoder.decode(await transform(batch.data, true, signal)), jsonReviver)
        for (const { kind, order, ...value } of entries) {
          const p = kind === 'tile' ? [value.x, value.y, value.z] : value.pos
          if (p.some((v, i) => v < bounds['min' + 'XYZ'[i]] || v >= bounds['max' + 'XYZ'[i]] + 1)) continue
          ;(kind === 'tile' ? tileEntities : entities).push({ order, value })
          if (entities.length + tileEntities.length > MAX_ENTITIES) throw loadError('windowTooComplex')
        }
      }
      const special = palette.map(p => /:(bell|enchanting_table|conduit|lectern|decorated_pot|player_head|player_wall_head)$|_banner$|copper_golem_statue$/.test(p.name))
      let count = 0
      for (const gi of blocks.values()) if (special[gi] && ++count > 2048) throw loadError('windowTooComplex')
      check(signal); onProgress?.(1)
      const originalOrder = entries => entries.sort((a, b) => a.order - b.order).map(entry => entry.value)
      return { metadata: info.metadata, palette, blocks, bounds, entities: originalOrder(entities), tileEntities: originalOrder(tileEntities), regions, sourceBounds: info.bounds, selection: bounds, maxFaces: MAX_WINDOW_FACES }
    },
  }
  return archive
}

/** Build an automatic whole-file preview and a bounded, seekable detail archive.
 * onProgress receives decompressed bytes, matching inspectLitematica. The archive
 * may survive transfer of data.overview.states.buffer to another worker context.
 */
export async function buildSchematicOverview(file, info, options = {}) {
  const { onProgress, signal, maxVoxels = DEFAULT_VOXELS, maxFaces = DEFAULT_FACES, maxCacheBytes = DEFAULT_CACHE_BYTES } = options
  if (!Number.isSafeInteger(maxVoxels) || maxVoxels < 1 || !Number.isSafeInteger(maxFaces) || maxFaces < 6 || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) throw new RangeError('Invalid overview budget')
  signal?.throwIfAborted()
  const { palette, plans } = makePalette(info)
  let step = 2, grid = gridSize(info.bounds, step)
  while (grid.width * grid.height * grid.depth > maxVoxels) grid = gridSize(info.bounds, step *= 2)
  grid.states = new Uint32Array(grid.width * grid.height * grid.depth)
  const top = info.bounds.height < 2147483647 ? new Int32Array(grid.states.length) : new Float64Array(grid.states.length)
  top.fill(-1)
  const counts = new Float64Array(palette.length), archive = createArchive(file, info, palette, plans, maxCacheBytes)
  const seen = new Set()

  async function readBlocks(r, plan) {
    const { region, local } = plan, words = await r.length()
    if (words !== region.words) throw loadError('invalidBlockStates')
    const total = region.width * region.height * region.depth, bits = region.bits, mask = (1 << bits) - 1
    const plane = region.width * region.depth, overviewPlane = grid.width * grid.depth
    const offsetX = region.minX - info.bounds.minX, offsetY = region.minY - info.bounds.minY, offsetZ = region.minZ - info.bounds.minZ
    const skipZeroWords = local[0] < 0
    let cell = 0, tail
    for (let firstWord = 0; firstWord < words; firstWord += SEGMENT_BYTES / 8) {
      signal?.throwIfAborted()
      const wordCount = Math.min(SEGMENT_BYTES / 8, words - firstWord), bytes = await r.bytes(wordCount * 8)
      await archive.addSegment(plan, bytes, signal)
      // A cell may straddle two compressed segments. Carry just its first word,
      // retaining no reference to a previously expanded megabyte-sized segment.
      let span = bytes, baseWord = firstWord
      if (cell * bits < firstWord * 64) {
        span = new Uint8Array(bytes.length + 8); span.set(tail); span.set(bytes, 8); baseWord--
      }
      const view = new DataView(span.buffer, span.byteOffset, span.byteLength)
      const end = Math.min(total, Math.floor((firstWord + wordCount) * 64 / bits))
      let bit = cell * bits - baseWord * 64, oldWord = -1, lo = 0, hi = 0
      while (cell < end) {
        const y = Math.floor(cell / plane), z = Math.floor(cell / region.width) % region.depth, x0 = cell % region.width
        const count = Math.min(region.width - x0, end - cell), relativeY = y + offsetY
        const overviewRow = Math.floor(relativeY / grid.step) * overviewPlane + Math.floor((z + offsetZ) / grid.step) * grid.width
        for (let x = x0, last = x0 + count; x < last; x++, bit += bits) {
          const word = Math.floor(bit / 64), off = bit & 63
          if (word !== oldWord) { oldWord = word; lo = view.getUint32(word * 8 + 4); hi = view.getUint32(word * 8) }
          if (skipZeroWords && !lo && !hi) {
            const empty = Math.min(last - x, Math.floor((64 - off) / bits))
            if (empty) { x += empty - 1; bit += (empty - 1) * bits; continue }
          }
          let value
          if (off + bits <= 32) value = lo >>> off
          else if (off < 32) value = (lo >>> off) | (hi << (32 - off))
          else if (off + bits <= 64) value = hi >>> (off - 32)
          else value = (hi >>> (off - 32)) | (view.getUint32(word * 8 + 12) << (64 - off))
          const li = value & mask
          if (li >= local.length) throw loadError('invalidBlockStates')
          const gi = local[li]
          if (gi < 0) continue
          counts[gi]++
          const index = overviewRow + Math.floor((x + offsetX) / grid.step)
          if (relativeY >= top[index]) { top[index] = relativeY; grid.states[index] = gi + 1 }
        }
        cell += count
      }
      tail = bytes.slice(-8)
    }
    if (cell !== total) throw loadError('invalidBlockStates')
  }
  try {
    await readNBTStream(file, { onProgress, signal, visit: async (r, type, path) => {
      if (!path.length || (path.length === 1 && ROOTS.has(path[0])) || (path.length === 2 && ROOTS.has(path[0]))) return
      if (path.length === 3 && ROOTS.has(path[0])) {
        const plan = plans.get(path[1])
        if (path[2] === 'BlockStates' && plan && type === 12) {
          await readBlocks(r, plan); seen.add(path[1]); return {}
        }
        if ((path[2] === 'Entities' || path[2] === 'TileEntities') && plan && type === 9 && archive.mode === 'memory') {
          const sub = await r.number(1), count = await r.length()
          if (count && sub !== 10) throw loadError('invalidBlockStates')
          for (let i = 0; i < count; i++) {
            if (archive.mode !== 'memory') { await r.payload(sub, [], false, 4, false); continue }
            const nbt = await r.payload(sub, [], true, 4, false), g = plan.region
            if (path[2] === 'TileEntities') {
              await archive.addEntity({ kind: 'tile', id: nbt.id, x: Number(nbt.x) + g.minX, y: Number(nbt.y) + g.minY, z: Number(nbt.z) + g.minZ, nbt, region: g.name }, signal)
            } else {
              const p = Array.isArray(nbt.Pos) ? nbt.Pos : [0, 0, 0]
              await archive.addEntity({ kind: 'entity', id: nbt.id, pos: [Number(p[0]) + g.position.x, Number(p[1]) + g.position.y, Number(p[2]) + g.position.z], rotation: [Number(nbt.Rotation?.[0]) || 0, Number(nbt.Rotation?.[1]) || 0], nbt, region: g.name }, signal)
            }
          }
          return {}
        }
      }
      await r.payload(type, path, false); return {}
    } })
    if (seen.size !== plans.size) throw loadError('invalidBlockStates')
    await archive.finish(signal)
    signal?.throwIfAborted()
    grid = simplify(grid, info.bounds, maxFaces)
    const materialCounts = new Map()
    for (let i = 0; i < palette.length; i++) if (counts[i]) materialCounts.set(palette[i].name, (materialCounts.get(palette[i].name) || 0) + counts[i])
    const data = { metadata: info.metadata, palette, blocks: new Map(), bounds: info.bounds, sourceBounds: info.bounds, selection: null,
      entities: [], tileEntities: [], regions: info.regions.map(({ name, minX, maxX, minY, maxY, minZ, maxZ, width, height, depth }) => ({ name, minX, maxX, minY, maxY, minZ, maxZ, width, height, depth })),
      overview: grid, materialCounts }
    return { data, archive }
  } catch (error) { archive.dispose(); throw error }
}
