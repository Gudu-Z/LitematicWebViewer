// 旋风人：验证原版外层的尺寸/UV、透明面排序及贴图隔离与缺失回退。
// 用法：node scripts/verify-breeze.mjs
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildEntityMesh, compileModel } from '../src/entities.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'

const quads = compileModel(EXTRA_MODELS.BreezeWindEntityModel)
assert.equal(quads.length, 42, '旋风应有 7 个盒体、42 个面')
// BreezeEntityModel.createModelData 的累积坐标转换到世界空间（模型像素）。
const bounds = [
  [-2.5, 0, -2.5, 2.5, 7, 2.5],
  [-6, 7, -6, 6, 13, 6],
  [-4, 7, -4, 4, 13, 4],
  [-2.5, 7, -2.5, 2.5, 13, 2.5],
  [-9, 13, -9, 9, 21, 9],
  [-6, 13, -6, 6, 21, 6],
  [-2.5, 13, -2.5, 2.5, 21, 2.5],
]
for (let i = 0; i < bounds.length; i++) {
  const box = new THREE.Box3().setFromPoints(quads.slice(i * 6, i * 6 + 6)
    .flatMap(q => q.verts.map(v => new THREE.Vector3(...v).multiplyScalar(16))))
  assert.deepEqual([...box.min.toArray(), ...box.max.toArray()], bounds[i])
}
// 顶层外壳的正面位于 z=9px，取 128×128 贴图的 [18,18]..[36,26]。
const front = quads.find(q => q.verts.every(v => v[2] === 9 / 16))
assert.deepEqual(front.uvs.map(uv => uv.map(v => v * 128)), [[36, 18], [18, 18], [18, 26], [36, 26]])

const skin = new THREE.Texture()
const windTexture = new THREE.Texture()
const requests = []
const assets = {
  async getTexture(key) {
    requests.push(key)
    return key === 'entity/breeze/breeze_wind' ? windTexture : skin
  },
}
const entity = { id: 'minecraft:breeze', pos: [12, 7, -3], rotation: [90, 0], nbt: { Health: 30 } }
const originalNow = performance.now
let time = 1000
performance.now = () => time
try {
  const group = await buildEntityMesh(entity, assets)
  const wind = group.getObjectByName('breeze_wind')
  assert.ok(wind, 'buildEntityMesh 应挂载外层')
  assert.deepEqual(group.position.toArray(), entity.pos)
  assert.equal(group.rotation.y, -Math.PI / 2)
  assert.equal(wind.geometry.index.count, 42 * 6)
  assert.ok(wind.material.isMeshBasicMaterial)
  assert.equal(wind.material.transparent, true)
  assert.equal(wind.material.alphaTest, 0.1)
  assert.equal(wind.material.side, THREE.DoubleSide)
  assert.equal(wind.material.forceSinglePass, true)
  assert.equal(wind.material.depthWrite, true)
  assert.notEqual(wind.material.map, windTexture)
  assert.equal(wind.material.map.source, windTexture.source, '资源包贴图应保留')
  assert.equal(wind.material.map.wrapS, THREE.RepeatWrapping)
  assert.deepEqual(requests, ['entity/breeze/breeze', 'entity/breeze/breeze_wind'])

  group.updateMatrixWorld(true)
  const camera = new THREE.PerspectiveCamera()
  for (const pos of [[14, 10, 3], [10, 6, -9]]) {
    camera.position.set(...pos)
    camera.updateMatrixWorld(true)
    wind.onBeforeRender(null, null, camera)
    // 验证旋转/平移后的面从远到近，且每个面恰好出现一次。
    const indices = Array.from(wind.geometry.index.array)
    const faceOrder = indices.filter((_, i) => i % 6 === 0).map(i => i / 4)
    assert.equal(new Set(faceOrder).size, 42)
    let previousDistance = Infinity
    for (const index of faceOrder) {
      const center = new THREE.Vector3()
      for (const vertex of quads[index].verts) center.add(new THREE.Vector3(...vertex))
      center.multiplyScalar(0.25).applyMatrix4(wind.matrixWorld)
      const distance = center.distanceToSquared(camera.position)
      assert.ok(distance <= previousDistance + 1e-10, '透明面应从远到近绘制')
      previousDistance = distance
    }
  }
  time += 1000
  wind.onBeforeRender(null, null, camera)
  assert.equal(wind.material.map.offset.x, 0.4, '每秒移动 0.4 个纹理周期')
  time += 2000
  wind.onBeforeRender(null, null, camera)
  assert.ok(Math.abs(wind.material.map.offset.x - 0.2) < 1e-10, 'UV 应循环')
  assert.equal(windTexture.offset.x, 0, '不应修改共享贴图的偏移')
  assert.equal(windTexture.wrapS, THREE.ClampToEdgeWrapping, '不应修改共享贴图的采样方式')

  const missingWind = await buildEntityMesh(entity, {
    async getTexture(key) { return key === 'entity/breeze/breeze_wind' ? null : skin },
  })
  assert.equal(missingWind.children.length, 1, '外层贴图缺失时保留主体')
  const pigRequests = []
  const pig = await buildEntityMesh({ ...entity, id: 'minecraft:pig' }, {
    async getTexture(key) { pigRequests.push(key); return skin },
  })
  assert.equal(pig.children.length, 1, '其他生物不应添加旋风层')
  assert.equal(pigRequests.length, 1)
} finally {
  performance.now = originalNow
}
console.log('旋风人校验通过：7 个盒体、UV、透明排序、滚动速度、资源隔离及缺失回退。')
