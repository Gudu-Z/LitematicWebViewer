import assert from 'node:assert/strict'
import * as THREE from 'three'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { blockFaceKeys, setBlockFaceKeys, markBlockObject, markEntityObject, blockKey } from '../src/selectionSources.js'
import { pickSchematic, sourceForIntersection, visibleIntersection, selectionBounds } from '../src/selectionPicking.js'
import { inspectSelection, readInventory, savedMaxHealth, facingFromYaw, textComponent } from '../src/selectionDetails.js'
import { mergeTranslucentBlocks } from '../src/translucentBlocks.js'
import { batchItemFrames, updateFrameBatches, frameInstanceRoot } from '../src/frameBatches.js'
import { registerEntityHitbox } from '../src/entityHitboxes.js'

const box = (from, to, texture = 'block/stone') => bakeModel({ textures: { all: texture }, elements: [{ from, to,
  faces: Object.fromEntries(['up', 'down', 'north', 'south', 'east', 'west'].map(face => [face, { texture: '#all', cullface: face }])) }] })
const bounds = { minX: -3, minY: -2, minZ: -4, width: 3, height: 3, depth: 3 }
const data = { bounds, palette: [
  { name: 'minecraft:stone', properties: {}, baked: box([0, 0, 0], [16, 16, 16]) },
  { name: 'minecraft:oak_slab', properties: { type: 'bottom' }, baked: box([0, 0, 0], [16, 8, 16]) },
], blocks: new Map([[0, 1], [2, 0], [6, 0], [9, 0]]), tileEntities: [], regions: [] }
const { groups } = await buildFaceGroups(data.palette, data.blocks, bounds, null, null, { trackBlocks: true })
const group = new THREE.Group()
for (const [name, g] of groups) {
  assert.ok(g.blockKeys instanceof Uint32Array)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3)); geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(g.indices, 1)); setBlockFaceKeys(geometry, g.blockKeys)
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
}
const renderer = { group, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 1, .01, 100),
  renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } }
renderer.scene.add(group)
const pick = (eye, target) => {
  renderer.camera.position.set(...eye); renderer.camera.lookAt(...target)
  return pickSchematic(renderer, data, 50, 50)
}
assert.equal(pick([-2.5, -1.75, -8], [-2.5, -1.75, -3.5]).key, 0, 'lower slab face selects its own cell')
assert.equal(pick([-2.5, -1.25, -8], [-2.5, -1.25, -3.5]).key, 6, 'ray passes above half slab to cube behind')
assert.equal(pick([-.5, -1.5, -8], [-.5, -1.5, -3.5]).key, 2, 'same-texture mesh retains distinct source cells')
group.visible = false
assert.equal(pick([-.5, -1.5, -8], [-.5, -1.5, -3.5]), null, 'hidden parents are not selectable')
group.visible = true
const ortho = new THREE.OrthographicCamera(-2, 2, 2, -2, .01, 100); renderer.camera = ortho
assert.equal(pick([-.5, -1.5, -8], [-.5, -1.5, -3.5]).key, 2, 'orthographic ray')

// Large sparse grids cannot use truncated 32-bit keys.
const huge = { minX: 0, minY: 0, minZ: 0, width: 100000, height: 100000, depth: 2 }, key = 9_000_000_001
const large = await buildFaceGroups(data.palette, new Map([[key, 0]]), huge, null, null, { trackBlocks: true })
for (const g of large.groups.values()) { assert.ok(g.blockKeys instanceof Float64Array); assert.ok(g.blockKeys.every(k => k === key)) }
assert.equal(blockKey([100000, 0, 0], huge), null)

// Camera sorting changes triangle order but not provenance. Exercise the merged
// multi-texture path as well as the >8-texture fallback and cloned frame items.
const translucent = []
for (let i = 0; i < 10; i++) {
  const geometry = group.children[0].geometry.clone()
  setBlockFaceKeys(geometry, blockFaceKeys(group.children[0].geometry).map(k => k + i * 100))
  translucent.push(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: new THREE.Texture(), transparent: true })))
}
const merged = mergeTranslucentBlocks(translucent.slice(0, 2))
const m = merged[0]; m.updateMatrixWorld(true)
m.onBeforeRender(null, null, renderer.camera)
for (let i = 0; i < m.geometry.index.count; i += 3) {
  const a = m.geometry.index.getX(i), hit = { object: m, face: { a }, faceIndex: i / 3 }
  assert.equal(sourceForIntersection(hit, data).key, blockFaceKeys(m.geometry)[Math.floor(a / 4)])
}
assert.equal(blockFaceKeys(m.clone().geometry), blockFaceKeys(m.geometry))
const fallback = mergeTranslucentBlocks(translucent.slice(1))
assert.ok(fallback.length > 9); assert.ok(fallback.every(mesh => blockFaceKeys(mesh.geometry)?.length === 1))

// True cutout holes permit selecting the next model, opaque texels do not.
const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]), 2, 1)
const cutout = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture, alphaTest: .5 }))
assert.equal(visibleIntersection({ object: cutout, uv: new THREE.Vector2(.1, .5) }), false)
assert.equal(visibleIntersection({ object: cutout, uv: new THREE.Vector2(.9, .5) }), true)

// Special block meshes may extend outside their owning cell (banner or piston).
const piston = markBlockObject(new THREE.Group(), 12, 3, 4)
const banner = markBlockObject(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()), 0, 0, 0)
piston.add(banner)
assert.deepEqual(sourceForIntersection({ object: banner }, data).position, [12, 3, 4])

const entityGroup = new THREE.Group(), frames = [], frameGeometry = new THREE.BoxGeometry(), frameMaterial = new THREE.MeshBasicMaterial()
for (let i = 0; i < 3; i++) {
  const root = markEntityObject(new THREE.Group(), { id: 'minecraft:item_frame', pos: [i, 0, 0], nbt: { marker: i } })
  root.position.x = i; root.add(new THREE.Mesh(frameGeometry, frameMaterial)); entityGroup.add(root); frames.push(root)
}
batchItemFrames(entityGroup, frames)
const batch = entityGroup.children.find(o => o.isInstancedMesh)
assert.equal(frameInstanceRoot(batch, 1), frames[1])
frames[0].visible = false; updateFrameBatches(entityGroup)
assert.equal(sourceForIntersection({ object: batch, instanceId: 0 }, data).entity.nbt.marker, 1)
assert.equal(frameInstanceRoot(batch, 1), frames[2]); assert.equal(frameInstanceRoot(batch, 2), null)
const passenger = registerEntityHitbox(new THREE.Group(), { id: 'minecraft:zombie', pos: [0, 1, 0], nbt: { Health: 7, UUID: 1n } })
passenger.position.y = 1; passenger.add(new THREE.Mesh(frameGeometry, frameMaterial)); frames[1].add(passenger)
assert.equal(sourceForIntersection({ object: passenger.children[0] }, data).entity.id, 'minecraft:zombie')
assert.ok(Number.isFinite(selectionBounds({ kind: 'entity', root: passenger }).min.x))
assert.doesNotThrow(() => passenger.clone(), 'raw BigInt NBT is not stored in cloneable userData')

const oldItems = { Items: [{ Slot: 0, id: 'minecraft:diamond', Count: 64 }, { Slot: 26, id: 'minecraft:stone', Count: 3 }] }
const newItems = { Items: [{ Slot: 4, id: 'minecraft:apple', count: 2, components: { 'minecraft:custom_name': { text: '<script>saved name</script>' } } }] }
assert.deepEqual([readInventory(oldItems, 'chest').occupied, readInventory(oldItems, 'chest').total], [2, 67])
assert.equal(readInventory(newItems, 'waxed_oxidized_copper_chest').capacity, 27)
assert.equal(readInventory({ Items: [] }, 'barrel').known, true)
assert.equal(readInventory({}, 'barrel').known, false)
assert.equal(readInventory(undefined, 'barrel').known, false)
assert.equal(readInventory({ LootTable: 'minecraft:chests/simple_dungeon' }, 'chest').lootTable, 'minecraft:chests/simple_dungeon')
assert.equal(readInventory({ Item: { id: 'minecraft:diamond_sword', Count: 1 } }, 'item_frame').total, 1)
assert.equal(readInventory({ item: { id: 'minecraft:diamond', count: 12 } }, 'decorated_pot').total, 12)
assert.equal(readInventory({ Items: [{ Slot: -1, id: 'minecraft:diamond', Count: 1 }] }, 'mod:crate').entries[0].slot, 255)
assert.equal(readInventory({ Items: [{ Slot: 0, id: 'minecraft:air', Count: 1 }, { Slot: 1, id: 'minecraft:stone', Count: 0 }] }, 'chest').total, 0)
assert.equal(readInventory({ components: { 'minecraft:container': [{ slot: 3, item: { id: 'minecraft:stone', count: 16 } }] } }, 'shulker_box').total, 16)

const chestData = { ...data, palette: [
  { name: 'minecraft:chest', properties: { type: 'left', facing: 'north', waterlogged: 'false' } },
  { name: 'minecraft:chest', properties: { type: 'right', facing: 'north', waterlogged: 'false' } },
], blocks: new Map([[0, 0], [1, 1]]), tileEntities: [
  { x: -3, y: -2, z: -4, id: 'minecraft:chest', nbt: oldItems, region: 'negative region' },
  { x: -2, y: -2, z: -4, id: 'minecraft:chest', nbt: newItems, region: 'negative region' },
] }
const details = inspectSelection(chestData, { kind: 'block', key: 0, position: [-3, -2, -4] })
assert.equal(details.containers.length, 2); assert.equal(details.containers[1].total, 2)
assert.equal(details.properties.waterlogged, 'false'); assert.deepEqual(details.regions, ['negative region'])
const zombie = inspectSelection(data, { kind: 'entity', entity: { id: 'minecraft:zombie', pos: [1.25, 2.75, -4.5], rotation: [-90, 15], nbt: {
  Health: 0, Attributes: [{ Name: 'minecraft:generic.max_health', Base: 20 }], ArmorItems: [{}, {}, {}, { id: 'minecraft:iron_helmet', Count: 1 }],
} } })
assert.equal(zombie.health, 0); assert.equal(zombie.maxHealth, 20); assert.equal(zombie.facing, 'east'); assert.equal(zombie.equipment[0][0], 'head')
assert.equal(inspectSelection(data, { kind: 'entity', entity: { id: 'minecraft:cow', pos: [0, 0, 0], nbt: {} } }).health, null)
assert.equal(savedMaxHealth({ attributes: [{ id: 'minecraft:max_health', base: 20, modifiers: [{ amount: 4, operation: 'add_value' }, { amount: .5, operation: 'add_multiplied_base' }, { amount: .5, operation: 'add_multiplied_total' }] }] }), 54)
assert.deepEqual([0, 90, 180, -90, 360].map(facingFromYaw), ['south', 'west', 'north', 'east', 'south'])
assert.equal(textComponent('{"text":"Chest","extra":[{"text":" name"}]}'), 'Chest name')
const sign = inspectSelection({ ...data, blocks: new Map([[0, 0]]), palette: [{ name: 'minecraft:oak_sign', properties: { rotation: '0' } }],
  tileEntities: [{ x: -3, y: -2, z: -4, id: 'minecraft:sign', nbt: { front_text: { messages: ['{"text":"Hello"}', { text: 'World' }, '', ''] }, back_text: { messages: ['', '', '', ''] } } }],
}, { kind: 'block', key: 0, position: [-3, -2, -4] })
assert.deepEqual(sign.texts, [{ side: 'front', text: 'Hello\nWorld\n\n' }, { side: 'back', text: '\n\n\n' }])
console.log('Selection verified: exact faces, partial/hidden blocks, orthographic camera, large keys, translucent sorting, alpha holes, special models, batched frames, passengers, old/new inventories, double chests and saved entity data.')
