// 资源提供者：负责提供方块状态 JSON、模型 JSON 和贴图。
// 默认资源来自 public/assets/minecraft/（由 scripts/fetch-assets.mjs 下载的官方资源）。
// 加载资源包（.zip，通过 JSZip）后，资源包中的同名资源会覆盖默认资源（复刻 Minecraft 的覆盖规则）。

import * as THREE from 'three'

export class AssetProvider {
  constructor() {
    this.pack = null // JSZip 实例
    // 用相对路径：无论通过 dev 服务器还是直接双击 index.html 打开都能正确解析
    this.baseUrl = 'assets/minecraft/'
    this.textureCache = new Map() // 纹理 key -> Promise<THREE.Texture|null>
    this.jsonCache = new Map() // 路径 -> Promise<object|null>
  }

  async setResourcePack(zip) {
    this.pack = zip
    this.textureCache.clear()
    this.jsonCache.clear()
  }

  // 加载 JSON 资源，path 形如 "blockstates/stone.json" 或 "models/block/stone.json"
  getJSON(path) {
    if (this.jsonCache.has(path)) return this.jsonCache.get(path)
    const p = this._getJSON(path)
    this.jsonCache.set(path, p)
    return p
  }

  async _getJSON(path) {
    if (this.pack) {
      const entry = this.pack.file('assets/minecraft/' + path)
      if (entry) {
        try {
          return JSON.parse(await entry.async('string'))
        } catch {
          /* 忽略损坏条目，回落到默认资源 */
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
    if (this.pack) {
      const entry = this.pack.file('assets/minecraft/' + rel)
      if (entry) {
        try {
          blob = await entry.async('blob')
        } catch {
          /* 回落默认 */
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
      const tex = new THREE.Texture(img)
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
