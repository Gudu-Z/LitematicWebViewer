// NBT doubles and actual float32 skinning inputs, including far-from-origin entities.
// Minecraft 26.3 LevelRenderer.submitEntities subtracts camera coordinates in double
// precision before PoseStack.translate converts the relative position to float.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import * as THREE from 'three'
import { parseNBT } from '../src/nbt.js'
import { parseLitematica } from '../src/litematica.js'
import { buildEntityMesh } from '../src/entities.js'

const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const float = n => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
const string = s => { const b = Buffer.from(s), length = Buffer.alloc(2); length.writeUInt16BE(b.length); return Buffer.concat([length, b]) }
const tag = (type, name, data) => Buffer.concat([Buffer.from([type]), string(name), data])
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
const list = (type, items) => Buffer.concat([Buffer.from([type]), int(items.length), ...items])
const vec = xyz => compound(...xyz.map((v, i) => tag(3, 'xyz'[i], int(v))))

// A real big-endian, gzip-compressed schematic. Negative Size must not change the
// origin used for entity Pos, and neighboring sub-float32 positions must stay distinct.
for (const origin of [[0, 0, 0], [-17, -30, 43], [29999980, 250, -29999980]]) {
  for (const size of [[2, 2, 2], [-2, -2, -2]]) {
    const positions = [[.123456789123, -.987654321987, 1 + 2 ** -35], [.123456889123, -.987654221987, 1 + 2 ** -25]]
    const rotation = [37.123456, -12.345678]
    const region = compound(
      tag(10, 'Position', vec(origin)), tag(10, 'Size', vec(size)),
      tag(9, 'BlockStatePalette', list(10, [compound(tag(8, 'Name', string('minecraft:air')))])),
      tag(12, 'BlockStates', Buffer.concat([int(1), Buffer.alloc(8)])),
      tag(9, 'Entities', list(10, positions.map(pos => compound(
        tag(8, 'id', string('minecraft:armor_stand')),
        tag(9, 'Pos', list(6, pos.map(double))), tag(9, 'Rotation', list(5, rotation.map(float))),
      )))),
    )
    const nbt = tag(10, '', compound(tag(3, 'Version', int(7)), tag(10, 'Regions', compound(tag(10, 'test', region)))))
    assert.deepEqual(parseNBT(nbt).Regions.test.Entities.map(e => e.Pos), positions, 'NBT must preserve every double bit')
    const data = await parseLitematica(gzipSync(nbt))
    assert.equal(data.entities.length, 2)
    for (let i = 0; i < positions.length; i++) {
      assert.deepEqual(data.entities[i].pos, positions[i].map((n, axis) => n + origin[axis]), 'Region origin + double Pos')
      assert.deepEqual(data.entities[i].rotation, rotation.map(Math.fround), 'Vanilla stores Rotation as float')
    }
    assert.notEqual(data.entities[0].pos[0], data.entities[1].pos[0], 'Nearby entities must not snap to the same float32 coordinate')
  }
}

const root = 'public/assets/minecraft/', textures = new Map()
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const path = root + 'textures/' + key + '.png'
      assert.ok(existsSync(path), 'Missing texture: ' + key)
      const png = readFileSync(path), texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}

// Emulate the vertex shader, including float32 arithmetic (CPU getVertexPosition
// alone uses doubles and did not expose world-space bone palette cancellation).
const f = Math.fround
function multiplyFloat(matrix, v) {
  return Array.from({ length: 4 }, (_, row) => {
    let sum = f(matrix[row] * v[0])
    for (let column = 1; column < 4; column++) sum = f(sum + f(matrix[column * 4 + row] * v[column]))
    return sum
  })
}
function gpuVertex(mesh, index, modelView) {
  const p = mesh.geometry.attributes.position
  let v = [p.getX(index), p.getY(index), p.getZ(index), 1]
  if (mesh.isSkinnedMesh) {
    const b = mesh.geometry.attributes.skinIndex.getX(index)
    v = multiplyFloat(new Float32Array(mesh.bindMatrix.elements), v)
    v = multiplyFloat(mesh.skeleton.boneMatrices.subarray(b * 16, (b + 1) * 16), v)
    v = multiplyFloat(new Float32Array(mesh.bindMatrixInverse.elements), v)
  }
  return new THREE.Vector3(...multiplyFloat(modelView, v))
}

const item = id => ({ id: 'minecraft:' + id, count: 1 })
const equipment = { head: item('iron_helmet'), chest: item('diamond_chestplate'), mainhand: item('diamond_sword'), offhand: item('shield') }
const rider = { id: 'minecraft:zombie', Health: 20, equipment }
const cases = [
  ['creeper', { powered: 1 }], ['breeze', {}], ['slime', { Size: 3 }], ['wither_skeleton', {}],
  ['ender_dragon', {}], ['guardian', {}], ['shulker', { AttachFace: 5, Peek: 100 }],
  ['zombie', { equipment, IsBaby: 1 }], ['armor_stand', { equipment, ShowArms: 1, Pose: { RightArm: [-75, 20, 10] } }],
  ['armor_stand', { equipment, Small: 1 }], ['snow_golem', { Pumpkin: 1 }], ['mooshroom', {}],
  ['oak_boat', { Passengers: [rider] }], ['minecart', { Passengers: [rider] }], ['cushion', { Passengers: [rider] }],
  ['item_frame', { Facing: 5, Item: item('stone') }], ['glow_item_frame', { Facing: 0, Item: item('diamond_sword') }],
]
const offsets = [[0, 0, 0], [1024, -64, -1024], [1000000, 2048, -1000000], [29999980, 320, -29999980], [-29999980, -64, 29999980]]
let vertices = 0, maxError = 0
for (const [id, nbt] of cases) {
  const entity = { id: 'minecraft:' + id, pos: [.123456789, .987654321, -.234567891], rotation: [37.125, 0], nbt: { Health: 20, ...nbt } }
  const source = JSON.stringify(entity), group = await buildEntityMesh(entity, assets), parent = new THREE.Group()
  parent.rotation.set(.07, -.31, .03)
  parent.scale.set(1.2, .8, .9)
  parent.add(group)
  const meshes = []
  group.traverse(o => { if (o.isMesh) meshes.push(o) })
  assert.ok(meshes.length, id + ' must render')
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100)
  const cameraOffset = new THREE.Vector3(5, 4, 7)
  const baseline = new Map()
  for (const offset of offsets) {
    parent.position.fromArray(offset)
    camera.position.fromArray(offset).add(cameraOffset)
    camera.lookAt(new THREE.Vector3(...offset))
    camera.updateMatrixWorld(true)
    for (const mesh of meshes) mesh.userData.updateAnimation?.(37)
    parent.updateMatrixWorld(true)
    for (const mesh of meshes) {
      if (mesh.isSkinnedMesh) {
        if (!mesh.skeleton.boneTexture) mesh.skeleton.computeBoneTexture()
        mesh.skeleton.update()
      }
      const view = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld)
      const viewFloat = new Float32Array(view.elements), expected = baseline.get(mesh) || []
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        const actual = gpuVertex(mesh, i, viewFloat)
        if (offset === offsets[0]) expected.push(actual)
        const error = actual.distanceTo(expected[i])
        maxError = Math.max(maxError, error)
        assert.ok(error < 2e-5, `${id}/${mesh.name} GPU vertex changes after translation ${offset}: ${error} blocks`)
        const cpu = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(view)
        assert.ok(cpu.distanceTo(actual) < 2e-5, `${id}/${mesh.name} CPU bounds/picking disagree with GPU`)
        vertices++
      }
      baseline.set(mesh, expected)
    }
  }
  assert.equal(JSON.stringify(entity), source, 'Rendering must not change saved entity data')
  group.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
}
console.log(`Entity precision: NBT doubles, negative regions, ${cases.length} entity cases, ${vertices} GPU vertices; max translation error ${maxError.toExponential(2)} blocks`)
