// 实体渲染：把 .litematica 里的实体转成 Three.js 网格。
// 目前支持：item_frame / glow_item_frame（物品展示框）、*_minecart（矿车，含漏斗/箱子/熔炉/TNT）、
// armor_stand（盔甲架）。
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
export async function buildEntityMesh(entity, assets) {
  const id = shortName(entity.id)
  if (id === 'item_frame' || id === 'glow_item_frame') {
    return buildItemFrame(entity, id, assets)
  }
  if (id.endsWith('_minecart')) {
    return buildMinecart(entity, id, assets)
  }
  if (id === 'armor_stand') {
    return buildArmorStand(entity, assets)
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
        if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 }))
      }),
    )
    const frame = quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk))
    frame.position.copy(anchor)
    frame.quaternion.copy(q)
    group.add(frame)
  }

  // 内部物品：框口 0.4375 处，缩放 0.5（8px），绕框法线按 ItemRotation × 45° 旋转
  const item = entity.nbt?.Item
  if (item && item.id) {
    const itemMesh = await buildFrameItem(item, resolver, assets)
    if (itemMesh) {
      const rot = Number(entity.nbt?.ItemRotation) || 0
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot * 45 * DEG)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
      itemMesh.position.copy(anchor).addScaledVector(forward, 0.4375)
      itemMesh.quaternion.copy(q).multiply(qz)
      group.add(itemMesh)
    }
  }

  return group
}

// 方块物品解析用的默认属性。
// 普通（variants）方块传 axis:y（轴类方块正立）；multipart 方块（墙/栅栏/玻璃板/铁栏杆等）
// 需还原其「默认状态」——即核心立柱可见、四周无连接，否则没有任何部件匹配（得到空模型）。
async function defaultItemProps(name, assets) {
  const bs = await assets.getJSON('blockstates/' + name + '.json')
  if (!bs || !bs.multipart) return { axis: 'y' }
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
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide })
      holder.add(new THREE.Mesh(quadGeometry(1, 1), mat))
      holder.scale.setScalar(0.5)
      return holder
    }
  }

  // 方块物品：3D 方块模型，统一缩放 0.25（4px）
  const props = await defaultItemProps(name, assets)
  const baked = await resolver.resolve('minecraft:' + name, props)
  if (baked && baked.quads && baked.quads.length) {
    const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
    const mats = new Map()
    await Promise.all(
      texKeys.map(async (tk) => {
        const tex = await assets.getTexture(tk)
        // DoubleSide：玻璃/植物等十字模型与透明方块背面也要可见（原版 cutout 不剔除背面）
        if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }))
      }),
    )
    holder.add(quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk)))
    holder.scale.setScalar(0.25)
    return holder
  }

  // 兜底：贴图平面
  const tex =
    (await assets.getTexture('item/' + name)) ||
    (await assets.getTexture('block/' + name)) ||
    (await assets.getTexture('entity/' + name))
  if (tex) {
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide })
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
// 的盒体尺寸/位置/UV 复现，用 bakeModel 烘焙 + entity/armorstand/wood.png 贴图。
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

  const baked = bakeModel({ textures: { all: 'entity/armorstand/wood' }, elements }, {}, 64)
  const tex = await assets.getTexture('entity/armorstand/wood')
  const mat = tex
    ? new THREE.MeshLambertMaterial({ map: tex })
    : new THREE.MeshLambertMaterial({ color: 0x9c7a4d })
  group.add(quadsToMesh(baked.quads, [0, 0, 0], () => mat))

  if (small) group.scale.setScalar(0.5)

  group.position.set(x, y, z)
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}

// 矿车：车身 + 4 轮（+ 漏斗/箱子/熔炉/TNT）
async function buildMinecart(entity, id, assets) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const yaw = Number(entity.rotation?.[0]) || 0

  // 车身用纯色（矿车贴图是 2:1 图集，直接贴到盒体会拉伸，这里简化为铁灰色）
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x7a7a7a })
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.7, 0.98), bodyMat)
  body.position.set(x, y, z)
  group.add(body)

  const wheelGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16)
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
  for (const [wx, wz] of [[0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat)
    wheel.position.set(x + wx, y - 0.43, z + wz)
    group.add(wheel)
  }

  if (id === 'hopper_minecart') {
    const hopperTex = await assets.getTexture('block/hopper_outside')
    const hopperMat = new THREE.MeshLambertMaterial({ map: hopperTex || null })
    const hopper = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), hopperMat)
    hopper.position.set(x, y + 0.55, z)
    group.add(hopper)
  } else if (id === 'chest_minecart' || id === 'furnace_minecart' || id === 'tnt_minecart') {
    // 顶部内容：箱子/熔炉/TNT 用方块模型，缩放 0.5 放在车身之上
    const resolver = new BlockModelResolver(assets)
    const [name, props] =
      id === 'chest_minecart'
        ? ['minecraft:chest', { type: 'single', facing: 'north' }]
        : id === 'furnace_minecart'
          ? ['minecraft:furnace', { facing: 'north', lit: 'false' }]
          : ['minecraft:tnt', {}]
    const baked = await resolver.resolve(name, props)
    if (baked && baked.quads && baked.quads.length) {
      const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
      const mats = new Map()
      await Promise.all(
        texKeys.map(async (tk) => {
          const tex = await assets.getTexture(tk)
          if (tex) mats.set(tk, new THREE.MeshLambertMaterial({ map: tex }))
        }),
      )
      const content = quadsToMesh(baked.quads, [-0.5, -0.5, -0.5], (tk) => mats.get(tk))
      content.scale.setScalar(0.5)
      content.position.set(x, y + 0.55, z)
      group.add(content)
    }
  }

  // 朝向：Minecraft yaw 与 Three.js rotation.y 方向相反
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}
