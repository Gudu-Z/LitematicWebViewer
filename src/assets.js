// 资源提供者：负责提供方块状态 JSON、模型 JSON 和贴图。
// 默认资源来自 public/assets/minecraft/（由 scripts/fetch-assets.mjs 下载的官方资源）。
// 加载资源包（.zip，通过 JSZip）后，资源包中的同名资源会覆盖默认资源（复刻 Minecraft 的覆盖规则）。

import * as THREE from 'three'
import { animateTexture } from './textureAnimation.js'

// 贴图由资源提供者统一释放；模型只借用，清理某个场景不能使其他模型的贴图失效。
// WeakSet 不会被 Texture.clone() 复制，也不阻止已释放贴图被垃圾回收。
const assetTextures = new WeakSet()
export const isAssetTexture = texture => !!texture && assetTextures.has(texture)
const textureBytes = new WeakMap()
const estimateTextureBytes = texture => textureBytes.get(texture) ||
  (texture.image?.width || 0) * (texture.image?.height || 0) * 8 // decoded RGBA + GPU image

// 默认资源可能因网络抖动或服务器暂时不可用而加载失败。只补试一次，
// 并将最终失败交给调用方清理缓存；404/SPA 回退仍视为真正缺失，不补试。
async function fetchAsset(url, read) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url)
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`资源请求失败：HTTP ${response.status}`)
      }
      if (!response.ok || (response.headers.get('content-type') || '').includes('text/html')) return null
      return await read(response)
    } catch (error) {
      if (attempt) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

// JsonUnbakedModel -> JsonHelper.deserialize 使用 Gson adapter 读取一个对象，
// 不要求对象后立即 EOF。XK 的四个 waxed_*cut_copper 模型尾部多一个 }，
// 原版仍能读取。仅为模型文件保留这一行为，正文错误仍由 JSON.parse 拒绝。
function parseResourceJSON(text, path) {
  const source = text.trimStart() // JSON Reader 同样接受 UTF-8 BOM。
  try {
    return JSON.parse(source)
  } catch (error) {
    if (!path.startsWith('models/') || source[0] !== '{') throw error
    let depth = 0, quoted = false, escaped = false
    for (let i = 0; i < source.length; i++) {
      const char = source[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) return JSON.parse(source.slice(0, i + 1))
    }
    throw error
  }
}

export class AssetProvider {
  constructor() {
    this.packs = [] // 有序数组 [{name, zip}]，index 0 优先级最高
    // 用相对路径：无论通过 dev 服务器还是直接双击 index.html 打开都能正确解析
    this.baseUrl = 'assets/minecraft/'
    this.textureCache = new Map() // 纹理 key -> Promise<THREE.Texture|null>
    this.jsonCache = new Map() // 路径 -> Promise<object|null>
    this.animatedTextures = new Set()
    this._animationTick = null
    this.cacheRevision = 0
    this._ownedTextures = new Set()
    this._cacheClearListeners = new Set()
    this._textureEvictListeners = new Set()
    this._textureRecords = new Map()
    this._cachedTextureRecords = new Map()
    this._sourceTextures = new WeakMap()
    this._textureOwners = new Map()
    this._textureReferences = new Map()
    this._textureUseClock = 0
    this._textureLoadDepth = 0
    this._pendingTextures = 0
    this._animationTicks = new WeakMap()
    this._animatedCloneVersions = new WeakMap()
  }

  // 派生模型缓存也需及时解除对旧资源包图片的引用，不等待下次模型构建。
  onCacheClear(listener) {
    this._cacheClearListeners.add(listener)
    return () => this._cacheClearListeners.delete(listener)
  }

  onTextureEvict(listener) {
    this._textureEvictListeners.add(listener)
    return () => this._textureEvictListeners.delete(listener)
  }

  // Loading a model may yield between textures. Its resources become trimmable
  // only after the caller registers the completed scene and ends the transaction.
  beginTextureLoad() {
    this._textureLoadDepth++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this._textureLoadDepth--
    }
  }

  // Hidden layers still retain their textures; only visible textures animate.
  // Texture.clone shares Source, so a clone also retains its provider-owned source.
  setTextureUsage(owner, retained, active = retained) {
    const previous = this._textureOwners.get(owner)
    const usage = { retained: new Set(), animated: new Map() }
    const collect = (textures, visible) => {
      for (const texture of textures || []) {
        const sources = this._ownedTextures.has(texture) ? [texture] : this._sourceTextures.get(texture?.source)
        if (!sources) continue
        for (const source of sources) {
          usage.retained.add(source)
          if (visible && source.userData.updateAnimation) {
            if (!usage.animated.has(source)) usage.animated.set(source, new Set())
            usage.animated.get(source).add(texture)
          }
        }
      }
    }
    collect(retained, false)
    collect(active, true)
    this._textureOwners.set(owner, usage)
    for (const texture of usage.retained) {
      if (!previous?.retained.has(texture)) this._textureReferences.set(texture, (this._textureReferences.get(texture) || 0) + 1)
      const record = this._textureRecords.get(texture)
      if (record) record.used = ++this._textureUseClock
    }
    for (const texture of previous?.retained || []) {
      if (!usage.retained.has(texture)) this._releaseTextureReference(texture)
    }
  }

  releaseTextureUsage(owner) {
    const usage = this._textureOwners.get(owner)
    if (!usage) return
    this._textureOwners.delete(owner)
    for (const texture of usage.retained) this._releaseTextureReference(texture)
  }

  _releaseTextureReference(texture) {
    const count = (this._textureReferences.get(texture) || 0) - 1
    if (count > 0) this._textureReferences.set(texture, count)
    else {
      this._textureReferences.delete(texture)
      // Pack changes retire live textures without breaking a scene/export that
      // still borrows them. They can be disposed after the final owner releases.
      if (this._textureRecords.get(texture)?.keys.size === 0) texture.dispose()
    }
  }

  trimTextures({ maxIdleCount = 256, maxIdleBytes = 64 * 1024 * 1024 } = {}) {
    if (this._textureLoadDepth || this._pendingTextures) return { skipped: true, evicted: 0 }
    const idle = [...this._textureRecords].filter(([texture, record]) =>
      record.keys.size && !this._textureReferences.has(texture)).sort((a, b) => a[1].used - b[1].used)
    let count = idle.length, bytes = idle.reduce((sum, [, record]) => sum + record.bytes, 0)
    const evicted = new Set()
    for (const [texture, record] of idle) {
      if (count <= maxIdleCount && bytes <= maxIdleBytes) break
      evicted.add(texture)
      count--; bytes -= record.bytes
    }
    // CPU templates must stop referring to old textures before their GPU images
    // are released. Active scenes are excluded even if they exceed the budget.
    if (evicted.size) {
      for (const listener of this._textureEvictListeners) listener(evicted)
      for (const texture of evicted) {
        this._removeTextureKeys(texture)
        texture.dispose()
      }
    }
    return { skipped: false, evicted: evicted.size, idleCount: count, idleBytes: bytes }
  }

  _removeTextureKeys(texture) {
    const record = this._textureRecords.get(texture)
    for (const [key, request] of record?.keys || []) {
      if (this.textureCache.get(key) === request) {
        this.textureCache.delete(key)
        this._cachedTextureRecords.delete(key)
      }
    }
    record?.keys.clear()
  }

  // 清空两个缓存（资源包集合变化时，需丢弃旧的模型/贴图缓存以便重新解析）
  clearCaches() {
    this.cacheRevision++
    for (const listener of this._cacheClearListeners) listener()
    for (const texture of this._ownedTextures) {
      this._removeTextureKeys(texture)
      if (!this._textureReferences.has(texture)) texture.dispose()
    }
    this._animationTick = null
    this.textureCache.clear()
    this._cachedTextureRecords.clear()
    this.jsonCache.clear()
  }

  // 多个资源包叠加：越靠前（index 越小）优先级越高，未命中再回落默认资源
  addPack(zip, name) {
    const i = this.packs.findIndex((p) => p.name === name)
    if (i >= 0) this.packs[i] = { name, zip }
    else this.packs.push({ name, zip })
    this.clearCaches()
  }

  removePack(name) {
    this.packs = this.packs.filter((p) => p.name !== name)
    this.clearCaches()
  }

  // delta = -1 上移（提高优先级），+1 下移
  movePack(name, delta) {
    const i = this.packs.findIndex((p) => p.name === name)
    if (i < 0) return
    const j = i + delta
    if (j < 0 || j >= this.packs.length) return
    const [p] = this.packs.splice(i, 1)
    this.packs.splice(j, 0, p)
    this.clearCaches()
  }

  clearPacks() {
    this.packs = []
    this.clearCaches()
  }

  getPackNames() {
    return this.packs.map((p) => p.name)
  }

  // 加载 JSON 资源，path 形如 "blockstates/stone.json" 或 "models/block/stone.json"
  getJSON(path) {
    if (this.jsonCache.has(path)) return this.jsonCache.get(path)
    const p = this._getJSON(path).catch(() => {
      // 瞬时失败不能像 404 一样永久缓存，否则共享框体模板失败后，
      // 后续所有展示框（甚至重新打开投影）都会只显示物品。
      // 切换资源包时可能已经建立新请求，旧请求只能清理自己的缓存。
      if (this.jsonCache.get(path) === p) this.jsonCache.delete(path)
      return null
    })
    this.jsonCache.set(path, p)
    return p
  }

  async _getJSON(path) {
    for (const p of this.packs) {
      const entry = p.zip.file('assets/minecraft/' + path)
      if (entry) {
        try {
          return parseResourceJSON(await entry.async('string'), path)
        } catch {
          /* 忽略损坏条目，继续下一个资源包 */
        }
      }
    }
    return fetchAsset(this.baseUrl + path, async resp => parseResourceJSON(await resp.text(), path))
  }

  // 加载贴图。texKey 形如 "block/stone"（已归一化，不含 minecraft: 前缀和 textures/ 前缀）。
  getTexture(texKey) {
    return this._cachedTexture(texKey, () => this._getTexture(texKey))
  }

  _cachedTexture(key, load) {
    if (this.textureCache.has(key)) {
      // Resolved entries are indexed separately so trimming never needs to await
      // promises or race the caller that is constructing a model.
      const request = this.textureCache.get(key)
      const record = this._cachedTextureRecords.get(key)
      if (record) record.used = ++this._textureUseClock
      return request
    }
    const revision = this.cacheRevision
    this._pendingTextures++
    let request
    try { request = load() } catch (error) { request = Promise.reject(error) }
    // 加载失败（null，如并发导致的瞬时解码失败）不缓存，下次调用重试；
    // 成功则缓存。避免一次瞬时失败把该贴图永久判为缺失。
    const p = Promise.resolve(request).catch(() => null).then(texture => {
      if (revision !== this.cacheRevision || this.textureCache.get(key) !== p) {
        // 切换资源包后才解码完成的旧贴图不能进入新缓存或动画更新列表。
        if (texture) { assetTextures.add(texture); texture.dispose() }
        return null
      }
      if (!texture) {
        this.textureCache.delete(key)
        return null
      }
      assetTextures.add(texture)
      if (!this._ownedTextures.has(texture)) {
        this._ownedTextures.add(texture)
        this._textureRecords.set(texture, { keys: new Map(), bytes: estimateTextureBytes(texture), used: 0 })
        let sources = this._sourceTextures.get(texture.source)
        if (!sources) this._sourceTextures.set(texture.source, sources = new Set())
        sources.add(texture)
        // 缩略图资源会按预算提前淘汰；同步移除所有持有引用，避免清空时再次释放。
        const onDispose = () => {
          // IconAssets may evict its independent clone through its own budget.
          if (this._textureRecords.get(texture)?.keys.size) {
            for (const listener of this._textureEvictListeners) listener(new Set([texture]))
          }
          this._removeTextureKeys(texture)
          this._textureRecords.delete(texture)
          this._sourceTextures.get(texture.source)?.delete(texture)
          this._ownedTextures.delete(texture)
          this.animatedTextures.delete(texture)
          if (this._textureReferences.delete(texture)) {
            for (const usage of this._textureOwners.values()) {
              usage.retained.delete(texture)
              usage.animated.delete(texture)
            }
          }
          texture.removeEventListener('dispose', onDispose)
        }
        texture.addEventListener('dispose', onDispose)
      }
      const record = this._textureRecords.get(texture)
      record.keys.set(key, p)
      record.used = ++this._textureUseClock
      this._cachedTextureRecords.set(key, record)
      if (texture.userData.updateAnimation) {
        this.animatedTextures.add(texture)
        // A newly decoded animation still needs to catch up within the current tick.
        this._animationTick = null
      }
      return texture
    }).finally(() => { this._pendingTextures-- })
    this.textureCache.set(key, p)
    return p
  }

  // 从外部 URL 加载贴图（如玩家皮肤），并缓存。返回 THREE.Texture 或 null。
  async getExternalTexture(url) {
    if (!url) return null
    return this._cachedTexture(url, async () => {
      try {
        // 皮肤 URL 可能是 http://，但本站是 https，需统一成 https 避免混合内容被浏览器拦截
        const resp = await fetch(String(url).replace(/^http:/, 'https:'))
        if (!resp.ok) return null
        const blob = await resp.blob()
        return await textureFromBlob(blob, false)
      } catch {
        return null
      }
    })
  }

  async _getTexture(texKey) {
    const rel = 'textures/' + texKey + '.png'
    let blob = null
    for (const p of this.packs) {
      const entry = p.zip.file('assets/minecraft/' + rel)
      if (entry) {
        try {
          blob = await entry.async('blob')
          break
        } catch {
          /* 继续下一个资源包 */
        }
      }
    }
    if (!blob) {
      try {
        blob = await fetchAsset(this.baseUrl + rel, resp => resp.blob())
        if (!blob) return null
      } catch {
        return null
      }
    }
    const animated = await this._isAnimated(texKey)
    // 图片解码失败（如大量并发展示框同时加载贴图时浏览器的瞬时失败）不应让整个实体渲染抛错，
    // 返回 null 让该贴图缺失、其余照常渲染。
    try {
      return await textureFromBlob(blob, animated)
    } catch {
      return null
    }
  }

  // 检查贴图是否为动画（.mcmeta 里有 animation 字段）。找不到 .mcmeta 返回 null（交由启发式判断）。
  async _isAnimated(texKey) {
    const rel = 'textures/' + texKey + '.png.mcmeta'
    for (const p of this.packs) {
      const entry = p.zip.file('assets/minecraft/' + rel)
      if (entry) {
        try { return JSON.parse(await entry.async('string')).animation || false } catch { return false }
      }
    }
    try {
      return await fetchAsset(this.baseUrl + rel, async resp => (await resp.json()).animation || false)
    } catch {
      return null
    }
  }

  hasAnimatedTextures(owner) {
    return arguments.length ? !!this._textureOwners.get(owner)?.animated.size : !!this.animatedTextures.size
  }

  updateAnimations(age, owner) {
    const tick = Math.floor(age)
    const targeted = arguments.length > 1
    if (!targeted && tick === this._animationTick) return false
    this._animationTick = targeted ? null : tick
    const selected = targeted ? this._textureOwners.get(owner)?.animated : this.animatedTextures
    if (!selected) return false
    let changed = false
    for (const entry of selected) {
      const [texture, clones] = targeted ? entry : [entry, null]
      if (this._animationTicks.get(texture) !== tick) {
        this._animationTicks.set(texture, tick)
        const version = texture.version
        texture.userData.updateAnimation(age)
        changed ||= texture.version !== version
      }
      // Updating the common canvas changes Source, but THREE also requires each
      // independently uploaded clone's own texture version to change.
      for (const clone of clones || []) {
        if (clone === texture || this._animatedCloneVersions.get(clone) === texture.version) continue
        clone.needsUpdate = true
        this._animatedCloneVersions.set(clone, texture.version)
        changed = true
      }
    }
    return changed
  }
}

function textureFromBlob(blob, animated) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    const cleanup = () => {
      img.onload = img.onerror = null
      URL.revokeObjectURL(url)
    }
    img.onload = () => {
      let tex
      try {
        // 资源包可定义横向/竖向帧表、不同帧时长和颜色插值。
        const heuristic = img.height > img.width && img.height % img.width === 0 && img.height / img.width >= 4
        tex = new THREE.Texture(img)
        if (animated || (animated == null && heuristic)) animateTexture(tex, img, animated || {})
        const layout = tex.userData.animation, frameBytes = tex.image.width * tex.image.height * 4
        textureBytes.set(tex, img.width * img.height * 4 + frameBytes * (layout ? 2 : 1) +
          (layout && animated?.interpolate ? frameBytes * (new Set(layout.frames.map(frame => frame.index)).size + 1) : 0))
        tex.magFilter = THREE.NearestFilter
        tex.minFilter = THREE.NearestFilter
        tex.generateMipmaps = false
        tex.flipY = false // Minecraft 贴图坐标（v 向下）与模型 UV 约定一致
        tex.colorSpace = THREE.SRGBColorSpace
        tex.needsUpdate = true
        resolve(tex)
      } catch (error) {
        // Event-handler exceptions do not reject the enclosing Promise by themselves.
        // Release this failed attempt so all frames can retry the shared texture.
        tex?.dispose()
        reject(error)
      } finally { cleanup() }
    }
    img.onerror = () => {
      cleanup()
      reject(new Error('贴图加载失败'))
    }
    try { img.src = url } catch (error) { cleanup(); reject(error) }
  })
}
