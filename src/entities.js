// 实体渲染：把 .litematica 里的实体转成 Three.js 网格。
// 目前支持：item_frame / glow_item_frame（物品展示框）、*_minecart（矿车，含漏斗矿车）。
// 说明：矿车在 Minecraft 中没有 JSON 模型（Java 硬编码），故用硬编码盒体 + 真实贴图近似；
// 物品展示框用方块贴图近似。

import * as THREE from 'three'

// Minecraft Direction 枚举：Facing 字节 -> 方向向量
const FACING_DIRS = {
  0: [0, -1, 0], // down
  1: [0, 1, 0], // up
  2: [0, 0, -1], // north
  3: [0, 0, 1], // south
  4: [-1, 0, 0], // west
  5: [1, 0, 0], // east
}

function orientTo(dir) {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
}

function shortName(id) {
  return (id || '').replace(/^minecraft:/, '')
}

// 把实体转成网格；不支持的实体返回 null
export async function buildEntityMesh(entity, assets) {
  const id = shortName(entity.id)
  if (id === 'item_frame' || id === 'glow_item_frame') {
    return buildItemFrame(entity, assets)
  }
  if (id.endsWith('_minecart')) {
    return buildMinecart(entity, id, assets)
  }
  return null
}

// 物品展示框：平面画框 + 内部物品
async function buildItemFrame(entity, assets) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const facing = FACING_DIRS[entity.nbt?.Facing] || [0, 0, -1]
  const dir = new THREE.Vector3(...facing)
  const quat = orientTo(dir)

  // 背板（木板近似）
  const backTex = await assets.getTexture('block/oak_planks')
  const backMat = new THREE.MeshLambertMaterial({ map: backTex || null })
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backMat)
  back.position.set(x, y, z)
  back.setRotationFromQuaternion(quat)
  group.add(back)

  // 内部物品（贴图依次尝试 item/、block/、entity/）
  const item = entity.nbt?.Item
  if (item && item.id) {
    const name = shortName(item.id)
    const itemTex =
      (await assets.getTexture('item/' + name)) ||
      (await assets.getTexture('block/' + name)) ||
      (await assets.getTexture('entity/' + name))
    if (itemTex) {
      const itemMat = new THREE.MeshLambertMaterial({ map: itemTex, alphaTest: 0.5 })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), itemMat)
      plane.position.set(x + dir.x * 0.01, y + dir.y * 0.01, z + dir.z * 0.01)
      plane.setRotationFromQuaternion(quat)
      group.add(plane)
    }
  }

  return group
}

// 矿车：车身 + 4 轮（+ 漏斗）
async function buildMinecart(entity, id, assets) {
  const group = new THREE.Group()
  const [x, y, z] = entity.pos
  const yaw = Number(entity.rotation?.[0]) || 0

  const bodyTex = await assets.getTexture('entity/minecart') // 所有矿车共用同一车身贴图
  const bodyMat = new THREE.MeshLambertMaterial({ map: bodyTex || null })
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
