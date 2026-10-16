import assert from 'node:assert/strict'
import * as THREE from 'three'
import { compileModel, quadsToEntityMesh, createEntityModelMesh, createEntityRig, sortTransparentFaces } from '../src/entityModel.js'
import { getMobAppearance } from '../src/entityAppearance.js'
import { ENTITY_MODELS } from '../src/entityModelData.js'
import { ALL_MOB_FIXTURES, FEATURE_FIXTURES } from './entity-fixtures.mjs'

const material = () => new THREE.MeshLambertMaterial({ transparent: true })
const bytes = attribute => Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength)
function equalGeometry(actual, expected) {
  for (const key of ['position', 'normal', 'uv']) assert.deepEqual(bytes(actual.attributes[key]), bytes(expected.attributes[key]), key + ' must retain every compiled byte')
  assert.deepEqual(bytes(actual.index), bytes(expected.index), 'Cached indices must keep the original winding and face order')
}
const dispose = mesh => { mesh.geometry.dispose(); mesh.material.dispose() }
let models = 0
for (const fixture of [...ALL_MOB_FIXTURES, ...FEATURE_FIXTURES]) {
  const appearance = getMobAppearance(fixture, fixture.id.slice(10))
  for (const model of [appearance.model, ...appearance.layers.map(layer => layer.model)]) {
    const fresh = quadsToEntityMesh(compileModel(model), material())
    const first = createEntityRig(model, material()), second = createEntityRig(structuredClone(model), material())
    equalGeometry(first.geometry, fresh.geometry)
    equalGeometry(second.geometry, fresh.geometry)
    assert.notEqual(first.geometry, second.geometry)
    for (const key of Object.keys(first.geometry.attributes)) assert.notEqual(first.geometry.attributes[key].array.buffer, second.geometry.attributes[key].array.buffer,
      key + ' must remain independently writable for equipment and animation')
    assert.notEqual(first.geometry.index.array.buffer, second.geometry.index.array.buffer)
    assert.notEqual(first.skeleton, second.skeleton)
    assert.ok(first.skeleton.bones.every((bone, i) => bone !== second.skeleton.bones[i]), 'Each entity needs its own pose')
    assert.deepEqual(first.boundingSphere, second.boundingSphere)
    const oldSphere = second.boundingSphere.clone()
    first.boundingSphere.radius *= 2
    first.geometry.translate(3, 5, 7)
    first.geometry.attributes.uv.setXY(0, .123, .456)
    first.geometry.computeVertexNormals()
    first.skeleton.bones[1].rotation.z += .5
    first.updateMatrixWorld(true)
    const camera = new THREE.PerspectiveCamera(); camera.position.set(4, 3, -5); camera.updateMatrixWorld(true)
    sortTransparentFaces(first)(camera)
    equalGeometry(second.geometry, fresh.geometry)
    assert.deepEqual(second.boundingSphere, oldSphere, 'Bounds must not be shared between instances')
    first.skeleton.computeBoneTexture(); second.skeleton.computeBoneTexture()
    let firstDisposed = 0, secondDisposed = 0
    first.skeleton.boneTexture.addEventListener('dispose', () => firstDisposed++)
    second.skeleton.boneTexture.addEventListener('dispose', () => secondDisposed++)
    dispose(first)
    assert.equal(firstDisposed, 1)
    assert.equal(secondDisposed, 0, 'Disposing one entity must keep the neighboring skeleton alive')
    const reopened = createEntityRig(model, material())
    equalGeometry(reopened.geometry, fresh.geometry)
    assert.deepEqual(reopened.boundingSphere, oldSphere, 'Reopening must not reuse mutated bounds')
    dispose(second); dispose(reopened); dispose(fresh)
    models++
  }
}

// Model builders clone and change plain model definitions for poses, babies and
// equipment. Even mutations to the same object must invalidate the geometry key.
const changed = structuredClone(ENTITY_MODELS.BoatEntityModel)
for (const mutate of [
  () => {},
  () => { changed.parts.left_paddle.rot[0] += .3 },
  () => { changed.parts.left_paddle.cuboids[0].dx += 2 },
  () => { changed.h *= 2 },
  () => { changed.parts.left_paddle.cuboids = [] },
]) {
  mutate()
  const mesh = createEntityModelMesh(changed, material()), expected = quadsToEntityMesh(compileModel(changed), material())
  equalGeometry(mesh.geometry, expected.geometry)
  dispose(mesh); dispose(expected)
}

// Observe compilation work without relying on wall-clock thresholds. The cache
// must reuse cloned definitions and evict old CPU data without touching live rigs.
const model = structuredClone(ENTITY_MODELS.MinecartEntityModel)
model.w = 937
const oldCos = Math.cos
let rotations = 0
Math.cos = value => { rotations++; return oldCos(value) }
try {
  const first = createEntityModelMesh(model, material())
  assert.ok(rotations > 0)
  rotations = 0
  const reused = createEntityModelMesh(structuredClone(model), material())
  assert.equal(rotations, 0, 'Identical definitions must skip cuboid compilation')
  for (let i = 0; i < 128; i++) {
    const next = structuredClone(model); next.w += i + 1
    dispose(createEntityModelMesh(next, material()))
  }
  rotations = 0
  const afterEviction = createEntityModelMesh(model, material())
  assert.ok(rotations > 0, 'Template count must stay bounded when opening many variants')
  equalGeometry(first.geometry, afterEviction.geometry)
  equalGeometry(reused.geometry, afterEviction.geometry)
  dispose(first); dispose(reused); dispose(afterEviction)
} finally { Math.cos = oldCos }
console.log('PASS entity model cache: ' + models + ' complete model/layer byte comparisons, independent geometry/poses/bounds/skeleton disposal, definition mutations, clone reuse and bounded eviction')
