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

// Reuse decoded scene resources, but own the texture objects uploaded by the
// thumbnail renderer. Retired snapshots must never read a replacement pack.
class IconAssets extends AssetProvider {
  constructor(source) {
    super()
    this.source = source
    this.baseUrl = source.baseUrl
    this.packs = [...source.packs]
    this.textures = new Map()
  }

  matchesSource() {
    return this.baseUrl === this.source.baseUrl && this.packs.length === this.source.packs.length &&
      this.packs.every((pack, i) => pack.zip === this.source.packs[i].zip)
  }

  async _getJSON(path) {
    const shared = this.matchesSource() && this.source.jsonCache.get(path)
    if (shared) {
      const json = await shared
      // A failed request is removed from the source cache so it can be retried.
      if (json || this.source.jsonCache.get(path) === shared) return json
    }
    return super._getJSON(path)
  }

  async _getTexture(key) {
    const shared = this.matchesSource() && this.source.textureCache.get(key)
    const texture = (shared && (await shared)?.clone()) || await super._getTexture(key)
    if (texture) this.textures.set(key, texture)
    return texture
  }

  // Only trim between batches, when no model still references these textures.
  // Bound both the number and the size of retained high-resolution pack images.
  trim(maxCount = 96, maxPixels = 4 * 1024 * 1024) {
    const pixels = texture => (texture.image?.width || 0) * (texture.image?.height || 0)
    let size = [...this.textures.values()].reduce((sum, texture) => sum + pixels(texture), 0)
    for (const [key, texture] of this.textures) {
      if (this.textures.size <= maxCount && size <= maxPixels) break
      size -= pixels(texture)
      texture.dispose()
      this.textures.delete(key); this.textureCache.delete(key); this.animatedTextures.delete(texture)
    }
  }
}

// Load a few models concurrently; GPU rendering stays synchronous on one lazy
// context. Cache the PNGs, prioritize visible rows and prepare only the first page
// while idle instead of generating an entire large schematic's material list.
export class MaterialIcons {
  constructor(list, source) {
    this.list = list
    this.source = source
    this.cache = new Map()
    this.queue = []
    this.visible = new WeakSet()
    this.queued = new Set()
    this.observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) { this.visible.delete(target); continue }
        this.visible.add(target)
        this.enqueue(target)
      }
      this.drain()
    }, { root: list, rootMargin: '80px 0px' })
    this.reset()
  }

  reset() {
    if (this.state && !this.state.active) this.state.assets.trim(0, 0)
    this.state = { assets: new IconAssets(this.source), active: 0, pending: new Map() }
    this.cache.clear()
    this.observe()
  }

  observe() {
    if (globalThis.cancelIdleCallback) cancelIdleCallback(this.warmup)
    clearTimeout(this.warmupTimer)
    this.observer.disconnect()
    this.queue = []; this.queued.clear(); this.visible = new WeakSet()
    this.prefetch = new WeakSet()
    const slots = [...this.list.querySelectorAll('.material-icon')]
    for (const slot of slots) {
      const id = materialIconId(slot.dataset.material)
      const image = slot.querySelector('img')
      image.hidden = true; image.removeAttribute('src')
      slot.classList.remove('loaded')
      if (this.cache.has(id)) this.paint(slot, this.cache.get(id))
      else this.observer.observe(slot)
    }
    const prepare = () => {
      for (const slot of slots.slice(0, 12)) {
        if (this.cache.has(materialIconId(slot.dataset.material))) continue
        this.prefetch.add(slot); this.enqueue(slot)
      }
      this.drain()
    }
    if (slots.length) {
      if (globalThis.requestIdleCallback) this.warmup = requestIdleCallback(prepare, { timeout: 1000 })
      else this.warmupTimer = setTimeout(prepare, 100)
    }
  }

  enqueue(slot) {
    if (this.queued.has(slot)) return
    this.queued.add(slot); this.queue.push(slot)
  }

  paint(slot, url) {
    if (!slot.isConnected) return
    const image = slot.querySelector('img')
    if (url) { image.src = url; image.hidden = false; slot.classList.add('loaded') }
    this.observer.unobserve(slot)
  }

  drain() {
    const state = this.state
    while (state.active < 4 && this.queue.length) {
      const index = this.queue.findIndex(slot => this.visible.has(slot))
      const [slot] = this.queue.splice(Math.max(0, index), 1)
      this.queued.delete(slot)
      if (!slot.isConnected || (!this.visible.has(slot) && !this.prefetch.has(slot))) continue
      state.active++
      this.fill(slot, state)
    }
  }

  async fill(slot, state) {
    try {
      const id = materialIconId(slot.dataset.material)
      let url = this.cache.get(id)
      if (!this.cache.has(id)) {
        // Aliases and list replacements share a single in-flight thumbnail.
        let pending = state.pending.get(id)
        if (!pending) {
          pending = this.render(id, state.assets).catch(() => null).then(url => {
            if (state === this.state) {
              this.cache.set(id, url)
              if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value)
            }
            return url
          }).finally(() => state.pending.delete(id))
          state.pending.set(id, pending)
        }
        url = await pending
      }
      if (state === this.state) this.paint(slot, url)
      // Let input, scrolling and list replacement run between GPU jobs.
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      state.active--
      if (state === this.state) this.drain()
      if (!state.active) state.assets.trim(...(state === this.state ? [] : [0, 0]))
    }
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
    }
  }
}
