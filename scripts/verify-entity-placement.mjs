// Source-derived placement checks, in addition to translation precision and pose
// consistency tests. A self-consistent model can still be several blocks away
// from vanilla when a renderer's root transform is missing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { getEntityHitbox } from '../src/entityHitboxes.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'

const ids = JSON.parse(readFileSync(new URL('./minecraft-26.3-mobs.json', import.meta.url))).mobs
const fixtures = JSON.parse(readFileSync(new URL('./entity-placement-fixtures.json', import.meta.url))).cases
const root = 'public/assets/minecraft/', textures = new Map()
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const png = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const scaleAttribute = base => ({ attributes: [{ id: 'minecraft:scale', base }] })
const dispose = group => group.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
const near = (a, b, label) => assert.ok(a.distanceTo(b) < 2e-5, `${label}: ${a.toArray()} != ${b.toArray()}`)
const yRotation = radians => new THREE.Matrix4().makeRotationY(radians)
const update = (group, age) => {
  group.traverse(mesh => mesh.userData.updateAnimation?.(age))
  group.updateMatrixWorld(true)
  group.traverse(mesh => { if (mesh.isSkinnedMesh) mesh.skeleton.update() })
}
const basis = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
let layers = 0
function check(group, expected, label) {
  for (const mesh of group.children.filter(o => o.isSkinnedMesh)) {
    for (const point of basis) near(new THREE.Vector3(...point).applyMatrix4(mesh.matrixWorld), new THREE.Vector3(...point).applyMatrix4(expected), label + '/' + mesh.name)
    // Check real animated surface positions after skinning as well as the frame.
    for (let i = 0; i < mesh.geometry.attributes.position.count; i += 17) {
      const vertex = mesh.getVertexPosition(i, new THREE.Vector3())
      near(vertex.clone().applyMatrix4(mesh.matrixWorld), vertex.applyMatrix4(expected), label + ' surface')
    }
    layers++
  }
}
// Independent LayerDefinitions / MeshTransformer.scaling inventory. These scales
// act around model Y=24; they must not multiply LivingEntityRenderer's .001 offset.
const bakedScales = { polar_bear: 1.2, cat: .8, horse: 1.1, donkey: .87, mule: .92, husk: 1.0625,
  wither_skeleton: 1.2, cave_spider: .7, witch: .9375, ghast: 4.5, elder_guardian: 2.35,
  villager: .9375, wandering_trader: .9375, pillager: .9375, vindicator: .9375, evoker: .9375, illusioner: .9375, happy_ghast: 4, giant: 6 }
const offset = Math.fround(1.501) - 1.5, slight = Math.fround(.999)
let defaults = 0
for (const id of ids.filter(id => id !== 'ender_dragon')) for (const attributeScale of [1, 2.5]) {
  const entity = { id: 'minecraft:' + id, pos: [1234.125, -62.875, 48.5], rotation: [37.125, 0], nbt: { Health: 20, OnGround: 0, ...scaleAttribute(attributeScale) } }
  const group = await buildEntityMesh(entity, assets), modelScale = bakedScales[id] || 1
  update(group, 0)
  const rendererScale = id === 'wither' ? 2 : ['slime', 'sulfur_cube'].includes(id) ? slight : 1
  const scale = modelScale * rendererScale
  let dy = offset * rendererScale, dz = 0
  if (id.endsWith('squid')) dy += .5 + Math.fround(-1.2)
  if (id === 'phantom') { dy -= 1.3125; dz = -.1875 }
  if (id === 'pufferfish') dy += .08
  if (id === 'slime') dy -= slight * Math.fround(.001)
  if (id === 'sulfur_cube') dy = -slight * Math.fround(.001) // Origin already baked in release model data.
  const expected = new THREE.Matrix4().makeTranslation(...entity.pos)
    .multiply(yRotation(-entity.rotation[0] * Math.PI / 180 + (id === 'shulker' ? Math.PI : 0)))
    .multiply(new THREE.Matrix4().makeTranslation(0, dy * attributeScale, dz * attributeScale))
    .scale(new THREE.Vector3().setScalar(scale * attributeScale))
  check(group, expected, id + ' default/attribute=' + attributeScale)
  assert.deepEqual(group.position.toArray(), entity.pos)
  assert.deepEqual(group.userData.entityHitbox.bounds, getEntityHitbox(entity))
  dispose(group); defaults++
}
for (const fixture of fixtures) {
  const { id, yaw, pitch, age, bed, dry, attributeScale = 1 } = fixture
  const entity = { id: 'minecraft:' + id, pos: [7.5, 40.6875, -3.5], rotation: [yaw, pitch], nbt: { Health: 20, OnGround: dry ? 1 : 0, ...fixture.nbt, ...scaleAttribute(attributeScale) } }
  const data = bed ? { bounds: { minX: 7, minY: 40, minZ: -4, width: 1, height: 1, depth: 1 }, blocks: new Map([[0, 0]]), palette: [{ name: 'minecraft:red_bed', properties: { facing: bed } }] } : undefined
  const before = JSON.stringify(entity), group = await buildEntityMesh(entity, assets, data)
  const expected = new THREE.Matrix4().makeTranslation(...entity.pos).multiply(new THREE.Matrix4().fromArray(fixture.matrix))
  for (const time of [age, 0, 400, age]) {
    update(group, time)
    if (time === age) check(group, expected, id + '/' + JSON.stringify(fixture.nbt))
  }
  const parts = group.children.find(m => m.name === 'body').userData.parts
  if (id === 'shulker') assert.equal(parts.head.rotation.y, -Math.PI, 'Shulker head compensates renderer half-turn')
  if (id === 'phantom') assert.equal(parts.head.rotation.x, ENTITY_MODELS.PhantomEntityModel.parts.body.children.head.rot[0], 'Phantom head must not receive the renderer pitch twice')
  assert.deepEqual(group.userData.entityHitbox.bounds, getEntityHitbox(entity))
  assert.deepEqual(group.position.toArray(), entity.pos)
  assert.equal(JSON.stringify(entity), before)
  dispose(group)
}
// AbstractCubeMob.setSize clamps the saved Size + 1 to [1, 127]. The renderer
// and logical dimensions must agree even for command-generated oversized mobs.
for (const id of ['slime', 'magma_cube']) {
  const group = await buildEntityMesh({ id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt: { Size: 999 } }, assets)
  assert.equal(group.scale.x, 127 * (id === 'slime' ? slight : 1))
  assert.equal(group.userData.entityHitbox.bounds.max[1], Math.fround(Math.fround(.52) * 127))
  dispose(group)
}
// AdultTurtleModel moves its entire root up one pixel when carrying an egg.
for (const baby of [false, true]) {
  const turtles = await Promise.all([false, true].map(egg => buildEntityMesh({ id: 'minecraft:turtle', pos: [0, 0, 0], rotation: [0, 0], nbt: { HasEgg: egg, ...(baby ? { Age: -24000 } : {}) } }, assets)))
  turtles.forEach(group => update(group, 0))
  const meshes = turtles.map(g => g.children.find(m => m.name === 'body'))
  const heads = meshes.map(m => m.userData.parts.head.getWorldPosition(new THREE.Vector3()))
  near(heads[1].sub(heads[0]), new THREE.Vector3(0, baby ? 0 : 1 / 16, 0), 'Turtle egg root height')
  turtles.forEach(dispose)
}
// Saved scale affects the whole equipped rider and its riding offset, while the
// vehicle's seat remains at its original location.
for (const vehicle of ['oak_boat', 'minecart', 'cushion']) {
  const group = await buildEntityMesh({ id: 'minecraft:' + vehicle, pos: [2, 10, 4], rotation: [0, 0], nbt: { Passengers: [{ id: 'minecraft:zombie', ...scaleAttribute(2), equipment: { head: { id: 'minecraft:diamond_helmet', count: 1 } } }] } }, assets)
  update(group, 13)
  const rider = group.getObjectByName('passenger-0'), seatY = vehicle === 'cushion' ? .25 : .1875
  near(rider.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(2, 10 + seatY - 1.4, 4), vehicle + ' scaled rider anchor')
  const body = rider.children.find(m => m.name === 'body'), armor = rider.children.find(m => m.userData.equipment)
  assert.ok(armor)
  for (const point of basis) near(new THREE.Vector3(...point).applyMatrix4(body.matrixWorld), new THREE.Vector3(...point).applyMatrix4(armor.matrixWorld), 'Equipped rider transform')
  dispose(group)
}
console.log(`Entity placement: ${defaults} default/scale cases across 89 mobs, ${fixtures.length} vanilla renderer fixtures, ${layers} layer frames; turtle eggs, scaled equipped riders and fixed logical anchors passed (dragon covered separately)`)
