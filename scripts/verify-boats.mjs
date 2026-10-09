// Minecraft 26.3 AbstractBoatRenderer.submit, BoatModel.createChestBoatModel,
// RaftModel.createChestRaftModel: model-space Y=0 is Pos.y + 0.375, not the waterline.
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'
import { compileModel } from '../src/entityModel.js'

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
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 2e-5, `${message}: ${a} != ${b}`)
const rotationY = angle => new THREE.Matrix4().makeRotationY(angle)
const vertex = (mesh, index) => mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
function bounds(mesh, start, count) {
  const box = new THREE.Box3()
  for (let i = start; i < start + count; i++) box.expandByPoint(vertex(mesh, i))
  return box
}
const woodTypes = readdirSync(root + 'textures/entity/boat').filter(n => n.endsWith('.png')).map(n => n.slice(0, -4))
const snapshot = JSON.stringify([ENTITY_MODELS.BoatEntityModel, EXTRA_MODELS.RaftModel])
let variants = 0
for (const wood of woodTypes) for (const chest of [false, true]) for (const yaw of [0, 90, 217.125, 270]) {
  const raft = wood === 'bamboo', id = wood + (chest ? '_chest' : '') + (raft ? '_raft' : '_boat')
  const source = raft ? EXTRA_MODELS.RaftModel : ENTITY_MODELS.BoatEntityModel
  const fixture = { id: 'minecraft:' + id, pos: [7.125, -3.625, 11.875], rotation: [yaw, 0], nbt: {} }
  const before = JSON.stringify(fixture), boat = await buildEntityMesh(fixture, assets), hull = boat.children[0]
  boat.updateMatrixWorld(true)
  // Check every hull vertex against the independent vanilla renderer matrix.
  const vanilla = new THREE.Matrix4().makeTranslation(...fixture.pos)
    .multiply(new THREE.Matrix4().makeTranslation(0, .375, 0))
    .multiply(rotationY((180 - yaw) * Math.PI / 180))
    .scale(new THREE.Vector3(-1, -1, 1)).multiply(rotationY(Math.PI / 2))
  const quads = compileModel(source, true)
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i]
    if ([source.parts.left_paddle, source.parts.right_paddle].includes(q.part)) continue
    for (let k = 0; k < 4; k++) {
      const [x, y, z] = q.verts[k]
      const expected = new THREE.Vector3(x, 1.5 - y, -z).applyMatrix4(vanilla)
      assert.ok(vertex(hull, i * 4 + k).distanceTo(expected) < 2e-5, id + ': hull world position must match vanilla')
    }
  }
  // Deck/floor heights are measured relative to saved Pos, independently of the mesh offset.
  const bottom = bounds(hull, 0, raft ? 48 : 24)
  near(bottom.min.y - fixture.pos[1], raft ? .00625 : 0, id + ' bottom')
  near(bottom.max.y - fixture.pos[1], raft ? .50625 : .1875, id + ' deck/floor')
  assert.equal(hull.material.map.name, `entity/${chest ? 'chest_boat' : 'boat'}/${wood}`)
  assert.equal(hull.material.map.image.height, chest ? 128 : 64)
  assert.equal(hull.geometry.attributes.position.count, quads.length * 4 + (chest ? 72 : 0))
  // Idle paddle blade centers: cuboid center -> paddle rotation/pivot -> vanilla renderer.
  for (const [name, right] of [['left_paddle', false], ['right_paddle', true]]) {
    const indices = quads.map((q, i) => q.part === source.parts[name] ? i : -1).filter(i => i >= 0).slice(-6)
    const actual = new THREE.Vector3()
    for (const i of indices) for (let k = 0; k < 4; k++) actual.add(vertex(hull, i * 4 + k))
    actual.divideScalar(24)
    const paddleYaw = Math.sin(1) * Math.PI / 4
    const rotation = new THREE.Euler(-5 * Math.PI / 24, right ? Math.PI - paddleYaw : paddleYaw, Math.PI / 16, 'ZYX')
    const expected = new THREE.Vector3(right ? .501 : -.501, 0, 11.5).applyEuler(rotation)
      .add(new THREE.Vector3(...source.parts[name].pivot)).divideScalar(16).applyMatrix4(vanilla)
    assert.ok(actual.distanceTo(expected) < 2e-5, id + ' ' + name + ' world-space blade center')
  }
  if (chest) {
    // The first two chest parts form a 12x12x12 box at the rear. Rafts raise it by 5.1 pixels.
    const chestBox = bounds(hull, quads.length * 4, 48)
    const y = raft ? -10.1 : -5
    const expected = new THREE.Box3(new THREE.Vector3(-14 / 16, (y - 4) / 16, -6 / 16), new THREE.Vector3(-2 / 16, (y + 8) / 16, 6 / 16)).applyMatrix4(vanilla)
    assert.ok(chestBox.min.distanceTo(expected.min) < 2e-5 && chestBox.max.distanceTo(expected.max) < 2e-5, id + ': chest must rest on its own deck')
    // The hull and paddles occupy the top half of the dedicated chest-boat texture.
    const uv = hull.geometry.attributes.uv
    for (let i = 0; i < quads.length * 4; i++) near(uv.getY(i), quads[Math.floor(i / 4)].uvs[i % 4][1] / 2, id + ' chest texture UV')
  }
  assert.equal(JSON.stringify(fixture), before)
  boat.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
  variants++
}
assert.equal(JSON.stringify([ENTITY_MODELS.BoatEntityModel, EXTRA_MODELS.RaftModel]), snapshot, 'Shared models must remain unchanged')
// Raising the boat mesh must not move its saved entity anchor or its passengers.
for (const id of ['oak_boat', 'oak_chest_boat', 'bamboo_raft', 'bamboo_chest_raft']) {
  const pos = [.123456789, 20.987654321, -.345678912]
  const boat = await buildEntityMesh({ id: 'minecraft:' + id, pos, rotation: [37, 0], nbt: { Passengers: [{ id: 'minecraft:pig', Health: 20 }] } }, assets)
  boat.updateMatrixWorld(true)
  assert.deepEqual(boat.position.toArray(), pos)
  const passenger = boat.getObjectByName('passenger-0').getWorldPosition(new THREE.Vector3())
  near(passenger.y - pos[1], id.endsWith('_raft') ? .5 : .1875, id + ' passenger seat')
  boat.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
}
console.log(`Boats: ${variants} material/type/yaw cases; vanilla hull height, paddles, chest geometry/UVs and passenger anchors passed`)
