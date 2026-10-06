// 资源提供者：负责提供方块状态 JSON、模型 JSON 和贴图。
// 默认资源来自 public/assets/minecraft/（由 scripts/fetch-assets.mjs 下载的官方资源）。
// 加载资源包（.zip，通过 JSZip）后，资源包中的同名资源会覆盖默认资源（复刻 Minecraft 的覆盖规则）。

import * as THREE from 'three'

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
  }

  // 清空两个缓存（资源包集合变化时，需丢弃旧的模型/贴图缓存以便重新解析）
  clearCaches() {
    this.textureCache.clear()
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
    const p = this._getJSON(path)
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
    // fetch 可能因网络/并发等原因 reject；返回 null 让调用方优雅降级，而不是让整个实体渲染失败。
    try {
      const resp = await fetch(this.baseUrl + path)
      if (!resp.ok) return null
      // dev 服务器下，缺失文件可能返回 SPA 回退的 index.html（text/html）。
      if ((resp.headers.get('content-type') || '').includes('text/html')) return null
      return parseResourceJSON(await resp.text(), path)
    } catch {
      return null
    }
  }

  // 加载贴图。texKey 形如 "block/stone"（已归一化，不含 minecraft: 前缀和 textures/ 前缀）。
  getTexture(texKey) {
    if (this.textureCache.has(texKey)) return this.textureCache.get(texKey)
    // 加载失败（null，如并发导致的瞬时解码失败）不缓存，下次调用重试；
    // 成功则缓存。避免一次瞬时失败把该贴图永久判为缺失。
    const p = this._getTexture(texKey).then((tex) => {
      if (!tex) this.textureCache.delete(texKey)
      return tex
    })
    this.textureCache.set(texKey, p)
    return p
  }

  // 从外部 URL 加载贴图（如玩家皮肤），并缓存。返回 THREE.Texture 或 null。
  async getExternalTexture(url) {
    if (!url) return null
    if (this.textureCache.has(url)) return this.textureCache.get(url)
    const p = (async () => {
      try {
        // 皮肤 URL 可能是 http://，但本站是 https，需统一成 https 避免混合内容被浏览器拦截
        const resp = await fetch(String(url).replace(/^http:/, 'https:'))
        if (!resp.ok) return null
        const blob = await resp.blob()
        return await textureFromBlob(blob, false)
      } catch {
        return null
      }
    })()
    this.textureCache.set(url, p)
    return p
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
        const resp = await fetch(this.baseUrl + rel)
        if (!resp.ok) return null
        // dev 服务器下，缺失文件会返回 SPA 回退的 index.html（text/html），避免把它当图片加载
        if ((resp.headers.get('content-type') || '').includes('text/html')) return null
        blob = await resp.blob()
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
        try { return !!JSON.parse(await entry.async('string')).animation } catch { return false }
      }
    }
    try {
      const resp = await fetch(this.baseUrl + rel)
      if (!resp.ok) return null
      return !!JSON.parse(await resp.text()).animation
    } catch {
      return null
    }
  }
}

function textureFromBlob(blob, animated) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let source = img
      // 动画贴图是「宽×宽 N 帧」的竖向长条（如 16×48 灯笼、16×512 水）；裁取第一帧，
      // 避免整条被压到面上。优先按 .mcmeta 的 animation 字段判定；没有 .mcmeta 时用
      // 宽高比启发式（>=4 帧）兜底，但 64×128 单张生物贴图（女巫/炽足兽）不误裁。
      const heuristic = img.height > img.width && img.height % img.width === 0 && img.height / img.width >= 4
      if (img.height > img.width && (animated === true || (animated == null && heuristic))) {
        const w = img.width
        const c = document.createElement('canvas')
        c.width = w
        c.height = w
        c.getContext('2d').drawImage(img, 0, 0, w, w, 0, 0, w, w)
        source = c
      }
      const tex = new THREE.Texture(source)
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.generateMipmaps = false
      tex.flipY = false // Minecraft 贴图坐标（v 向下）与模型 UV 约定一致
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      URL.revokeObjectURL(url)
      resolve(tex)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('贴图加载失败'))
    }
    img.src = url
  })
}
