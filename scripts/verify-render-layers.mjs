import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'

const root = 'public/assets/minecraft/', textures = new Map()
let requests = 0, disposed = 0
const assets = {
  async getJSON(path) { requests++; return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    requests++
    if (!textures.has(key)) {
      const png = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      texture.addEventListener('dispose', () => disposed++)
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const renderer = Object.create(Renderer.prototype)
renderer.scene = new THREE.Scene()
const groups = ['entitiesGroup', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']
for (const key of ['group', ...groups]) { renderer[key] = new THREE.Group(); renderer.scene.add(renderer[key]) }
// Canvas text/pattern composition is covered by the browser check; use real
// block/entity geometry here without constructing a DOM or WebGL context.
renderer._makeSignTexture = () => new THREE.Texture()
renderer._makeBannerTexture = async () => new THREE.Texture()
const entity = (id, y, nbt = {}) => ({ id: 'minecraft:' + id, pos: [1.5, y, 1.5], rotation: [0, 0], nbt })
const entries = [entity('zombie', -2), entity('unsupported', 99), entity('item_frame', -.01, { Facing: 3 }),
  entity('armor_stand', 0, { Invisible: 1 }), entity('pig', .999), entity('cow', 1),
  entity('oak_boat', 2.25, { Passengers: [{ id: 'minecraft:pig', Pos: [1.5, 3.5, 1.5], Rotation: [0, 0] }] })]
await renderer.renderEntities(entries, assets)
assert.equal(renderer.entitiesGroup.children.length, 6, 'Unsupported entities must not shift saved-layer associations')
assert.deepEqual(renderer.entitiesGroup.children.map(o => o.userData.schematicLayer), [-2, -1, 0, 0, 1, 2])
assert.equal(renderer.entitiesGroup.children[1].position.y, 0, 'Frame vertices use world coordinates, so object.position is not its saved layer')
renderer.setEntityHitboxesVisible(true)
const original = [...renderer.entitiesGroup.children], requestCount = requests, disposeCount = disposed
const layers = () => renderer.entitiesGroup.children.filter(o => o.visible).map(o => o.userData.schematicLayer)
renderer.setLayerVisibility('single', -1); assert.deepEqual(layers(), [-1], 'Floor negative fractional Y instead of truncating it')
renderer.setLayerVisibility('single', 0); assert.deepEqual(layers(), [0, 0], 'Whole models use their saved Y cell')
renderer.setLayerVisibility('below', 0); assert.deepEqual(layers(), [-2, -1, 0, 0], 'Below includes the selected layer')
renderer.setLayerVisibility('above', 0); assert.deepEqual(layers(), [0, 0, 1, 2], 'Above includes the selected layer')
renderer.setLayerVisibility('all', 999); assert.deepEqual(layers(), [-2, -1, 0, 0, 1, 2])
assert.deepEqual(renderer.entitiesGroup.children, original, 'Layer changes retain the same animated models')
assert.equal(requests, requestCount, 'No texture/model reloading while changing layers')
assert.equal(disposed, disposeCount, 'Layer changes must not dispose shared textures')
assert.equal(original[2].getObjectByName('body').material.visible, false, 'NBT invisibility survives all/single toggles')
renderer.setEntitiesVisible(false)
renderer.setLayerVisibility('single', -1)
assert.equal(renderer.entitiesGroup.visible, false, 'Layer updates preserve the global entity toggle')
renderer.setEntitiesVisible(true); assert.deepEqual(layers(), [-1])
renderer.setLayerVisibility('single', 2)
let passengers = 0, overlays = 0
renderer.entitiesGroup.traverseVisible(o => { if (o.userData.isPassenger) passengers++; if (o.userData.isEntityHitbox) overlays++ })
assert.equal(passengers, 1, 'Rider follows its vehicle as one complete model')
assert.ok(overlays >= 2)
renderer.setLayerVisibility('single', 3)
overlays = 0; renderer.entitiesGroup.traverseVisible(o => { if (o.userData.isEntityHitbox) overlays++ })
assert.equal(overlays, 0, 'Hidden entities also hide their F3+B overlays')
console.log('PASS entity layers: fractional/negative positions, frames, vehicles, invisibility, hitboxes and model reuse')

renderer.setLayerVisibility('single', -1)
await renderer.renderSigns([-1, 4].map(y => ({ x: 0, y, z: 0, lines: ['test'], rotation: 0 })), assets)
await renderer.renderPlayerHeads([-1, 4].map(y => ({ x: 0, y, z: 0, rotation: 0 })), assets)
await renderer.renderBanners([{ x: 0, y: -1, z: 0, rotation: 0 }, { x: 0, y: 4, z: 0, facing: 'north' }], assets)
await renderer.renderStatues([-1, 4].map(y => ({ x: 0, y, z: 0, facing: 'north', pose: 'standing', texKey: 'entity/copper_golem/copper_golem' })), assets)
await renderer.renderDecoratedPots([-1, 4].map(y => ({ x: 0, y, z: 0, facing: 'north', sherds: {} })), assets)
for (const key of groups.slice(1)) {
  assert.deepEqual(renderer[key].children.map(o => o.visible), [true, false], key + ': newly built objects inherit the active layer')
}
assert.equal(renderer.bannersGroup.children[0].position.y, 0, 'Standing flag extends into the next layer')
assert.equal(renderer.bannersGroup.children[0].visible, true, 'Flag follows its block rather than its offset geometry')
renderer.setLayerVisibility('above', 0)
for (const key of groups.slice(1)) assert.deepEqual(renderer[key].children.map(o => o.visible), [false, true], key)
renderer.setLayerVisibility('single', -1)
console.log('PASS signs, heads, flags, statues and pots follow their source layers')

// A resource-pack or region rebuild happens while the filter is already active.
await renderer.renderEntities([entity('pig', -1), entity('cow', 4)], assets)
assert.deepEqual(layers(), [-1])
renderer.setLayerVisibility('all', 0)
assert.deepEqual(layers(), [-1, 4])
for (const key of groups.slice(1)) assert.ok(renderer[key].children.every(o => o.visible), key + ': all restores the complete scene')
console.log('PASS regenerated entities inherit the current mode and all mode restores visibility')
