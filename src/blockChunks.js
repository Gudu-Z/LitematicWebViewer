// 保守地分割完整实心方块；流体、特殊模型和混用贴图继续保持原全局组顺序。
import { buildFaceGroups, fluidOfEntry, isSkipBlock, isTransparent } from './geometry.js'

const DEFAULTS = { chunkSize: 32, maxChunks: 64, minBlocks: 4096, minTextureBlocks: 512 }

function isUnitCube(entry) {
  const baked = entry.baked
  if (!baked?.fullCube || baked.quads?.length !== 6 || isSkipBlock(entry.name)
    || isTransparent(entry.name) || fluidOfEntry(entry)) return false
  const directions = new Set()
  for (const quad of baked.quads) {
    const direction = quad.cullface
    if (!direction || direction.length !== 3 || direction.reduce((sum, v) => sum + Math.abs(v), 0) !== 1) return false
    const axis = direction.findIndex(v => v !== 0)
    if (Math.abs(direction[axis]) !== 1 || quad.verts?.length !== 4) return false
    const corners = new Set()
    for (const vertex of quad.verts) {
      if (vertex.length !== 3 || vertex.some(v => v !== 0 && v !== 1)
        || vertex[axis] !== (direction[axis] > 0 ? 1 : 0)) return false
      corners.add(vertex.join(','))
    }
    if (corners.size !== 4) return false
    directions.add(direction.join(','))
  }
  return directions.size === 6
}

function reservedGroup(key) {
  return key.startsWith('special/') || key === 'particle/bubble'
    || /^block\/(water|lava)_(still|flow|overlay)$/.test(key)
    || /redstone_dust_(dot|line0|line1)$/.test(key)
}

function coordinates(key, bounds) {
  return [key % bounds.width + bounds.minX,
    Math.floor(key / (bounds.width * bounds.depth)) + bounds.minY,
    Math.floor(key / bounds.width) % bounds.depth + bounds.minZ]
}

function chunkId(x, y, z, size, bounds) {
  return `${Math.floor((x - bounds.minX) / size)},${Math.floor((y - bounds.minY) / size)},${Math.floor((z - bounds.minZ) / size)}`
}

function addLayer(layers, y, id) {
  let layer = layers.get(y)
  if (!layer) layers.set(y, layer = new Set())
  layer.add(id)
}

/** Build once for a baked palette / resource revision. Keys retain the source Map order. */
export function createBlockChunkIndex(data, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  const { palette, blocks, bounds } = data
  if (blocks.isPagedBlockStore) {
    // The compact store already has bounded pages. Do not duplicate hundreds of
    // millions of cell keys just to enumerate an original-order texture group.
    const layers = new Map()
    for (const region of blocks.regions) for (let y = region.minY; y <= region.maxY; y++) layers.set(y, new Set([null]))
    return { data, enabled: false, compact: true, chunkSize: settings.chunkSize, splitGroups: new Set(),
      chunks: new Map(), globalKeys: blocks.keyView, ids: [null], layers, layerYs: [...layers.keys()].sort((a, b) => a - b) }
  }
  const useCounts = new Float64Array(palette.length)
  for (const gi of blocks.values()) useCounts[gi]++
  const safePalette = palette.map(isUnitCube)
  const textureKeys = palette.map(p => [...new Set(p.baked?.quads?.map(q => q.texKey) || [])])
  const textureCounts = new Map()
  const unsafeTextures = new Set()
  for (let gi = 0; gi < palette.length; gi++) {
    if (!useCounts[gi]) continue
    for (const key of textureKeys[gi]) {
      if (!safePalette[gi] || reservedGroup(key)) unsafeTextures.add(key)
      textureCounts.set(key, (textureCounts.get(key) || 0) + useCounts[gi])
    }
  }
  const splitGroups = new Set([...textureCounts]
    .filter(([key, count]) => !unsafeTextures.has(key) && count >= settings.minTextureBlocks)
    .map(([key]) => key))
  const splitPalette = textureKeys.map((keys, gi) => safePalette[gi] && keys.some(key => splitGroups.has(key)))
  const globalPalette = textureKeys.map((keys, gi) => !!fluidOfEntry(palette[gi])
    || keys.some(key => !splitGroups.has(key)))
  let splitCount = 0
  for (let gi = 0; gi < palette.length; gi++) if (splitPalette[gi]) splitCount += useCounts[gi]

  let size = Math.max(1, Math.floor(settings.chunkSize))
  const maxChunks = Math.max(1, Math.floor(settings.maxChunks))
  const index = { data, enabled: false, chunkSize: size, splitGroups, chunks: new Map(), globalKeys: [], ids: [null], layers: new Map(), layerYs: [] }
  // At larger magnitudes Float32 can collapse adjacent cells onto the same plane.
  // Keep their original face order, even though individual vertex values would match.
  const exactCells = [[bounds.minX, bounds.width], [bounds.minY, bounds.height], [bounds.minZ, bounds.depth]]
    .every(([min, length]) => Number.isInteger(min) && Number.isInteger(length)
      && Math.abs(min) <= 2 ** 24 && Math.abs(min + length) <= 2 ** 24)
  if (exactCells && splitCount >= settings.minBlocks && splitGroups.size) {
    // Probe only keys, before allocating per-chunk arrays. Sparse structures do not pay
    // for every empty cell in their bounding box.
    let ids
    do {
      ids = new Set()
      for (const [key, gi] of blocks) {
        if (!splitPalette[gi]) continue
        const [x, y, z] = coordinates(key, bounds)
        ids.add(chunkId(x, y, z, size, bounds))
        if (ids.size > maxChunks) break
      }
      if (ids.size > maxChunks) size *= 2
    } while (ids.size > maxChunks)
    index.enabled = ids.size > 1
  }
  index.chunkSize = size
  for (const [key, gi] of blocks) {
    const [x, y, z] = coordinates(key, bounds)
    // Even a missing model can affect a fluid through its block-name flow tag.
    if (!index.layers.has(y)) index.layers.set(y, new Set())
    if (!index.enabled || globalPalette[gi]) {
      index.globalKeys.push(key)
      addLayer(index.layers, y, null)
    }
    if (index.enabled && splitPalette[gi]) {
      const id = chunkId(x, y, z, size, bounds)
      let chunk = index.chunks.get(id)
      if (!chunk) index.chunks.set(id, chunk = { keys: [], minY: y, maxY: y })
      chunk.keys.push(key)
      chunk.minY = Math.min(chunk.minY, y)
      chunk.maxY = Math.max(chunk.maxY, y)
      addLayer(index.layers, y, id)
    }
  }
  if (index.enabled) index.ids = [null, ...index.chunks.keys()]
  index.layerYs = [...index.layers.keys()].sort((a, b) => a - b)
  return index
}

export async function buildBlockChunk(index, id, filter, onProgress, trackBlocks = false) {
  const keys = id === null ? index.globalKeys : index.chunks.get(id)?.keys
  if (!keys) throw new Error(`Unknown block chunk: ${id}`)
  const includeGroup = !index.enabled ? undefined
    : id === null ? key => !index.splitGroups.has(key) : key => index.splitGroups.has(key)
  const { palette, blocks, bounds } = index.data
  const result = await buildFaceGroups(palette, blocks, bounds, onProgress, filter, { keys, includeGroup, trackBlocks, compactFaces: index.compact })
  return { ...result, scannedBlocks: keys.length }
}

function descriptor(value) {
  if (value === null) return { mode: 'all', regionKey: '' }
  if (!value || !['all', 'single', 'below', 'above'].includes(value.mode)
    || (value.mode !== 'all' && !Number.isInteger(value.layerY))) return null
  return { ...value, regionKey: value.regionKey ?? '' }
}

function interval(value) {
  if (value.mode === 'single') return [value.layerY, value.layerY]
  if (value.mode === 'below') return [-Infinity, value.layerY]
  if (value.mode === 'above') return [value.layerY, Infinity]
  return [-Infinity, Infinity]
}

function difference(a, b) {
  if (a[1] < b[0] || a[0] > b[1]) return [a]
  const ranges = []
  if (a[0] < b[0]) ranges.push([a[0], b[0] - 1])
  if (a[1] > b[1]) ranges.push([b[1] + 1, a[1]])
  return ranges
}

function lowerBound(values, target) {
  let lo = 0, hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** No blocks Map scan on layer changes; only changed occupied layers and their neighbours. */
export function planBlockChunkUpdate(index, previousDescriptor, nextDescriptor) {
  const previous = descriptor(previousDescriptor), next = descriptor(nextDescriptor)
  const fullRebuild = !previous || !next || previous.regionKey !== next.regionKey
  let dirty
  if (fullRebuild) {
    dirty = index.ids.slice()
  } else {
    const before = interval(previous), after = interval(next)
    const affected = new Set()
    for (const [minY, maxY] of [...difference(before, after), ...difference(after, before)]) {
      for (let pos = lowerBound(index.layerYs, minY); pos < index.layerYs.length && index.layerYs[pos] <= maxY; pos++) {
        const y = index.layerYs[pos]
        for (let neighbour = y - 1; neighbour <= y + 1; neighbour++) {
          for (const id of index.layers.get(neighbour) || []) affected.add(id)
        }
      }
    }
    dirty = index.ids.filter(id => affected.has(id))
  }
  const scannedBlocks = dirty.reduce((sum, id) => sum + (id === null ? index.globalKeys.length : index.chunks.get(id).keys.length), 0)
  return { dirty, scannedBlocks, fullRebuild }
}
