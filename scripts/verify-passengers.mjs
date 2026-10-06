// Real textures/models, vanilla seat coordinates and passenger bones (Minecraft 26.3).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { createPassengerEntity } from '../src/entityPassengers.js'
import { BABY_MOBS } from '../src/entityBabies.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { CATALOG, createFixture, entityFields, filterCatalog, setLanguage } from './inspection-catalog.js'
import { applyRidingPreview } from './inspection-riding.js'
import { buildInspectionModel } from './inspection-models.js'
import { optionLabel } from './inspection-i18n.js'
import { ALL_MOB_FIXTURES } from './entity-fixtures.mjs'

const textures = new Map(), root = 'public/assets/minecraft/'
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const path = root + 'textures/' + key + '.png'
      assert.ok(existsSync(path), 'missing texture: ' + key)
      const png = readFileSync(path), texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} != ${b}`)
const mount = (id, passengers = [], rotation = [0, 0]) => ({ id: 'minecraft:' + id, pos: [10, 20, 30], rotation, nbt: { Passengers: passengers } })
const mob = (id, nbt = {}) => ({ id: 'minecraft:' + id, Health: 20, ...nbt })
const passenger = (group, index = 0) => group.children.find(child => child.name === 'passenger-' + index)
const world = group => { group.updateWorldMatrix(true, false); return group.getWorldPosition(new THREE.Vector3()).toArray() }
const dispose = group => group.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
const modelSnapshot = JSON.stringify(ENTITY_MODELS), fixtureSnapshot = JSON.stringify(ALL_MOB_FIXTURES)

// Values from AbstractBoat/Boat/Raft/AbstractChestBoat, AbstractMinecart and EntityTypes.
for (const [vehicle, id, nbt, y] of [
  ['minecart', 'zombie', {}, -.5125], ['minecart', 'villager', {}, 0], ['minecart', 'wandering_trader', {}, 0],
  ['oak_boat', 'pig', {}, .1875], ['bamboo_raft', 'pig', {}, .5],
  ['cushion', 'zombie', {}, -.45], ['cushion', 'zombie', { IsBaby: 1 }, .0625],
  ['cushion', 'zombie_villager', { Age: -24000 }, .125], ['cushion', 'piglin', { IsBaby: 1 }, .0625],
]) {
  const result = createPassengerEntity(mount(vehicle), mob(id, nbt), 0, 1)
  near(result.pos[1], 20 + y, vehicle + '/' + id + ' attachment')
}
const boat = mount('oak_boat', [mob('zombie'), mob('skeleton')], [90, 0])
const group = await buildEntityMesh(boat, assets)
for (const [index, x] of [[0, 9.8], [1, 10.6]]) {
  const rider = passenger(group, index), p = world(rider)
  near(p[0], x, 'rotated seat X'); near(p[1], 19.4875, 'rotated seat Y'); near(p[2], 30, 'rotated seat Z')
  near(rider.rotation.y, -Math.PI / 2, 'rider does not inherit hull rotation correction')
  const body = rider.getObjectByName('body')
  for (const age of [0, 30, 120]) {
    body.userData.updateAnimation(age)
    near(body.userData.parts.right_leg.rotation.x, -1.4137167, 'seated leg persists through idle animation')
    near(body.userData.parts.left_leg.rotation.y, -Math.PI / 10, 'left seated leg yaw')
  }
}
dispose(group)
const pig = createPassengerEntity(mount('oak_boat'), mob('pig'), 0, 2)
near(pig.pos[2], 30.4, 'animal front seat offset')
assert.equal(pig.rotation[0], 90, 'full boat animal faces sideways')
const chestPig = createPassengerEntity(mount('oak_chest_boat'), mob('pig'), 0, 1)
near(chestPig.pos[2], 30.15, 'single chest boat seat is in front of chest')
assert.equal(chestPig.rotation[0], 90)
assert.equal(createPassengerEntity(mount('oak_boat'), mob('breeze', { Rotation: [47, 0] }), 0, 1).rotation[0], 47, 'breeze may turn in boats')

// Cover every supported adult and baby on all three requested vehicle families.
let combinations = 0
for (const vehicle of ['minecart', 'oak_boat', 'cushion']) for (const fixture of ALL_MOB_FIXTURES) {
  const id = fixture.id.slice(10)
  for (const baby of BABY_MOBS.has(id) ? [false, true] : [false]) {
    const rider = { ...structuredClone(fixture.nbt), id: fixture.id, ...(baby ? { Age: -24000 } : {}) }
    const model = await buildEntityMesh(mount(vehicle, [rider]), assets)
    const child = passenger(model)
    assert.equal(child?.userData.mobId, id, `${vehicle}/${id} missing passenger`)
    assert.equal(child.userData.appearance.state.riding, true)
    assert.ok(world(child).every(Number.isFinite), `${vehicle}/${id} invalid coordinates`)
    dispose(model); combinations++
  }
}
// Equipment follows the seated skeleton; the fun option also reaches nested illagers.
const equipped = await buildEntityMesh(mount('cushion', [mob('skeleton', { equipment: { legs: { id: 'minecraft:iron_leggings', count: 1 } } })]), assets)
const rider = passenger(equipped), body = rider.getObjectByName('body')
const armor = rider.children.find(child => child.userData.equipment)
assert.ok(armor, 'seated armor layer missing')
armor.userData.updateAnimation(80)
near(armor.userData.parts.right_leg.rotation.x, body.userData.parts.right_leg.rotation.x, 'leggings follow seated legs')
dispose(equipped)
const illager = await buildEntityMesh({ ...mount('minecart', [mob('vindicator')]), renderOptions: { illagerExtraArms: true } }, assets)
assert.ok(passenger(illager).userData.appearance.model.parts.right_arm.cuboids.length)
near(passenger(illager).getObjectByName('body').userData.parts.right_leg.rotation.x, -1.4137167, 'illager sitting')
dispose(illager)
const nested = await buildEntityMesh(mount('oak_boat', [{ id: 'minecraft:cushion', Passengers: [mob('zombie')] }]), assets)
assert.ok(passenger(passenger(nested)), 'nested Passengers tree missing')
near(world(passenger(passenger(nested)))[1], 20 + .1875 + .25 - .7, 'nested seat transforms')
dispose(nested)
const cycle = mount('cushion'); cycle.nbt.id = cycle.id; cycle.nbt.Passengers = [cycle.nbt]
const safe = await buildEntityMesh(cycle, assets); assert.equal(safe.children.length, 1, 'cyclic input must stop recursion'); dispose(safe)

const entry = key => CATALOG.find(e => e.key === key)
const paths = (key, values = {}) => entityFields(entry(key), values).map(f => f.path)
assert.ok(paths('entity/boat').includes('ridingPreview.passenger0'))
assert.ok(!paths('entity/boat').includes('ridingPreview.passenger1'), 'empty first seat hides second seat')
assert.ok(paths('entity/boat', { 'ridingPreview.passenger0': 'pig' }).includes('ridingPreview.passenger1'))
assert.ok(!paths('entity/boat', { id: 'minecraft:oak_chest_boat', 'ridingPreview.passenger0': 'pig' }).includes('ridingPreview.passenger1'))
assert.ok(!paths('entity/minecart', { id: 'minecraft:chest_minecart' }).includes('ridingPreview.passenger0'), 'storage minecarts have no normal seat')
assert.ok(!paths('entity/cushion', { 'ridingPreview.passenger0': 'skeleton' }).includes('ridingPreview.passenger0Age'))
assert.ok(paths('entity/cushion', { 'ridingPreview.passenger0': 'zombie' }).includes('ridingPreview.passenger0Age'))
const zombie = entry('mob/zombie'), values = { 'ridingPreview.vehicle': 'cushion', 'ridingPreview.color': 'red', 'nbt.Age': -24000 }
const preview = applyRidingPreview(createFixture(zombie, values), zombie)
assert.equal(preview.nbt.color, 'red'); assert.equal(preview.nbt.Passengers[0].Age, -24000)
const inspection = await buildInspectionModel(zombie, assets, values)
assert.equal(passenger(inspection).userData.mobId, 'zombie'); dispose(inspection)
const itemView = await buildInspectionModel(entry('entity/boat'), assets, { 'ridingPreview.passenger0': 'zombie' }, '', 'item')
assert.equal(passenger(itemView), undefined, 'item preview must not show riders'); dispose(itemView)
assert.ok(!filterCatalog('entity', '僵尸').some(match => match.entry.key === 'entity/boat'), 'passenger menu must not pollute name search')
setLanguage('en')
assert.equal(optionLabel(entityFields(entry('entity/boat'), {}).find(f => f.path === 'ridingPreview.passenger0').options.find(o => o.value === 'zombie')), 'Zombie')
setLanguage('zh')
assert.equal(JSON.stringify(ENTITY_MODELS), modelSnapshot, 'passenger poses mutated shared models')
assert.equal(JSON.stringify(ALL_MOB_FIXTURES), fixtureSnapshot, 'passenger previews mutated base fixtures')
console.log(`Passed ${combinations} adult/baby rider combinations, vanilla seats and rotations, animated seated limbs, armor, nested NBT, illager option, cycle guard, catalog capacity/age controls, item views and bilingual search`)
