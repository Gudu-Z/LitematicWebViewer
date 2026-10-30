import { PagedBlockStore } from './pagedBlocks.js'

export const GEOMETRY_STREAM_VERSION = 1
export const DEFAULT_STREAM_BATCH_BYTES = 32 * 1024 * 1024
const STREAM_TYPES = { Float32Array, Float64Array, Uint16Array, Uint32Array }

export function streamProtocolError(message) {
  return Object.assign(new Error(message), { code: 'WORKER_PROTOCOL' })
}

export function streamBatchBytes(value = DEFAULT_STREAM_BATCH_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > DEFAULT_STREAM_BATCH_BYTES) throw new RangeError('Invalid geometry stream batch budget')
  return value
}

// Keep validated primitive copies: a consumer may annotate or change the raw
// callback payload, but that must not change protocol checks or ACK ownership.
export function validateStreamLayout(layout) {
  if (layout?.version !== GEOMETRY_STREAM_VERSION || !Array.isArray(layout.groups)
    || !Number.isSafeInteger(layout.emitted) || layout.emitted < 0
    || !Number.isSafeInteger(layout.geometryBytes) || layout.geometryBytes < 0) throw streamProtocolError('Invalid geometry stream layout')
  const keys = new Set()
  let emitted = 0
  const groups = layout.groups.map((group, groupIndex) => {
    if (group?.groupIndex !== groupIndex || typeof group.key !== 'string' || keys.has(group.key)
      || !['compact', 'quads', 'points'].includes(group.kind) || !Number.isSafeInteger(group.count) || group.count < 0
      || !Array.isArray(group.buffers)) throw streamProtocolError('Invalid geometry stream group')
    keys.add(group.key); emitted += group.count
    const expected = group.kind === 'compact' ? { cells: 1, templateIds: 1, cellYs: 1 }
      : group.kind === 'quads' ? { positions: 12, uvs: 8, indices: 6, blockKeys: 1 } : { positions: 3 }
    const required = group.kind === 'compact' ? ['cells', 'templateIds'] : group.kind === 'quads' ? ['positions', 'uvs', 'indices'] : ['positions']
    const names = new Set()
    const buffers = group.buffers.map(spec => {
      if (!spec || !Object.hasOwn(expected, spec.name) || names.has(spec.name) || !Object.hasOwn(STREAM_TYPES, spec.type)
        || spec.stride !== expected[spec.name] || !Number.isSafeInteger(spec.length) || spec.length !== group.count * spec.stride) {
        throw streamProtocolError('Invalid geometry stream buffer layout')
      }
      const allowed = spec.name === 'indices' ? ['Uint16Array', 'Uint32Array'] : spec.name === 'blockKeys' ? ['Uint32Array', 'Float64Array']
        : ['positions', 'uvs'].includes(spec.name) ? ['Float32Array'] : ['Uint32Array']
      if (!allowed.includes(spec.type)) throw streamProtocolError('Invalid geometry stream buffer type')
      names.add(spec.name)
      return { name: spec.name, type: spec.type, length: spec.length, stride: spec.stride }
    })
    if (required.some(name => !names.has(name))) throw streamProtocolError('Missing geometry stream buffer')
    return { groupIndex, key: group.key, kind: group.kind, count: group.count, buffers }
  })
  if (!Number.isSafeInteger(emitted) || emitted !== layout.emitted) throw streamProtocolError('Geometry stream counts do not match')
  return { emitted, geometryBytes: layout.geometryBytes, groups }
}

function slabId(id) { return Number.isSafeInteger(id) && id >= 0 }

export function snapshotStreamSlabs(slabs, maxBytes = DEFAULT_STREAM_BATCH_BYTES) {
  if (!Array.isArray(slabs) || !slabs.length) throw streamProtocolError('Missing geometry stream slabs')
  const ids = new Set(), buffers = new Set()
  let bytes = 0
  const snapshot = slabs.map(slab => {
    if (!slab || !slabId(slab.slabId) || ids.has(slab.slabId) || !(slab.buffer instanceof ArrayBuffer)
      || !slab.buffer.byteLength || buffers.has(slab.buffer)) throw streamProtocolError('Invalid geometry stream slab')
    ids.add(slab.slabId); buffers.add(slab.buffer); bytes += slab.buffer.byteLength
    return { slabId: slab.slabId, buffer: slab.buffer, byteLength: slab.buffer.byteLength }
  })
  if (bytes > maxBytes) throw streamProtocolError('Geometry stream batch exceeds staging budget')
  return snapshot
}

export function validateStreamBatch(batch, layout, cursors, maxBytes) {
  if (!batch || !Array.isArray(batch.parts) || !batch.parts.length) throw streamProtocolError('Empty geometry stream batch')
  const slabs = snapshotStreamSlabs(batch.slabs, maxBytes), ranges = new Map(slabs.map(slab => [slab.buffer, []]))
  const nextCursors = cursors.slice()
  for (const part of batch.parts) {
    const group = layout.groups[part?.groupIndex]
    if (!group || !Number.isSafeInteger(part.groupIndex) || !Number.isSafeInteger(part.start) || part.start !== nextCursors[group.groupIndex]
      || !Number.isSafeInteger(part.count) || part.count <= 0 || part.start + part.count > group.count
      || !part.buffers || Object.keys(part.buffers).length !== group.buffers.length) throw streamProtocolError('Invalid geometry stream segment range')
    for (const spec of group.buffers) {
      const view = part.buffers[spec.name]
      if (!(view instanceof STREAM_TYPES[spec.type]) || view.length !== part.count * spec.stride || !ranges.has(view.buffer)) {
        throw streamProtocolError('Invalid geometry stream segment buffer')
      }
      ranges.get(view.buffer).push([view.byteOffset, view.byteOffset + view.byteLength])
    }
    nextCursors[group.groupIndex] += part.count
  }
  for (const intervals of ranges.values()) {
    if (!intervals.length) throw streamProtocolError('Unused geometry stream slab')
    intervals.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < intervals.length; i++) if (intervals[i][0] < intervals[i - 1][1]) throw streamProtocolError('Overlapping geometry stream segment views')
  }
  return { slabs, nextCursors }
}

export function validateStreamAck(slabs, expected) {
  if (!Array.isArray(slabs) || slabs.length !== expected.length) throw streamProtocolError('Invalid geometry stream ACK slabs')
  const ids = new Set(), buffers = new Set()
  const sizes = new Map(expected.map(slab => [slab.slabId, slab.byteLength]))
  return slabs.map(slab => {
    if (!slab || !sizes.has(slab.slabId) || ids.has(slab.slabId) || !(slab.buffer instanceof ArrayBuffer)
      || slab.buffer.byteLength !== sizes.get(slab.slabId) || buffers.has(slab.buffer)) throw streamProtocolError('Invalid returned geometry stream slab')
    ids.add(slab.slabId); buffers.add(slab.buffer)
    return { slabId: slab.slabId, buffer: slab.buffer }
  })
}

export function validateStreamResult(result, layout, cursors, batchCount) {
  if (result?.streamed !== true || result.version !== GEOMETRY_STREAM_VERSION || result.batchCount !== batchCount
    || result.emitted !== layout.emitted || !Number.isSafeInteger(result.geometryBytes) || result.geometryBytes < layout.geometryBytes
    || !Array.isArray(result.tails) || result.tails.length !== layout.groups.length || Object.hasOwn(result, 'groups')
    || cursors.some((count, index) => count !== layout.groups[index].count)) throw streamProtocolError('Incomplete geometry stream result')
  for (let i = 0; i < result.tails.length; i++) {
    const tail = result.tails[i]
    if (tail?.groupIndex !== i || !tail.metadata || typeof tail.metadata !== 'object'
      || layout.groups[i].buffers.some(spec => Object.hasOwn(tail.metadata, spec.name))) throw streamProtocolError('Invalid geometry stream tail')
  }
}

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
