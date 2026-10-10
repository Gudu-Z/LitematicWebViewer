import * as THREE from 'three'
import { AssetProvider } from './assets.js'
import { buildGuiItem } from './entities.js'
import { BlockModelResolver } from './blocks.js'
import { Renderer } from './renderer.js'

// Placed-only blocks use their inventory counterpart; other blocks can fall back
// to their block model (for example a planted flower pot or a cake with a candle).
export function materialIconId(name) {
  const id = name.replace(/^minecraft:/, '').replace(/(^|_)wall_/, '$1')
  return ({
    water: 'water_bucket', lava: 'lava_bucket', bubble_column: 'water_bucket',
    redstone_wire: 'redstone', tripwire: 'string', wheat: 'wheat_seeds',
    carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds',
    cocoa: 'cocoa_beans', sweet_berry_bush: 'sweet_berries',
    melon_stem: 'melon_seeds', attached_melon_stem: 'melon_seeds',
    pumpkin_stem: 'pumpkin_seeds', attached_pumpkin_stem: 'pumpkin_seeds',
    kelp_plant: 'kelp', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries',
    twisting_vines_plant: 'twisting_vines', weeping_vines_plant: 'weeping_vines',
    powder_snow: 'powder_snow_bucket', tall_seagrass: 'seagrass',
    moving_piston: 'piston',
  })[id] || id
}

export async function buildMaterialIcon(id, assets) {
  const pot = id === 'decorated_pot' && (await assets.getJSON('items/decorated_pot.json'))?.model?.type === 'minecraft:special'
  if (!pot && id !== 'end_portal' && id !== 'end_gateway') return buildGuiItem({ id: 'minecraft:' + id }, assets)
  // Portals need their shader; a decorated pot also needs its four rendered sides.
  const name = 'minecraft:' + id, baked = await new BlockModelResolver(assets).resolve(name, {})
  const object = await Renderer.buildBlockPreview({
    palette: [{ name, properties: {}, baked }], blocks: new Map([[0, 0]]),
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, width: 1, height: 1, depth: 1 },
    ...(pot ? { pots: [{ x: 0, y: 0, z: 0, facing: 'north', sherds: {} }] } : {}),
  }, assets)
  object.rotation.set(Math.PI / 6, Math.PI * (pot ? .25 : 1.25), 0)
  object.scale.setScalar(.625)
  return object
}

// One lazy WebGL context, cached PNGs and a serial queue for the visible rows.
// Independent asset snapshots keep pack changes and texture disposal away from
// the main scene, including while an older thumbnail is still loading.
export class MaterialIcons {
  constructor(list, source) {
    this.list = list
    this.source = source
    this.cache = new Map()
    this.queue = []
    this.visible = new WeakSet()
    this.queued = new Set()
    this.generation = 0
    this.observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) { this.visible.delete(target); continue }
        this.visible.add(target)
        if (this.queued.has(target)) continue
        this.queued.add(target); this.queue.push(target)
      }
      this.drain()
    }, { root: list, rootMargin: '80px 0px' })
    this.reset()
  }

  reset() {
    this.generation++
    this.cache.clear()
    this.assets = new AssetProvider()
    this.assets.baseUrl = this.source.baseUrl
    this.assets.packs = [...this.source.packs]
    this.observe()
  }

  observe() {
    this.observer.disconnect()
    this.queue = []; this.queued.clear(); this.visible = new WeakSet()
    for (const slot of this.list.querySelectorAll('.material-icon')) {
      const id = materialIconId(slot.dataset.material)
      const image = slot.querySelector('img')
      image.hidden = true; image.removeAttribute('src')
      slot.classList.remove('loaded')
      if (this.cache.has(id)) this.paint(slot, this.cache.get(id))
      else this.observer.observe(slot)
    }
  }

  paint(slot, url) {
    if (!slot.isConnected) return
    const image = slot.querySelector('img')
    if (url) { image.src = url; image.hidden = false; slot.classList.add('loaded') }
    this.observer.unobserve(slot)
  }

  async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const slot = this.queue.shift()
        this.queued.delete(slot)
        if (!slot.isConnected || !this.visible.has(slot)) continue
        const id = materialIconId(slot.dataset.material), generation = this.generation
        let url = this.cache.get(id)
        if (!this.cache.has(id)) {
          try { url = await this.render(id, this.assets) } catch { url = null }
          if (generation !== this.generation) continue
          this.cache.set(id, url)
          if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value)
        }
        this.paint(slot, url)
        // Let input, scrolling and list replacement run between GPU jobs.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } finally { this.running = false }
  }

  initRenderer() {
    if (this.renderer) return
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false })
    this.renderer.setSize(64, 64, false)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.scene = new THREE.Scene()
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2.5)
    sun.position.set(-3, 5, 4); this.scene.add(sun)
    this.camera = new THREE.OrthographicCamera(-.55, .55, .55, -.55, .01, 100)
  }

  async render(id, assets) {
    if (!/^[a-z0-9_]+$/.test(id)) return null
    let object
    try {
      object = await buildMaterialIcon(id, assets)
      if (!object) return null
      const bounds = new THREE.Box3().setFromObject(object)
      if (bounds.isEmpty()) return null
      this.initRenderer()
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
      const radius = Math.max(1, size.x, size.y) * .55
      Object.assign(this.camera, { left: -radius, right: radius, top: radius, bottom: -radius })
      this.camera.position.set(center.x, center.y, bounds.max.z + 10)
      this.camera.lookAt(center); this.camera.updateProjectionMatrix()
      this.scene.add(object)
      this.renderer.render(this.scene, this.camera)
      return this.renderer.domElement.toDataURL('image/png')
    } finally {
      object?.removeFromParent()
      object?.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
      this.renderer?.renderLists.dispose()
      // Only this icon provider owns these textures; never dispose scene textures.
      for (const pending of assets.textureCache.values()) (await pending)?.dispose()
      assets.textureCache.clear(); assets.animatedTextures.clear()
    }
  }
}
