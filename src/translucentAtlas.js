import * as THREE from 'three'

// Glass adds more sprites than the minimum WebGL sampler budget. A bounded atlas
// keeps all colours in one sorted draw, rather than creating a mesh per face.
// Source textures stay owned/animated by AssetProvider; only this copy is private.
export function createTranslucentAtlas(maps) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null
  const sizes = maps.map(map => [map.image?.width || 0, map.image?.height || 0])
  if (sizes.some(([w, h]) => !w || !h || w > 2046 || h > 2046)) return null
  const area = sizes.reduce((n, [w, h]) => n + (w + 2) * (h + 2), 0)
  const width = THREE.MathUtils.ceilPowerOfTwo(Math.max(Math.sqrt(area), ...sizes.map(([w]) => w + 2)))
  if (width > 2048) return null
  let x = 0, y = 0, row = 0
  const slots = sizes.map(([w, h]) => {
    if (x + w + 2 > width) { x = 0; y += row; row = 0 }
    const slot = { x: x + 1, y: y + 1, w, h, version: -1 }
    x += w + 2; row = Math.max(row, h + 2)
    return slot
  })
  const height = THREE.MathUtils.ceilPowerOfTwo(y + row)
  if (height > 2048) return null
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(width, height)
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.imageSmoothingEnabled = false
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false; texture.generateMipmaps = false
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.name = 'translucent-block-atlas'
  return {
    texture, slots, width, height,
    update() {
      let dirty = false
      for (let i = 0; i < maps.length; i++) {
        const slot = slots[i], map = maps[i]
        if (slot.version === map.version) continue
        context.clearRect(slot.x, slot.y, slot.w, slot.h)
        context.drawImage(map.image, slot.x, slot.y, slot.w, slot.h)
        slot.version = map.version; dirty = true
      }
      if (dirty) texture.needsUpdate = true
    },
    dispose() { texture.dispose(); canvas.width = canvas.height = 1 },
  }
}
