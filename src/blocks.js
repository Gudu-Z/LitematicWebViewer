// 方块状态 -> 几何解析。
// 通过 blockstates JSON 找到模型（含变体旋转），合并父模板后，
// 用 modelBaker 把模型 elements 烘焙成一组 quad（支持非完整方块的真实形状）。

import { bakeModel } from './modelBaker.js'

// ===== 无常规 JSON 模型的方块 =====
// 箱子靠方块实体渲染器绘制、水/岩浆是流体，这里手工构造模型。

// 按 Minecraft 的 ModelPart.addBox 自动 UV 算法生成一个盒体的 6 面，
// 用于 64×64 贴图的方块实体（箱子等）：texU/texV 为纹理偏移（像素），
// from/to 为盒体局部坐标（像素）。UV 换算成 modelBaker 的 16 制（像素/4），
// 这样 bakeModel 里 /16 后正好得到「像素/64」。
function texBox(from, to, texU, texV) {
  const [fx, fy, fz] = from
  const [tx, ty, tz] = to
  const dx = tx - fx
  const dy = ty - fy
  const dz = tz - fz
  const uv = (u0, v0, u1, v1) => [u0 / 4, v0 / 4, u1 / 4, v1 / 4]
  return {
    from,
    to,
    faces: {
      up: { uv: uv(texU + dz, texV, texU + dz + dx, texV + dz), texture: '#all' }, // 顶 +y
      down: { uv: uv(texU + dz + dx, texV, texU + dz + 2 * dx, texV + dz), texture: '#all' }, // 底 -y
      east: { uv: uv(texU, texV + dz, texU + dz, texV + dz + dy), texture: '#all' }, // 东 +x
      south: { uv: uv(texU + dz, texV + dz, texU + dz + dx, texV + dz + dy), texture: '#all' }, // 南 +z（正面）
      west: { uv: uv(texU + dz + dx, texV + dz, texU + dz + dx + dz, texV + dz + dy), texture: '#all' }, // 西 -x
      north: { uv: uv(texU + dz + dx + dz, texV + dz, texU + dz + dx + dz + dx, texV + dz + dy), texture: '#all' }, // 北 -z（背面）
    },
  }
}

// 复刻原版 ChestRenderer 的箱子：底座 14×10×14 + 箱盖 14×5×14 + 锁扣 2×4×1。
// 锁扣在 +z（南）面，朝向由 facing 属性在 _resolve 里旋转。
function chestModel(texKey) {
  return {
    textures: { all: texKey },
    elements: [
      texBox([1, 0, 1], [15, 10, 15], 0, 19), // 底座，纹理偏移 (0,19)
      texBox([1, 9, 1], [15, 14, 15], 0, 0), // 箱盖，纹理偏移 (0,0)
      texBox([7, 8, 15], [9, 12, 16], 0, 0), // 锁扣，纹理偏移 (0,0)
    ],
  }
}

// 流体（水/岩浆）：level 决定水面高度。0=满格；1-7 每级下降 2px；8+（下落）近似薄层。
function fluidModel(texKey, level) {
  const lvl = Number(level) || 0
  const h = lvl <= 0 ? 16 : lvl < 8 ? 16 - 2 * lvl : 2
  const flow = texKey.replace('_still', '_flow')
  return {
    textures: { still: texKey, flow },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, h, 16],
        faces: {
          up: { uv: [0, 0, 16, 16], texture: '#still', cullface: 'up' },
          down: { uv: [0, 0, 16, 16], texture: '#still', cullface: 'down' },
          north: { uv: [0, 0, 16, h], texture: '#flow', cullface: 'north' },
          south: { uv: [0, 0, 16, h], texture: '#flow', cullface: 'south' },
          east: { uv: [0, 0, 16, h], texture: '#flow', cullface: 'east' },
          west: { uv: [0, 0, 16, h], texture: '#flow', cullface: 'west' },
        },
      },
    ],
  }
}

// 箱子朝向 -> variant y 旋转（锁扣默认在 +z/南面）
const CHEST_FACING_Y = { north: 180, south: 0, east: -90, west: 90 }

function chestVariant(p) {
  const facing = String(p.facing || 'north')
  return { y: CHEST_FACING_Y[facing] || 0 }
}

// 铜箱子的氧化程度（属性名不确定时回退默认铜色）
function copperChestTex(p) {
  const s = String(p.oxidized || p.tier || p.oxidation || '')
  if (s.includes('exposed')) return 'entity/chest/copper_exposed'
  if (s.includes('weathered')) return 'entity/chest/copper_weathered'
  if (s.includes('oxidized')) return 'entity/chest/copper_oxidized'
  return 'entity/chest/copper'
}

const SPECIAL_MODELS = {
  chest: (p) => ({ model: chestModel('entity/chest/normal'), variant: chestVariant(p) }),
  trapped_chest: (p) => ({ model: chestModel('entity/chest/trapped'), variant: chestVariant(p) }),
  ender_chest: (p) => ({ model: chestModel('entity/chest/ender'), variant: chestVariant(p) }),
  copper_chest: (p) => ({ model: chestModel(copperChestTex(p)), variant: chestVariant(p) }),
  water: (p) => ({ model: fluidModel('block/water_still', p.level), variant: {} }),
  lava: (p) => ({ model: fluidModel('block/lava_still', p.level), variant: {} }),
}

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
    // 特殊方块：箱子/水/岩浆等没有常规块模型
    const special = SPECIAL_MODELS[shortName]
    if (special) {
      const { model, variant } = special(properties || {})
      return bakeModel(model, variant)
    }

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
