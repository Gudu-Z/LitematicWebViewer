import * as THREE from 'three'

export const MAX_EXPORT_EDGE = 8192
export const MAX_EXPORT_PIXELS = 16 * 1024 * 1024

export function validImageSize(width, height, maxEdge = MAX_EXPORT_EDGE) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 64 && height >= 64 &&
    width <= maxEdge && height <= maxEdge && width * height <= MAX_EXPORT_PIXELS
}

export function exportFilename(value) {
  return (String(value).replace(/\.(?:litematic|litematica|nbt|png)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '') || 'schematic') + '.png'
}

export function viewDirection(yaw, pitch) {
  const azimuth = THREE.MathUtils.degToRad(yaw)
  const elevation = THREE.MathUtils.degToRad(Math.max(-89.999, Math.min(89.999, pitch)))
  return new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
}

export function setImageAspect(camera, aspect) {
  if (camera.isOrthographicCamera) {
    camera.left = -camera.top * aspect
    camera.right = camera.top * aspect
  } else camera.aspect = aspect
  camera.updateProjectionMatrix()
}

// Fit every bounding-box corner, including deep perspective views and narrow canvases.
export function fitImageCamera(camera, box, aspect, direction, padding = .12) {
  const target = box.getCenter(new THREE.Vector3())
  const radius = Math.max(.5, box.getSize(new THREE.Vector3()).length() / 2)
  const available = 1 - Math.max(0, Math.min(.4, padding)) * 2
  camera.zoom = 1
  camera.position.copy(target).add(direction.clone().normalize())
  camera.lookAt(target)
  const inverse = camera.quaternion.clone().invert()
  let halfHeight = .01, distance = radius * 3
  const tan = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) : 1
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new THREE.Vector3(x, y, z).sub(target).applyQuaternion(inverse)
    halfHeight = Math.max(halfHeight, Math.abs(p.y) / available, Math.abs(p.x) / (aspect * available))
    if (camera.isPerspectiveCamera) distance = Math.max(distance, p.z + Math.abs(p.y) / (tan * available), p.z + Math.abs(p.x) / (tan * aspect * available))
  }
  if (camera.isOrthographicCamera) { camera.top = halfHeight; camera.bottom = -halfHeight }
  camera.position.copy(target).addScaledVector(direction.clone().normalize(), distance)
  camera.near = Math.max(.001, radius / 10000)
  camera.far = Math.max(1000, radius * 200)
  setImageAspect(camera, aspect)
  camera.updateMatrixWorld(true)
  return { target, radius, distance }
}
