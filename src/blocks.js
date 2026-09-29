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
// 原版 ModelPart.Cuboid 的 auto-UV（已按原版 ModelPart.Quad 源码逐面核实）：
//   顶面 up 在第二列 (u=u+dz+dx)、底面 down 在第一列 (u=u+dz)；
//   侧面按 u 范围依次为 west(0)、north(1)、east(2)、south(3)。
//   注意：原版 Quad 会对侧面做 180° 旋转、顶面做 v 反转，下面 uv 的 u0/u1、v0/v1 顺序已照抄，
//   因此部分面的 u0>u1 或 v0>v1（bakeModel 直接按区间插值，能正确处理反向区间）。
function texBox(from, to, texU, texV) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  return {
    from,
    to,
    faces: {
      up: face(texU + dz + dx, texV + dz, texU + dz + 2 * dx, texV),
      down: face(texU + dz + dx, texV, texU + dz, texV + dz),
      west: face(texU + dz, texV + dz + dy, texU, texV + dz),
      north: face(texU + dz + dx, texV + dz + dy, texU + dz, texV + dz),
      east: face(texU + dz + dx + dz, texV + dz + dy, texU + dz + dx, texV + dz),
      south: face(texU + dz + dx + dz + dx, texV + dz + dy, texU + dz + dx + dz, texV + dz),
    },
  }
}

// type: single/left/right。几何与原版 ChestRenderer 的三种模型一致：
//   single 底座 x=1..15，锁扣 2px 居中；
//   left   底座 x=0..15（贴左缘），锁扣 1px 在最左；
//   right  底座 x=1..16（贴右缘），锁扣 1px 在最右。
// 拼成大箱子时两半在中间相接、锁扣恰好落在整只大箱子正中间。朝向由 facing 属性旋转。
function chestModel(texKey, type) {
  const x0 = type === 'right' ? 1 : type === 'left' ? 0 : 1
  const x1 = type === 'left' ? 15 : type === 'right' ? 16 : 15
  const lockX = type === 'left' ? 0 : type === 'right' ? 15 : 7
  const lockW = type === 'single' ? 2 : 1
  return {
    textures: { all: texKey },
    elements: [
      texBox([x0, 0, 1], [x1, 10, 15], 0, 19), // 底座
      texBox([x0, 9, 1], [x1, 14, 15], 0, 0), // 箱盖
      texBox([lockX, 8, 15], [lockX + lockW, 12, 16], 0, 0), // 锁扣
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

// 潜影盒：箱盖(顶部 12px) + 底座(底部 8px) 两段式，贴图 entity/shulker/*（64×64）。
// 几何与原版 ShulkerEntityModel 一致：base 16×8×16（y 0..8）、lid 16×12×16（y 4..16）。
//
// 潜影盒方块由 ShulkerBoxBlockEntityRenderer 用实体模型绘制，其 setTransforms 里
// scale(1,-1,-1) 等价于绕 X 轴旋转 180°，把实体模型翻到方块空间。因此与「直接按
// Cuboid auto-UV 读」相比，最终每个面都被整体旋转了 180°：
//   - 顶/底互换：顶面用原版 DOWN 列(u16-32)，底面用原版 UP 列(u32-48)；
//   - 北/南互换：北面(-z)用 col3(u48-64)，南面(+z)用 col1(u16-32)；
//   - 所有侧面的 u、v 同时翻转。
// 下面这些 face() 的值已按「原版 ShulkerEntityModel 顶点 × 上述变换」逐一核算，
// 使渲染结果与游戏内一致（侧面凸起的横肋落在箱盖与底座交界处）。
// 贴图内容（64×64）：u16-32 v0-16 紫色盖顶；u32-48 v0-16 深色内面；侧面 v16-28/44-52。
// 朝向由 facing 属性旋转。
function shulkerModel(texKey) {
  return {
    textures: { all: texKey },
    elements: [
      { // 底座 16×8×16
        from: [0, 0, 0], to: [16, 8, 16],
        faces: {
          up: face(16, 28, 32, 44), // u16-32, v28-44（深色箱内地板）
          down: face(48, 44, 32, 28), // u32-48, v28-44（紫色外底）
          west: face(0, 44, 16, 52),
          north: face(48, 44, 64, 52),
          east: face(32, 44, 48, 52),
          south: face(16, 44, 32, 52),
        },
      },
      { // 箱盖 16×12×16
        from: [0, 4, 0], to: [16, 16, 16],
        faces: {
          up: face(16, 0, 32, 16), // u16-32, v0-16（紫色盖顶）
          down: face(48, 16, 32, 0), // u32-48, v0-16（深色内面）
          west: face(0, 16, 16, 28),
          north: face(48, 16, 64, 28),
          east: face(32, 16, 48, 28),
          south: face(16, 16, 32, 28),
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

// 猪灵头：原版 PiglinModel.addHead 的头是 10×8×8（比标准 8×8×8 宽），并带左右尖耳。
// 头 UV 同标准玩家头（脸 u8..16/v8..16），耳在皮肤 u40..48/v0..8。这里简化：10×8×8 头 + 两只尖耳。
function piglinHeadModel() {
  const f = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#all' })
  const ear = (x0, x1) => ({ from: [x0, 10, 4], to: [x1, 14, 6], faces: { up: f(40, 0, 48, 8), down: f(40, 0, 48, 8), north: f(40, 0, 48, 8), south: f(40, 0, 48, 8), west: f(40, 0, 48, 8), east: f(40, 0, 48, 8) } })
  return {
    textures: { all: 'entity/piglin/piglin' },
    elements: [
      { from: [3, 4, 4], to: [13, 12, 12], faces: {
          up: f(8, 0, 16, 8), down: f(16, 0, 24, 8),
          east: f(0, 8, 8, 16), south: f(8, 8, 16, 16), west: f(16, 8, 24, 16), north: f(24, 8, 32, 16),
      } },
      ear(3, 6), ear(10, 13),
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
  // 铜箱（含 waxed/exposed/weathered/oxidized，氧化程度编码在方块名里）见下方循环
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
// 猪灵头有左右耳，用专门模型覆盖
SPECIAL_MODELS.piglin_head = (p) => ({ model: piglinHeadModel(), variant: headVariant(p, false), texSize: 64 })
SPECIAL_MODELS.piglin_wall_head = (p) => ({ model: piglinHeadModel(), variant: headVariant(p, true), texSize: 64 })

// —— 26.x 起改为「方块实体渲染器」的方块：JSON 模型为空（仅 particle），这里手工构造几何 ——

// 铜箱：氧化/打蜡程度编码在方块名里（waxed_exposed_copper_chest 等）
const COPPER_CHEST_TEX = {
  copper_chest: 'copper', exposed_copper_chest: 'copper_exposed',
  weathered_copper_chest: 'copper_weathered', oxidized_copper_chest: 'copper_oxidized',
  waxed_copper_chest: 'copper', waxed_exposed_copper_chest: 'copper_exposed',
  waxed_weathered_copper_chest: 'copper_weathered', waxed_oxidized_copper_chest: 'copper_oxidized',
}
for (const [name, base] of Object.entries(COPPER_CHEST_TEX)) {
  SPECIAL_MODELS[name] = (p) => ({
    model: chestModel('entity/chest/' + base + (p.type === 'left' ? '_left' : p.type === 'right' ? '_right' : ''), p.type),
    variant: chestVariant(p),
    texSize: 64,
  })
}

// 旗帜：杆 / 墙架（旗面含底色+图案是每个旗帜实例独有的，由 renderer.renderBanners 单独绘制）。
// 木板是 16×16，这里按 texSize=64 归一化（贴图采样时会各自映射到整张）。
// 注意原版 BannerRenderer 对杆/旗面统一应用 MODEL_SCALE=(2/3,−2/3,−2/3)，这里按 2/3 后的
// 尺寸/位置定义：立地杆 2×42×2 → 1.33×28×1.33，y 从方块中心(8)到 36（即地面往上 0.5..2.25 格）。
function bannerModel() {
  const plank = { uv: [0, 0, 64, 64], texture: '#plank' }
  // 旗面：20×40 像素（贴图左上角 u0..20 v0..40），挂在杆右侧、杆顶往下。旗面贴图 entity/banner/base
  // 是灰度遮罩，实际底色/图案在渲染端按旗帜实例上色（这里 texture 键 #flag 供 entities.js 上色）。
  const flag = { uv: [0, 0, 20, 40], texture: '#flag' }
  return {
    textures: { plank: 'block/oak_planks', flag: 'entity/banner/base' },
    elements: [
      { from: [7, 8, 7], to: [9, 36, 9], faces: { up: plank, down: plank, north: plank, south: plank, west: plank, east: plank } },
      { from: [9, 8, 6], to: [22.33, 36, 7], faces: { north: flag, south: flag, up: flag, down: flag, west: flag, east: flag } },
    ],
  }
}
function wallBannerModel() {
  const plank = { uv: [0, 0, 64, 64], texture: '#plank' }
  return {
    textures: { plank: 'block/oak_planks' },
    elements: [
      // 墙上旗帜：旗面顶端的横木杆（原版 BannerModel 的 wall bar：addBox(-10,-44,-1,20,2,2)，
      // 20×2×2，横跨旗面宽度、旗面从它垂下；2/3 后约 13.3×1.33×1.33）。
      // 木杆顶边与旗面顶边对齐：旗面中心在方块上方 0.375 格、半高 5/6 格，故顶边 = 0.375+5/6
      // = 29/24 格 = 58/3 像素；杆高 2×2/3=4/3 像素，故下边 = 58/3−4/3 = 18 像素。
      { from: [1.5, 18, 7.5], to: [14.5, 58 / 3, 8.5], faces: { up: plank, down: plank, north: plank, south: plank, west: plank, east: plank } },
    ],
  }
}
const BANNER_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
for (const c of BANNER_COLORS) {
  SPECIAL_MODELS[c + '_banner'] = (p) => ({ model: bannerModel(), variant: {}, texSize: 64 })
  SPECIAL_MODELS[c + '_wall_banner'] = (p) => ({ model: wallBannerModel(), variant: { y: FACING_Y[String(p.facing || 'north')] || 0 }, texSize: 64 })
}

// 装饰罐：10×15×10 罐体（侧面/顶面都用 side 贴图，不渲染陶片图案）
function potModel() {
  const side = { uv: [0, 0, 16, 16], texture: '#all' }
  return {
    textures: { all: 'entity/decorated_pot/decorated_pot_side' },
    elements: [
      { from: [3, 0, 3], to: [13, 15, 13], faces: { up: side, down: side, north: side, south: side, west: side, east: side } },
    ],
  }
}
SPECIAL_MODELS.decorated_pot = (p) => ({ model: potModel(), variant: { y: FACING_Y[String(p.facing || 'north')] || 0 }, texSize: 16 })

// 潮涌核心（BER，无 JSON 几何）：原版 ConduitRenderer 用 entity/conduit/base(32×16 壳)、
// cage(32×16 笼)、closed_eye(16×16 眼)。壳贴图 32×16 分上下两段：u6..18/v0..6 是圆顶（顶/底），
// u0..32/v6..12 是环带（侧面）。这里简化：满立方体顶底贴圆顶、侧面贴环带，中央眼立方体贴整张眼。
function conduitModel() {
  const dome = { uv: [6, 0, 18, 6], texture: '#shell' }
  const band = { uv: [0, 6, 32, 12], texture: '#shell' }
  const eye = { uv: [0, 0, 32, 16], texture: '#eye' }
  return {
    textures: { shell: 'entity/conduit/base', eye: 'entity/conduit/closed_eye' },
    elements: [
      { from: [0, 0, 0], to: [16, 16, 16], faces: { up: dome, down: dome, north: band, south: band, west: band, east: band } },
      { from: [6, 6, 6], to: [10, 10, 10], faces: { up: eye, down: eye, north: eye, south: eye, west: eye, east: eye } },
    ],
  }
}
SPECIAL_MODELS.conduit = () => ({ model: conduitModel(), variant: {}, texSize: [32, 16] })

// 盾牌（BER）：原版 ShieldModel 的 plate 是 12×22×1（texOffs 0,0）。这里简化成 12×22 薄板，
// 整张 64×64 无图案木盾贴到正反面。展示框里 fixed 旋转 [0,180,0]。
function shieldModel() {
  const tex = { uv: [0, 0, 64, 64], texture: '#all' }
  return {
    textures: { all: 'entity/shield/shield_base_nopattern' },
    elements: [{ from: [2, -3, 7.5], to: [14, 19, 8.5], faces: { up: tex, down: tex, north: tex, south: tex, west: tex, east: tex } }],
  }
}
SPECIAL_MODELS.shield = () => ({ model: shieldModel(), variant: {}, texSize: 64 })

// 铜傀儡雕像：无 JSON 模型（BER 绘制），由 renderer.renderStatues 用实体模型逐块绘制

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
          display: { ...(parent.display || {}), ...(json.display || {}) },
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
