import * as THREE from 'three'
import { compileModel, quadsToEntityMesh } from './entityModel.js'

export const CUSHION_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// Minecraft 26.3 Cushion 的小写 color 字段使用 DyeColor.CODEC，缺省为白色。
// https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/world/entity/decoration/cushion/
export function cushionColor(nbt = {}) {
  return CUSHION_COLORS.includes(nbt.color) ? nbt.color : 'white'
}

// 原版 CushionModel.createBodyLayer：保留 pivot、UV 和 -0.005 像素收缩，避免贴面闪烁。
// https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/object/cushion/cushionmodel/
const MODEL = { w: 64, h: 64, parts: {
  cushion: { pivot: [23, 4, -7], cuboids: [
    { u: 0, v: 0, x: -31, y: -4, z: -1, dx: 16, dy: 4, dz: 16, dil: [-.005, -.005, -.005] },
  ] },
} }

// https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/entity/cushionrenderer/
export async function buildCushion(entity, assets) {
  const color = cushionColor(entity.nbt)
  const texture = await assets.getTexture('entity/cushion/' + color + '_cushion')
  const material = new THREE.MeshLambertMaterial({ map: texture, alphaTest: .1, side: THREE.DoubleSide })
  const mesh = quadsToEntityMesh(compileModel(MODEL), material)
  // 按实际三角形绕向生成法线，保证坐垫上表面朝上受光。
  mesh.geometry.computeVertexNormals()
  mesh.name = 'cushion'
  // compileModel 已做 Rx(180°) 和 y + 24/16；原版渲染器只需 y + 4/16。
  mesh.position.y = -20 / 16
  const group = new THREE.Group()
  group.add(mesh)
  group.position.fromArray(entity.pos)
  // Direction.fromYRot 将任意实体 yaw 取到最近的水平朝向，再应用 180° - toYRot。
  const direction = Math.floor((Number(entity.rotation?.[0]) || 0) / 90 + .5)
  group.rotation.y = (180 - direction * 90) * Math.PI / 180
  return group
}
