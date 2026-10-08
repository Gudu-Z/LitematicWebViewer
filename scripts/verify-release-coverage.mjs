// Independent 26.3 registry coverage, all block states, and previously missing render paths.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { MOB_TABLE, getMobAppearance } from '../src/entityAppearance.js'
import { buildEntityMesh, buildItemPreview } from '../src/entities.js'
import { BlockModelResolver } from '../src/blocks.js'
import { bakeModel } from '../src/modelBaker.js'
import { movingPistonParts } from '../src/movingPistons.js'
import { Renderer } from '../src/renderer.js'
import { BLOCK_STATES } from './inspection-block-states.js'
import { CATALOG, entityFields } from './inspection-catalog.js'
import { createBlockSampleData, buildInspectionModel, disposeInspectionModel } from './inspection-models.js'
import { extractStatues } from '../src/schematicDetails.js'

const release = JSON.parse(readFileSync(new URL('./minecraft-26.3-mobs.json', import.meta.url)))
assert.equal(release.mobs.length, 90)
assert.deepEqual(Object.keys(MOB_TABLE).sort(), [...release.mobs].sort(), 'Must cover the official mob registry, not just existing fixtures')
assert.deepEqual(CATALOG.filter(e => e.kind === 'mob').map(e => e.id).sort(), [...release.mobs].sort())
const root = new URL('../public/assets/minecraft/', import.meta.url), json = new Map(), textures = new Map(), shared = new Set()
const assets = {
  async getJSON(path) {
    if (path.startsWith('models/builtin/')) return null // Virtual generated/entity item parents have no JSON file.
    if (!json.has(path)) {
      const file = new URL(path, root)
      assert.ok(existsSync(file), 'Missing model/state resource: ' + path)
      json.set(path, JSON.parse(readFileSync(file, 'utf8')))
    }
    return json.get(path)
  },
  async getTexture(key) {
    if (!textures.has(key)) {
      const file = new URL('textures/' + key + '.png', root)
      assert.ok(existsSync(file), 'Missing texture: ' + key)
      const png = readFileSync(file), texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }; texture.name = key
      textures.set(key, texture); shared.add(texture)
    }
    return textures.get(key)
  },
}
const dispose = group => disposeInspectionModel(group, shared)
const entry = id => CATALOG.find(e => e.kind === 'block' && e.id === id)
function* combinations(entries, properties = {}, index = 0) {
  if (index === entries.length) { yield { ...properties }; return }
  const [key, values] = entries[index]
  for (const value of values) { properties[key] = value; yield* combinations(entries, properties, index + 1) }
}
const textureKeys = new Set(), invisible = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void', 'moving_piston'])
let states = 0, quads = 0
for (const [id, [properties]] of Object.entries(BLOCK_STATES)) {
  const resolver = new BlockModelResolver(assets)
  for (const state of combinations(Object.entries(properties))) {
    const baked = await resolver.resolve('minecraft:' + id, state), context = id + ' ' + JSON.stringify(state)
    const emptyExpected = invisible.has(id) || id.endsWith('copper_golem_statue')
      || (id.endsWith('_wall') && state.up === 'false' && ['north', 'south', 'east', 'west'].every(k => state[k] === 'none'))
      || (id === 'pitcher_crop' && state.half === 'upper' && Number(state.age) < 3)
    if (!emptyExpected) assert.ok(baked?.quads.length, 'Unexpected empty model: ' + context)
    for (const quad of baked?.quads || []) {
      assert.ok([...quad.verts.flat(), ...quad.uvs.flat(), ...quad.normal].every(Number.isFinite), 'Invalid vertex/UV/normal: ' + context)
      textureKeys.add(quad.texKey); quads++
    }
    states++
  }
}
assert.equal(Object.keys(BLOCK_STATES).length, 1286)
assert.equal(states, 35723)
for (const key of textureKeys) if (!key.startsWith('special/')) await assets.getTexture(key)

// Reference calculation uses THREE's ZYX Euler matrix, including rescale of each basis column.
// Includes legacy rotations so the hanging-sign fix cannot break resource-pack models.
const model = { textures: { all: 'block/stone' }, elements: [{ from: [1, 2, 3], to: [7, 11, 15], faces: { south: { texture: '#all' } } }] }
const baseVertices = bakeModel(model).quads[0].verts
for (const rotation of [
  { x: 45, y: -22.5, z: 67.5 }, { x: 22.5, y: 45, z: 45, rescale: true },
  { axis: 'y', angle: 22.5, rescale: true }, { axis: 'x', angle: -45 },
]) {
  rotation.origin = [2, 6, 9]
  const radians = ['x', 'y', 'z'].map(axis => (rotation.axis ? rotation.axis === axis ? rotation.angle : 0 : rotation[axis] || 0) * Math.PI / 180)
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...radians, 'ZYX'))
  if (rotation.rescale) for (let c = 0; c < 3; c++) {
    const divisor = Math.max(...matrix.elements.slice(c * 4, c * 4 + 3).map(Math.abs))
    for (let r = 0; r < 3; r++) matrix.elements[c * 4 + r] /= divisor
  }
  const copy = structuredClone(model); copy.elements[0].rotation = rotation
  const origin = new THREE.Vector3(...rotation.origin)
  bakeModel(copy).quads[0].verts.forEach((vertex, i) => {
    const expected = new THREE.Vector3(...baseVertices[i]).multiplyScalar(16).sub(origin).applyMatrix4(matrix).add(origin).divideScalar(16)
    assert.ok(expected.distanceTo(new THREE.Vector3(...vertex)) < 1e-8, 'Element rotation/rescale must match vanilla')
  })
}

function signature(group) {
  group.updateMatrixWorld(true)
  const rows = [], point = new THREE.Vector3()
  group.traverse(mesh => {
    if (!mesh.isMesh) return
    mesh.skeleton?.update()
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld)
      assert.ok(point.toArray().every(Number.isFinite), mesh.name + ' finite world position')
      rows.push(...point.toArray().map(n => Math.round(n * 1e6)))
    }
  })
  assert.ok(rows.length, 'Must have visible geometry')
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
const statueHashes = new Set()
for (const pose of ['standing', 'running', 'sitting', 'star']) {
  const data = await createBlockSampleData(entry('copper_golem_statue'), assets, { copper_golem_pose: pose })
  assert.equal(extractStatues(data)[0].pose, pose, 'Full viewer must forward the saved statue pose')
  const group = await Renderer.buildBlockPreview(data, assets)
  statueHashes.add(signature(group))
  const bounds = new THREE.Box3().setFromObject(group)
  // The tilted foot of the vanilla running pose extends 0.024 blocks below the origin.
  assert.ok(bounds.min.y > -.03 && bounds.max.y > 1.2 && bounds.max.y <= 1.6, 'Statue uses vanilla scale and ground origin')
  dispose(group)
}
assert.equal(statueHashes.size, 4, 'Each statue pose needs its own geometry')
for (const facing of ['north', 'south', 'east', 'west']) {
  const without = await buildInspectionModel(entry('lectern'), assets, { facing, has_book: 'false' })
  const withBook = await buildInspectionModel(entry('lectern'), assets, { facing, has_book: 'true' })
  assert.ok(!without.getObjectByName('lectern-effect'))
  assert.ok(withBook.getObjectByName('lectern-effect')?.children.length)
  assert.notEqual(signature(without), signature(withBook))
  const bounds = new THREE.Box3().setFromObject(withBook.getObjectByName('lectern-effect'))
  assert.ok(bounds.min.y > .7 && bounds.max.y < 1.6, 'Book must rest on the lectern')
  dispose(without); dispose(withBook)
}

// Real piston block-entity schema: all six directions, both motions, actual carried block/state.
const directions = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const piston = { blockState: { Name: 'minecraft:oak_log', Properties: { axis: 'x' } }, progress: .25 }
for (let facing = 0; facing < 6; facing++) for (const extending of [false, true]) {
  const part = movingPistonParts({ ...piston, facing, extending })[0]
  assert.equal(part.name, 'minecraft:oak_log'); assert.equal(part.properties.axis, 'x')
  part.offset.forEach((value, axis) => assert.ok(Math.abs(value - directions[facing][axis] * (extending ? -.75 : .75)) < 1e-8))
}
for (const progress of [0, .25, .5, .75, 1]) {
  const head = movingPistonParts({ ...piston, blockState: { Name: 'minecraft:piston_head' }, progress })
  assert.equal(head[0].properties.short, String(progress <= .5))
  const retract = movingPistonParts({ ...piston, blockState: { Name: 'minecraft:sticky_piston', Properties: { facing: 'east' } }, progress, source: 1, extending: 0 })
  assert.equal(retract.length, 2); assert.equal(retract[0].properties.type, 'sticky')
  assert.equal(retract[0].properties.short, String(progress >= .5))
  assert.equal(retract[1].properties.extended, 'true'); assert.deepEqual(retract[1].offset, [0, 0, 0])
}
for (const nbt of [{}, { blockState: { Name: 'minecraft:air' } }, { blockState: { Name: 'minecraft:moving_piston' } }]) assert.deepEqual(movingPistonParts(nbt), [])
const moving = await createBlockSampleData(entry('moving_piston'), assets, { facing: 'east', preview_moved_block: 'oak_log', preview_progress: '0.25' })
assert.equal(moving.palette[0].baked.quads.length, 0, 'No invented piston head without NBT')
const moved = await Renderer.buildBlockPreview(moving, assets)
assert.equal(moved.getObjectByName('moving-piston-block').position.x, -.75)
assert.ok(moved.getObjectByProperty('isMesh', true).material.map.name.startsWith('block/oak_log'))
signature(moved); dispose(moved)
moving.bounds = { minX: -9, maxX: -9, minY: 7, maxY: 7, minZ: -3, maxZ: -3, width: 1, height: 1, depth: 1 }
Object.assign(moving.tileEntities[0], { x: -9, y: 7, z: -3 })
const builder = Object.create(Renderer.prototype); builder.group = new THREE.Group()
await builder._buildBlockMeshes(moving, assets, null, (x, y, z, relativeY) => { assert.deepEqual([x, y, z, relativeY], [-9, 7, -3, 0]); return false })
assert.equal(builder.group.children.length, 0, 'Hidden regions/layers must also hide moving blocks')
await builder._buildBlockMeshes(moving, assets)
assert.equal(builder.group.getObjectByName('moving-piston-block').position.x, -9.75)
signature(builder.group); dispose(builder.group)

const mob = (id, nbt = {}) => ({ id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt: { Health: 20, OnGround: 0, ...nbt } })
for (const age of [0, -24000]) {
  const cat = getMobAppearance(mob('cat', { Age: age, variant: 'all_black' }), 'cat')
  assert.equal(cat.texture, 'entity/cat/cat_all_black' + (age < 0 ? '_baby' : ''), 'Use the 26.3 black-cat path, without stale local aliases')
}
// Light has no models/item/light.json or textures/item/light.png in a clean 26.3 install.
const lightAssets = { ...assets, async getJSON(path) {
  if (path === 'models/item/light.json') return null
  return assets.getJSON(path)
} }
for (const level of [undefined, ...Array.from({ length: 16 }, (_, i) => String(i))]) {
  const light = await buildItemPreview({ id: 'minecraft:light', components: { 'minecraft:block_state': { level } } }, lightAssets)
  assert.ok(light, 'Selected generated item must render')
  assert.equal(light.getObjectByProperty('isMesh', true).material.map.name, 'item/light_' + String(level ?? 15).padStart(2, '0'))
  dispose(light)
}
for (const id of ['camel_husk', 'nautilus', 'zombie_nautilus', 'parched', 'sulfur_cube']) {
  const group = await buildEntityMesh(mob(id), assets)
  assert.equal(group.userData.mobId, id, 'Must not fall back to brown boxes')
  assert.ok(group.getObjectByName('body').material.map)
  signature(group); dispose(group)
}
for (const id of ['nautilus', 'zombie_nautilus', 'camel_husk', 'parched']) {
  const equipment = id === 'parched' ? { chest: { id: 'minecraft:iron_chestplate' }, mainhand: { id: 'minecraft:bow' } }
    : { saddle: { id: 'minecraft:saddle' }, ...(id.includes('nautilus') ? { body: { id: 'minecraft:diamond_nautilus_armor' } } : {}) }
  const group = await buildEntityMesh(mob(id, { variant: 'warm', equipment }), assets)
  for (const slot of Object.keys(equipment)) assert.ok(group.getObjectByName('equipment_' + slot + (['mainhand', 'offhand'].includes(slot) ? '' : '_0')), id + ' equipment ' + slot)
  signature(group); dispose(group)
}
const warm = getMobAppearance(mob('zombie_nautilus', { variant: 'minecraft:warm' }), 'zombie_nautilus')
assert.ok(warm.model.parts.root.children.shell.children.corals)
const armored = getMobAppearance(mob('zombie_nautilus', { variant: 'warm', equipment: { body: { id: 'minecraft:iron_nautilus_armor' } } }), 'zombie_nautilus')
assert.deepEqual(armored.model.parts.root.children.shell.children.corals.cuboids, [])
for (const id of ['nautilus', 'sulfur_cube']) {
  const adult = await buildEntityMesh(mob(id), assets), baby = await buildEntityMesh(mob(id, { Age: -24000 }), assets)
  assert.notEqual(signature(adult), signature(baby))
  const a = new THREE.Box3().setFromObject(adult).getSize(new THREE.Vector3()), b = new THREE.Box3().setFromObject(baby).getSize(new THREE.Vector3())
  assert.ok(b.length() < a.length() * .75, id + ' juvenile geometry must be smaller')
  dispose(adult); dispose(baby)
}
for (const age of [0, -24000]) {
  const sulfur = await buildEntityMesh(mob('sulfur_cube', { Age: age, equipment: { body: { id: 'minecraft:oak_log', components: { 'minecraft:block_state': { axis: 'x' } } } } }), assets)
  assert.ok(sulfur.getObjectByName('body').material.transparent)
  assert.ok(sulfur.getObjectByName('sulfur_contained_block')); assert.ok(!sulfur.getObjectByName('sulfur_inner'))
  signature(sulfur); dispose(sulfur)
}
for (const id of ['nautilus', 'zombie_nautilus']) {
  const fields = entityFields(CATALOG.find(e => e.kind === 'mob' && e.id === id))
  assert.ok(fields.find(f => f.path === 'nbt.equipment.body').options.some(o => o.value.id === 'minecraft:diamond_nautilus_armor'))
}
console.log(`26.3 覆盖回归通过：${release.mobs.length} 种官方生物、1,286 个方块的 ${states.toLocaleString('en-US')} 个状态、${quads} 个面；新生物/装备/幼体、告示牌旋转、雕像姿势、讲台书本、移动活塞。`)
