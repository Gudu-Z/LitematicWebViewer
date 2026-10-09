// Minecraft 26.3 default minecart renderer: rail sampling, model pivot and contents.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { compileModel } from '../src/entityModel.js'
import { minecartRenderPose } from '../src/entityMinecart.js'
import { setEntityHitboxesVisible } from '../src/entityHitboxes.js'

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
function world(cells, origin = [0, 0, 0], name = 'rail') {
  const positions = cells.map(c => c.slice(0, 3).map((n, axis) => n + origin[axis]))
  const min = [0, 1, 2].map(i => Math.min(...positions.map(p => p[i])))
  const max = [0, 1, 2].map(i => Math.max(...positions.map(p => p[i])))
  const [width, height, depth] = max.map((n, i) => n - min[i] + 1)
  const bounds = { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2], width, height, depth }
  const palette = cells.map(c => ({ name: 'minecraft:' + name, properties: { shape: c[3] } }))
  const blocks = new Map(positions.map(([x, y, z], i) => [x - min[0] + (z - min[2]) * width + (y - min[1]) * width * depth, i]))
  return { bounds, palette, blocks }
}
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 2e-6, `${label}: ${a} != ${b}`)
const vectorNear = (a, b, label) => a.forEach((v, i) => near(v, b[i], label + ' axis ' + i))
const dispose = group => group.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
const translation = xyz => new THREE.Matrix4().makeTranslation(...xyz)
const rotationY = degrees => new THREE.Matrix4().makeRotationY(degrees * Math.PI / 180)
const rotationZ = degrees => new THREE.Matrix4().makeRotationZ(degrees * Math.PI / 180)
const distance = Math.fround(.3), quads = compileModel(ENTITY_MODELS.MinecartEntityModel)
const offsets = { chest_minecart: 8, hopper_minecart: 1, furnace_minecart: 6, tnt_minecart: 6, command_block_minecart: 6, spawner_minecart: 6 }
let cases = 0, vertices = 0
async function check(entity, data, center, front, back) {
  const before = JSON.stringify(entity)
  let yaw = entity.rotation[0], pitch = entity.rotation[1]
  let pivot = entity.pos.map((n, i) => n + (i === 1 ? .375 : 0))
  if (center) {
    const delta = new THREE.Vector3(...back).sub(new THREE.Vector3(...front)).normalize()
    yaw = Math.fround(Math.atan2(delta.z, delta.x) * 180 / Math.PI)
    pitch = Math.fround(Math.atan(delta.y) * 73)
    pivot = [center[0], (front[1] + back[1]) / 2 + .375, center[2]]
  }
  // The original renderer matrix, operating on Minecraft's Y-down model coordinates.
  const vanilla = translation(pivot).multiply(rotationY(Math.fround(180 - yaw))).multiply(rotationZ(-pitch))
  const hullMatrix = vanilla.clone().scale(new THREE.Vector3(-1, -1, 1))
  const model = await buildEntityMesh(entity, assets, data), hull = model.getObjectByName('minecart-body')
  assert.ok(hull, entity.id)
  model.updateMatrixWorld(true)
  for (let i = 0; i < quads.length; i++) for (let k = 0; k < 4; k++) {
    const [x, y, z] = quads[i].verts[k]
    const expected = new THREE.Vector3(x, 1.5 - y, -z).applyMatrix4(hullMatrix)
    const actual = hull.getVertexPosition(i * 4 + k, new THREE.Vector3()).applyMatrix4(hull.matrixWorld)
    assert.ok(actual.distanceTo(expected) < 2e-6, `${entity.id}: hull vertex ${i * 4 + k} at ${entity.pos}`)
    vertices++
  }
  const offset = offsets[entity.id.slice(10)]
  if (offset != null) {
    const contents = model.getObjectByName('minecart-contents')
    assert.ok(contents, entity.id + ' contents')
    const expected = vanilla.clone().scale(new THREE.Vector3(.75, .75, .75))
      .multiply(translation([-.5, (offset - 8) / 16, .5])).multiply(rotationY(90)).multiply(translation([.5, .5, .5]))
    vectorNear(contents.matrixWorld.elements, expected.elements, entity.id + ' contents matrix')
  }
  setEntityHitboxesVisible(model, true); model.updateMatrixWorld(true)
  const overlay = model.children.find(o => o.userData.isEntityHitbox)
  assert.ok(overlay, 'root hitbox')
  vectorNear(new THREE.Vector3().applyMatrix4(overlay.matrixWorld).toArray(), entity.pos, 'hitbox remains at saved Pos')
  const corners = new THREE.Box3()
  for (let i = 0; i < 24; i++) corners.expandByPoint(new THREE.Vector3().fromBufferAttribute(overlay.geometry.attributes.position, i).applyMatrix4(overlay.matrixWorld))
  vectorNear(corners.min.toArray(), entity.pos.map((n, i) => n - (i === 1 ? 0 : Math.fround(.98) / 2)), 'axis-aligned hitbox')
  const passenger = model.children.find(o => o.name === 'passenger-0')
  if (passenger) {
    vectorNear(passenger.getWorldPosition(new THREE.Vector3()).toArray(), entity.pos.map((n, i) => n + (i === 1 ? .1875 : 0)), 'passenger does not inherit model tilt/offset')
    const angles = new THREE.Euler().setFromQuaternion(passenger.getWorldQuaternion(new THREE.Quaternion()))
    near(angles.x, 0, 'passenger pitch'); near(angles.z, 0, 'passenger roll')
  }
  assert.equal(JSON.stringify(entity), before, 'saved coordinates and NBT unchanged')
  dispose(model); cases++
}

// Each track has flat rails at both ends of its slope. Expected heights are the
// analytic ramp y=clamp(t,0,1)+1/16; samples cross both block and height boundaries.
for (const origin of [[0, 0, 0], [-31, -12, 17], [29999980, 250, -29999980]]) {
  for (const [shape, axis, sign] of [['ascending_east', 0, 1], ['ascending_west', 0, -1], ['ascending_south', 2, 1], ['ascending_north', 2, -1]]) {
    const straight = axis === 0 ? 'east_west' : 'north_south'
    const cells = [-1, 0, 1].map(p => axis === 0 ? [p, p * sign > 0 ? 1 : 0, 0, p === 0 ? shape : straight] : [0, p * sign > 0 ? 1 : 0, p, p === 0 ? shape : straight])
    for (const name of ['rail', 'powered_rail', 'detector_rail', 'activator_rail']) {
      const data = world(cells, origin, name)
      const point = t => {
        const p = [.5, .0625 + Math.max(0, Math.min(1, t)), .5]
        p[axis] = sign > 0 ? t : 1 - t
        return p.map((n, i) => n + origin[i])
      }
      for (const t of [-.1, .05, .2, .5, .8, .95, 1.1]) {
        const pos = point(t), front = point(t + sign * distance), back = point(t - sign * distance)
        // A cross-track saved offset must affect only the model snap, not the hitbox.
        const saved = [...pos]; saved[axis === 0 ? 2 : 0] += .12
        for (const id of name === 'rail' ? ['minecart', ...Object.keys(offsets)] : ['minecart']) {
          const nbt = id === 'minecart' && t === .5 ? { Passengers: [{ id: 'minecraft:pig', Rotation: [0, 0] }] } : {}
          await check({ id: 'minecraft:' + id, pos: saved, rotation: [137, 12], nbt }, data, pos, front, back)
        }
      }
    }
  }
}

// The tangent of a corner joins its two exits; a vector pointing into the corner
// would turn the model 90 degrees the wrong way. Neighbouring straights smooth yaw.
for (const [shape, center, tangent] of [
  ['south_east', [.75, .0625, .75], [1, 0, -1]], ['south_west', [.25, .0625, .75], [-1, 0, -1]],
  ['north_west', [.25, .0625, .25], [-1, 0, 1]], ['north_east', [.75, .0625, .25], [1, 0, 1]],
]) {
  const delta = tangent.map(n => n * distance / Math.sqrt(2))
  await check({ id: 'minecraft:minecart', pos: center, rotation: [0, 0], nbt: {} }, world([[0, 0, 0, shape]]), center, center.map((n, i) => n + delta[i]), center.map((n, i) => n - delta[i]))
}
const corner = world([[0, 0, 0, 'south_east'], [1, 0, 0, 'east_west'], [0, 0, 1, 'north_south']])
const d = distance / Math.sqrt(2)
for (const [center, front, back] of [
  [[.98, .0625, .52], [.98 + d, .0625, .5], [.98 - d, .0625, .52 + d]],
  [[.52, .0625, .98], [.52 + d, .0625, .98 - d], [.5, .0625, .98 + d]],
]) await check({ id: 'minecraft:chest_minecart', pos: center, rotation: [0, 0], nbt: {} }, corner, center, front, back)

// Missing track samples fall back to the current rail position, as in oldExtractState.
const isolated = world([[0, 0, 0, 'ascending_east']]), pos = [.05, .1125, .5]
await check({ id: 'minecraft:minecart', pos, rotation: [0, 0], nbt: {} }, isolated, pos, [.05 + distance, .1125 + distance, .5], pos)
for (const [shape, axis] of [['east_west', 0], ['north_south', 2]]) {
  const cells = [-1, 0, 1].map(p => axis === 0 ? [p, 0, 0, shape] : [0, 0, p, shape])
  const center = [.5, .0625, .5], front = [...center], back = [...center]
  front[axis] += distance; back[axis] -= distance
  await check({ id: 'minecraft:minecart', pos: center, rotation: [45, 15], nbt: {} }, world(cells), center, front, back)
}
// The vanilla lookup prioritizes a rail below, even if the current block is also a rail.
const stacked = world([[-1, 0, 0, 'east_west'], [0, 0, 0, 'east_west'], [1, 0, 0, 'east_west'], [0, 1, 0, 'north_south']])
await check({ id: 'minecraft:minecart', pos: [.5, 1.0625, .5], rotation: [0, 0], nbt: {} }, stacked, [.5, .0625, .5], [.5 + distance, .0625, .5], [.5 - distance, .0625, .5])
// No rail: use saved rotation, including pitch, with the same unrotated lift.
for (const yaw of [0, 90, 213.5]) for (const pitch of [-45, 0, 37]) {
  await check({ id: 'minecraft:minecart', pos: [1.25, 3.375, -5.625], rotation: [yaw, pitch], nbt: {} }, undefined)
}
const outside = { id: 'minecraft:minecart', pos: [-.25, .0625, 1.25], rotation: [33, 17], nbt: {} }
assert.deepEqual(minecartRenderPose(outside, world([[0, 0, 0, 'east_west']])), minecartRenderPose(outside), 'out-of-bounds keys must not wrap to another rail')
console.log(`Minecarts: ${cases} cases / ${vertices} hull vertices; all slopes and rail types, transitions, curves, seven cart types, contents, passengers and fixed hitboxes passed.`)
