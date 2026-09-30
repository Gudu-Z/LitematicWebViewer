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
  // 原版 PiglinModel.addHead：头 10×8×8（texOffs 0,0）+ 吻部 4×4×1（texOffs 31,1，前突下半脸）
  // + 双耳 1×5×4（texOffs 51,6 / 39,6，头侧上方，原版有 ±30° zRot 外张，这里近似为轴对齐）。
  // 头宽 10（普通头颅是 8），故面部 UV 用 u8..18 而非 u8..16。
  const earL = { from: [2.5, 5, 6], to: [3.5, 10, 10], faces: {
    up: f(55, 6, 56, 10), down: f(56, 10, 57, 6),
    west: f(56, 10, 60, 15), south: f(55, 10, 56, 15), east: f(51, 10, 55, 15), north: f(60, 10, 61, 15),
  } }
  const earR = { from: [12.5, 5, 6], to: [13.5, 10, 10], faces: {
    up: f(43, 6, 44, 10), down: f(44, 10, 45, 6),
    west: f(44, 10, 48, 15), south: f(43, 10, 44, 15), east: f(39, 10, 43, 15), north: f(48, 10, 49, 15),
  } }
  return {
    textures: { all: 'entity/piglin/piglin' },
    elements: [
      // 头 10×8×8
      { from: [3, 4, 4], to: [13, 12, 12], faces: {
          up: f(8, 0, 18, 8), down: f(18, 0, 28, 8),
          east: f(0, 8, 8, 16), south: f(8, 8, 18, 16), west: f(18, 8, 26, 16), north: f(26, 8, 36, 16),
      } },
      // 吻部 4×4×1（前突，下半脸）
      { from: [6, 4, 12], to: [10, 8, 13], faces: {
          up: f(32, 1, 36, 2), down: f(36, 2, 40, 1),
          east: f(31, 2, 32, 6), south: f(32, 2, 36, 6), west: f(36, 2, 37, 6), north: f(37, 2, 41, 6),
      } },
      earL, earR,
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

// 龙首（DragonHeadModel）：上颚头盖骨 + 上唇 + 下颌 + 双角 + 双鼻孔，7 个盒子，整体
// PartPose.offset(0,−7.986666,0).scaled(0.75)。贴图 256×256（entity/enderdragon/dragon）。
// 这里把 0.75 缩放烘进几何（16×16×16 → 12×12×12 等），offset 近似 −8（误差 <0.02px 忽略）。
function dragonHeadModel() {
  const f = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#all' })
  // ModelPart.Cube 自动 UV：盒 w×h×d、texOffs(u,v)，面朝南（正脸）。
  const faces = (u, v, w, h, d) => ({
    up: f(u + d, v, u + d + w, v + d),
    down: f(u + d + w, v, u + d + 2 * w, v + d),
    east: f(u, v + d, u + d, v + d + h),
    south: f(u + d, v + d, u + d + w, v + d + h),
    west: f(u + d + w, v + d, u + d + w + d, v + d + h),
    north: f(u + d + w + d, v + d, u + d + w + d + w, v + d + h),
  })
  return {
    textures: { all: 'entity/enderdragon/dragon' },
    elements: [
      // 上颚头盖骨 16×16×16（texOffs 112,30）
      { from: [2, 10, 3.5], to: [14, 22, 15.5], faces: faces(112, 30, 16, 16, 16) },
      // 上唇 12×5×16（texOffs 176,44）
      { from: [3.5, 13, 14], to: [12.5, 16.75, 26], faces: faces(176, 44, 12, 5, 16) },
      // 下颌 12×4×16（texOffs 176,65）
      { from: [3.5, 10, 14], to: [12.5, 13, 26], faces: faces(176, 65, 12, 4, 16) },
      // 双角 2×4×6（texOffs 0,0）
      { from: [4.25, 22, 6.5], to: [5.75, 25, 11], faces: faces(0, 0, 2, 4, 6) },
      { from: [10.25, 22, 6.5], to: [11.75, 25, 11], faces: faces(0, 0, 2, 4, 6) },
      // 双鼻孔 2×2×4（texOffs 112,0）
      { from: [4.25, 16.75, 21.5], to: [5.75, 18.25, 24.5], faces: faces(112, 0, 2, 2, 4) },
      { from: [10.25, 16.75, 21.5], to: [11.75, 18.25, 24.5], faces: faces(112, 0, 2, 2, 4) },
    ],
  }
}
SPECIAL_MODELS.dragon_head = (p) => ({ model: dragonHeadModel(), variant: headVariant(p, false), texSize: [256, 256] })
SPECIAL_MODELS.dragon_wall_head = (p) => ({ model: dragonHeadModel(), variant: headVariant(p, true), texSize: [256, 256] })

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
// 旗帜（BER）：原版 BannerModel.createBodyLayer(true)（立地旗）＝竖杆 2×42×2（texOffs 44,0）
// + 横杆 20×2×2（texOffs 0,42）+ 旗面 20×40×1（texOffs 0,0，BannerFlagModel），都在 64×64 贴图
// entity/banner/banner_base（杆/横杆木纹）与 entity/banner/base（旗面灰度遮罩，按底色上色）。
// 原版 BannerRenderer 对整面旗帜应用 MODEL_SCALE=(2/3,−2/3,−2/3)、MODEL_TRANSLATION=(0.5,0,0.5)，
// 故这里把 2/3 缩放与平移烘进几何：竖杆 2×42 → 4/3×28、旗面 20×40 → 40/3×80/3；Y 翻转后
// 杆底在方块底 y=0、旗面 y=8/3..88/3（中心 y=16，与 renderer.renderBanners 的旗面中心一致）。
function bannerModel() {
  const wood = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#wood' })
  return {
    textures: { wood: 'entity/banner/banner_base' },
    elements: [
      // 竖杆 2×42×2 ×2/3 → 4/3×28×4/3（居中 x=z=8，y 0..28）
      { from: [22 / 3, 0, 22 / 3], to: [26 / 3, 28, 26 / 3], faces: {
        up: wood(46, 0, 48, 2), down: wood(48, 2, 50, 0),
        north: wood(50, 2, 52, 44), south: wood(46, 2, 48, 44),
        west: wood(44, 2, 46, 44), east: wood(48, 2, 50, 44),
      } },
      // 横杆 20×2×2 ×2/3 → 40/3×4/3×4/3（y 28..88/3）
      { from: [4 / 3, 28, 22 / 3], to: [44 / 3, 88 / 3, 26 / 3], faces: {
        up: wood(2, 42, 22, 44), down: wood(22, 44, 42, 42),
        north: wood(24, 44, 44, 46), south: wood(2, 44, 22, 46),
        west: wood(0, 44, 2, 46), east: wood(22, 44, 24, 46),
      } },
      // 旗面由 renderer.renderBanners 用着色贴图（底色+图案）单独绘制，这里不再渲染灰色旗面，
      // 避免灰色旗面挡在前面、遮住着色旗面的图案。
    ],
  }
}
function wallBannerModel() {
  const wood = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#wood' })
  return {
    textures: { wood: 'entity/banner/banner_base' },
    elements: [
      // 墙上横杆 20×2×2 ×2/3 → 40/3×4/3×4/3（贴图 u0..44/v42..46，与立地旗横杆同）；
      // 原版 wall bar 顶点 (-10,-20.5,9.5)..(10,-18.5,11.5) 经 S(2/3,−2/3,−2/3)+T(0.5,0,0.5)
      // 得 y 37/3..41/3、z 1/3..5/3（贴在 z≈0 的墙面上）。
      { from: [4 / 3, 37 / 3, 1 / 3], to: [44 / 3, 41 / 3, 5 / 3], faces: {
        up: wood(2, 42, 22, 44), down: wood(22, 44, 42, 42),
        north: wood(24, 44, 44, 46), south: wood(2, 44, 22, 46),
        west: wood(0, 44, 2, 46), east: wood(22, 44, 24, 46),
      } },
    ],
  }
}
const BANNER_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
for (const c of BANNER_COLORS) {
  SPECIAL_MODELS[c + '_banner'] = (p) => ({ model: bannerModel(), variant: { y: (Number(p.rotation) || 0) * 22.5 }, texSize: 64 })
  SPECIAL_MODELS[c + '_wall_banner'] = (p) => ({ model: wallBannerModel(), variant: { y: FACING_Y[String(p.facing || 'north')] || 0 }, texSize: 64 })
}

// 装饰罐（BER）：罐体分「底座」与「四个侧面」两部分。底座（颈口/罐口/罐底）贴图固定为
// 32×32 的 entity/decorated_pot/decorated_pot_base，作为静态方块模型烘焙；四个侧面贴图随
// 每只罐子的陶片图案而变（16×16，空白 side 或 *_pottery_pattern），由 renderer.renderDecoratedPots
// 逐实例绘制。原版 DecoratedPotRenderer.createBaseLayer()：颈口 8×3×8（texOffs 0,0）+ 6×1×6
// （texOffs 0,5），经 PartPose(0,37,16,π,0,0) 后落到 y 17..20 与 16..17；罐口/罐底各 14×0×14
// （texOffs -14,13，负 u 由 auto-UV 补偿到 u14..28）。
function potBaseModel() {
  return {
    textures: { all: 'entity/decorated_pot/decorated_pot_base' },
    elements: [
      texBox([4, 17, 4], [12, 20, 12], 0, 0), // 颈口上段 8×3×8
      texBox([5, 16, 5], [11, 17, 11], 0, 5), // 颈口下段 6×1×6
      texBox([1, 16, 1], [15, 16, 15], -14, 13), // 罐口（顶面）
      texBox([1, 0, 1], [15, 0, 15], -14, 13), // 罐底
    ],
  }
}
SPECIAL_MODELS.decorated_pot = (p) => ({ model: potBaseModel(), variant: { y: FACING_Y[String(p.facing || 'north')] || 0 }, texSize: 32 })

// 末地传送门/末地折跃门（BER，无 JSON 几何）：原版 AbstractEndPortalRenderer.submitCube
// 就是一个满覆盖立方体（FROM(0,0,0)..TO(1,1,1)），六个面都贴 entity/end_portal/end_portal
// 星空贴图（256×256，透明感由原版着色器实现，这里用不透明整张贴图近似）。
// 折跃门的「光束」是瞬态特效（实体穿过时才有），此处略去，只画门体。
function endPortalModel() {
  const f = { uv: [0, 0, 16, 16], texture: '#portal' }
  return {
    textures: { portal: 'entity/end_portal/end_portal' },
    elements: [
      { from: [0, 0, 0], to: [16, 16, 16], faces: { up: f, down: f, north: f, south: f, west: f, east: f } },
    ],
  }
}
SPECIAL_MODELS.end_portal = () => ({ model: endPortalModel(), variant: {}, texSize: 16 })
SPECIAL_MODELS.end_gateway = () => ({ model: endPortalModel(), variant: {}, texSize: 16 })

// 移动中的活塞（moving_piston 方块实体，BER）：只在活塞动画约 2 tick 内存在，几乎不会出现在
// 投影里。这里至少画成可识别的活塞头——复刻原版 template_piston_head 几何（16×16×4 头板 +
// 4×4×16 活塞臂，臂伸出方块一格伸向活塞底座）。头部朝向由 facing 旋转，type 决定是否粘性。
function pistonHeadModel(type) {
  const sticky = String(type) === 'sticky'
  return {
    textures: {
      platform: 'block/piston_top',
      side: 'block/piston_side',
      unsticky: sticky ? 'block/piston_top_sticky' : 'block/piston_top',
    },
    elements: [
      { from: [0, 0, 0], to: [16, 16, 4], faces: {
        down: { uv: [0, 0, 16, 4], texture: '#side', cullface: 'down', rotation: 180 },
        up: { uv: [0, 0, 16, 4], texture: '#side', cullface: 'up' },
        north: { uv: [0, 0, 16, 16], texture: '#platform', cullface: 'north' },
        south: { uv: [0, 0, 16, 16], texture: '#unsticky' },
        west: { uv: [0, 0, 16, 4], texture: '#side', rotation: 270, cullface: 'west' },
        east: { uv: [0, 0, 16, 4], texture: '#side', rotation: 90, cullface: 'east' },
      } },
      { from: [6, 6, 4], to: [10, 10, 20], faces: {
        down: { uv: [0, 0, 16, 4], texture: '#side', rotation: 90 },
        up: { uv: [0, 0, 16, 4], texture: '#side', rotation: 270 },
        west: { uv: [16, 4, 0, 0], texture: '#side' },
        east: { uv: [0, 0, 16, 4], texture: '#side' },
      } },
    ],
  }
}
// 活塞头朝向（头面朝 -z/north），与 piston_head.json 的变体一致
const PISTON_HEAD_FACING = { down: { x: 90 }, up: { x: 270 }, north: {}, south: { y: 180 }, east: { y: 90 }, west: { y: 270 } }
SPECIAL_MODELS.moving_piston = (p) => ({ model: pistonHeadModel(p.type), variant: PISTON_HEAD_FACING[String(p.facing || 'north')] || {}, texSize: 16 })

// 潮涌核心（BER，无 JSON 几何）：原版 ConduitRenderer.createShellLayer 就是一个 6×6×6 立方体
// （addBox(-3,-3,-3, 6,6,6)，texOffs 0,0，32×16 贴图 entity/conduit/base）。物品渲染（ConduitSpecialRenderer）
// 只画壳，不含眼/笼（眼/笼仅世界内激活时才有）。ModelPart.Cube 自动 UV：±Y 面贴圆顶
// （u6..12、u12..18 / v0..6 两半），四侧面贴环带（u0..24 / v6..12，每面 6 宽一段）。
// items/conduit.json 的 special transformation 平移 [0.5,0.5,0.5] 把 -3..3px 的壳移进方块空间，
// 与 display.fixed 的 translate(-0.5) 居中相消，故壳居中、尺寸 6/16=0.375。
function conduitModel() {
  const shell = 'entity/conduit/base'
  const domeL = { uv: [6, 0, 12, 6], texture: '#shell' }
  const domeR = { uv: [12, 0, 18, 6], texture: '#shell' }
  const band = (u) => ({ uv: [u, 6, u + 6, 12], texture: '#shell' })
  return {
    textures: { shell },
    elements: [
      {
        from: [5, 5, 5], to: [11, 11, 11],
        faces: {
          up: domeL,
          down: domeR,
          north: band(6),
          south: band(18),
          west: band(0),
          east: band(12),
        },
      },
    ],
  }
}
SPECIAL_MODELS.conduit = () => ({ model: conduitModel(), variant: {}, texSize: [32, 16] })

// 盾牌（BER）：原版 ShieldModel 的 plate 是 12×22×1（addBox(-6,-11,-2,12,22,1)，texOffs 0,0，
// 64×64 贴图），另有 2×6×6 手柄（texOffs 26,0，藏在板后、正面看不到，此处略去）。ModelPart.Cube
// 自动 UV：正面（南面）贴 u1..13/v1..23（木+金属边），背面（北面）贴 u14..26/v1..23（木板），
// 四条薄边贴 1px 边条。展示框里 fixed 旋转 [0,180,0]（正面经 Q_FLIP 后朝观察者）。
function shieldModel() {
  const tex = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#all' })
  return {
    textures: { all: 'entity/shield/shield_base_nopattern' },
    elements: [
      {
        from: [-6, -11, 1], to: [6, 11, 2],
        faces: {
          south: tex(1, 1, 13, 23), // 正面（木 + 金属边）
          north: tex(14, 1, 26, 23), // 背面（木板）
          up: tex(1, 0, 13, 1), // 顶边
          down: tex(13, 1, 25, 0), // 底边
          west: tex(0, 1, 1, 23), // 左边
          east: tex(13, 1, 14, 23), // 右边
        },
      },
    ],
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
    if (k === 'AND') {
      // {AND: [条件1, 条件2]}：所有条件都满足才匹配（如雕纹书架/架子的 facing + slot 占用）
      if (!Array.isArray(v) || !v.every((cond) => matchWhen(cond, props))) return false
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
