// node scripts/verify-cushion.mjs — 原版坐垫尺寸、UV、朝向、NBT 颜色及图鉴物品映射。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { CUSHION_COLORS } from '../src/cushion.js'
import { CATALOG, entityFields, filterCatalog, createFixture, setLanguage } from './inspection-catalog.js'
import { inspectionItemId, disposeInspectionModel } from './inspection-models.js'

const textures = new Map()
const assets = { async getTexture(key) {
  if (!textures.has(key)) {
    const png = readFileSync('public/assets/minecraft/textures/' + key + '.png')
    assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64)
    const texture = new THREE.Texture(); texture.name = key; textures.set(key, texture)
  }
  return textures.get(key)
} }
const entry = CATALOG.find(e => e.key === 'entity/cushion')
assert.ok(entry)
const fields = entityFields(entry)
assert.equal(fields.find(f => f.path === 'nbt.color').options.length, 16)
assert.equal(fields.find(f => f.path === 'rotation').options.length, 4)
assert.equal(inspectionItemId(entry), 'white_cushion')
for (const [lang, query] of [['zh', '坐垫'], ['zh', '红色坐垫'], ['en', 'Cushion'], ['en', 'Red Cushion']]) {
  setLanguage(lang)
  assert.ok(filterCatalog('entity', query).some(r => r.entry === entry), query)
  assert.equal(filterCatalog('block', query).length, 0)
}
setLanguage('zh')

for (const color of CUSHION_COLORS) {
  const fixture = createFixture(entry, { 'nbt.color': color })
  const before = structuredClone(fixture)
  const group = await buildEntityMesh(fixture, assets)
  const mesh = group.getObjectByName('cushion')
  assert.equal(mesh.material.map.name, 'entity/cushion/' + color + '_cushion')
  assert.equal(inspectionItemId(entry, { 'nbt.color': color }), color + '_cushion')
  const box = new THREE.Box3().setFromObject(group)
  // 原版模型总范围 x/z = ±8px、y = 0..4px，每侧向内收缩 0.005px。
  assert.ok(box.min.distanceTo(new THREE.Vector3(-7.995 / 16, .005 / 16, -7.995 / 16)) < 1e-6)
  assert.ok(box.max.distanceTo(new THREE.Vector3(7.995 / 16, 3.995 / 16, 7.995 / 16)) < 1e-6)
  assert.equal(mesh.geometry.attributes.position.count, 24)
  assert.deepEqual([...mesh.geometry.attributes.normal.array].slice(0, 3), [0, 1, 0], '顶面法线应朝上')
  assert.deepEqual([...mesh.geometry.attributes.uv.array].slice(0, 8), [.5, 0, .25, 0, .25, .25, .5, .25])
  assert.deepEqual(fixture, before, '渲染不能修改输入 NBT')
  disposeInspectionModel(group, new Set(textures.values()))
}
for (const [yaw, direction] of [[0, 0], [35, 0], [45, 90], [90, 90], [180, 180], [270, 270], [-45, 0], [-46, 270], [405, 90]]) {
  const fixture = { id: 'minecraft:cushion', pos: [7.5, 12.125, -3.5], rotation: [yaw, 20], nbt: {} }
  const group = await buildEntityMesh(fixture, assets)
  const mesh = group.getObjectByName('cushion')
  group.updateMatrixWorld(true)
  // 独立应用 CushionRenderer 的 Y(180-direction) · X(180) · T(0,-.25,0)。
  // 第一个顶点是 Java 盒体 v5；先加模型 pivot，再按 1/16 转成方块单位。
  const expected = new THREE.Vector3(7.995 / 16, .005 / 16 - .25, 7.995 / 16)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), (180 - direction) * Math.PI / 180)
    .add(new THREE.Vector3(...fixture.pos))
  const actual = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 0).applyMatrix4(mesh.matrixWorld)
  assert.ok(actual.distanceTo(expected) < 1e-6, '原版坐垫变换 yaw=' + yaw)
  assert.equal(mesh.material.map.name, 'entity/cushion/white_cushion', '缺省颜色应为白色')
  disposeInspectionModel(group, new Set(textures.values()))
}
for (const color of ['invalid', 14, null]) assert.equal(inspectionItemId(entry, { 'nbt.color': color }), 'white_cushion')
textures.forEach(t => t.dispose())
console.log('通过：坐垫 16 色真实贴图、原版尺寸与 UV、四向及非直角旋转、位置偏移、NBT 缺省与图鉴物品映射。')
