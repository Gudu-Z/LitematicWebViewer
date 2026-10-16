// Scan only when scene membership/visibility changes, not once per animation frame.
export function collectSceneResources(scene) {
  const retained = new Set(), active = new Set(), materials = new Map()
  let animated = false
  const texturesOf = material => {
    if (materials.has(material)) return materials.get(material)
    const textures = new Set()
    const add = value => {
      if (value?.isTexture) textures.add(value)
      else if (Array.isArray(value)) value.forEach(add)
    }
    for (const value of Object.values(material)) add(value)
    for (const uniform of Object.values(material.uniforms || {})) add(uniform.value)
    materials.set(material, textures)
    return textures
  }
  const visit = (object, parentVisible) => {
    const visible = parentVisible && object.visible !== false
    if (visible && object.userData?.updateAnimation) animated = true
    for (const material of [object.material].flat()) {
      if (!material) continue
      for (const texture of texturesOf(material)) {
        retained.add(texture)
        if (visible && material.visible !== false) active.add(texture)
      }
    }
    for (const child of object.children) visit(child, visible)
  }
  visit(scene, true)
  for (const texture of [scene.background, scene.environment]) if (texture?.isTexture) {
    retained.add(texture); active.add(texture)
  }
  return { retained, active, animated }
}
