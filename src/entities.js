// 实体渲染：把 .litematica 里的实体转成 Three.js 网格。
// 目前支持：item_frame / glow_item_frame（物品展示框）、*_minecart（矿车，含漏斗/箱子/熔炉/TNT）、
// armor_stand（盔甲架）、*_boat（船，含箱船）、以及带 Health 的生物实体——用原版实体模型
// + 真实皮肤贴图渲染（约 60 种，见下方 MOB_TABLE；模型数据在 entityModelData.js）。
//
// 物品展示框严格按原版 ItemFrameEntityRenderer 的变换复现（1.21.11）：
//   - 实体 Pos = 附着方块中心 − facing × 15/32（新版展示框位置移到支撑方块内，实测 NBT 印证）
//   - 框体锚点 = 附着方块中心 + facing × 1.0（即框所在空气方块中心）
//   - 模型 +z 轴经旋转后指向 −facing（框背贴墙），开面朝玩家
//   - 框板/边框直接用原版 template_item_frame 模型烘焙；物品在框口 0.4375 处、缩放 0.5、
//     按 ItemRotation × 45° 绕框法线旋转
// 矿车在 Minecraft 中没有 JSON 模型（Java 硬编码），故用硬编码盒体 + 真实贴图近似。

import * as THREE from 'three'
import { BlockModelResolver } from './blocks.js'
import { bakeModel } from './modelBaker.js'
import { ENTITY_MODELS } from './entityModelData.js'
import { EXTRA_MODELS } from './extraEntityModels.js'

// Minecraft Direction 枚举：Facing 字节 -> 方向向量
const FACING_DIRS = {
  0: [0, -1, 0], // down
  1: [0, 1, 0], // up
  2: [0, 0, -1], // north
  3: [0, 0, 1], // south
  4: [-1, 0, 0], // west
  5: [1, 0, 0], // east
}
// 水平方向的 getPositiveHorizontalDegrees()（南 0 / 西 90 / 北 180 / 东 270）
const HORIZ_DEG = { 2: 180, 3: 0, 4: 90, 5: 270 }
const DEG = Math.PI / 180

function shortName(id) {
  return (id || '').replace(/^minecraft:/, '')
}

// 把实体转成网格；不支持的实体返回 null
export async function buildEntityMesh(entity, assets, data) {
  const id = shortName(entity.id)
  if (id === 'item_frame' || id === 'glow_item_frame') {
    return buildItemFrame(entity, id, assets)
  }
  if (id === 'minecart' || id.endsWith('_minecart')) {
    return buildMinecart(entity, id, assets, data)
  }
  if (id === 'armor_stand') {
    return buildArmorStand(entity, assets)
  }
  if (id.endsWith('_boat') || id.endsWith('_raft')) {
    return buildBoat(entity, id, assets)
  }
  if (entity.nbt && 'Health' in entity.nbt) {
    return buildMob(entity, id, assets) // 生物实体（猪/牛/羊/村民等）
  }
  return null
}

// 一个放在 XY 平面、法线 +z 的四边形，UV 用 MC 约定（v=0 在上，配合贴图 flipY=false）。
// three.js 自带的 PlaneGeometry 顶边是 v=1，会把 MC 贴图上下颠倒，故这里手写。
function quadGeometry(w, h) {
  const geo = new THREE.BufferGeometry()
  const hw = w / 2
  const hh = h / 2
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0]), 3),
  )
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2))
  geo.setIndex([0, 2, 1, 1, 2, 3]) // 法线 +z
  return geo
}

// 把一组烘焙好的 quads（verts/uvs/texKey，局部坐标 0..1）转成 Three.js 网格。
// offset 统一加到顶点上（展示框传 -0.5，使模型居中于方块）；materialFor 按 texKey 取材质。
function quadsToMesh(quads, offset, materialFor) {
  const byTex = new Map()
  for (const q of quads) {
    let a = byTex.get(q.texKey)
    if (!a) {
      a = []
      byTex.set(q.texKey, a)
    }
    a.push(q)
  }
  const group = new THREE.Group()
  for (const [texKey, qs] of byTex) {
    const mat = materialFor(texKey)
    if (!mat) continue
    const n = qs.length
    const positions = new Float32Array(n * 12)
    const uvs = new Float32Array(n * 8)
    const indices = new Uint32Array(n * 6)
    for (let i = 0; i < n; i++) {
      const q = qs[i]
      for (let k = 0; k < 4; k++) {
        positions[i * 12 + k * 3] = q.verts[k][0] + offset[0]
        positions[i * 12 + k * 3 + 1] = q.verts[k][1] + offset[1]
        positions[i * 12 + k * 3 + 2] = q.verts[k][2] + offset[2]
        uvs[i * 8 + k * 2] = q.uvs[k][0]
        uvs[i * 8 + k * 2 + 1] = q.uvs[k][1]
      }
      const b = i * 4
      // 与 geometry.js 的 writeFace 相同三角化：0,1,2 + 2,1,3
      indices[i * 6] = b
      indices[i * 6 + 1] = b + 1
      indices[i * 6 + 2] = b + 2
      indices[i * 6 + 3] = b + 2
      indices[i * 6 + 4] = b + 1
      indices[i * 6 + 5] = b + 3
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    group.add(new THREE.Mesh(geo, mat))
  }
  return group
}

// 物品展示框
async function buildItemFrame(entity, id, assets) {
  const group = new THREE.Group()
  const [px, py, pz] = entity.pos
  const facingByte = Number(entity.nbt?.Facing)
  const F = FACING_DIRS[facingByte] || [0, 0, -1]

  // 附着方块中心（由 Pos 反推：Pos = 附着中心 − facing × 15/32）。
  // 注意：这里的「附着方块」是框自己所在的空气方块（TileX/Y/Z），墙在 facing 的反面。
  const aCenter = new THREE.Vector3(px + F[0] * 0.46875, py + F[1] * 0.46875, pz + F[2] * 0.46875)
  // 框体锚点 = 框所在方块中心；模型 +z 经旋转后指向 −facing（框背贴墙，墙在 −facing 侧）
  const anchor = aCenter.clone()

  // 朝向（原版）：水平 f=0, g = 180 − positiveHorizontalDegrees；垂直 f = −90 × offset, g = 180
  let f, g
  if (F[1] === 0) {
    f = 0
    g = 180 - (HORIZ_DEG[facingByte] ?? 0)
  } else {
    f = -90 * F[1]
    g = 180
  }
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g * DEG)
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), f * DEG)
  const q = qx.clone().multiply(qy) // 等价原版 Rx·Ry（先绕 Y 再绕 X）

  // 框板 + 边框：直接用原版 block/item_frame（或 glow_item_frame）模型烘焙
  const resolver = new BlockModelResolver(assets)
  const modelId = id === 'glow_item_frame' ? 'minecraft:glow_item_frame' : 'minecraft:item_frame'
  const baked = await resolver.resolve(modelId, { map: 'false' })
  if (baked && baked.quads && baked.quads.length) {
    const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
    const mats = new Map()
    await Promise.all(
      texKeys.map(async (tk) => {
        const tex = await assets.getTexture(tk)
        if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, flatShading: true }))
      }),
    )
    const frame = quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk))
    frame.position.copy(anchor)
    frame.quaternion.copy(q)
    group.add(frame)
  }

  // 内部物品：框口 0.4375 处，缩放 0.5（8px），绕框法线按 ItemRotation × 45° 旋转。
  // 框模型（template_item_frame）的正面是 −z（+z 贴墙），而物品模型正面是 +z，两者相反，
  // 直接用框的四元数会让物品正面朝墙、观众看到镜像背面；额外绕 Y 转 180° 把正面翻向玩家。
  const item = entity.nbt?.Item
  if (item && item.id) {
    const itemMesh = await buildFrameItem(item, resolver, assets)
    if (itemMesh) {
      const rot = Number(entity.nbt?.ItemRotation) || 0
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot * 45 * DEG)
      const qflip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
      itemMesh.position.copy(anchor).addScaledVector(forward, 0.4375)
      itemMesh.quaternion.copy(q).multiply(qflip).multiply(qz)
      group.add(itemMesh)
    }
  }

  return group
}

// 方块物品解析用的默认属性。
// 原版方块物品按 Block.getDefaultState() 渲染：普通（variants）方块要还原其默认状态——
// 朝向类方块在 item 帧里正面朝观察者（+z），故取 facing=south；例外：观察者 observer=south、
// 避雷针/末地烛=up、漏斗=down、楼梯=west。轴类 axis=y、楼梯 half=bottom/shape=straight 等。
// 之前这里统一传 axis:y，导致活塞/观察者/发射器等朝向类方块在展示框里朝向不对。
// multipart 方块（墙/栅栏/玻璃板/铁栏杆等）需还原「孤立默认状态」——核心立柱可见、四周无连接。
async function defaultItemProps(name, assets) {
  // 箱子是方块实体渲染器（BER）：blockstates 里没有 facing 变体，走不到下面的 facing 分支。
  // 这里直接给 single + facing=south，让锁扣（模型 +z 面）朝向观察者——等效原版 item 模型
  // template_chest 的 fixed 旋转 [0,180,0]（默认 facing=north 正面 −z 再转 180° 到 +z）。
  if (name === 'chest' || name.endsWith('_chest')) {
    return { type: 'single', facing: 'south' }
  }
  const bs = await assets.getJSON('blockstates/' + name + '.json')
  if (!bs) return {}
  if (!bs.multipart) {
    const firstKey = Object.keys(bs.variants || {})[0] || ''
    const props = {}
    for (const kv of firstKey.split(',')) {
      const [k, v] = kv.split('=')
      if (!k) continue
      // 方块物品按 Block.getDefaultState() 渲染：观察者默认 south、避雷针/末地烛默认 up、
      // 漏斗默认 down、楼梯默认 west；其余朝向类方块（熔炉/发射器/活塞等）正面朝 +z，
      // 在 item 帧里即朝向观察者（配合下方 buildFrameItem 的 180° Y 翻转）。
      if (k === 'facing') props[k] =
        name === 'observer' ? 'south' :
        name.endsWith('lightning_rod') || name === 'end_rod' ? 'up' :
        name === 'hopper' ? 'down' :
        name.endsWith('_stairs') ? 'west' :
        'south'
      else if (k === 'axis') props[k] = 'y'
      else if (k === 'half') props[k] = 'bottom'
      else if (k === 'shape') props[k] = 'straight'
      else if (k === 'type') props[k] = 'bottom'
      else if (k === 'waterlogged' || k === 'powered' || k === 'lit' || k === 'open' || k === 'locked' || k === 'inverted') props[k] = 'false'
      else props[k] = v || 'false'
    }
    return props
  }
  const props = {}
  for (const part of bs.multipart) {
    const when = part.when
    if (!when || typeof when !== 'object') continue
    for (const k of Object.keys(when)) {
      if (k === 'OR' || props[k] !== undefined) continue
      const v = when[k]
      const first = Array.isArray(v) ? String(v[0]) : String(v).split('|')[0]
      if (k === 'up') props[k] = 'true' // 墙的中心立柱
      else if (first === 'low' || first === 'tall' || first === 'none') props[k] = 'none' // 墙的侧面
      else if (first === 'true' || first === 'false') props[k] = 'false' // 布尔连接（孤立状态默认无连接）
      else if (k === 'facing') props[k] = 'north'
      else props[k] = 'none'
    }
  }
  return props
}

// 框内物品网格：先按物品模型判定——含 layer0 的 2D 物品（小麦/铁轨/箭/剑等）渲染成平面贴图；
// 否则按方块模型渲染（游戏内方块图标即方块模型）。
async function buildFrameItem(item, resolver, assets) {
  const name = shortName(item.id)
  const holder = new THREE.Group()

  // 2D 物品：models/item/NAME.json 含 layer0（fixed 缩放 1，叠加框体 0.5 后总 0.5 = 8px）
  const itemModel = await assets.getJSON('models/item/' + name + '.json')
  const layer0 = itemModel?.textures?.layer0
  if (layer0) {
    const texKey = String(layer0).replace(/^minecraft:/, '')
    const tex = await assets.getTexture(texKey)
    if (tex) {
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
      holder.add(new THREE.Mesh(quadGeometry(1, 1), mat))
      holder.scale.setScalar(0.5)
      return holder
    }
  }

  // 时钟/指南针/追溯指针：特殊物品（无 JSON 模型，纹理是逐帧的 *_00..NN）。
  // 静态预览里渲染第一帧（时钟 00=正午、指南针/追溯指针 00=初始朝向）。
  if (name === 'clock' || name === 'compass' || name === 'recovery_compass') {
    const tex = await assets.getTexture('item/' + name + '_00')
    if (tex) {
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
      holder.add(new THREE.Mesh(quadGeometry(1, 1), mat))
      holder.scale.setScalar(0.5)
      return holder
    }
  }

  // 铜傀儡雕像：无 JSON 模型，用实体模型渲染。原版 item 模型 template_copper_golem_statue 的
  // fixed 显示变换是 translation[0,3,0]（=3/16=0.1875 上移）+ scale 0.5。方块模型居中（-0.5）后
  // 雕像脚底在 -0.5，上移 0.1875 → -0.3125；再乘展示框 0.5 缩放。实体模型本身已缩 0.6（BER）。
  if (name.endsWith('copper_golem_statue')) {
    const tex = await assets.getTexture('entity/copper_golem/copper_golem' + (name.includes('exposed') ? '_exposed' : name.includes('weathered') ? '_weathered' : name.includes('oxidized') ? '_oxidized' : ''))
    if (tex) {
      const golem = buildCopperGolemStatueMesh(tex)
      if (golem) {
        golem.position.y = -0.3125
        holder.add(golem)
        holder.scale.setScalar(0.5)
        return holder
      }
    }
  }

  // 方块物品：3D 方块模型（原版展示框 scale 0.5 = 8px，方块是 3D 立方体显得偏大，这里用 0.4 略缩）
  const props = await defaultItemProps(name, assets)
  const baked = await resolver.resolve('minecraft:' + name, props)
  if (baked && baked.quads && baked.quads.length) {
    const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
    const mats = new Map()
    await Promise.all(
      texKeys.map(async (tk) => {
        const tex = await assets.getTexture(tk)
        // DoubleSide：玻璃/植物等十字模型与透明方块背面也要可见（原版 cutout 不剔除背面）
        if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true }))
      }),
    )
    holder.add(quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk)))
    holder.scale.setScalar(0.4)
    return holder
  }

  // 兜底：贴图平面
  const tex =
    (await assets.getTexture('item/' + name)) ||
    (await assets.getTexture('block/' + name)) ||
    (await assets.getTexture('entity/' + name))
  if (tex) {
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
    holder.add(new THREE.Mesh(quadGeometry(1, 1), mat))
    holder.scale.setScalar(0.5)
    return holder
  }
  return null
}

// 盔甲架的一个立方体部件：按原版 ModelPart.Cuboid 的 auto-UV 布局生成各面贴图。
// from/to 用「模型像素」坐标（1 像素 = 1/16 方块，世界 Y 向上，脚底 y=0）；
// texU/texV 为该部件在 64×64 贴图里的 UV 原点。原版实体模型 Y 轴向下，
// 故 up/down 面的 UV 互换（世界 up = 实体 down）。
function cuboidElement(from, to, texU, texV) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const f = (u0, v0, u1, v1) => ({ uv: [u0, v0, u1, v1], texture: '#all' })
  return {
    from,
    to,
    faces: {
      up: f(texU + dz + dx, texV, texU + dz, texV + dz), // 实体 down
      down: f(texU + dz + dx, texV + dz, texU + dz + 2 * dx, texV), // 实体 up
      west: f(texU + dz, texV + dz + dy, texU, texV + dz),
      north: f(texU + dz + dx, texV + dz + dy, texU + dz, texV + dz),
      east: f(texU + dz + dx + dz, texV + dz + dy, texU + dz + dx, texV + dz),
      south: f(texU + dz + dx + dz + dx, texV + dz + dy, texU + dz + dx + dz, texV + dz),
    },
  }
}

// 盔甲架：无 JSON 模型（Java 硬编码），按原版 ArmorStandEntityModel.getTexturedModelData
// 的盒体尺寸/位置/UV 复现，用 bakeModel 烘焙 + entity/armorstand/armorstand.png 贴图。
// 支持 ShowArms（双臂）、Small（缩小）、NoBasePlate（去底板）。
async function buildArmorStand(entity, assets) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const nbt = entity.nbt || {}
  const yaw = Number(entity.rotation?.[0]) || 0
  const small = Number(nbt.Small) === 1
  const showArms = Number(nbt.ShowArms) === 1
  const showBase = Number(nbt.NoBasePlate) !== 1

  // 各部件（模型像素坐标，世界 Y 向上，脚底 y=0）：
  const elements = []
  if (showBase) elements.push(cuboidElement([-6, 0, -6], [6, 1, 6], 0, 32)) // 底板 12×1×12
  elements.push(cuboidElement([-2.9, 1, -1], [-0.9, 12, 1], 8, 0)) // 右腿 2×11×2
  elements.push(cuboidElement([0.9, 1, -1], [2.9, 12, 1], 40, 16)) // 左腿
  elements.push(cuboidElement([-3, 14, -1], [-1, 21, 1], 16, 0)) // 右躯干竖条 2×7×2
  elements.push(cuboidElement([1, 14, -1], [3, 21, 1], 48, 16)) // 左躯干竖条
  elements.push(cuboidElement([-4, 12, -1], [4, 14, 1], 0, 48)) // 肩横条 8×2×2
  elements.push(cuboidElement([-6, 21, -1.5], [6, 24, 1.5], 0, 26)) // 躯干 12×3×3
  elements.push(cuboidElement([-1, 23, -1], [1, 30, 1], 0, 0)) // 头 2×7×2
  if (showArms) {
    elements.push(cuboidElement([-7, 12, -1], [-5, 24, 1], 24, 0)) // 右臂 2×12×2
    elements.push(cuboidElement([5, 12, -1], [7, 24, 1], 32, 16)) // 左臂
  }

  const baked = bakeModel({ textures: { all: 'entity/armorstand/armorstand' }, elements }, {}, 64)
  const tex = await assets.getTexture('entity/armorstand/armorstand')
  const mat = tex
    ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, flatShading: true })
    : new THREE.MeshLambertMaterial({ color: 0x9c7a4d, flatShading: true })
  group.add(quadsToMesh(baked.quads, [0, 0, 0], () => mat))

  if (small) group.scale.setScalar(0.5)

  group.position.set(x, y, z)
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}

// 矿车：原版 MinecartEntityModel（5 部件）+ minecart.png 贴图（+ 内容方块）。
// 原版模型不含车轮（轮子在旧版由渲染器单独绘制、这份源码里已移除），故不加。
// 铁轨 shape -> 前进方向 [dx, dy, dz]（dy=1 表示上坡）。方向取「正方向」，矿车左右对称故无碍。
const RAIL_SHAPES = {
  north_south: [0, 0, 1],
  east_west: [1, 0, 0],
  ascending_east: [1, 1, 0],
  ascending_west: [-1, 1, 0],
  ascending_north: [0, 1, -1],
  ascending_south: [0, 1, 1],
  south_east: [1, 0, 1],
  south_west: [-1, 0, 1],
  north_west: [-1, 0, -1],
  north_east: [1, 0, -1],
}

const RAIL_NAMES = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail'])

// 查找矿车所在铁轨的前进方向：先查脚下方块，再查下一格（矿车可能停在 ascending 铁轨顶端）。
function railDirectionAt(data, x, y, z) {
  if (!data?.blocks || !data?.palette || !data?.bounds) return null
  const { blocks, palette, bounds } = data
  const cx = Math.floor(x)
  const cz = Math.floor(z)
  const W = bounds.width
  const strideY = W * bounds.depth
  for (const cy of [Math.floor(y), Math.floor(y) - 1]) {
    const key = (cx - bounds.minX) + (cz - bounds.minZ) * W + (cy - bounds.minY) * strideY
    const gi = blocks.get(key)
    if (gi === undefined) continue
    const p = palette[gi]
    const name = (p?.name || '').replace(/^minecraft:/, '')
    if (RAIL_NAMES.has(name)) {
      const shape = p.properties?.shape
      if (shape && RAIL_SHAPES[shape]) return RAIL_SHAPES[shape]
    }
  }
  return null
}

async function buildMinecart(entity, id, assets, data) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos

  const model = ENTITY_MODELS.MinecartEntityModel
  const tex = await assets.getTexture('entity/minecart/minecart')
  const bodyMat = tex
    ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
    : new THREE.MeshLambertMaterial({ color: 0x7a7a7a })
  const body = quadsToEntityMesh(compileModel(model), bodyMat)
  // 编译后车底在局部 y=19/16，下移使车底贴到铁轨（原版车底在 Pos 上方 1/16=0.0625）
  body.position.set(0, -1.125, 0)
  group.add(body)

  // 内容方块（漏斗/箱子/熔炉/TNT/命令方块/刷怪笼）。原版缩放 DISPLAY_BLOCK_SCALE=0.75，
  // 并按 displayOffset 上下偏移（chest=8 最高、hopper=1 最低、其余默认 6），
  // translate(-0.5,(offset-8)/16,0.5) 后块中心 y = 0.375 + 0.75*(0.5 + (offset-8)/16)。
  const resolver = new BlockModelResolver(assets)
  let contentName = null
  let contentProps = {}
  let contentOffset = 6
  if (id === 'hopper_minecart') { contentName = 'minecraft:hopper'; contentProps = { facing: 'down', enabled: 'true' }; contentOffset = 1 }
  else if (id === 'chest_minecart') { contentName = 'minecraft:chest'; contentProps = { type: 'single', facing: 'north' }; contentOffset = 8 }
  else if (id === 'furnace_minecart') { contentName = 'minecraft:furnace'; contentProps = { facing: 'north', lit: 'false' } }
  else if (id === 'tnt_minecart') { contentName = 'minecraft:tnt'; contentProps = {} }
  else if (id === 'command_block_minecart') { contentName = 'minecraft:command_block'; contentProps = { conditional: 'false', facing: 'up' } }
  else if (id === 'spawner_minecart') { contentName = 'minecraft:spawner'; contentProps = {} }
  if (contentName) {
    const baked = await resolver.resolve(contentName, contentProps)
    if (baked && baked.quads && baked.quads.length) {
      const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
      const mats = new Map()
      await Promise.all(
        texKeys.map(async (tk) => {
          const tex = await assets.getTexture(tk)
          if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, flatShading: true }))
        }),
      )
      const content = quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk))
      content.scale.setScalar(0.75)
      content.position.set(0, 0.375 + 0.75 * (0.5 + (contentOffset - 8) / 16), 0)
      group.add(content)
    }
  }

  group.position.set(x, y, z)
  // 矿车朝向与铁轨一致：原版默认控制器渲染时不读实体存储的 Rotation，而是
  // snapPositionToRail + simulateMovement(±0.3) 算出 railDirection，再
  // yaw=atan2(dz,dx)、pitch=atan(dy)*73。本渲染器矿车模型 front 在 -x，
  // 故 rotation.y=atan2(dz,-dx) 让车头指向铁轨前进方向，上坡时 rotation.z=-pitch 车头上仰。
  const railDir = railDirectionAt(data, x, y, z)
  let yawDeg, pitchDeg
  if (railDir) {
    const [dx, dy, dz] = railDir
    yawDeg = (Math.atan2(dz, -dx) * 180) / Math.PI
    const invLen = 1 / Math.hypot(dx, dy, dz)
    pitchDeg = dy ? Math.atan(dy * invLen) * 73 : 0
  } else {
    // 找不到铁轨时回退到实体存储的 Rotation
    yawDeg = 90 - (Number(entity.rotation?.[0]) || 0)
    pitchDeg = Number(entity.rotation?.[1]) || 0
  }
  group.rotation.order = 'YXZ'
  group.rotation.y = (yawDeg * Math.PI) / 180
  group.rotation.z = -(pitchDeg * Math.PI) / 180
  return group
}

// ---------------------------------------------------------------------------
// 生物实体：用 vanilla 实体模型 + 真实皮肤贴图渲染。
// 模型数据由 scripts/parse-entity-models.mjs 从原版反编译源码自动生成。
// 复刻 vanilla ModelPart.Cuboid 的 UV 布局与 ModelPart 的变换约定。

// 单个 cuboid 的 6 个面（模型空间，Y 向下）
function cuboidFaces(c, texW, texH) {
  const { u, v, x, y, z, dx, dy, dz, mirror } = c
  const [rx, ry, rz] = c.dil || [0, 0, 0]
  let x0 = x - rx, y0 = y - ry, z0 = z - rz
  let x1 = x + dx + rx, y1 = y + dy + ry, z1 = z + dz + rz
  if (mirror) { const t = x0; x0 = x1; x1 = t }
  const V = {
    v0: [x0, y0, z0], v1: [x1, y0, z0], v2: [x1, y1, z0], v3: [x0, y1, z0],
    v4: [x0, y0, z1], v5: [x1, y0, z1], v6: [x1, y1, z1], v7: [x0, y1, z1],
  }
  const uN = u + dz, uE = u + dz + dx, uE2 = u + dz + dx + dx
  const uS = u + dz + dx + dz, uS2 = u + dz + dx + dz + dx
  const vT = v, vM = v + dz, vB = v + dz + dy
  const FACES = [
    [['v5', 'v4', 'v0', 'v1'], [uN, vT, uE, vM], [0, 1, 0]], // down(+y)
    [['v2', 'v3', 'v7', 'v6'], [uE, vM, uE2, vT], [0, -1, 0]], // up(-y)
    [['v0', 'v4', 'v7', 'v3'], [u, vM, uN, vB], [-1, 0, 0]], // west(-x)
    [['v1', 'v0', 'v3', 'v2'], [uN, vM, uE, vB], [0, 0, -1]], // north(-z)
    [['v5', 'v1', 'v2', 'v6'], [uE, vM, uS, vB], [1, 0, 0]], // east(+x)
    [['v4', 'v5', 'v6', 'v7'], [uS, vM, uS2, vB], [0, 0, 1]], // south(+z)
  ]
  // 平面（某维度为 0）的“背面”采样与“正面”相同的 UV，避免背面空白（如炽足兽刚毛、沼泽骷髅蘑菇）
  if (dy === 0) FACES[1][1] = FACES[0][1].slice()
  if (dz === 0) FACES[5][1] = FACES[3][1].slice()
  if (dx === 0) FACES[4][1] = FACES[2][1].slice()
  const out = []
  for (const [idx, [u1, v1, u2, v2], dir] of FACES) {
    const nuv = (uu, vv) => [uu / texW, vv / texH]
    let pairs = [
      [V[idx[0]], nuv(u2, v1)],
      [V[idx[1]], nuv(u1, v1)],
      [V[idx[2]], nuv(u1, v2)],
      [V[idx[3]], nuv(u2, v2)],
    ]
    let d = dir
    if (mirror && d[0] !== 0) d = [-d[0], d[1], d[2]]
    if (mirror) pairs.reverse()
    out.push({ verts: pairs.map((p) => p[0]), uvs: pairs.map((p) => p[1]), dir: d })
  }
  return out
}

// 旋转：Rz(roll)*Ry(yaw)*Rx(pitch)（vanilla rotationZYX）
function rotPoint(pt, rot) {
  const [x, y, z] = pt
  const [pitch, yaw, roll] = rot
  const cx = Math.cos(pitch), sx = Math.sin(pitch)
  const y1 = y * cx - z * sx, z1 = y * sx + z * cx
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy
  const cr = Math.cos(roll), sr = Math.sin(roll)
  return [x2 * cr - y1 * sr, x2 * sr + y1 * cr, z2]
}
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

// 编译实体模型为 world 坐标 quad 列表（Y 向上、脚底 y=0、前向 +z）
export function compileModel(model) {
  const { w, h, parts } = model
  const quads = []
  const walk = (node, toModel, toDir) => {
    for (const name of Object.keys(node)) {
      const p = node[name]
      const R = p.rot || [0, 0, 0]
      const pivot = p.pivot || [0, 0, 0]
      const childToModel = (pt) => toModel(add3(pivot, rotPoint(pt, R)))
      const childToDir = (d) => toDir(rotPoint(d, R))
      for (const c of p.cuboids || []) {
        for (const face of cuboidFaces(c, w, h)) {
          const verts = face.verts.map(childToModel).map(([mx, my, mz]) => [mx / 16, (24 - my) / 16, -mz / 16])
          const nd = childToDir(face.dir)
          quads.push({ verts, uvs: face.uvs, normal: [nd[0], -nd[1], -nd[2]] })
        }
      }
      walk(p.children || {}, childToModel, childToDir)
    }
  }
  walk(parts, (p) => p, (d) => d)
  return quads
}

// quads -> 单一材质网格
export function quadsToEntityMesh(quads, mat) {
  const n = quads.length
  const positions = new Float32Array(n * 12)
  const uvs = new Float32Array(n * 8)
  const normals = new Float32Array(n * 12)
  const indices = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const q = quads[i]
    for (let k = 0; k < 4; k++) {
      positions[i * 12 + k * 3] = q.verts[k][0]
      positions[i * 12 + k * 3 + 1] = q.verts[k][1]
      positions[i * 12 + k * 3 + 2] = q.verts[k][2]
      uvs[i * 8 + k * 2] = q.uvs[k][0]
      uvs[i * 8 + k * 2 + 1] = q.uvs[k][1]
      normals[i * 12 + k * 3] = q.normal[0]
      normals[i * 12 + k * 3 + 1] = q.normal[1]
      normals[i * 12 + k * 3 + 2] = q.normal[2]
    }
    const b = i * 4
    // 实体 quad 顶点是「周边顺序」（vanilla ModelPart.Quad），须用 0,1,2 + 0,2,3 三角化
    // 才能让两个三角形绕向一致（否则其中一个三角形法线朝内、渲染发暗/消失）。
    indices[i * 6] = b; indices[i * 6 + 1] = b + 1; indices[i * 6 + 2] = b + 2
    indices[i * 6 + 3] = b; indices[i * 6 + 4] = b + 2; indices[i * 6 + 5] = b + 3
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  return new THREE.Mesh(geo, mat)
}

// 铜傀儡雕像：BER 绘制（无 JSON 模型），用铜傀儡实体模型渲染成缩小雕像。
// 实体模型约 1.5 格高，缩到 0.6 倍后脚底贴方块底部。返回的 mesh 前向为 +z。
export function buildCopperGolemStatueMesh(tex) {
  const model = EXTRA_MODELS.CopperGolemEntityModel
  if (!model || !tex) return null
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
  const mesh = quadsToEntityMesh(compileModel(model), mat)
  mesh.scale.setScalar(0.6)
  mesh.position.y = 0.05
  return mesh
}

// 生物实体 id -> [模型键, 贴图键]
const MOB_TABLE = {
  pig: ['PigEntityModel', 'entity/pig/pig_temperate'],
  cow: ['CowEntityModel', 'entity/cow/cow_temperate'],
  mooshroom: ['CowEntityModel', 'entity/cow/mooshroom_red'],
  sheep: ['SheepEntityModel', 'entity/sheep/sheep'],
  goat: ['GoatEntityModel', 'entity/goat/goat'],
  panda: ['PandaEntityModel', 'entity/panda/panda'],
  polar_bear: ['PolarBearEntityModel', 'entity/bear/polarbear'],
  wolf: ['WolfEntityModel', 'entity/wolf/wolf'],
  cat: ['Feline', 'entity/cat/cat_tabby'],
  ocelot: ['Feline', 'entity/cat/ocelot'],
  fox: ['FoxEntityModel', 'entity/fox/fox'],
  rabbit: ['AdultRabbitModel', 'entity/rabbit/rabbit_brown'],
  horse: ['Horse', 'entity/horse/horse_brown'],
  donkey: ['Horse', 'entity/horse/donkey'],
  mule: ['Horse', 'entity/horse/mule'],
  llama: ['LlamaEntityModel', 'entity/llama/llama_creamy'],
  turtle: ['TurtleEntityModel', 'entity/turtle/turtle'],
  chicken: ['ChickenEntityModel', 'entity/chicken/chicken_temperate'],
  frog: ['FrogEntityModel', 'entity/frog/frog_temperate'],
  axolotl: ['AxolotlEntityModel', 'entity/axolotl/axolotl_wild'],
  camel: ['CamelEntityModel', 'entity/camel/camel'],
  sniffer: ['SnifferEntityModel', 'entity/sniffer/sniffer'],
  armadillo: ['ArmadilloEntityModel', 'entity/armadillo/armadillo'],
  allay: ['AllayEntityModel', 'entity/allay/allay'],
  hoglin: ['HoglinEntityModel', 'entity/hoglin/hoglin'],
  zoglin: ['HoglinEntityModel', 'entity/hoglin/zoglin'],
  strider: ['StriderEntityModel', 'entity/strider/strider'],
  dolphin: ['DolphinEntityModel', 'entity/dolphin/dolphin'],
  squid: ['SquidEntityModel', 'entity/squid/squid'],
  glow_squid: ['SquidEntityModel', 'entity/squid/glow_squid'],
  cod: ['CodEntityModel', 'entity/fish/cod'],
  salmon: ['SalmonEntityModel', 'entity/fish/salmon'],
  pufferfish: ['MediumPufferfishEntityModel', 'entity/fish/pufferfish'],
  bat: ['BatEntityModel', 'entity/bat/bat'],
  parrot: ['ParrotEntityModel', 'entity/parrot/parrot_red_blue'],
  bee: ['BeeEntityModel', 'entity/bee/bee'],
  zombie: ['Biped', 'entity/zombie/zombie'],
  husk: ['Biped', 'entity/zombie/husk'],
  drowned: ['DrownedEntityModel', 'entity/zombie/drowned', 1, ['entity/zombie/drowned_outer_layer']],
  zombie_villager: ['ZombieVillagerEntityModel', 'entity/zombie_villager/zombie_villager'],
  skeleton: ['SkeletonEntityModel', 'entity/skeleton/skeleton'],
  stray: ['SkeletonEntityModel', 'entity/skeleton/stray', 1, ['entity/skeleton/stray_overlay']],
  bogged: ['BoggedEntityModel', 'entity/skeleton/bogged', 1, ['entity/skeleton/bogged_overlay']],
  wither_skeleton: ['SkeletonEntityModel', 'entity/skeleton/wither_skeleton'],
  creeper: ['CreeperEntityModel', 'entity/creeper/creeper'],
  spider: ['SpiderEntityModel', 'entity/spider/spider'],
  cave_spider: ['SpiderEntityModel', 'entity/spider/cave_spider'],
  enderman: ['EndermanEntityModel', 'entity/enderman/enderman'],
  witch: ['WitchEntityModel', 'entity/witch/witch'],
  blaze: ['BlazeEntityModel', 'entity/blaze/blaze'],
  ghast: ['GhastEntityModel', 'entity/ghast/ghast'],
  phantom: ['PhantomEntityModel', 'entity/phantom/phantom'],
  slime: ['SlimeEntityModel', 'entity/slime/slime'],
  magma_cube: ['MagmaCubeEntityModel', 'entity/slime/magmacube'],
  silverfish: ['SilverfishEntityModel', 'entity/silverfish/silverfish'],
  endermite: ['EndermiteEntityModel', 'entity/endermite/endermite'],
  shulker: ['ShulkerEntityModel', 'entity/shulker/shulker'],
  guardian: ['GuardianEntityModel', 'entity/guardian/guardian'],
  elder_guardian: ['GuardianEntityModel', 'entity/guardian/guardian_elder', 2.35],
  wither: ['WitherEntityModel', 'entity/wither/wither', 2],
  ravager: ['RavagerEntityModel', 'entity/illager/ravager'],
  vex: ['VexEntityModel', 'entity/illager/vex'],
  warden: ['WardenEntityModel', 'entity/warden/warden'],
  breeze: ['BreezeEntityModel', 'entity/breeze/breeze'],
  creaking: ['CreakingEntityModel', 'entity/creaking/creaking'],
  villager: ['Villager', 'entity/villager/villager'],
  wandering_trader: ['Villager', 'entity/wandering_trader/wandering_trader'],
  pillager: ['IllagerEntityModel', 'entity/illager/pillager'],
  vindicator: ['IllagerEntityModel', 'entity/illager/vindicator'],
  evoker: ['IllagerEntityModel', 'entity/illager/evoker'],
  illusioner: ['IllagerEntityModel', 'entity/illager/illusioner'],
  iron_golem: ['IronGolemEntityModel', 'entity/iron_golem/iron_golem'],
  snow_golem: ['SnowGolemEntityModel', 'entity/snow_golem/snow_golem'],
  piglin: ['Piglin', 'entity/piglin/piglin'],
  piglin_brute: ['Piglin', 'entity/piglin/piglin_brute'],
  zombified_piglin: ['Piglin', 'entity/piglin/zombified_piglin'],
  // 之前漏掉的实体（26.3 新增/旧实体）：
  ender_dragon: ['DragonEntityModel', 'entity/enderdragon/dragon'],
  happy_ghast: ['HappyGhastEntityModel', 'entity/ghast/happy_ghast'],
  copper_golem: ['CopperGolemEntityModel', 'entity/copper_golem/copper_golem'],
  tadpole: ['TadpoleEntityModel', 'entity/tadpole/tadpole'],
  tropical_fish: ['SmallTropicalFishEntityModel', 'entity/fish/tropical_a'],
  trader_llama: ['LlamaEntityModel', 'entity/llama/llama_creamy', 1, ['entity/equipment/llama_body/trader_llama']],
  skeleton_horse: ['Horse', 'entity/horse/horse_skeleton'],
  zombie_horse: ['Horse', 'entity/horse/horse_zombie'],
  giant: ['Biped', 'entity/zombie/zombie', 6],
}

// 生物实体：真实模型 + 皮肤贴图
async function buildMob(entity, id, assets) {
  const entry = MOB_TABLE[id]
  const model = entry ? (ENTITY_MODELS[entry[0]] || EXTRA_MODELS[entry[0]]) : null
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const yaw = Number(entity.rotation?.[0]) || 0

  const tex = entry ? await assets.getTexture(entry[1]) : null
  if (!model || !tex) return buildMobFallback(entity, id)

  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
  const quads = compileModel(model)
  group.add(quadsToEntityMesh(quads, mat))

  // 第二层贴图：叠在身体上的额外贴图层（如行商羊驼的地毯），透明部分不遮挡底层。
  // 用 polygonOffset 让叠层略向相机偏移，避免与底层共面时闪烁。
  const overlays = entry && entry[3]
  if (Array.isArray(overlays)) {
    for (const ovKey of overlays) {
      const ovTex = await assets.getTexture(ovKey)
      if (!ovTex) continue
      const ovMat = new THREE.MeshLambertMaterial({
        map: ovTex,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        flatShading: true,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      group.add(quadsToEntityMesh(quads, ovMat))
    }
  }

  const scale = (entry && entry[2]) || (model.scale) || 1
  if (scale !== 1) group.scale.setScalar(scale)

  group.position.set(x, y, z)
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}

// 兜底：未知生物用纯色通用四足形状
const MOB_COLORS = {
  pig: 0xf2a9a5, cow: 0x5a3a24, sheep: 0xe6e2d8, chicken: 0xf0efe6,
  horse: 0x8a5a2b, donkey: 0x7a6a55, mule: 0x5a4a38, llama: 0xb89a72,
  villager: 0x8a6a4a, wandering_trader: 0x4a6a8a, zombie: 0x5f8f5f,
  skeleton: 0xc8c4bc, creeper: 0x5fbf5f, spider: 0x2a2a2a,
  enderman: 0x1a1a2a, iron_golem: 0xb0a8a0, snow_golem: 0xf0f0f0,
  wolf: 0x8a8a8a, cat: 0xd8b078, rabbit: 0xd8c8b0, fox: 0xd97a2b,
  panda: 0x1a1a1a, polar_bear: 0xf0f0e8, bee: 0xf0c820, frog: 0x5a8a4a,
  goat: 0xe0d0c0, axolotl: 0xf0a0b0, turtle: 0x5a8a5a, dolphin: 0x8a9aa0,
}
function buildMobFallback(entity, id) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const yaw = Number(entity.rotation?.[0]) || 0
  const mat = new THREE.MeshLambertMaterial({ color: MOB_COLORS[id] || 0xa0806a })
  const add = (cx, cy, cz, w, h, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(cx, cy, cz)
    group.add(m)
  }
  add(0, 0.5, 0, 0.6, 0.4, 0.9)
  add(0, 0.6, 0.55, 0.4, 0.35, 0.35)
  for (const [lx, lz] of [[-0.22, -0.3], [-0.22, 0.3], [0.22, -0.3], [0.22, 0.3]]) add(lx, 0.175, lz, 0.15, 0.35, 0.15)
  group.position.set(x, y, z)
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}

// 船：硬编码船体 + 箱子（箱船）。船体用木色近似（原版是 skin 贴图，这里只求形状）。
async function buildBoat(entity, id, assets) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const yaw = Number(entity.rotation?.[0]) || 0
  // 类型从实体 id 推断（1.19+ 每种船/筏是独立实体类型，NBT 里不存 Type）：
  // oak_boat / oak_chest_boat / bamboo_raft / bamboo_chest_raft -> 木材类型
  const type =
    id.replace(/_chest_boat$/, '').replace(/_chest_raft$/, '').replace(/_boat$/, '').replace(/_raft$/, '') ||
    String(entity.nbt?.Type || 'oak').replace(/^minecraft:/, '')
  const isChest = id.includes('_chest_')
  const isRaft = id.includes('_raft')

  // 船体：BoatEntityModel（船底 + 四壁 + 双桨）/ RaftModel（平底木筏 + 双桨）+ 船皮贴图
  const model = isRaft ? EXTRA_MODELS.RaftModel : ENTITY_MODELS.BoatEntityModel
  const tex = await assets.getTexture('entity/boat/' + type)
  const hullMat = tex
    ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
    : new THREE.MeshLambertMaterial({ color: 0x8a6a45 })
  const hull = quadsToEntityMesh(compileModel(model), hullMat)
  // 编译后船体中心在局部 y≈1.406，下移使船体中心落在吃水线（实体 Pos）
  hull.position.set(0, -22.5 / 16, 0)
  group.add(hull)

  // 箱船：船体之上加箱子
  if (isChest) {
    const resolver = new BlockModelResolver(assets)
    const baked = await resolver.resolve('minecraft:chest', { type: 'single', facing: 'north' })
    if (baked && baked.quads && baked.quads.length) {
      const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
      const mats = new Map()
      await Promise.all(
        texKeys.map(async (tk) => {
          const tex = await assets.getTexture(tk)
          if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, flatShading: true }))
        }),
      )
      const chest = quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk))
      // 原版箱船的箱子是船模型里 12×12×12（0.75 方块）的 chest_bottom+chest_lid，中心在船体中心
      chest.scale.setScalar(0.75)
      chest.position.set(0, 0.28, 0)
      group.add(chest)
    }
  }

  group.position.set(x, y, z)
  // 船模型长度沿 X（front 在 +x），实体 yaw 0=南(+z)，故绕 Y 转 -(yaw+90°)
  group.rotation.y = -((yaw + 90) * Math.PI) / 180
  return group
}
