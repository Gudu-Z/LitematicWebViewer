import { PagedBlockStore } from './pagedBlocks.js'

// Keep the already-computed region overlay index and material counts, but never
// clone the decoded-page cache or keyView's iterator closure across threads.
export function serializeSchematic(data) {
  const blocks = data.blocks
  const serialized = blocks?.isPagedBlockStore ? {
    kind: 'paged', regions: blocks.regions, bounds: blocks.bounds,
    size: blocks.size, paletteCounts: blocks.paletteCounts, storageBytes: blocks.storageBytes,
    regionGrid: blocks.regionGrid, onlyRegion: blocks.onlyRegion,
  } : { kind: 'map', values: blocks }
  return { ...data, blocks: serialized }
}

export function deserializeSchematic(data) {
  const wire = data.blocks
  if (wire?.kind === 'map') {
    if (!(wire.values instanceof Map)) throw new TypeError('Invalid worker block map')
    return { ...data, blocks: wire.values }
  }
  if (wire?.kind !== 'paged' || !Array.isArray(wire.regions)
    || !Number.isSafeInteger(wire.size) || wire.size < 0) throw new TypeError('Invalid worker block pages')
  // Empty construction creates the normal bounded cache/prototype without
  // walking any blocks. Restoring overlapping regions must not scan them again.
  const blocks = new PagedBlockStore([], wire.bounds, 0)
  for (const key of ['regions', 'bounds', 'size', 'paletteCounts', 'storageBytes', 'regionGrid', 'onlyRegion']) blocks[key] = wire[key]
  blocks.keyView.length = blocks.size
  return { ...data, blocks }
}

const coordinateKeys = ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ']

/** Serializable equivalent of the viewer's layer/hidden-region predicate. */
export function filterFromDescriptor(descriptor) {
  if (descriptor == null) return null
  if (typeof descriptor !== 'object' || !['all', 'single', 'below', 'above'].includes(descriptor.mode)) {
    throw new TypeError('Invalid worker layer mode')
  }
  const { mode, layerY } = descriptor
  if ((mode !== 'all' || layerY !== undefined) && !Number.isSafeInteger(layerY)) throw new RangeError('Invalid worker layer coordinate')
  if (descriptor.regionKey && descriptor.hiddenRegions === undefined) throw new TypeError('Missing worker hidden-region bounds')
  const hidden = descriptor.hiddenRegions ?? []
  if (!Array.isArray(hidden)) throw new TypeError('Invalid worker hidden regions')
  for (const region of hidden) {
    if (!region || !coordinateKeys.every(key => Number.isSafeInteger(region[key]))
      || region.minX > region.maxX || region.minY > region.maxY || region.minZ > region.maxZ) {
      throw new RangeError('Invalid worker region bounds')
    }
  }
  if (mode === 'all' && !hidden.length) return null
  const filter = (x, y, z) => {
    if (mode === 'single' && y !== layerY || mode === 'below' && y > layerY || mode === 'above' && y < layerY) return false
    return !hidden.some(region => x >= region.minX && x <= region.maxX
      && y >= region.minY && y <= region.maxY && z >= region.minZ && z <= region.maxZ)
  }
  filter.descriptor = { ...descriptor, hiddenRegions: hidden }
  return filter
}

/** Deduplicate backing buffers, including aliases and cycles in cloned NBT. */
export function transferBuffers(value, excluded = new Set()) {
  const seen = new Set(), buffers = new Set()
  const visit = item => {
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (item instanceof ArrayBuffer) {
      if (!excluded.has(item)) buffers.add(item)
    } else if (ArrayBuffer.isView(item)) visit(item.buffer)
    else if (item instanceof Map) for (const [key, child] of item) { visit(key); visit(child) }
    else if (item instanceof Set) for (const child of item) visit(child)
    else for (const child of Object.values(item)) visit(child)
  }
  visit(value)
  return [...buffers]
}

export function serializeWorkerError(error) {
  const result = { name: error?.name || 'Error', message: error?.message || String(error) }
  for (const key of ['code', 'reason', 'bytes', 'maxBytes']) {
    if (typeof error?.[key] === 'string' || typeof error?.[key] === 'number') result[key] = error[key]
  }
  return result
}

export function deserializeWorkerError(error) {
  const result = new Error(error?.message || 'Background task failed')
  result.name = error?.name || 'Error'
  for (const key of ['code', 'reason', 'bytes', 'maxBytes']) if (error?.[key] !== undefined) result[key] = error[key]
  return result
}
