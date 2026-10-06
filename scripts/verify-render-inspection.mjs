// node scripts/verify-render-inspection.mjs — 目录完整性、官方名称、状态组合与真实模型资源。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import * as THREE from 'three'
import { CATALOG, BLOCK_IDS, ITEM_IDS, officialName, entityFields, blockFields, createFixture, filterCatalog } from './inspection-catalog.js'
import { buildInspectionModel, disposeInspectionModel, createBlockSampleData, fieldsFor } from './inspection-models.js'
import { BLOCK_STATES } from './inspection-block-states.js'
import { Renderer } from '../src/renderer.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'
import { compileModel } from '../src/entityModel.js'

const root = 'public/assets/minecraft/'
const ids = dir => readdirSync(root + dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
assert.deepEqual(BLOCK_IDS, ids('blockstates'), '目录须覆盖所有原版方块状态文件')
assert.deepEqual(ITEM_IDS, ids('items'), '展示框须可选择所有物品')
assert.equal(new Set(CATALOG.map(e => e.key)).size, CATALOG.length, '卡片键不能重复')
assert.deepEqual(CATALOG.filter(e => e.kind === 'block').flatMap(e => e.variants).sort(), BLOCK_IDS, '分组后每个方块仍须恰好出现一次')
assert.equal(CATALOG.find(e => e.id === 'cake').variants.length, 18, '蛋糕与 17 种插蜡烛蛋糕应在同一卡片')
assert.equal(CATALOG.some(e => e.kind === 'block' && e.id.endsWith('_wall_banner')), false)
for (const entry of CATALOG) assert.notEqual(entry.name, '未命名对象', entry.key)
for (const id of ITEM_IDS) assert.notEqual(officialName(id, 'item'), '未命名对象', id)
assert.deepEqual(filterCatalog('mob', '闪电苦力怕').map(r => r.entry.id), ['creeper'])
assert.ok(filterCatalog('entity', '白桦木船').some(r => r.entry.id === 'boat'))
assert.ok(filterCatalog('entity', '涂蜡的铜块').some(r => r.matchedItem === 'waxed_copper_block'))
assert.equal(filterCatalog('block', 'stone').some(r => r.entry.kind !== 'block'), false)
assert.equal(filterCatalog('all', '不可能存在的测试名称').length, 0)
const wetResults = filterCatalog('all', '含水')
assert.ok(wetResults.length > 0, '含水搜索应显示可含水方块')
assert.deepEqual(filterCatalog('block', ' WATERLOGGED '), wetResults, '中英文搜索应返回相同方块')
for (const id of ['oak_slab', 'oak_stairs', 'oak_sign', 'chain', 'iron_chain']) {
  assert.ok(wetResults.some(r => r.entry.id === id), id + ' 应被含水搜索命中')
}
assert.equal(wetResults.some(r => r.entry.kind !== 'block' || ['stone', 'water', 'oak_door'].includes(r.entry.id)), false)
assert.equal(filterCatalog('mob', '含水').length, 0)
assert.equal(filterCatalog('entity', 'waterlogged').length, 0)
assert.deepEqual(filterCatalog('block', '含水 spruce_wall_sign').map(r => [r.entry.id, r.matchedBlock]), [['spruce_sign', 'spruce_wall_sign']])
assert.equal(filterCatalog('block', '含水 stone').some(r => r.entry.id === 'stone'), false)

const textures = new Map(), shared = new Set()
const assets = {
  async getJSON(path) {
    const file = root + path
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  },
  async getTexture(key) {
    if (!textures.has(key)) {
      assert.ok(existsSync(root + 'textures/' + key + '.png'), '贴图不存在：' + key)
      const data = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.image = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
      texture.name = key
      textures.set(key, texture); shared.add(texture)
    }
    return textures.get(key)
  },
}
const countMeshes = group => { let n = 0; group?.traverse(o => { if (o.isMesh || o.isPoints) n++ }); return n }
let states = 0
for (const entry of CATALOG.filter(e => e.kind !== 'block')) {
  const before = JSON.stringify(entry.fixture), fields = entityFields(entry)
  assert.equal(new Set(fields.map(f => f.path)).size, fields.length, entry.key + ' 重复状态字段')
  const patches = [{}, ...fields.flatMap(f => f.options.map(o => ({ [f.path]: o.value })))]
  for (const values of patches) {
    const group = await buildInspectionModel(entry, assets, values)
    assert.ok(countMeshes(group), entry.key + ' 应可渲染')
    disposeInspectionModel(group, shared); states++
  }
  assert.equal(JSON.stringify(entry.fixture), before, '状态切换不能修改目录中的默认实体')
}
const creeper = CATALOG.find(e => e.key === 'mob/creeper')
const charged = await buildInspectionModel(creeper, assets, { 'nbt.powered': 1 })
assert.ok(charged.children.some(o => o.name === 'charged_creeper'))
disposeInspectionModel(charged, shared)
const villager = CATALOG.find(e => e.key === 'mob/villager')
const combined = createFixture(villager, { 'nbt.VillagerData.type': 'desert', 'nbt.VillagerData.profession': 'librarian', 'nbt.VillagerData.level': 5 })
assert.deepEqual(combined.nbt.VillagerData, { type: 'desert', profession: 'librarian', level: 5 })

const synthetic = blockFields({ multipart: [{ when: { OR: [{ north: 'side|up' }, { AND: [{ powered: true }, { facing: 'north' }] }] }, apply: {} }] }, 'test')
assert.deepEqual(synthetic.find(f => f.path === 'powered').options.map(o => o.value).sort(), ['false', 'true'])
assert.deepEqual(synthetic.find(f => f.path === 'north').options.map(o => o.value).sort(), ['side', 'up'])
const invisible = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void', 'moving_piston'])
const empty = []
for (const entry of CATALOG.filter(e => e.kind === 'block')) {
  const fields = blockFields(await assets.getJSON('blockstates/' + entry.id + '.json'), entry.id)
  const values = Object.fromEntries(fields.map(f => [f.path, f.options[0].value]))
  // 合成旗面需要 Canvas，浏览器回归单独检查；其余方块走真实共享渲染路径。
  if (entry.id.endsWith('_banner')) continue
  const group = await buildInspectionModel(entry, assets, values)
  if (!countMeshes(group) && !invisible.has(entry.id)) empty.push(entry.id)
  disposeInspectionModel(group, shared)
}
assert.deepEqual(empty, [], '可见方块不应出现空白卡片')

const entryFor = id => CATALOG.find(e => e.id === id && e.kind === 'block')
let waterlogged = 0, walls = 0
for (const [id, [properties]] of Object.entries(BLOCK_STATES)) {
  const fields = blockFields(await assets.getJSON('blockstates/' + id + '.json'), id)
  if (properties.waterlogged) {
    assert.deepEqual(fields.find(f => f.path === 'waterlogged').options.map(o => o.value).sort(), ['false', 'true'], id)
    waterlogged++
  }
  if (id.endsWith('_wall')) {
    for (const side of ['north', 'south', 'west', 'east']) {
      const options = fields.find(f => f.path === side).options
      assert.deepEqual(options.map(o => o.value).sort(), ['low', 'none', 'tall'], id + ' ' + side)
      assert.equal(options.find(o => o.value === 'none').label, '不显示')
    }
    walls++
  }
}
assert.equal(waterlogged, 505)
const wet = await buildInspectionModel(entryFor('oak_stairs'), assets, { waterlogged: 'true' })
const dry = await buildInspectionModel(entryFor('oak_stairs'), assets, { waterlogged: 'false' })
const hasWater = group => { let found = false; group.traverse(o => { if (o.material?.map?.name === 'block/water_still') found = true }); return found }
assert.ok(hasWater(wet)); assert.equal(hasWater(dry), false)
disposeInspectionModel(wet, shared); disposeInspectionModel(dry, shared)

for (const id of ['oak_door', 'iron_door', 'tall_seagrass', 'sunflower', 'pitcher_plant']) {
  const entry = entryFor(id), fields = await fieldsFor(entry, assets)
  assert.deepEqual(fields.find(f => f.path === 'half').options.map(o => o.label), ['全部', '上半', '下半'])
  const whole = await createBlockSampleData(entry, assets)
  assert.equal(whole.bounds.height, 2, id); assert.equal(whole.blocks.size, 2, id)
  for (const half of ['lower', 'upper']) assert.equal((await createBlockSampleData(entry, assets, { half })).blocks.size, 1)
}
for (const [facing, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]]) {
  const data = await createBlockSampleData(entryFor('red_bed'), assets, { facing })
  assert.equal(data.blocks.size, 2)
  const position = part => {
    const [key] = [...data.blocks].find(([, i]) => data.palette[i].properties.part === part)
    return [key % data.bounds.width + data.bounds.minX, Math.floor(key / data.bounds.width) % data.bounds.depth + data.bounds.minZ]
  }
  const head = position('head'), foot = position('foot')
  assert.deepEqual([head[0] - foot[0], head[1] - foot[1]], [dx, dz], '床头应按原版沿 facing 相邻')
}
for (const id of entryFor('cake').variants) {
  const fields = await fieldsFor(entryFor('cake'), assets, { block: id })
  assert.equal(fields.some(f => f.path === 'bites'), id === 'cake')
  assert.equal(fields.some(f => f.path === 'lit'), id !== 'cake')
  assert.equal((await createBlockSampleData(entryFor('cake'), assets, { block: id })).palette[0].name, 'minecraft:' + id)
}

// BannerBlockModel / BannerFlagBlockModel：横杆顶端和旗面顶端都在 y=20.5/24，
// 旗面中心比横杆中心沿朝向靠前 1.5/24。用生产渲染方法检查四个朝向，Canvas 合成在浏览器验证。
for (const [facing, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]]) {
  const data = await createBlockSampleData(entryFor('red_banner'), assets, { block: 'red_wall_banner', facing })
  assert.equal(data.banners[0].facing, facing)
  const flagTexture = new THREE.Texture(), target = { bannersGroup: new THREE.Group(), clearBanners() {}, async _makeBannerTexture() { return flagTexture } }
  await Renderer.prototype.renderBanners.call(target, data.banners, assets)
  target.bannersGroup.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(target.bannersGroup), flagCenter = box.getCenter(new THREE.Vector3())
  const bar = new THREE.Box3().setFromPoints(data.palette[0].baked.quads.flatMap(q => q.verts.map(v => new THREE.Vector3(...v))))
  const delta = flagCenter.clone().sub(bar.getCenter(new THREE.Vector3()))
  assert.ok(Math.abs(box.max.y - 20.5 / 24) < 1e-6)
  assert.ok(Math.abs(box.max.y - bar.max.y) < 1e-6)
  const restingPitch = -.0025 * Math.PI
  assert.ok(Math.abs(delta.x * dx + delta.z * dz - (1.5 / 24 - 5 / 6 * Math.sin(restingPitch))) < 1e-6)
  target.bannersGroup.traverse(o => o.material?.dispose()); flagTexture.dispose()
}

const pillagerEntry = CATALOG.find(e => e.key === 'mob/pillager')
for (const held of [false, true]) {
  const pillager = await buildInspectionModel(pillagerEntry, assets, { 'nbt.HandItems': held ? [{ id: 'minecraft:crossbow' }] : [] })
  const model = pillager.userData.appearance.model, parts = pillager.children.find(o => o.name === 'body').userData.parts
  assert.equal(model.parts.arms.cuboids.length, 0)
  assert.equal(Object.keys(model.parts.arms.children).length, 0)
  assert.ok(model.parts.left_arm.cuboids.length && model.parts.right_arm.cuboids.length)
  assert.ok(Math.abs(parts.right_arm.rotation.x - (held ? -Math.PI / 2 + .1 : 0)) < 1e-6)
  assert.ok(Math.abs(parts.left_arm.rotation.y - (held ? .6 : 0)) < 1e-6)
  disposeInspectionModel(pillager, shared)
}
const stand = CATALOG.find(e => e.key === 'entity/armor_stand')
assert.equal(createFixture(stand).nbt.ShowArms, 0)

// 船桨叶中心由原版 cuboid + setPaddleAngles(0) 独立推算，不能沿用横伸的绑定姿态。
const boatEntry = CATALOG.find(e => e.key === 'entity/boat')
for (const [id, source] of [['oak_boat', ENTITY_MODELS.BoatEntityModel], ['bamboo_raft', EXTRA_MODELS.RaftModel]]) {
  const before = JSON.stringify(source), boat = await buildInspectionModel(boatEntry, assets, { id: 'minecraft:' + id })
  const quads = compileModel(source, true), positions = boat.children[0].geometry.attributes.position
  for (const [name, sign] of [['left_paddle', -1], ['right_paddle', 1]]) {
    const indices = quads.map((q, i) => q.part === source.parts[name] ? i : -1).filter(i => i >= 0).slice(-6)
    const center = new THREE.Vector3()
    for (const i of indices) for (let j = 0; j < 4; j++) center.add(new THREE.Vector3().fromBufferAttribute(positions, i * 4 + j))
    center.divideScalar(24)
    const yaw = Math.sin(1) * Math.PI / 4
    const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-5 * Math.PI / 24, sign === 1 ? Math.PI - yaw : yaw, Math.PI / 16, 'ZYX'))
    const expected = new THREE.Vector3(sign * .501, 0, 11.5).applyMatrix4(matrix).add(new THREE.Vector3(...source.parts[name].pivot))
    expected.set(expected.x / 16, (24 - expected.y) / 16, -expected.z / 16)
    assert.ok(center.distanceTo(expected) < 1e-6, id + ' ' + name)
  }
  assert.equal(JSON.stringify(source), before, '不能修改共享船模型')
  disposeInspectionModel(boat, shared)
}
console.log(`通过：${BLOCK_IDS.length} 个方块、${ITEM_IDS.length} 个物品的官方名称与目录，${states} 个实体状态、组合状态与默认方块模型。`)
console.log(`修复回归：多格组合、蛋糕/旗帜分组、${waterlogged} 种含水方块、${walls} 种墙、四向旗帜对齐、掠夺者双臂与船桨静止姿态。`)
