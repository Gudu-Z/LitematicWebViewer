// node scripts/verify-render-inspection.mjs — 目录完整性、官方名称、状态组合与真实模型资源。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import * as THREE from 'three'
import { CATALOG, BLOCK_IDS, ITEM_IDS, officialName, entityFields, blockFields, createFixture, filterCatalog } from './inspection-catalog.js'
import { buildInspectionModel, disposeInspectionModel } from './inspection-models.js'

const root = 'public/assets/minecraft/'
const ids = dir => readdirSync(root + dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
assert.deepEqual(BLOCK_IDS, ids('blockstates'), '目录须覆盖所有原版方块状态文件')
assert.deepEqual(ITEM_IDS, ids('items'), '展示框须可选择所有物品')
assert.equal(new Set(CATALOG.map(e => e.key)).size, CATALOG.length, '卡片键不能重复')
for (const entry of CATALOG) assert.notEqual(entry.name, '未命名对象', entry.key)
for (const id of ITEM_IDS) assert.notEqual(officialName(id, 'item'), '未命名对象', id)
assert.deepEqual(filterCatalog('mob', '闪电苦力怕').map(r => r.entry.id), ['creeper'])
assert.ok(filterCatalog('entity', '白桦木船').some(r => r.entry.id === 'boat'))
assert.ok(filterCatalog('entity', '涂蜡的铜块').some(r => r.matchedItem === 'waxed_copper_block'))
assert.equal(filterCatalog('block', 'stone').some(r => r.entry.kind !== 'block'), false)
assert.equal(filterCatalog('all', '不可能存在的测试名称').length, 0)

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
console.log(`通过：${BLOCK_IDS.length} 个方块、${ITEM_IDS.length} 个物品的官方名称与目录，${states} 个实体状态、组合状态与默认方块模型。`)
