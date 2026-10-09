import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import * as THREE from 'three'
import { ENTITY_DIMENSIONS, BABY_DIMENSIONS } from '../src/entityDimensionData.js'
import { MOB_TABLE } from '../src/entityAppearance.js'
import { buildEntityMesh } from '../src/entities.js'
import { getEntityHitbox, setEntityHitboxesVisible } from '../src/entityHitboxes.js'

const fixture = (id, nbt = {}, pos = [0, 0, 0], rotation = [0, 0]) => ({ id: 'minecraft:' + id, nbt, pos, rotation })
const near = (actual, expected, name = '') => assert.ok(Math.abs(actual - expected) < 1e-6, `${name}: ${actual} != ${expected}`)
function size(id, nbt, expected) {
  const b = getEntityHitbox(fixture(id, nbt))
  expected.forEach((n, i) => near(b.max[i] - b.min[i], n, id + ' axis ' + i))
  return b
}
assert.equal(Object.keys(ENTITY_DIMENSIONS).length, 161)
for (const id of Object.keys(MOB_TABLE)) assert.ok(getEntityHitbox(fixture(id)), id + ': dimensions missing')
for (const [id, [w, h, eye]] of Object.entries(BABY_DIMENSIONS)) {
  const b = size(id, id === 'armor_stand' ? { Small: 1 } : { Age: -24000, IsBaby: 1 }, [w, h, w])
  near(b.eyeHeight, eye, id + ' baby eye')
}
// Independent source expectations: vanilla logic is not the visible model bounds.
size('oak_boat', {}, [1.375, .5625, 1.375])
size('boat', { Type: 'oak' }, [1.375, .5625, 1.375])
size('bamboo_chest_raft', {}, [1.375, .5625, 1.375])
size('cushion', {}, [1, .25, 1])
size('armor_stand', { Marker: 1, Small: 1 }, [0, 0, 0])
size('zombie', { IsBaby: 1 }, [.49, .98, .49])
size('horse', { Age: -1 }, [.9775390625, 1.12, .9775390625])
size('rabbit', { Age: -1 }, [.24, .4, .24])
size('slime', { Size: 3 }, [2.08, 2.08, 2.08])
size('magma_cube', { Size: 1 }, [1.04, 1.04, 1.04])
size('sulfur_cube', {}, [.98, .98, .98])
size('sulfur_cube', { Age: -1 }, [.49, .49, .49])
for (const [state, width] of [[0, .35], [1, .49], [2, .7]]) size('pufferfish', { PuffState: state }, [width, width, width])
size('salmon', { type: 'large' }, [1.05, .6, 1.05])
size('camel', { LastPoseTick: -1 }, [1.7, .945, 1.7])
size('camel', { Sitting: 1, Age: -1 }, [.95, .425, .95])
size('warden', { Pose: 'digging' }, [.9, 1, .9])
size('villager', { sleeping_pos: [1, 2, 3] }, [.2, .2, .2])
size('pig', { attributes: [{ id: 'minecraft:scale', base: 2, modifiers: [{ type: 'add_value', amount: 1 }, { type: 'add_multiplied_base', amount: .5 }, { type: 'add_multiplied_total', amount: 1 }] }] }, [8.1, 8.1, 8.1])
size('pig', { Attributes: [{ Name: 'generic.scale', Base: 2 }] }, [1.8, 1.8, 1.8])
for (let face = 0; face < 6; face++) {
  const axis = face < 2 ? 1 : face < 4 ? 2 : 0
  const b = size('shulker', { AttachFace: face, Peek: 100 }, [0, 1, 2].map(i => i === axis ? 2 : 1))
  near(b.eyeHeight, face === 0 ? 1 : .5)
  const frame = size('item_frame', { Facing: face }, [0, 1, 2].map(i => i === axis ? .0625 : .75))
  frame.min.forEach((n, i) => near(n, -frame.max[i]))
  size('glow_item_frame', { Facing: face, Item: { id: 'minecraft:filled_map' } }, [0, 1, 2].map(i => i === axis ? .0625 : 1))
}
const looking = getEntityHitbox(fixture('pig', {}, [0, 0, 0], [90, 30]))
near(looking.direction[0], -Math.sqrt(3) / 2); near(looking.direction[1], -.5); near(looking.direction[2], 0)
assert.equal(getEntityHitbox(fixture('not_registered')), null)
assert.equal(getEntityHitbox(fixture('__proto__')), null)
const dragon = getEntityHitbox(fixture('ender_dragon', { attributes: [{ id: 'minecraft:scale', base: 2 }] }))
near(dragon.width, 16, 'dragons ignore the scale attribute')
assert.equal(dragon.parts.length, 8)
assert.deepEqual(dragon.parts[0].min, [-.5, 0, -7])
assert.deepEqual(dragon.parts[0].max, [.5, 1, -6])
assert.deepEqual(dragon.parts[5].min, [-1, 1.5, 6.5])
near(getEntityHitbox(fixture('ender_dragon', { DragonPhase: 5 })).parts[0].min[1], -1)
near(getEntityHitbox(fixture('ender_dragon', {}, [0, 0, 0], [90, 0])).parts[0].min[0], 6)

const root = 'public/assets/minecraft/', textures = new Map()
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const png = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.name = key; texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const overlays = root => { const all = []; root.traverse(o => { if (o.userData.isEntityHitbox) all.push(o) }); return all }
let models = 0
for (const pos of [[7.25, 2.625, -3.125], [29999980.25, -12.375, -29999979.625]]) {
  for (const [id, nbt] of [
    ['pig', {}], ['zombie', { IsBaby: 1 }], ['armor_stand', { Small: 1 }],
    ['oak_chest_boat', {}], ['bamboo_raft', {}], ['minecart', {}], ['slime', { Size: 3 }],
    ['item_frame', { Facing: 5 }], ['shulker', { Peek: 100, AttachFace: 5 }],
    ['ender_dragon', {}],
    ['oak_boat', { Passengers: [{ id: 'minecraft:zombie', IsBaby: 1 }, { id: 'minecraft:pig', Age: -1 }] }],
    ['cushion', { Passengers: [{ id: 'minecraft:armor_stand', Small: 1, Passengers: [{ id: 'minecraft:cat', Age: -1 }] }] }],
  ]) for (const yaw of [0, 90, 237.5]) {
    const entity = fixture(id, nbt, pos, [yaw, 0]), before = JSON.stringify(entity)
    const model = await buildEntityMesh(entity, assets)
    assert.ok(model, id); assert.equal(overlays(model).length, 0, 'off allocates no debug meshes')
    model.updateMatrixWorld(true)
    setEntityHitboxesVisible(model, true); model.updateMatrixWorld(true)
    const all = overlays(model)
    assert.equal(all.length, nbt.Passengers ? 3 : 1, id + ' one overlay per entity')
    const first = all.find(o => o.parent === model), b = getEntityHitbox(entity)
    assert.ok(first)
    // Only the first 24 vertices are the white box. The arrow/eye box are not its bounds.
    const whiteBox = new THREE.Box3(), vertex = new THREE.Vector3()
    for (let i = 0; i < 24; i++) whiteBox.expandByPoint(vertex.fromBufferAttribute(first.geometry.attributes.position, i).applyMatrix4(first.matrixWorld))
    for (let i = 0; i < 3; i++) { near(whiteBox.min.getComponent(i), pos[i] + b.min[i], id); near(whiteBox.max.getComponent(i), pos[i] + b.max[i], id) }
    if (id === 'oak_boat' && nbt.Passengers) {
      const child = model.children.find(o => o.name === 'passenger-0'), overlay = overlays(child)[0]
      const origin = new THREE.Vector3().applyMatrix4(overlay.matrixWorld)
      const angle = yaw * Math.PI / 180
      near(origin.x, pos[0] - Math.sin(angle) * .2)
      near(origin.y, pos[1]) // boat seat .1875, baby zombie riding offset -.1875
      near(origin.z, pos[2] + Math.cos(angle) * .2)
      const colors = overlay.geometry.attributes.color
      let yellow = 0
      for (let i = 0; i < colors.count; i++) if (colors.getX(i) === 1 && colors.getY(i) === 1 && colors.getZ(i) === 0) yellow++
      assert.equal(yellow, 24)
    }
    setEntityHitboxesVisible(model, false)
    assert.ok(all.every(o => !o.visible))
    setEntityHitboxesVisible(model, true)
    assert.deepEqual(overlays(model), all, 'toggle reuses resources')
    assert.equal(JSON.stringify(entity), before, 'source NBT unchanged')
    JSON.stringify(model.userData) // no circular debug references in Three.js metadata
    model.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
    models++
  }
}
const hidden = await buildEntityMesh(fixture('armor_stand', { Invisible: 1 }), assets)
setEntityHitboxesVisible(hidden, true); assert.equal(overlays(hidden).length, 0, 'F3+B skips invisible entities')
console.log(`Entity hitboxes: ${Object.keys(MOB_TABLE).length} mobs, 43 baby dimensions, saved-state overrides and ${models} rotated/large-coordinate/passenger model cases passed.`)
