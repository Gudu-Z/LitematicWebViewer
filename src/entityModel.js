// 原版 ModelPart 几何、骨骼与透明面排序；坐标统一转换为预览器世界坐标。
import * as THREE from 'three'

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
  // Dilation 可把零宽盒膨胀成实体（如疣猪兽鬃毛）；只有实际共面时才去重。
  const flatX = x0 === x1, flatY = y0 === y1, flatZ = z0 === z1
  const FACES = [
    [['v5', 'v4', 'v0', 'v1'], [uN, vT, uE, vM], [0, -1, 0], flatX || flatY || flatZ], // 原版 Direction.DOWN
    [['v2', 'v3', 'v7', 'v6'], [uE, vM, uE2, vT], [0, 1, 0], flatX || flatZ], // 原版 Direction.UP
    [['v0', 'v4', 'v7', 'v3'], [u, vM, uN, vB], [-1, 0, 0], flatX || flatY || flatZ],
    [['v1', 'v0', 'v3', 'v2'], [uN, vM, uE, vB], [0, 0, -1], flatX || flatY || flatZ],
    [['v5', 'v1', 'v2', 'v6'], [uE, vM, uS, vB], [1, 0, 0], flatY || flatZ], // east(+x)
    [['v4', 'v5', 'v6', 'v7'], [uS, vM, uS2, vB], [0, 0, 1], flatX || flatY], // south(+z)
  ]
  // 平面（某维度为 0）的“背面”采样与“正面”相同的 UV，避免背面空白（如炽足兽刚毛、沼泽骷髅蘑菇）。
  // 跳过重合面以避免 z-fighting，也跳过面积为零的侧面，避免蒙皮浮点误差产生边缘杂线。
  // 保留面的顶点顺序与原面相反：Y 平面重排 V（如末影龙翼膜），Z/X 平面重排 U。
  if (flatY) FACES[1][1] = [uN, vM, uE, vT]
  if (flatZ) FACES[5][1] = [uE, vM, uN, vB]
  if (flatX) FACES[4][1] = [uN, vM, u, vB]
  const out = []
  for (const [idx, [u1, v1, u2, v2], dir, skip] of FACES) {
    if (skip) continue
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
export function compileModel(model, includeParts = false) {
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
          const quad = { verts, uvs: face.uvs, normal: [nd[0], -nd[1], -nd[2]] }
          if (includeParts) quad.part = p
          quads.push(quad)
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

// Three 默认把骨骼 matrixWorld 转成 float32，再在 shader 中消去实体世界变换。
// 这会在大坐标处丢失模型的小数（甚至压扁模型）。原版先以 double 计算实体与相机
// 的相对位置，ModelPart 始终在局部空间计算；这里同样不把世界坐标放进骨骼纹理。
class EntitySkeleton extends THREE.Skeleton {
  constructor(bones) {
    super(bones)
    const indices = new Map(bones.map((bone, index) => [bone, index]))
    this.parentIndices = bones.map(bone => indices.get(bone.parent) ?? -1)
    this.modelMatrices = bones.map(() => new THREE.Matrix4())
    this.offsetMatrix = new THREE.Matrix4()
  }

  update() {
    // createEntityRig 按父先子后的顺序创建骨骼；只累乘骨骼本身，不包含网格或实体的变换。
    for (let i = 0; i < this.bones.length; i++) {
      const matrix = this.modelMatrices[i].copy(this.bones[i].matrix)
      const parent = this.parentIndices[i]
      if (parent >= 0) matrix.premultiply(this.modelMatrices[parent])
      this.offsetMatrix.multiplyMatrices(matrix, this.boneInverses[i]).toArray(this.boneMatrices, i * 16)
    }
    if (this.boneTexture) this.boneTexture.needsUpdate = true
  }
}

class EntitySkinnedMesh extends THREE.SkinnedMesh {
  // CPU 包围盒、拾取、透明面排序也使用局部蒙皮。每个顶点仅绑定一个 ModelPart，
  // 权重恒为 1；骨骼仍留在场景树中，手持物和头部附件继续继承完整的世界变换。
  applyBoneTransform(index, target) {
    const boneIndex = this.geometry.attributes.skinIndex.getX(index)
    target.applyMatrix4(this.skeleton.boneInverses[boneIndex])
    for (let bone = this.skeleton.bones[boneIndex]; bone && bone !== this; bone = bone.parent) {
      target.applyMatrix4(bone.matrix)
    }
    return target
  }
}

// 每个原版 ModelPart 对应一根骨骼，每个顶点只受所属部件影响。
// 保留一层一个 draw call；动画只更新骨骼矩阵，不重建几何或材质。
export function createEntityRig(model, material) {
  const quads = compileModel(model, true)
  const geometry = quadsToEntityMesh(quads, material).geometry
  const root = new THREE.Bone()
  root.position.y = 24 / 16
  root.scale.set(1 / 16, -1 / 16, -1 / 16)
  const bones = [root]
  const parts = {}
  const indices = new Map()
  const walk = (nodes, parent) => {
    for (const [name, node] of Object.entries(nodes)) {
      const bone = new THREE.Bone()
      bone.name = name
      bone.position.fromArray(node.pivot || [0, 0, 0])
      bone.rotation.set(...(node.rot || [0, 0, 0]), 'ZYX')
      bone.userData.restPosition = bone.position.clone()
      bone.userData.restRotation = bone.rotation.clone()
      indices.set(node, bones.length)
      bones.push(bone)
      parts[name] = bone
      parent.add(bone)
      walk(node.children || {}, bone)
    }
  }
  walk(model.parts, root)
  const skinIndices = new Uint16Array(quads.length * 16)
  const skinWeights = new Float32Array(quads.length * 16)
  for (let i = 0; i < quads.length; i++) {
    for (let k = 0; k < 4; k++) {
      skinIndices[i * 16 + k * 4] = indices.get(quads[i].part)
      skinWeights[i * 16 + k * 4] = 1
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))
  const mesh = new EntitySkinnedMesh(geometry, material)
  // 在原点绑定，bindMatrix 与 bindMatrixInverse 保持单位矩阵。世界变换由 Three
  // 的 modelViewMatrix 在双精度中合并相机变换后，再交给 GPU。
  mesh.bindMode = THREE.DetachedBindMode
  mesh.add(root)
  mesh.bind(new EntitySkeleton(bones))
  mesh.computeBoundingSphere()
  // 待机摆动可越出绑定姿态，留出局部空间余量，避免边缘部件被误剔除。
  mesh.boundingSphere.radius += 1.5
  mesh.userData.parts = parts
  mesh.userData.resetPose = () => {
    for (let i = 1; i < bones.length; i++) {
      const bone = bones[i]
      bone.position.copy(bone.userData.restPosition)
      bone.rotation.copy(bone.userData.restRotation)
      bone.scale.setScalar(1)
    }
  }
  geometry.addEventListener('dispose', () => mesh.skeleton.dispose())
  return mesh
}

// 原版透明层逐 quad 排序；Three.js 仅排序整个对象，故独立重排索引。
export function sortTransparentFaces(mesh) {
  const faces = Array.from({ length: mesh.geometry.index.count / 6 }, (_, index) => ({ index, distance: 0 }))
  const cameraPosition = new THREE.Vector3()
  const center = new THREE.Vector3()
  const opposite = new THREE.Vector3()
  return camera => {
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    for (const face of faces) {
      mesh.getVertexPosition(face.index * 4, center)
      mesh.getVertexPosition(face.index * 4 + 2, opposite)
      center.add(opposite).multiplyScalar(0.5).applyMatrix4(mesh.matrixWorld)
      face.distance = center.distanceToSquared(cameraPosition)
    }
    faces.sort((a, b) => b.distance - a.distance || a.index - b.index)
    const indices = mesh.geometry.index
    for (let i = 0; i < faces.length; i++) {
      const b = faces[i].index * 4, offset = i * 6
      indices.array[offset] = b; indices.array[offset + 1] = b + 1; indices.array[offset + 2] = b + 2
      indices.array[offset + 3] = b; indices.array[offset + 4] = b + 2; indices.array[offset + 5] = b + 3
    }
    indices.needsUpdate = true
  }
}
