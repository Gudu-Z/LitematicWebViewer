// 方块状态 -> 几何解析。
// 通过 blockstates JSON 找到模型（含变体旋转），合并父模板后，
// 用 modelBaker 把模型 elements 烘焙成一组 quad（支持非完整方块的真实形状）。

import { bakeModel } from './modelBaker.js'

// ===== 无常规 JSON 模型的方块（靠方块实体渲染器或流体系统绘制）=====
// 这些方块的模型是空的，这里按原版渲染器手工构造几何与 UV。
// UV 一律用「贴图像素坐标」，配合 bakeModel 的 texSize 参数归一化到 [0,1]。

// 构造一个面：uv 为贴图像素 [u0,v0,u1,v1]
const face = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#all' })

// 箱子：复刻原版 ChestRenderer —— 底座 + 箱盖 + 锁扣。
// 原版箱子贴图布局（已按实际贴图逐面核实）：顶面在第二列(x=u+dz+dx)、底面在第一列(x=u+dz)，
// 与直觉相反。texBox 用这个修正后的 auto-UV 生成 6 面（像素坐标，配 texSize=64）。
function texBox(from, to, texU, texV) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  return {
    from,
    to,
    faces: {
      up: face(texU + dz + dx, texV, texU + dz + 2 * dx, texV + dz),
      down: face(texU + dz, texV, texU + dz + dx, texV + dz),
      east: face(texU, texV + dz, texU + dz, texV + dz + dy),
      south: face(texU + dz, texV + dz, texU + dz + dx, texV + dz + dy),
      west: face(texU + dz + dx, texV + dz, texU + dz + dx + dz, texV + dz + dy),
      north: face(texU + dz + dx + dz, texV + dz, texU + dz + dx + dz + dx, texV + dz + dy),
    },
  }
}

// type: single/left/right。大箱子左右两半各延伸 1px 到中间消除接缝；
// 锁扣在 +z（南）面：单人箱居中，大箱子左右两半的锁扣都贴向中间（左箱在右缘、右箱在左缘），
// 两半拼起来后锁扣恰好落在整只大箱子的正中间。朝向由 facing 属性旋转。
function chestModel(texKey, type) {
  const x0 = type === 'right' ? 0 : 1
  const x1 = type === 'left' ? 16 : 15
  const lockX = type === 'left' ? 15 : type === 'right' ? -1 : 7
  return {
    textures: { all: texKey },
    elements: [
      texBox([x0, 0, 1], [x1, 10, 15], 0, 19), // 底座
      texBox([x0, 9, 1], [x1, 14, 15], 0, 0), // 箱盖
      texBox([lockX, 8, 15], [lockX + 2, 12, 16], 0, 0), // 锁扣
    ],
  }
}

// 箱子贴图名：normal/trapped/ender/copper[+氧化]，左右型加 _left/_right
const CHEST_BASES = { chest: 'normal', trapped_chest: 'trapped', ender_chest: 'ender', copper_chest: 'copper' }

function chestTex(blockName, type, p) {
  let t = CHEST_BASES[blockName]
  if (blockName === 'copper_chest') {
    const s = String(p.oxidized || p.tier || p.oxidation || '')
    if (s.includes('exposed')) t = 'copper_exposed'
    else if (s.includes('weathered')) t = 'copper_weathered'
    else if (s.includes('oxidized')) t = 'copper_oxidized'
  }
  const suffix = type === 'left' ? '_left' : type === 'right' ? '_right' : ''
  return 'entity/chest/' + t + suffix
}

// 潜影盒：箱盖(顶部 12px) + 底座(底部 4px) 两段式，贴图 entity/shulker/*（64×64）。
// 顶部=浅紫盖顶、四周=中紫盖侧、底部=深紫底座。朝向由 facing 属性旋转。
function shulkerModel(texKey) {
  return {
    textures: { all: texKey },
    elements: [
      { // 箱盖 16×12×16（顶部 12px）
        from: [0, 4, 0], to: [16, 16, 16],
        faces: {
          up: face(16, 0, 32, 16),
          down: face(32, 0, 48, 16),
          east: face(0, 16, 16, 28),
          south: face(16, 16, 32, 28),
          west: face(32, 16, 48, 28),
          north: face(48, 16, 64, 28),
        },
      },
      { // 底座 16×4×16（底部 4px，侧面取底座侧条底部）
        from: [0, 0, 0], to: [16, 4, 16],
        faces: {
          up: face(16, 28, 32, 44),
          down: face(32, 28, 48, 44),
          east: face(0, 44, 16, 60),
          south: face(16, 44, 32, 60),
          west: face(32, 44, 48, 60),
          north: face(48, 44, 64, 60),
        },
      },
    ],
  }
}

// 头颅：8×8×8 立方（居中），贴图是生物皮肤，头部区域在皮肤纹理顶部（标准 64×64 布局）。
// scale 用于 256×256 的龙首（皮肤整体放大 4 倍）。
function headModel(texKey, scale) {
  const s = scale || 1
  return {
    textures: { all: texKey },
    elements: [{
      from: [4, 4, 4], to: [12, 12, 12],
      faces: {
        up: face(8 * s, 0, 16 * s, 8 * s),
        down: face(16 * s, 0, 24 * s, 8 * s),
        east: face(0, 8 * s, 8 * s, 16 * s),
        south: face(8 * s, 8 * s, 16 * s, 16 * s),
        west: face(16 * s, 8 * s, 24 * s, 16 * s),
        north: face(24 * s, 8 * s, 32 * s, 16 * s),
      },
    }],
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

// 箱子/头颅等「正面朝 +z」的朝向 -> variant y 旋转
const FACING_Y = { north: 180, south: 0, east: -90, west: 90 }

function chestVariant(p) {
  return { y: FACING_Y[String(p.facing || 'north')] || 0 }
}

// 潜影盒朝向（箱盖默认在 +y 顶面）
const SHULKER_FACING = {
  up: {},
  down: { x: 180 },
  north: { x: 90 },
  south: { x: -90 },
  east: { x: -90, y: -90 },
  west: { x: -90, y: 90 },
}

function shulkerVariant(p) {
  return SHULKER_FACING[String(p.facing || 'up')] || {}
}

// 站立头颅用 rotation(0-15) 旋转，墙上头颅用 facing 旋转
function headVariant(p, isWall) {
  if (isWall) return { y: FACING_Y[String(p.facing || 'north')] || 0 }
  return { y: (Number(p.rotation) || 0) * 22.5 }
}

// 潜影盒颜色 -> 贴图名
const SHULKER_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// 头颅类型 -> {贴图, texSize, scale, wall 方块名}。骷髅用 _skull 命名，其余用 _head。
const HEAD_TYPES = {
  player_head: { tex: 'entity/player/wide/steve', texSize: [64, 64], scale: 1, wall: 'player_wall_head' },
  zombie_head: { tex: 'entity/zombie/zombie', texSize: [64, 64], scale: 1, wall: 'zombie_wall_head' },
  creeper_head: { tex: 'entity/creeper/creeper', texSize: [64, 32], scale: 1, wall: 'creeper_wall_head' },
  skeleton_skull: { tex: 'entity/skeleton/skeleton', texSize: [64, 32], scale: 1, wall: 'skeleton_wall_skull' },
  wither_skeleton_skull: { tex: 'entity/skeleton/wither_skeleton', texSize: [64, 32], scale: 1, wall: 'wither_skeleton_wall_skull' },
  piglin_head: { tex: 'entity/piglin/piglin', texSize: [64, 64], scale: 1, wall: 'piglin_wall_head' },
  dragon_head: { tex: 'entity/enderdragon/dragon', texSize: [256, 256], scale: 4, wall: 'dragon_wall_head' },
}

const SPECIAL_MODELS = {
  // 箱子
  chest: (p) => ({ model: chestModel(chestTex('chest', p.type, p), p.type), variant: chestVariant(p), texSize: 64 }),
  trapped_chest: (p) => ({ model: chestModel(chestTex('trapped_chest', p.type, p), p.type), variant: chestVariant(p), texSize: 64 }),
  ender_chest: (p) => ({ model: chestModel('entity/chest/ender', 'single'), variant: chestVariant(p), texSize: 64 }),
  copper_chest: (p) => ({ model: chestModel(chestTex('copper_chest', p.type, p), p.type), variant: chestVariant(p), texSize: 64 }),
  // 流体
  water: (p) => ({ model: fluidModel('block/water_still', p.level), variant: {} }),
  lava: (p) => ({ model: fluidModel('block/lava_still', p.level), variant: {} }),
  bubble_column: () => ({ model: fluidModel('block/water_still', 0), variant: {} }),
}

// 潜影盒（16 种颜色 + 默认）
SPECIAL_MODELS.shulker_box = (p) => ({ model: shulkerModel('entity/shulker/shulker'), variant: shulkerVariant(p), texSize: 64 })
for (const c of SHULKER_COLORS) {
  SPECIAL_MODELS[c + '_shulker_box'] = (p) => ({ model: shulkerModel('entity/shulker/shulker_' + c), variant: shulkerVariant(p), texSize: 64 })
}

// 头颅（站立 + 墙上两种）
for (const [name, info] of Object.entries(HEAD_TYPES)) {
  SPECIAL_MODELS[name] = (p) => ({ model: headModel(info.tex, info.scale), variant: headVariant(p, false), texSize: info.texSize })
  SPECIAL_MODELS[info.wall] = (p) => ({ model: headModel(info.tex, info.scale), variant: headVariant(p, true), texSize: info.texSize })
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
    // 特殊方块：箱子/潜影盒/头颅/水/岩浆等没有常规块模型
    const special = SPECIAL_MODELS[shortName]
    if (special) {
      const { model, variant, texSize } = special(properties || {})
      return bakeModel(model, variant, texSize)
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
