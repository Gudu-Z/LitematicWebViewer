// ModelPart.Cube / WardenModel (26.3): verify texture attachment in model space,
// including mirrored planes and cubes whose zero nominal size has positive dilation.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { compileModel } from '../src/entityModel.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'
import { BABY_MODELS } from '../src/babyEntityModels.js'
import { getMobAppearance } from '../src/entityAppearance.js'

const isolated = c => ({ w: 128, h: 128, parts: { part: { cuboids: [c] } } })
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`)
let planes = 0, solids = 0
function check(c, label) {
  const dil = c.dil || [0, 0, 0]
  const size = [c.dx, c.dy, c.dz].map((n, i) => n + dil[i] * 2)
  const flat = size.findIndex(n => n === 0)
  const quads = compileModel(isolated(c))
  if (flat < 0) {
    assert.equal(quads.length, 6, label + ' must retain all six faces')
    for (const q of quads) {
      const points = q.verts.map(v => new THREE.Vector3(...v))
      const geometricNormal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize()
      near(geometricNormal.dot(new THREE.Vector3(...q.normal)), 1, label + ' outward lighting normal')
    }
    solids++; return
  }
  if (size.filter(n => n === 0).length > 1) return
  planes++
  assert.equal(quads.length, 1, label + ' must not emit coincident or zero-area faces')
  const q = quads.find(q => Math.abs(q.normal[flat]) === 1)
  const min = [c.x, c.y, c.z].map((n, i) => n - dil[i])
  for (let i = 0; i < 4; i++) {
    const world = q.verts[i], model = [world[0] * 16, 24 - world[1] * 16, -world[2] * 16]
    const f = model.map((n, axis) => size[axis] ? (n - min[axis]) / size[axis] : 0)
    if (c.mirror) f[0] = 1 - f[0]
    // Canonical WEST / DOWN / NORTH faces from the game, matched by spatial vertex.
    const u = flat === 0 ? c.u + c.dz * (1 - f[2]) : c.u + c.dz + c.dx * f[0]
    const v = flat === 1 ? c.v + c.dz * (1 - f[2]) : c.v + c.dz + c.dy * f[1]
    near(q.uvs[i][0] * 128, u, label + ' U attachment')
    near(q.uvs[i][1] * 128, v, label + ' V attachment')
  }
}
const walk = (parts, prefix) => {
  for (const [name, part] of Object.entries(parts)) {
    for (const c of part.cuboids || []) check(c, prefix + '/' + name)
    walk(part.children || {}, prefix + '/' + name)
  }
}
for (const [name, model] of Object.entries({ ...ENTITY_MODELS, ...EXTRA_MODELS, ...BABY_MODELS })) walk(model.parts, name)
for (const mirror of [false, true]) for (const axis of ['dx', 'dy', 'dz']) {
  const c = { u: 7, v: 11, x: -3, y: 5, z: -2, dx: 8, dy: 13, dz: 6, mirror, [axis]: 0 }
  check(c, axis + ' plane')
  check({ ...c, dil: [.001, .001, .001] }, axis + ' inflated plane')
}

const warden = ENTITY_MODELS.WardenEntityModel
let tendrils = 0
function checkTendrils(parts) {
  for (const [name, part] of Object.entries(parts)) {
    if (name.endsWith('_tendril')) {
      const right = name === 'right_tendril', c = part.cuboids[0]
      assert.deepEqual([c.u, c.v, c.x, c.y, c.z, c.dx, c.dy, c.dz], [right ? 52 : 58, right ? 32 : 0, right ? -16 : 0, -13, 0, 16, 16, 0])
      assert.deepEqual(part.pivot, [right ? -8 : 8, -12, 0]); tendrils++
    }
    checkTendrils(part.children || {})
  }
}
checkTendrils(warden.parts); assert.equal(tendrils, 2)
const original = JSON.stringify(ENTITY_MODELS)
for (const id of ['vindicator', 'evoker', 'illusioner', 'pillager']) {
  const entity = { id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt: {} }
  const defaults = getMobAppearance(entity, id).model
  const enabled = getMobAppearance({ ...entity, renderOptions: { illagerExtraArms: true } }, id).model
  for (const name of ['right_arm', 'left_arm']) {
    assert.equal(defaults.parts[name].cuboids.length > 0, id === 'pillager')
    assert.ok(enabled.parts[name].cuboids.length > 0)
  }
  assert.equal(enabled.parts.arms.cuboids.length > 0, id !== 'pillager')
  assert.deepEqual(getMobAppearance(entity, id).model, defaults, 'setting must not leak into normal viewer')
}
assert.equal(JSON.stringify(ENTITY_MODELS), original)
console.log(`Passed ${planes} planar and ${solids} solid cuboids: spatial UV attachment, mirrored/dilated planes, outward normals, Warden source dimensions and opt-in illager arms`)
