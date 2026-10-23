// CPU-only provenance. Never put NBT or typed arrays in Object3D.userData:
// Three clones that object through JSON, and saved NBT can contain BigInts.
const faces = new WeakMap(), objects = new WeakMap()

export const blockFaceKeys = geometry => faces.get(geometry)
export function setBlockFaceKeys(geometry, keys) {
  if (keys) faces.set(geometry, keys)
}
export function markBlockObject(object, x, y, z) {
  objects.set(object, { kind: 'block', position: [x, y, z] })
  return object
}
export function markEntityObject(object, entity) {
  objects.set(object, { kind: 'entity', entity, root: object })
  return object
}
export const selectionSource = object => objects.get(object)

export function blockPosition(key, bounds) {
  return [key % bounds.width + bounds.minX,
    Math.floor(key / (bounds.width * bounds.depth)) + bounds.minY,
    Math.floor(key / bounds.width) % bounds.depth + bounds.minZ]
}
export function blockKey([x, y, z], bounds) {
  x -= bounds.minX; y -= bounds.minY; z -= bounds.minZ
  if (![x, y, z].every(Number.isInteger) || x < 0 || y < 0 || z < 0 || x >= bounds.width || y >= bounds.height || z >= bounds.depth) return null
  return x + z * bounds.width + y * bounds.width * bounds.depth
}
