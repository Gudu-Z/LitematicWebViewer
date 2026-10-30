import { canCompactFaces, FACE_BATCH_SIZE } from './compactFaceData.js'

export const MAX_GEOMETRY_BYTES = 6 * 1024 ** 3
const MAX_ARRAY_BYTES = 2 ** 31 - 1
export function geometryLimit(bytes, maxBytes = MAX_GEOMETRY_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_GEOMETRY_BYTES) throw new RangeError('Invalid geometry budget')
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw Object.assign(new Error('Visible geometry exceeds the memory budget'),
    { code: 'FILE_TOO_LARGE', reason: 'geometry', bytes, maxBytes })
  return bytes
}

// Count exact face/point buffers before allocating any of them. Template atlas
// bytes are added as each compact group finishes; GPU and texture memory are separate.
export function estimateGeometryBytes(counts, bounds, options = {}) {
  options ??= {}
  let bytes = 0
  const wide = bounds.width * bounds.height * bounds.depth > 2 ** 32
  for (const [key, count] of counts) {
    const compact = options.compactFaces && canCompactFaces(bounds, key)
    const largest = compact ? count * 4 : key === 'particle/bubble' ? count * 12 : count * 48
    if (largest > MAX_ARRAY_BYTES) geometryLimit(MAX_GEOMETRY_BYTES + 1, options.maxGeometryBytes)
    bytes += compact ? count * (wide ? 12 : 8) + Math.ceil(count / FACE_BATCH_SIZE) * 72 + 72
      : key === 'particle/bubble' ? count * 12
        : count * (80 + (count * 4 < 65536 ? 12 : 24) + (options.trackBlocks ? wide ? 8 : 4 : 0))
  }
  return geometryLimit(bytes, options.maxGeometryBytes)
}
