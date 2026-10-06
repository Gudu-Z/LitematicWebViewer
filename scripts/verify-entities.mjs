// node scripts/verify-entities.mjs — 真实资源、骨骼绑定、原版特效条件与时间更新回归。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { createEntityRig, compileModel } from '../src/entityModel.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'
import { getMobAppearance, MOB_TABLE } from '../src/entityAppearance.js'
import { ALL_MOB_FIXTURES, FEATURE_FIXTURES } from './entity-fixtures.mjs'

const beforeModels = JSON.stringify([ENTITY_MODELS, EXTRA_MODELS])
const textures = new Map()
const assets = {
  async getJSON(path) {
    const file = 'public/assets/minecraft/' + path
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  },
  async getTexture(key) {
    if (textures.has(key)) return textures.get(key)
    const file = 'public/assets/minecraft/textures/' + key + '.png'
    assert.ok(existsSync(file), '缺少贴图: ' + key)
    const png = readFileSync(file), texture = new THREE.Texture()
    texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    textures.set(key, texture)
    return texture
  },
}
const entity = (id, nbt = {}) => ({ id: 'minecraft:' + id, pos: [7, 11, -3], rotation: [35, 12], nbt: { Health: 20, OnGround: 0, ...nbt } })
const appearance = (id, nbt) => getMobAppearance(entity(id, nbt), id)
const dispose = group => group.traverse(o => {
  o.geometry?.dispose()
  for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) m.dispose()
})
const pose = mesh => JSON.stringify(Object.values(mesh.userData.parts).map(p => [p.position.toArray(), p.rotation.toArray(), p.scale.toArray()]))
let meshCount = 0
for (const fixture of [...ALL_MOB_FIXTURES, ...FEATURE_FIXTURES]) {
  const fixtureBefore = JSON.stringify(fixture)
  const group = await buildEntityMesh(fixture, assets)
  assert.equal(group.userData.mobId, fixture.id.slice(10), '不应回退为方盒生物')
  for (const mesh of group.children.filter(m => m.isSkinnedMesh)) {
    meshCount++
    const { width, height } = mesh.material.map.image
    const model = mesh.name === 'body' ? group.userData.appearance.model : group.userData.appearance.layers.find(l => l.name === mesh.name).model
    assert.equal(width / height, model.w / model.h, fixture.id + ' ' + mesh.name + ' 模型与贴图宽高比应匹配')
    // 每个时间点必须从绑定姿态重算，不能逐帧累积变换。眼睛/服装也使用同一套姿态。
    mesh.userData.updateAnimation(37)
    const expected = pose(mesh)
    for (const t of [0, 500, 13, 4000, 37]) mesh.userData.updateAnimation(t)
    assert.equal(pose(mesh), expected, fixture.id + ' 动画不能漂移')
    group.updateMatrixWorld(true); mesh.skeleton.update()
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      const p = mesh.getVertexPosition(i, new THREE.Vector3())
      assert.ok(p.toArray().every(Number.isFinite), fixture.id + ' 非有限动画坐标')
    }
    mesh.userData.resetPose(); group.updateMatrixWorld(true); mesh.skeleton.update()
    // 绑定姿态须与旧版静态编译器完全相同，包括嵌套旋转与镜像 cuboid。
    const quads = compileModel(model)
    for (let i = 0; i < quads.length * 4; i++) {
      const p = mesh.getVertexPosition(i, new THREE.Vector3())
      const q = new THREE.Vector3(...quads[Math.floor(i / 4)].verts[i % 4])
      assert.ok(p.distanceTo(q) < 2e-5, fixture.id + ' 骨骼绑定改变了静态几何')
    }
  }
  assert.equal(JSON.stringify(fixture), fixtureBefore, '不得修改输入 NBT')
  dispose(group)
}

// 效果应由存档触发，不能给普通苦力怕/健康凋零强加护甲。
assert.equal(appearance('creeper', {}).layers.length, 0)
assert.equal(appearance('creeper', { powered: 1 }).layers[0].name, 'charged_creeper')
assert.equal(appearance('wither', { Health: 151 }).layers.length, 0)
assert.equal(appearance('wither', { Health: 150 }).layers[0].name, 'wither_armor')
assert.equal(appearance('wither', { Health: 300, attributes: [{ id: 'minecraft:max_health', base: 1000 }] }).layers.length, 1)
assert.equal(appearance('sheep', { Sheared: 1 }).layers.length, 0)
assert.equal(appearance('sheep', { Color: 14, Sheared: 1 }).layers.length, 1)
assert.equal(appearance('cave_spider', {}).scale, 0.7)
assert.equal(appearance('wither_skeleton', {}).scale, 1.2)
assert.equal(appearance('slime', { Size: 3 }).scale, 4)
assert.notDeepEqual(appearance('pufferfish', { PuffState: 0 }).model, appearance('pufferfish', { PuffState: 2 }).model)
assert.ok(appearance('shulker', { Peek: 100 }).model.parts.head, '潜影贝实体必须包含内部头部')
assert.equal(appearance('copper_golem', { weather_state: 'weathered' }).texture, 'entity/copper_golem/copper_golem_weathered')
// 遍历皮肤枚举，防止路径有效但指向另一版本的兔子 UV、或变种命名错误。
for (const [id, field, values] of [
  ['rabbit', 'RabbitType', [0, 1, 2, 3, 4, 5, 99]],
  ['cat', 'variant', ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black']],
  ['wolf', 'variant', ['pale', 'spotted', 'snowy', 'black', 'ashen', 'rusty', 'woods', 'chestnut', 'striped']],
  ['copper_golem', 'weather_state', ['unaffected', 'exposed', 'weathered', 'oxidized']],
  ['pig', 'variant', ['temperate', 'warm', 'cold']], ['cow', 'variant', ['temperate', 'warm', 'cold']], ['chicken', 'variant', ['temperate', 'warm', 'cold']],
]) for (const value of values) {
  const a = appearance(id, { [field]: value })
  for (const layer of [{ texture: a.texture, model: a.model }, ...a.layers]) {
    const texture = await assets.getTexture(layer.texture)
    assert.equal(texture.image.width / texture.image.height, layer.model.w / layer.model.h, id + ' 变种 UV 比例')
  }
}

// 一秒的真实游戏时长：流动贴图推进，两个实例与 AssetProvider 原贴图互不污染。
const chargedA = await buildEntityMesh(entity('creeper', { powered: 1 }), assets)
const chargedB = await buildEntityMesh(entity('creeper', { powered: 1 }), assets)
const shellA = chargedA.getObjectByName('charged_creeper'), shellB = chargedB.getObjectByName('charged_creeper')
shellA.userData.updateAnimation(20)
assert.deepEqual(shellA.material.map.offset.toArray(), [0.2, 0.2])
assert.deepEqual(shellB.material.map.offset.toArray(), [0, 0])
assert.deepEqual(textures.get('entity/creeper/creeper_armor').offset.toArray(), [0, 0])
assert.equal(shellA.material.blending, THREE.AdditiveBlending)
assert.equal(shellA.material.depthWrite, true)
const sheep = await buildEntityMesh(entity('sheep', { CustomName: { text: 'jeb_' } }), assets)
const wool = sheep.getObjectByName('wool')
wool.userData.updateAnimation(0); const white = wool.material.color.getHex()
wool.userData.updateAnimation(25); const orange = wool.material.color.getHex()
assert.notEqual(white, orange)
wool.userData.updateAnimation(400); assert.equal(wool.material.color.getHex(), white, '彩虹羊毛应在 400 tick 循环')

// 动作振幅来自原版公式，使用带世界旋转/平移的网格验证。
const blaze = await buildEntityMesh(entity('blaze'), assets), blazeMesh = blaze.getObjectByName('body')
blazeMesh.userData.updateAnimation(5)
assert.ok(Math.abs(blazeMesh.userData.parts.rod0.position.x) < 1e-6)
assert.ok(Math.abs(blazeMesh.userData.parts.rod0.position.z + 9) < 1e-6)
const guardian = await buildEntityMesh(entity('guardian'), assets), guardMesh = guardian.getObjectByName('body')
guardMesh.userData.updateAnimation(4)
assert.ok(Math.abs(guardMesh.userData.parts.tail2.rotation.y - Math.sin(0.5) * Math.PI * 0.15) < 1e-7)

// 水中分支读结构中的真实方块，不只依赖 OnGround。
const waterData = { bounds: { minX: 7, minY: 11, minZ: -3, width: 1, height: 1, depth: 1 }, blocks: new Map([[0, 0]]), palette: [{ name: 'minecraft:water', properties: {} }] }
assert.ok(getMobAppearance(entity('cod', { OnGround: 1 }), 'cod', waterData).state.touchingWater)
waterData.palette[0].name = 'minecraft:air'
assert.equal(getMobAppearance(entity('cod'), 'cod', waterData).state.touchingWater, false)

// 可选 feature 缺失应保留主体；贴图尺寸可以被资源包按整数倍放大。
const missingOverlay = await buildEntityMesh(entity('creeper', { powered: 1 }), { getTexture: async key => key.endsWith('creeper_armor') ? null : assets.getTexture(key) })
assert.ok(missingOverlay.getObjectByName('body'))
assert.equal(missingOverlay.getObjectByName('charged_creeper'), undefined)
const rig = createEntityRig(EXTRA_MODELS.BreezeWindEntityModel, new THREE.MeshBasicMaterial())
rig.skeleton.computeBoneTexture()
let freed = false
rig.skeleton.boneTexture.addEventListener('dispose', () => { freed = true })
rig.geometry.dispose(); rig.material.dispose()
assert.ok(freed, '实体卸载时必须释放骨骼 GPU 纹理')
for (const group of [chargedA, chargedB, sheep, blaze, guardian, missingOverlay]) dispose(group)
assert.equal(JSON.stringify([ENTITY_MODELS, EXTRA_MODELS]), beforeModels, '不得污染共享模型')
console.log(`实体校验通过：${Object.keys(MOB_TABLE).length} 种生物、${FEATURE_FIXTURES.length} 个状态样例、${meshCount} 个图层；绑定姿态、无漂移、NBT 条件、真实贴图、资源隔离与释放。`)
