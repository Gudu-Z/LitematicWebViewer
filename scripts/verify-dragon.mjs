// Minecraft 26.3 EnderDragonRenderer.submit + EnderDragonModel.setupAnim.
// Golden world-space vertices below were calculated in vanilla's original model
// coordinates with float poses, before the viewer's coordinate conversion. All
// flight-history samples have the same saved height/yaw; idle flapTime = age / 10.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { buildEntityMesh } from '../src/entities.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'
import { getEntityHitbox } from '../src/entityHitboxes.js'

const textures = new Map()
const assets = {
  async getTexture(key) {
    if (!textures.has(key)) {
      const png = readFileSync('public/assets/minecraft/textures/' + key + '.png')
      const texture = new THREE.Texture()
      texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
// Actual cuboid corners, rather than just bone origins: exercise GPU skinning
// inputs as well as the renderer's position, yaw, model-root and limb transforms.
const probes = [
  ['body', [-12, 1, -16]], ['head', [-6, -1, -24]], ['jaw', [-6, 0, -16]],
  ['neck4', [-5, -5, -5]], ['tail0', [-5, -5, -5]], ['tail11', [-5, -5, -5]],
  ['left_wing_tip', [56, 0, 2]], ['left_front_foot', [-4, 0, -12]],
]
const samples = [
  { age: 0, sitting: false, points: [[.75,3.233592,-2.4998506],[.375,2.0582073,-7.3580243],[.375,1.54705,-7.3377856],[.3125,2.2984666,-5.5352008],[-.3125,3.1738168,2.0626859],[-.3125006,2.2602027,8.8781922],[-6.112646,.6460797,-.6823014],[-.5,.0913401,.332315]] },
  { age: 0, sitting: true, points: [[.75,3.233592,-2.4998506],[.375,.1877361,-6.7807698],[.375,-.1593958,-6.405016],[.3125,1.6276764,-5.5479133],[-.3125,3.1738168,2.0626859],[-.3125006,2.2602027,8.8781922],[-6.112646,.6460797,-.6823014],[-.5,.0913401,.332315]] },
  { age: 2.5, sitting: false, points: [[.75,2.9735959,-2.497598],[.375,2.2860472,-7.3472961],[.375,1.584912,-7.2616803],[.3125,2.5048745,-5.4946361],[-.3125,2.9386584,2.0806698],[-.3125006,2.7509632,8.8904181],[-5.0972963,8.08692,-.0442953],[-.5,-.1126214,.3910019]] },
  { age: 2.5, sitting: true, points: [[.75,2.9735959,-2.497598],[.375,.4016047,-6.8824502],[.375,-.0336332,-6.3261332],[.3125,1.8358772,-5.615888],[-.3125,2.9386584,2.0806698],[-.3125006,2.7509632,8.8904181],[-5.0972963,8.08692,-.0442953],[-.5,-.1126214,.3910019]] },
  { age: 7.25, sitting: false, points: [[.75,3.1719675,-2.4993203],[.375,1.9655826,-7.3540483],[.375,1.6506215,-7.3531912],[.3125,2.2634484,-5.5924194],[-.3125,3.1368412,2.0474843],[-.3125006,3.5477983,8.923717],[-4.2896446,-2.2246223,.1395564],[-.5,.0428615,.3463611]] },
  { age: 7.25, sitting: true, points: [[.75,3.1719675,-2.4993203],[.375,.1215723,-6.6977247],[.375,-.1005328,-6.4744075],[.3125,1.5803264,-5.5473444],[-.3125,3.1368412,2.0474843],[-.3125006,3.5477983,8.923717],[-4.2896446,-2.2246223,.1395564],[-.5,.0428615,.3463611]] },
]
const sourceModel = ENTITY_MODELS.DragonEntityModel || EXTRA_MODELS.DragonEntityModel
const beforeModel = JSON.stringify(sourceModel)
const near = (a, b, message) => assert.ok(a.distanceTo(b) < 2e-5, `${message}: ${a.toArray()} != ${b.toArray()}`)
let cases = 0, checked = 0
for (const phase of [0, 5, 6, 7, 10]) for (const yaw of [0, 90, 180, 270, -135, 37.125]) for (const pitch of [0, 31]) {
  const entity = { id: 'minecraft:ender_dragon', pos: [7.123456789, 42.987654321, -13.375], rotation: [yaw, pitch], nbt: { DragonPhase: phase, Health: 200 } }
  const before = JSON.stringify(entity), dragon = await buildEntityMesh(entity, assets)
  const layers = dragon.children.filter(m => m.isSkinnedMesh)
  assert.deepEqual(layers.map(m => m.name), ['body', 'eyes'])
  const vertices = layers.map(mesh => probes.map(([name, point]) => {
    const bone = mesh.skeleton.bones.indexOf(mesh.userData.parts[name])
    const position = mesh.geometry.attributes.position, skin = mesh.geometry.attributes.skinIndex
    for (let i = 0; i < position.count; i++) {
      if (skin.getX(i) !== bone) continue
      const local = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.skeleton.boneInverses[bone])
      if (local.distanceTo(new THREE.Vector3(...point)) < 1e-4) return i
    }
    assert.fail('Missing cuboid corner for ' + name)
  }))
  // Revisiting an earlier frame checks that neither model offset nor pose drifts.
  for (const sample of [...samples, samples[0], samples[1]].filter(s => s.sitting === [5, 6, 7].includes(phase))) {
    layers.forEach(mesh => mesh.userData.updateAnimation(sample.age))
    dragon.updateMatrixWorld(true)
    for (const [layer, mesh] of layers.entries()) {
      mesh.skeleton.update()
      for (const [probe, index] of vertices[layer].entries()) {
        const expected = new THREE.Vector3(...sample.points[probe])
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw * Math.PI / 180).add(new THREE.Vector3(...entity.pos))
        const actual = mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
        near(actual, expected, `${mesh.name}/${probes[probe][0]} phase=${phase} yaw=${yaw} pitch=${pitch} age=${sample.age}`)
        // Emulate Three's float32 skeleton palette used by the vertex shader.
        const skin = mesh.geometry.attributes.skinIndex.getX(index)
        const gpu = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index)
          .applyMatrix4(new THREE.Matrix4().fromArray(mesh.skeleton.boneMatrices, skin * 16)).applyMatrix4(mesh.matrixWorld)
        near(gpu, expected, 'GPU model position')
        checked++
      }
    }
    assert.deepEqual(dragon.position.toArray(), entity.pos, 'Animation must not move the saved entity position')
    assert.deepEqual(dragon.userData.entityHitbox.bounds, getEntityHitbox(entity), 'Logical hitboxes must stay unchanged')
    near(new THREE.Vector3().applyMatrix4(dragon.userData.entityHitbox.anchor).applyMatrix4(dragon.matrixWorld), new THREE.Vector3(...entity.pos), 'Hitbox anchor')
  }
  // Full wing cycle must fit the sphere used for frustum culling, including the
  // model-root displacement and the downward-bent sitting head.
  const body = layers[0]
  for (let age = 0; age <= 10; age += .5) {
    body.userData.updateAnimation(age); dragon.updateMatrixWorld(true)
    for (let i = 0; i < body.geometry.attributes.position.count; i++) {
      assert.ok(body.boundingSphere.containsPoint(body.getVertexPosition(i, new THREE.Vector3())), 'Animated dragon outside culling sphere')
    }
  }
  assert.equal(JSON.stringify(entity), before, 'Input NBT is immutable')
  dragon.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose() })
  cases++
}
assert.equal(JSON.stringify(sourceModel), beforeModel, 'Shared model is immutable')
console.log(`Dragon: ${cases} phase/yaw/pitch cases, ${checked} vanilla body/eye vertex positions; GPU skinning, hitboxes and animation bounds passed`)
