// 实体渲染：把 .litematica 里的实体转成 Three.js 网格。
// 目前支持：item_frame / glow_item_frame（物品展示框）、*_minecart（矿车，含漏斗矿车）。
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

// 读取方块模型链里继承的 "fixed" 显示缩放：block/block.json 为 0.5（立方体方块），
// 独立模型（墙柱/火把/十字植物等）没有此字段 → 1。
async function blockFixedScale(name, assets) {
  const bs = await assets.getJSON('blockstates/' + name + '.json')
  let modelPath = null
  if (bs?.variants) {
    const keys = Object.keys(bs.variants)
    let entry = bs.variants['']
    if (!entry) entry = bs.variants[keys.find((k) => k)]
    const v = Array.isArray(entry) ? entry[0] : entry
    if (typeof v === 'string') modelPath = v
    else if (v?.model) modelPath = v.model
  } else if (bs?.multipart) {
    const part = bs.multipart.find((p) => p.apply?.model)
    modelPath = part?.apply?.model
  }
  if (!modelPath) return 1
  const seen = new Set()
  let cur = String(modelPath).replace(/^minecraft:/, '')
  for (let d = 0; d < 8 && cur && !seen.has(cur); d++) {
    seen.add(cur)
    const m = await assets.getJSON('models/' + cur + '.json')
    if (!m) break
    const s = m.display?.fixed?.scale
    if (Array.isArray(s) && s.length) return s[0]
    if (typeof s === 'number') return s
    cur = (m.parent || '').replace(/^minecraft:/, '')
  }
  return 1
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

  // 方块物品：3D 方块模型，缩放 = 框体 0.5 × 模型链的 fixed 缩放（立方体 0.25，墙柱/植物 0.5）
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
    const fixedScale = await blockFixedScale(name, assets)
    holder.scale.setScalar(0.5 * fixedScale)
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

// 矿车：车身 + 4 轮（+ 漏斗）
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
  }

  // 朝向：Minecraft yaw 与 Three.js rotation.y 方向相反
  group.rotation.y = -(yaw * Math.PI) / 180
  return group
}
