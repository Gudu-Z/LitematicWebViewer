import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import * as THREE from 'three'
import { CATALOG, entityFields, blockFields, setLanguage, officialName, filterCatalog } from './inspection-catalog.js'
import { buildInspectionModel, inspectionItemId, createBlockSampleData, disposeInspectionModel } from './inspection-models.js'
import { animationFrames } from '../src/textureAnimation.js'
import { BABY_MOBS, babyModel } from '../src/entityBabies.js'
import { buildFaceGroups } from '../src/geometry.js'
import { t, optionLabel } from './inspection-i18n.js'
const root = 'public/assets/minecraft/', textures = new Map(), shared = new Set()
const assets = {
  async getJSON(path) { try { return JSON.parse(readFileSync(root + path, 'utf8')) } catch { return null } },
  async getTexture(key) {
    if (!existsSync(root + 'textures/' + key + '.png')) return null
    if (!textures.has(key)) {
      const image = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.image = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }; texture.name = key
      textures.set(key, texture); shared.add(texture)
    }
    return textures.get(key)
  },
}
const entry = id => CATALOG.find(e => e.id === id)
const meshes = group => { let n = 0; group?.traverse(o => { if (o.isMesh) n++ }); return n }
const dispose = group => disposeInspectionModel(group, shared)
assert.deepEqual(entry('cauldron').variants, ['cauldron', 'lava_cauldron', 'powder_snow_cauldron', 'water_cauldron'])
for (const id of ['oak_hanging_sign', 'oak_sign', 'red_banner', 'zombie_head', 'torch', 'brain_coral_fan']) assert.equal(entry(id).variants.length, 2, id)
assert.ok(entry('flower_pot').variants.includes('potted_fern'))
assert.deepEqual(filterCatalog('block', 'potted_fern').map(r => r.entry.id), ['flower_pot'])
assert.deepEqual(filterCatalog('block', 'Water Cauldron').map(r => r.entry.id), ['cauldron'])
setLanguage('en'); assert.equal(officialName('oak_hanging_sign'), 'Oak Hanging Sign'); assert.equal(t('含水'), 'Waterlogged')
for (const e of CATALOG) for (const f of e.kind === 'block' ? blockFields(null, e.id) : entityFields(e)) {
  assert.ok(!t(f.label, 'MISSING').includes('MISSING'), f.label)
  for (const o of f.options) {
    assert.ok(!/[\u3400-\u9fff]/.test(optionLabel(o)))
    assert.ok(!t(o.label, 'MISSING').includes('MISSING'), o.label)
  }
}
setLanguage('zh')
assert.deepEqual(animationFrames(32, 64, { width: 16, height: 16, frametime: 3, frames: [3, { index: 0, time: 7 }] }),
  { width: 16, height: 16, columns: 2, frames: [{ index: 3, time: 3 }, { index: 0, time: 7 }], duration: 10 })
for (const id of ['end_portal', 'end_gateway']) {
  const data = await createBlockSampleData(entry(id), assets), quads = data.palette[0].baked.quads
  assert.equal(quads.length, id === 'end_portal' ? 2 : 6)
  const ys = quads.flatMap(q => q.verts.map(v => v[1]))
  assert.equal(Math.max(...ys), id === 'end_portal' ? .75 : 1)
  assert.equal(Math.min(...ys), id === 'end_portal' ? .375 : 0)
  const group = await buildInspectionModel(entry(id), assets)
  assert.ok(group.children[0].children[0].material.isShaderMaterial); dispose(group)
}
for (const [id, values] of [['bell', { preview_ringing: 'true' }], ['enchanting_table', { preview_book: 'open' }], ['conduit', { preview_active: 'true' }]]) {
  const group = await buildInspectionModel(entry(id), assets, values)
  assert.ok(group.getObjectByName(id + '-effect')?.children.length, id)
  group.traverse(o => { if (o.userData.updateAnimation) { o.userData.updateAnimation(10); o.userData.updateAnimation(50) } })
  group.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(group)
  assert.ok(bounds.min.toArray().every(Number.isFinite) && bounds.max.toArray().every(Number.isFinite), id)
  dispose(group)
}
const waterUVs = []
for (const direction of ['still', 'north', 'east', 'south', 'west', 'northeast', 'southeast', 'southwest', 'northwest']) {
  const data = await createBlockSampleData(entry('water'), assets, { preview_flow: direction })
  const { groups } = await buildFaceGroups(data.palette, data.blocks, data.bounds)
  waterUVs.push(Array.from(groups.get(direction === 'still' ? 'block/water_still' : 'block/water_flow').uvs).join(','))
}
assert.equal(new Set(waterUVs).size, 9, '静水和八个流向的 UV 应互不相同')
let babies = 0
for (const id of BABY_MOBS) {
  const e = CATALOG.find(e => e.key === 'mob/' + id); if (!e) continue
  const group = await buildInspectionModel(e, assets, { 'nbt.Age': -24000 })
  assert.ok(meshes(group), id)
  assert.ok(group.userData.appearance.texture.endsWith('_baby') || id === 'sniffer', id + ' 幼年贴图')
  if (babyModel(id)) assert.equal(group.userData.appearance.model.w, babyModel(id).w)
  group.traverse(o => {
    if (!o.isSkinnedMesh) return
    for (const age of [0, 100, 1000]) {
      o.userData.updateAnimation?.(age); o.updateWorldMatrix(true, true); o.skeleton.update()
      const p = new THREE.Vector3()
      for (let i = 0; i < o.geometry.attributes.position.count; i++) assert.ok(o.getVertexPosition(i, p).toArray().every(Number.isFinite), id + ' 幼年几何')
      assert.ok(o.material.map, id + ' 幼年图层纹理')
    }
  })
  dispose(group); babies++
}
// 幼年状态与皮肤、坐姿等选项组合，避免只验证缺省幼体而遗漏图层和变种。
for (const id of BABY_MOBS) {
  const e = CATALOG.find(e => e.key === 'mob/' + id); if (!e) continue
  for (const field of entityFields(e).filter(f => f.path !== 'nbt.Age')) for (const option of field.options) {
    const group = await buildInspectionModel(e, assets, { 'nbt.Age': -24000, [field.path]: option.value })
    assert.ok(meshes(group), id + ' ' + option.label)
    group.traverse(o => {
      if (!o.isSkinnedMesh) return
      assert.ok(o.material.map, id + ' ' + option.label + ' 图层')
      // 穿戴的生物头颅使用静态骨骼，随父骨骼移动，没有独立待机回调。
      o.userData.updateAnimation?.(80); o.updateWorldMatrix(true, true); o.skeleton.update()
      const vertex = new THREE.Vector3()
      for (let i = 0; i < o.geometry.attributes.position.count; i++) assert.ok(o.getVertexPosition(i, vertex).toArray().every(Number.isFinite))
    })
    dispose(group)
  }
}
const itemIds = new Set(), missing = []
for (const e of CATALOG) {
  const id = inspectionItemId(e); if (!id || itemIds.has(id)) continue
  itemIds.add(id)
  const group = await buildInspectionModel(e, assets, {}, '', 'item')
  if (!meshes(group)) missing.push(id)
  dispose(group)
}
assert.deepEqual(missing, [], '所有存在对应物品的卡片都应能显示物品')
for (const id of ['red_banner', 'bell', 'oak_hanging_sign', 'cow']) {
  const group = await buildInspectionModel(entry(id), assets, {}, '', 'frame')
  assert.ok(meshes(group) > 1, id + ' 框与物品应同时可见'); dispose(group)
}
console.log(`特殊渲染通过：${itemIds.size} 个对应物品，${babies} 种幼年形态，特殊方块/动画、九种流向、同类分组及英文标签。`)
