import * as THREE from 'three'
import { blockFaceKeys, selectionSource, blockPosition, blockKey } from './selectionSources.js'
import { frameInstanceRoot } from './frameBatches.js'

const pixels = new WeakMap()
const GROUPS = ['group', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup', 'entitiesGroup']

// A triangle's vertex still identifies its original quad after translucent faces
// are sorted. faceIndex does not. This also handles pack models outside the cell.
export function sourceForIntersection(hit, data) {
  const object = frameInstanceRoot(hit.object, hit.instanceId) || hit.object
  let block = null
  for (let node = object; node; node = node.parent) {
    const source = selectionSource(node)
    if (source?.kind === 'entity') return source
    if (source) block = source
  }
  if (block) return block
  const keys = blockFaceKeys(hit.object.geometry)
  if (!keys || !hit.face || !data) return null
  const key = keys[Math.floor(hit.face.a / 4)]
  return key === undefined ? null : { kind: 'block', key, position: blockPosition(key, data.bounds) }
}

// Skip transparent sprite pixels (fences, flowers, leaves, skins). Read only a
// texture that was actually hit, and retain its pixels weakly across clicks.
export function visibleIntersection(hit) {
  const object = hit.object
  const material = Array.isArray(object.material) ? object.material[hit.face?.materialIndex || 0] : object.material
  if (!material || !material.visible || material.opacity === 0) return false
  let map = material.map
  if (material.translucentMaps && hit.face) map = material.translucentMaps[object.geometry.attributes.blockTexture.getX(hit.face.a)]
  if (!map || !hit.uv || (!material.alphaTest && !material.transparent)) return true
  const image = map.image
  if (!image?.width || !image?.height) return true
  try {
    let record = pixels.get(map)
    if (!record || record.version !== map.version || record.image !== image) {
      const width = image.width, height = image.height
      // Avoid a huge secondary copy of a high-resolution pack texture.
      if (width * height > 4 * 1024 * 1024) return true
      let rgba = image.data
      if (!rgba) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(image, 0, 0); rgba = ctx.getImageData(0, 0, width, height).data
      }
      if (rgba.length !== width * height * 4) return true
      record = { image, version: map.version, rgba, width, height }; pixels.set(map, record)
    }
    if (map.matrixAutoUpdate) map.updateMatrix()
    const uv = map.transformUv(hit.uv.clone())
    const x = Math.max(0, Math.min(record.width - 1, Math.floor(uv.x * record.width)))
    const y = Math.max(0, Math.min(record.height - 1, Math.floor(uv.y * record.height)))
    const alpha = record.rgba[(x + y * record.width) * 4 + 3] / 255 * material.opacity
    return alpha >= Math.max(material.alphaTest || 0, .001)
  } catch { return true } // A cross-origin skin may prohibit reading its pixels.
}

export function pickSchematic(renderer, data, clientX, clientY) {
  if (!data) return null
  const rect = renderer.renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  renderer.scene.updateMatrixWorld(true)
  renderer.camera.updateMatrixWorld(true)
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1,
    1 - (clientY - rect.top) / rect.height * 2), renderer.camera)
  const hits = []
  for (const name of GROUPS) renderer[name]?.traverseVisible(object => {
    if (!object.isMesh) return
    // Animated rigs can have moved since Three cached their initial bounds.
    if (object.isSkinnedMesh) { object.computeBoundingSphere(); object.computeBoundingBox() }
    raycaster.intersectObject(object, false, hits)
  })
  hits.sort((a, b) => a.distance - b.distance)
  for (const hit of hits) {
    const source = sourceForIntersection(hit, data)
    if (!source || !visibleIntersection(hit)) continue
    if (source.kind === 'block') {
      const key = source.key ?? blockKey(source.position, data.bounds)
      if (key === null || !data.blocks.has(key)) continue
      return { ...source, key, point: hit.point }
    }
    return { ...source, point: hit.point }
  }
  return null
}

export function selectionBounds(selection) {
  if (selection.kind === 'block') {
    const min = new THREE.Vector3(...selection.position)
    return new THREE.Box3(min, min.clone().addScalar(1)).expandByScalar(.003)
  }
  const root = selection.root, record = root.userData.entityHitbox
  root.updateWorldMatrix(true, true)
  if (record) {
    const matrix = root.matrixWorld.clone().multiply(record.anchor)
    const box = new THREE.Box3(new THREE.Vector3(...record.bounds.min), new THREE.Vector3(...record.bounds.max))
    for (const part of record.bounds.parts || []) box.union(new THREE.Box3(new THREE.Vector3(...part.min), new THREE.Vector3(...part.max)))
    return box.applyMatrix4(matrix).expandByScalar(.008)
  }
  return new THREE.Box3().setFromObject(root).expandByScalar(.008)
}

// Single primary tap only. Do not turn orbiting, right-drag panning, a drag that
// returns to its start, or the final finger of a pinch into an accidental pick.
export function bindSelectionClicks(canvas, enabled, onClick) {
  const abort = new AbortController(), options = { signal: abort.signal, capture: true }
  const pointers = new Set()
  let start = null
  canvas.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId)
    if (pointers.size !== 1 || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !enabled()) { start = null; return }
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, threshold: event.pointerType === 'touch' ? 8 : 5 }
  }, options)
  window.addEventListener('pointermove', event => {
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > start.threshold) start = null
  }, options)
  window.addEventListener('pointerup', event => {
    const click = start?.id === event.pointerId && pointers.size === 1 && event.button === 0
    pointers.delete(event.pointerId); start = null
    const r = canvas.getBoundingClientRect()
    if (click && enabled() && event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom) onClick(event.clientX, event.clientY)
  }, options)
  window.addEventListener('pointercancel', event => { pointers.delete(event.pointerId); start = null }, options)
  window.addEventListener('blur', () => { pointers.clear(); start = null }, options)
  canvas.addEventListener('wheel', () => { start = null }, { ...options, passive: true })
  return () => abort.abort()
}
