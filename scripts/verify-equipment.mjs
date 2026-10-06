// node scripts/verify-equipment.mjs — 真实装备资源、NBT 兼容、骨骼同步和装备槽隔离。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh, buildEquippedItem } from '../src/entities.js'
import { EQUIPMENT_MODELS } from '../src/equipmentModelData.js'
import { armorModel } from '../src/equipment.js'
import { readEquipment, equipmentDye, hasGlint } from '../src/equipmentState.js'
import { CATALOG, createFixture } from './inspection-catalog.js'

const root = 'public/assets/minecraft/', textures = new Map(), before = JSON.stringify(EQUIPMENT_MODELS)
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const path = root + 'textures/' + key + '.png'
      assert.ok(existsSync(path), 'Missing texture: ' + key)
      const png = readFileSync(path), texture = new THREE.Texture()
      texture.name = key; texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const item = (id, components) => ({ id: 'minecraft:' + id, count: 1, ...(components ? { components } : {}) })
const slots = ['head', 'chest', 'legs', 'feet'], suffixes = ['helmet', 'chestplate', 'leggings', 'boots']
const fullSet = material => Object.fromEntries(slots.map((slot, i) => [slot, item(material + '_' + suffixes[i])]))
const entity = (id, nbt = {}) => ({ id: 'minecraft:' + id, pos: [3, 5, -2], rotation: [30, 12], nbt: { Health: 20, ...nbt } })
const build = (id, nbt) => buildEntityMesh(entity(id, nbt), assets)
const pose = mesh => JSON.stringify(Object.values(mesh.userData.parts).map(p => [p.position.toArray(), p.quaternion.toArray(), p.scale.toArray()]))
const dispose = group => group.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })

const old = { ArmorItems: [item('iron_boots'), item('iron_leggings'), item('iron_chestplate'), item('iron_helmet')], HandItems: [item('bow'), item('shield')], ArmorItem: item('diamond_horse_armor'), Saddle: 1 }
assert.deepEqual(Object.fromEntries(slots.map(s => [s, readEquipment(old)[s]])), fullSet('iron'))
assert.equal(readEquipment(old).mainhand.id, 'minecraft:bow')
assert.equal(readEquipment(old).saddle.id, 'minecraft:saddle')
assert.equal(readEquipment(old).body.id, 'minecraft:diamond_horse_armor')
assert.equal(readEquipment({ ...old, equipment: { mainhand: {} } }).mainhand, null, 'Modern explicit empty slot wins')
assert.equal(readEquipment({ equipment: { head: { id: 'minecraft:iron_helmet', Count: 0 } } }).head, null)
assert.equal(equipmentDye(item('leather_helmet', { 'minecraft:dyed_color': { rgb: 0x123456 } })), 0x123456)
assert.equal(equipmentDye({ tag: { display: { color: 0x654321 } } }), 0x654321)
assert.ok(hasGlint({ tag: { Enchantments: [{ id: 'minecraft:protection', lvl: 1 }] } }))
assert.equal(hasGlint(item('iron_helmet', { 'minecraft:enchantments': { 'minecraft:protection': 1 }, 'minecraft:enchantment_glint_override': false })), false)

let layers = 0
for (const id of ['armor_stand', 'zombie', 'zombie_villager', 'skeleton', 'piglin', 'zombified_piglin']) {
  for (const material of ['leather', 'chainmail', 'copper', 'iron', 'golden', 'diamond', 'netherite']) {
    for (const young of [false, true]) {
      if (id === 'skeleton' && young) continue
      const equipment = { ...fullSet(material), mainhand: item('diamond_sword'), offhand: item('shield') }
      const nbt = { equipment, ...(id === 'armor_stand' ? { Small: young, Pose: { RightArm: [-75, 20, 10] } } : { Age: young ? -24000 : 0 }) }
      const input = entity(id, nbt), original = JSON.stringify(input), group = await buildEntityMesh(input, assets), body = group.getObjectByName('body')
      assert.equal(JSON.stringify(input), original, 'Rendering must not mutate input')
      for (const slot of slots) {
        const mesh = group.getObjectByName('equipment_' + slot + '_0'); assert.ok(mesh, id + ' ' + slot); layers++
        assert.equal(mesh.material.map.image.height, young && id !== 'armor_stand' ? 64 : 32)
        mesh.userData.updateAnimation(37); const expected = pose(mesh)
        for (const t of [0, 1500, 20, 37]) mesh.userData.updateAnimation(t)
        assert.equal(pose(mesh), expected, 'Equipment animation must not accumulate')
        for (const name of ['head', 'right_arm', 'left_arm', 'body']) {
          const bone = mesh.userData.parts[name], parent = body.userData.parts[name]
          if (bone && parent) assert.ok(bone.quaternion.angleTo(parent.quaternion) < 1e-7, id + ' pose sync ' + name)
        }
        group.updateMatrixWorld(true); mesh.skeleton.update()
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) assert.ok(mesh.getVertexPosition(i, new THREE.Vector3()).toArray().every(Number.isFinite))
      }
      assert.equal(group.getObjectByName('equipment_mainhand').parent.name, 'right_arm')
      assert.equal(group.getObjectByName('equipment_offhand').parent.name, 'left_arm')
      if (id === 'armor_stand') {
        assert.equal(body.userData.model.parts.right_arm.cuboids.length, 0, 'Stand wood arms hidden by default')
        assert.ok(armorModel(id, 'chest').parts.right_arm.cuboids.length, 'Armor sleeves remain visible')
      }
      dispose(group)
    }
  }
}
const babyBoots = armorModel('zombie', 'feet', true)
const trident = await buildEquippedItem(item('trident'), assets)
trident.children[0].geometry.computeBoundingBox()
const tridentBox = trident.children[0].geometry.boundingBox
assert.equal(tridentBox.getCenter(new THREE.Vector3()).x, -.5, 'Special item must retain ItemTransform centering')
assert.equal(tridentBox.getSize(new THREE.Vector3()).y, 31 / 16, 'Held trident must use the full 3D pole')
dispose(trident)
const wingFixture = createFixture(CATALOG.find(e => e.id === 'armor_stand'), { 'nbt.equipment.chest': item('elytra'), 'preview.equipment_trim': 'bolt' })
assert.equal(wingFixture.nbt.equipment.chest.components['minecraft:trim'], undefined, 'Trim selection must not add invalid trims to elytra')
assert.ok(babyBoots.parts.left_leg.children.right_foot.cuboids.length)
assert.equal(babyBoots.parts.left_leg.cuboids.length, 0, 'Baby boots use the feet parts')
assert.equal(armorModel('armor_stand', 'head').parts.head.pivot[1], 1)
assert.equal(EQUIPMENT_MODELS.HumanoidHead.parts.head.children.hat.cuboids[0].dil[0], .25)
for (const [id, equipment] of [
  ['horse', { body: item('diamond_horse_armor'), saddle: item('saddle') }],
  ['donkey', { saddle: item('saddle') }], ['mule', { saddle: item('saddle') }],
  ['camel', { saddle: item('saddle') }], ['pig', { saddle: item('saddle') }], ['strider', { saddle: item('saddle') }],
  ['llama', { body: item('red_carpet') }], ['trader_llama', { body: item('blue_carpet') }],
  ['happy_ghast', { body: item('red_harness') }], ['wolf', { body: item('wolf_armor') }],
]) {
  const group = await build(id, { equipment })
  for (const slot of Object.keys(equipment)) assert.ok(group.getObjectByName('equipment_' + slot + '_0'), id + ' ' + slot)
  if (id === 'trader_llama') assert.equal(group.getObjectByName('carpet'), undefined, 'Custom carpet replaces trader layer')
  dispose(group)
}
for (const [damage, crack] of [[0, null], [4, 'low'], [20, 'medium'], [44, 'high']]) {
  const group = await build('wolf', { Sitting: 1, equipment: { body: item('wolf_armor', { 'minecraft:damage': damage }) } })
  const mesh = group.getObjectByName('equipment_body_cracks')
  assert.equal(mesh?.material.map.name ?? null, crack && 'entity/wolf/wolf_armor_crackiness_' + crack)
  dispose(group)
}
const wrong = await build('zombie', { equipment: { head: item('iron_boots') } })
assert.equal(wrong.getObjectByName('equipment_head_0'), undefined)
dispose(wrong)
const left = await build('piglin', { LeftHanded: 1, equipment: { mainhand: item('golden_sword') } })
assert.equal(left.getObjectByName('equipment_mainhand').parent.name, 'left_arm'); dispose(left)
const preview = createFixture(CATALOG.find(e => e.id === 'armor_stand'), { 'nbt.equipment.chest': item('leather_chestplate'), 'preview.equipment_dye': 0xff0000, 'preview.equipment_glint': true })
const dyed = await buildEntityMesh(preview, assets)
assert.equal(dyed.getObjectByName('equipment_chest_0').material.color.getHex(), 0xff0000)
assert.equal(dyed.getObjectByName('equipment_chest_1').material.color.getHex(), 0xffffff, 'Leather overlay must not be dyed')
const glint = dyed.getObjectByName('equipment_chest_glint')
assert.notEqual(glint.material.map, textures.get('misc/enchanted_glint_armor'))
glint.userData.updateAnimation(30)
assert.deepEqual(textures.get('misc/enchanted_glint_armor').offset.toArray(), [0, 0], 'Glint must not mutate shared texture')
dispose(dyed)
assert.equal(JSON.stringify(EQUIPMENT_MODELS), before, 'Equipment models must remain immutable')
console.log(`Passed ${layers} armor layers, adult/baby/Small poses, legacy/modern slots, hand sides, animal equipment, dye, glint, cracks and model isolation`)
