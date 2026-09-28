// 资源提供者：负责提供方块状态 JSON、模型 JSON 和贴图。
// 默认资源来自 public/assets/minecraft/（由 scripts/fetch-assets.mjs 下载的官方资源）。
// 加载资源包（.zip，通过 JSZip）后，资源包中的同名资源会覆盖默认资源（复刻 Minecraft 的覆盖规则）。

import * as THREE from 'three'

export class AssetProvider {
  constructor() {
    this.packs = [] // 有序数组 [{name, zip}]，index 0 优先级最高
    // 用相对路径：无论通过 dev 服务器还是直接双击 index.html 打开都能正确解析
    this.baseUrl = 'assets/minecraft/'
    this.textureCache = new Map() // 纹理 key -> Promise<THREE.Texture|null>
    this.jsonCache = new Map() // 路径 -> Promise<object|null>
  }

  // 多个资源包叠加：越靠前（index 越小）优先级越高，未命中再回落默认资源
  addPack(zip, name) {
    const i = this.packs.findIndex((p) => p.name === name)
    if (i >= 0) this.packs[i] = { name, zip }
    else this.packs.push({ name, zip })
    this.textureCache.clear()
    this.jsonCache.clear()
  }

  removePack(name) {
    this.packs = this.packs.filter((p) => p.name !== name)
    this.textureCache.clear()
    this.jsonCache.clear()
  }

  // delta = -1 上移（提高优先级），+1 下移
  movePack(name, delta) {
    const i = this.packs.findIndex((p) => p.name === name)
    if (i < 0) return
    const j = i + delta
    if (j < 0 || j >= this.packs.length) return
    const [p] = this.packs.splice(i, 1)
    this.packs.splice(j, 0, p)
    this.textureCache.clear()
    this.jsonCache.clear()
  }

  clearPacks() {
    this.packs = []
    this.textureCache.clear()
    this.jsonCache.clear()
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
          return JSON.parse(await entry.async('string'))
        } catch {
          /* 忽略损坏条目，继续下一个资源包 */
        }
      }
    }
    const resp = await fetch(this.baseUrl + path)
    if (!resp.ok) return null
    return resp.json()
  }

  // 加载贴图。texKey 形如 "block/stone"（已归一化，不含 minecraft: 前缀和 textures/ 前缀）。
  getTexture(texKey) {
    if (this.textureCache.has(texKey)) return this.textureCache.get(texKey)
    const p = this._getTexture(texKey)
    this.textureCache.set(texKey, p)
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
      const resp = await fetch(this.baseUrl + rel)
      if (!resp.ok) return null
      blob = await resp.blob()
    }
    return textureFromBlob(blob)
  }
}

function textureFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let source = img
      // 动画贴图是「宽×宽 N 帧」的竖向长条（如 16×512、32×1024）；裁取第一帧，避免整条被压到面上。
      // 但 64×128 这类「高比宽」的单张生物贴图（女巫/炽足兽）不能被误裁：帧数极多时宽高比才大，
      // 这里用 >=4 区分（原版动画至少 8 帧，如 16×512 比值 32）。
      if (img.height > img.width && img.height % img.width === 0 && img.height / img.width >= 4) {
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
