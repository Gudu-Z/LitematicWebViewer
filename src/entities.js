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

// display.fixed 旋转 [x,y,z]（度）→ 四元数。Minecraft 的显示变换按 X→Y→Z 依次左乘，
// 即先绕 Z 再绕 Y 再绕 X；这里 q = Qx·Qy·Qz 复现之（对仅单轴的 [0,90,0]/[0,180,0] 无歧义）。
function fixedRotQuaternion(rot) {
  const [x, y, z] = (rot || [0, 0, 0]).map((d) => (Number(d) || 0) * DEG)
  const q = new THREE.Quaternion()
  if (x) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x))
  if (y) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y))
  if (z) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z))
  return q
}
// 2D 物品/头颅/时钟等 item 模型 fixed 显示旋转均为 [0,180,0]
const Q_FLIP = fixedRotQuaternion([0, 180, 0])

// 旗帜 16 色染料（与 renderer.js 的 DYE_COLORS 一致），用于给展示框里旗帜的旗面底色上色。
const DYE_COLORS = {
  white: '#ffffff', orange: '#ff681f', magenta: '#c74ebd', light_blue: '#3ab3da',
  yellow: '#fed83d', lime: '#80c71f', pink: '#f38baa', gray: '#474f52',
  light_gray: '#9d9d97', cyan: '#169c9c', purple: '#8932b8', blue: '#3c44aa',
  brown: '#835432', green: '#5e7c16', red: '#b02e26', black: '#000000',
}

// 把 items/NAME.json 的 model 定义解析成「fixed 展示（默认）状态」的模型列表。
// 返回 [{ path: "block/xxx"|"item/xxx", transform: {translation,scale,...}|null }]。
// 各类解析为默认分支：composite 拆成多个（如床的 head+foot）；condition 取 on_false；
// range_dispatch 取 fallback；select 取 fixed/gui/ground 的 case，否则 fallback；
// special（箱子/头颅/旗帜等）返回空，交由 SPECIAL_MODELS 处理。
// 注意 composite 的 transformation.translation 单位是「方块」（床 foot 偏移 [0,0,1] 即 1 格），
// 与 display 变换的 translation（单位像素 1/16）不同。
function resolveItemModelDef(def, out = []) {
  if (!def || typeof def !== 'object') return out
  const t = def.type
  if (t === 'minecraft:model') {
    if (typeof def.model === 'string') out.push({ path: def.model.replace(/^minecraft:/, ''), transform: def.transformation || null })
    return out
  }
  if (t === 'minecraft:composite') {
    for (const m of def.models || []) resolveItemModelDef(m, out)
    return out
  }
  if (t === 'minecraft:condition') return resolveItemModelDef(def.on_false, out)
  if (t === 'minecraft:range_dispatch') return resolveItemModelDef(def.fallback, out)
  if (t === 'minecraft:select') {
    const cases = def.cases || []
    for (const c of cases) {
      const w = c.when
      const list = Array.isArray(w) ? w : [w]
      if (list.includes('fixed') || list.includes('gui') || list.includes('ground')) return resolveItemModelDef(c.model, out)
    }
    return resolveItemModelDef(def.fallback, out)
  }
  return out
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

  // 内部物品：框口 0.4375 处，绕框法线按 ItemRotation × 45° 旋转。
  // 框模型（template_item_frame）正面是 −z（+z 贴墙）。物品模型的 display.fixed 显示旋转
  // （2D 物品/头颅 [0,180,0]，方块多为 [0,0,0]，铁砧 [0,90,0]，床 [270,180,0]）在框旋转之后、
  // 绕法线旋转之前应用，故 quaternion = q · fixedRot · qz；display.fixed 平移（单位方块，如床
  // [0,4,-2]px）加在框口偏移上再随框旋转。buildFrameItem 把这两者存进 userData.fixedRot/fixedTrans。
  const item = entity.nbt?.Item
  if (item && item.id) {
    const itemMesh = await buildFrameItem(item, resolver, assets)
    if (itemMesh) {
      const rot = Number(entity.nbt?.ItemRotation) || 0
      const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot * 45 * DEG)
      const fixedRot = itemMesh.userData.fixedRot || null
      const fixedTrans = itemMesh.userData.fixedTrans || null
      // 原版 ItemFrameRenderer 顺序：T(0,0,0.4375) → Rz(itemRot) → S(0.5) → display 变换
      // （T(trans/16) → R(displayRot) → S(displayScale)）→ T(-0.5) 居中。框体缩放 0.5 会把 display
      // 平移一起缩 0.5（S(0.5)·T(t)=T(0.5t)·S(0.5)），故 display 平移在框局部系里是 0.5·trans，
      // 再被 Rz(itemRot) 旋转；旋转顺序是 Rz(itemRot)·R(displayRot)，不是 displayRot·Rz。
      const local = new THREE.Vector3(0, 0, 0.4375)
      if (fixedTrans) {
        const t = new THREE.Vector3(fixedTrans[0], fixedTrans[1], fixedTrans[2]).multiplyScalar(0.5)
        local.add(t.applyQuaternion(qz))
      }
      itemMesh.position.copy(anchor).add(local.applyQuaternion(q))
      itemMesh.quaternion.copy(q)
      itemMesh.quaternion.multiply(qz)
      if (fixedRot) itemMesh.quaternion.multiply(fixedRot)
      group.add(itemMesh)
    }
  }

  return group
}

// 方块物品解析用的默认属性。
// 按展示框里游戏内的实际朝向（对游戏实测）：facing 类默认 north（熔炉/发射器/投掷器/木桶/箱子等，
// 正面朝观察者），例外：观察者=south、避雷针/末地烛/活塞=up（活塞头朝上）、漏斗=down、
// 楼梯/铁砧=east（侧面朝相机）；合成器用 orientation=north_up。轴类 axis=y、楼梯 half=bottom/shape=straight 等。
// multipart 方块（墙/栅栏/玻璃板/铁栏杆等）需还原「孤立默认状态」——核心立柱可见、四周无连接。
async function defaultItemProps(name, assets) {
  const bs = await assets.getJSON('blockstates/' + name + '.json')
  if (!bs) return {}
  if (!bs.multipart) {
    const firstKey = Object.keys(bs.variants || {})[0] || ''
    const props = {}
    for (const kv of firstKey.split(',')) {
      const [k, v] = kv.split('=')
      if (!k) continue
      if (k === 'facing') props[k] =
        name === 'observer' ? 'south' :
        name.endsWith('lightning_rod') || name === 'end_rod' || name === 'piston' || name === 'sticky_piston' ? 'up' :
        name === 'hopper' ? 'down' :
        name.endsWith('_stairs') || name === 'anvil' ? 'east' :
        'north'
      else if (k === 'orientation') props[k] = 'north_up' // 合成器（1.21 orientation 属性）默认 north_up
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
      // 药水/药水箭等有两层贴图：layer1 是着色层（药水液体），叠一层并用药水颜色染色。
      // 液体画在玻璃（layer0）上层，玻璃透明处透出液体。
      const layer1 = itemModel?.textures?.layer1
      if (layer1) {
        const tex1Key = String(layer1).replace(/^minecraft:/, '')
        const tex1 = await assets.getTexture(tex1Key)
        if (tex1) {
          const pc = Number(item?.tag?.CustomPotionColor)
          const color = Number.isFinite(pc) && pc !== 0
            ? new THREE.Color((pc >>> 0) & 0xffffff)
            : new THREE.Color(0x385dc6) // 默认水/普通药水蓝色
          const mat1 = new THREE.MeshLambertMaterial({ map: tex1, color, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
          const q1 = new THREE.Mesh(quadGeometry(1, 1), mat1)
          q1.position.z = 0.001 // 稍靠前，避免与 layer0 z-fighting
          holder.add(q1)
        }
      }
      holder.scale.setScalar(0.5)
      holder.userData.fixedRot = Q_FLIP
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
      holder.userData.fixedRot = Q_FLIP
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
        holder.userData.fixedRot = Q_FLIP
        return holder
      }
    }
  }

  // 方块物品：3D 方块模型（原版展示框 scale 0.5 = 8px，方块是 3D 立方体显得偏大，这里用 0.4 略缩）。
  // 26.3 的物品模型定义在 items/NAME.json，指向具体的方块模型（如 block/piston_inventory、
  // block/anvil），其几何朝向与 display.fixed 变换是烘焙好的——和 blockstate 的 registerDefaultState
  // 无关。这里直接解析该模型并应用 display.fixed（旋转+平移）；composite（床=头+脚）拆成多个
  // 子模型分别烘焙后按子模型 translation 偏移合并、整体居中。
  const itemDef = await assets.getJSON('items/' + name + '.json')
  const modelDefs = resolveItemModelDef(itemDef?.model)
  let baked = null
  let fixedRot = null
  let fixedTrans = null
  let fixedScale = null
  if (modelDefs.length) {
    const parts = []
    let fixed = null
    for (const md of modelDefs) {
      const model = await resolver.loadModel(md.path)
      if (model && model.elements) {
        const b = bakeModel(model, { x: 0, y: 0 })
        if (b && b.quads && b.quads.length) {
          const tr = md.transform?.translation || [0, 0, 0]
          parts.push({ quads: b.quads, ox: Number(tr[0]) || 0, oy: Number(tr[1]) || 0, oz: Number(tr[2]) || 0 })
          if (!fixed && model.display?.fixed) fixed = model.display.fixed
        }
      }
    }
    if (parts.length) {
      const quads = []
      // 原版 ItemTransform.apply 对每个子模型（composite 里的每个 minecraft:model）都独立做
      // translate(-0.5,-0.5,-0.5) 整方块居中，再叠加 composite 的 transformation.translation（床 foot 的
      // [0,0,1]）。因此床是 head 居中在原点、foot 再 +1z（整体中心在 z=+0.5），而不是把 head+foot
      // 合并成一个包围盒后整体居中（那会把床往 head 方向错移半格）。这里逐子模型：
      // offset = 复合平移 + (-0.5,-0.5,-0.5)，不再二次居中。
      for (const p of parts) for (const q of p.quads) quads.push({ ...q, verts: q.verts.map((v) => [v[0] + p.ox - 0.5, v[1] + p.oy - 0.5, v[2] + p.oz - 0.5]) })
      baked = { quads, center: [0, 0, 0] }
      if (fixed) {
        fixedRot = fixedRotQuaternion(fixed.rotation)
        const t = fixed.translation || [0, 0, 0]
        fixedTrans = [Number(t[0]) / 16, Number(t[1]) / 16, Number(t[2]) / 16]
        fixedScale = fixed.scale || null
      }
    }
  }
  if (!baked || !baked.quads || !baked.quads.length) {
    // 特殊方块（箱子/头颅/旗帜/潜影盒/装饰罐等 BER，无 JSON 几何）走 SPECIAL_MODELS
    const props = await defaultItemProps(name, assets)
    baked = await resolver.resolve('minecraft:' + name, props)
    fixedRot = name.endsWith('_head') || name.endsWith('_skull') || name === 'shield' || name === 'conduit' || name.endsWith('_banner') ? Q_FLIP : null
    // 潮涌核心 items/conduit.json 的 display.fixed 缩放是 [1,1,1]（不缩），总缩放 = 框体 0.5 × 1。
    // 这里显式给 fixedScale，否则走 fixedScale=null 的 0.4 兜底会偏小约 20%。
    if (name === 'conduit') fixedScale = [1, 1, 1]
    // 盾牌 models/item/shield.json 的 display.fixed：rotation [0,180,0]、translation [-4.5,4.5,-5]px、
    // scale [0.55,0.55,0.55]。fixedTrans 存原值（块单位），buildItemFrame 会乘 0.5 框体缩放。
    if (name === 'shield') {
      fixedScale = [0.55, 0.55, 0.55]
      fixedTrans = [-4.5 / 16, 4.5 / 16, -5 / 16]
    }
    // 旗帜 items/*_banner.json 的 special transformation：scale (2/3,−2/3,−2/3)、translation [0.5,0,0.5]，
    // 与 display.fixed scale 0.5 合并 = 1/3（反射已烘进几何）；translation 与居中 translate(-0.5) 合并后
    // 净平移为 (0,−0.25,0)。
    if (name.endsWith('_banner')) {
      fixedScale = [1 / 3, 1 / 3, 1 / 3]
      fixedTrans = [0, -0.25, 0]
    }
    // 龙首 display.fixed 缩放 1（不缩，0.75 已烘进几何），translation [0,4,0] 与居中合并后净平移 (0,−0.25,0)。
    if (name === 'dragon_head' || name === 'dragon_wall_head') {
      fixedScale = [1, 1, 1]
      fixedTrans = [0, -0.25, 0]
    }
  }
  if (baked && baked.quads && baked.quads.length) {
    const texKeys = [...new Set(baked.quads.map((q) => q.texKey))]
    const mats = new Map()
    // 旗帜旗面（entity/banner/base 灰度遮罩）按底色上色
    const bannerColor = name.endsWith('_banner') || name.endsWith('_wall_banner')
      ? DYE_COLORS[name.replace(/_wall_banner$/, '').replace(/_banner$/, '')]
      : null
    await Promise.all(
      texKeys.map(async (tk) => {
        const tex = await assets.getTexture(tk)
        // DoubleSide：玻璃/植物等十字模型与透明方块背面也要可见（原版 cutout 不剔除背面）
        if (tex) {
          const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
          if (bannerColor && tk === 'entity/banner/base') mat.color = new THREE.Color(bannerColor)
          mats.set(tk, mat)
        }
      }),
    )
    const center = baked.center || [-0.5, -0.5, -0.5]
    holder.add(quadsToMesh(baked.quads, center, (tk) => mats.get(tk)))
    // 展示框物品总缩放 = 框体 0.5 × 模型 display.fixed 缩放（方块/床/铁砧等 0.5 → 0.25；头颅/盾牌等 1 → 0.5）。
    // 特殊 BER 方块（SPECIAL_MODELS）几何已按原版外观手工定死，fixedScale 为 null 时保持 0.4 略缩。
    const fs = fixedScale || [1, 1, 1]
    const base = fixedScale ? 0.5 : 0.4
    holder.scale.set((Number(fs[0]) || 1) * base, (Number(fs[1]) || 1) * base, (Number(fs[2]) || 1) * base)
    holder.userData.fixedRot = fixedRot
    holder.userData.fixedTrans = fixedTrans || null
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
    holder.userData.fixedRot = Q_FLIP
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
