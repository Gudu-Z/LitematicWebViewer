// 方块状态 -> 几何解析。
// 通过 blockstates JSON 找到模型（含变体旋转），合并父模板后，
// 用 modelBaker 把模型 elements 烘焙成一组 quad（支持非完整方块的真实形状）。

import { bakeModel } from './modelBaker.js'

export class BlockModelResolver {
  constructor(assets) {
    this.assets = assets
    this.faceCache = new Map() // 方块状态 key -> Promise<{quads, fullCube}|null>
  }

  clear() {
    this.faceCache.clear()
  }

  // name 形如 "minecraft:oak_log"，properties 形如 {axis:"y"}
  // 返回 { quads, fullCube } 或 null
  resolve(name, properties) {
    const shortName = (name || '').replace(/^minecraft:/, '')
    const props = properties || {}
    const keys = Object.keys(props).sort()
    const key = shortName + (keys.length ? '[' + keys.map((k) => k + '=' + props[k]).join(',') + ']' : '')
    if (this.faceCache.has(key)) return this.faceCache.get(key)
    const p = this._resolve(shortName, props)
    this.faceCache.set(key, p)
    return p
  }

  async _resolve(shortName, properties) {
    const bs = await this.assets.getJSON('blockstates/' + shortName + '.json')
    if (!bs) return null

    if (bs.multipart) {
      // 栅栏/墙等：合并所有匹配部分的几何
      const quads = []
      for (const part of bs.multipart) {
        if (!matchWhen(part.when, properties)) continue
        const info = variantInfo(part.apply)
        if (!info || !info.model) continue
        const model = await this.loadModel(info.model)
        if (!model) continue
        quads.push(...bakeModel(model, { x: info.x, y: info.y }).quads)
      }
      if (!quads.length) return null
      return { quads, fullCube: false }
    }

    const picked = pickModel(bs, properties)
    if (!picked) return null
    const model = await this.loadModel(picked.model)
    if (!model) return null
    return bakeModel(model, { x: picked.x, y: picked.y })
  }

  async loadModel(modelPath) {
    const p = (modelPath || '').replace(/^minecraft:/, '')
    return this._loadModelRec(p, new Set(), 0)
  }

  async _loadModelRec(path, seen, depth) {
    if (depth > 8 || !path || seen.has(path)) return null
    seen.add(path)
    const json = await this.assets.getJSON('models/' + path + '.json')
    if (!json) return null
    if (json.parent) {
      const parent = await this._loadModelRec(json.parent.replace(/^minecraft:/, ''), seen, depth + 1)
      if (parent) {
        return {
          ...json,
          textures: { ...(parent.textures || {}), ...(json.textures || {}) },
          elements: json.elements || parent.elements,
          parent: parent.parent,
        }
      }
    }
    return json
  }
}

function pickModel(blockstates, properties) {
  const props = properties || {}
  if (blockstates.variants) {
    const variants = blockstates.variants
    const keys = Object.keys(variants)
    // 逐个 key 匹配：只比较 blockstate 定义里出现的属性（如楼梯的 waterlogged 会被忽略），
    // 且属性顺序无关（有些包用 facing=enabled 这种非字典序键，如漏斗）。
    for (const k of keys) {
      if (!k) continue
      let allMatch = true
      for (const part of k.split(',')) {
        const eq = part.indexOf('=')
        if (eq <= 0) continue
        if (String(props[part.slice(0, eq)]) !== part.slice(eq + 1)) {
          allMatch = false
          break
        }
      }
      if (allMatch) return variantInfo(variants[k])
    }
    if (variants['']) return variantInfo(variants[''])
    const firstKey = keys[0]
    if (firstKey !== undefined) return variantInfo(variants[firstKey])
  }
  return null
}

function variantInfo(entry) {
  if (!entry) return null
  if (Array.isArray(entry)) entry = entry[0]
  if (typeof entry === 'string') return { model: entry, x: 0, y: 0 }
  if (!entry.model) return null
  return { model: entry.model, x: entry.x || 0, y: entry.y || 0 }
}

function matchWhen(when, props) {
  if (!when) return true
  for (const k of Object.keys(when)) {
    const v = when[k]
    if (k === 'OR') {
      // {OR: [条件1, 条件2]}：任一条件满足即匹配
      if (!Array.isArray(v) || !v.some((cond) => matchWhen(cond, props))) return false
      continue
    }
    if (v === undefined) continue
    const actual = props[k]
    if (Array.isArray(v)) {
      if (!v.some((x) => String(x) === String(actual))) return false
    } else if (typeof v === 'string') {
      // 属性值支持 "a|b" 表示 a 或 b（如红石粉的 side|up）
      if (v.includes('|')) {
        if (!v.split('|').some((x) => String(actual) === x)) return false
      } else if (String(actual) !== v) {
        return false
      }
    } else if (typeof v === 'object' && v !== null) {
      // 其他对象形式：逐字段检查
      if (!matchWhen(v, props)) return false
    }
  }
  return true
}
