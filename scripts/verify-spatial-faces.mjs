import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CompactFaceMesh } from '../src/compactFaceMesh.js'
import { CompactFaceData } from '../src/compactFaceData.js'
import { enableSpatialFaces, configureSpatialFaces, setSpatialFacesEnabled } from '../src/spatialFaces.js'
import { sourceForIntersection, visibleIntersection } from '../src/selectionPicking.js'
import { collectSceneResources } from '../src/sceneResources.js'
import { spatialFixture, exactPositions } from './spatial-face-fixture.js'

const options = { batchFaces: 4096, minFaces: 8192, wholeRatio: .8 }
function cameraFor(fixture, index = -1) {
  const data = fixture.data, box = new THREE.Box3(new THREE.Vector3().fromArray(data.worldBounds), new THREE.Vector3().fromArray(data.worldBounds, 3))
  const target = index < 0 ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(...fixture.clusters[index])
  const half = index < 0 ? fixture.bounds.width : 30
  const camera = new THREE.OrthographicCamera(-half, half, half * .75, -half * .75, .01, index < 0 ? 40000 : 120)
  camera.position.copy(target).add(new THREE.Vector3(0, 0, index < 0 ? 16000 : 60)); camera.lookAt(target); camera.updateMatrixWorld(true)
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  return { camera, frustum: new THREE.Frustum().setFromProjectionMatrix(matrix) }
}
function collectDraws(mesh, camera, frustum) {
  mesh.updateMatrixWorld(true)
  const included = mesh.frustumCulled === false || mesh.intersectsFrustum(frustum)
  if (!included) return []
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const groups = Array.isArray(mesh.material) ? [...mesh.geometry.groups] : [null]
  return groups.map(group => {
    mesh.onBeforeRender({}, new THREE.Scene(), camera, mesh.geometry, material, group)
    const attributes = mesh.geometry.attributes
    const snapshot = attribute => {
      if (!attribute) return null
      const { data, array, offset = 0, isInterleavedBufferAttribute } = attribute
      return { data, array, offset, isInterleavedBufferAttribute,
        getX: index => data ? data.array[index * data.stride + offset] : array[index] }
    }
    return { count: mesh.geometry.instanceCount, cells: snapshot(attributes.compactCell),
      templates: snapshot(attributes.compactTemplate), ys: snapshot(attributes.compactCellY) }
  })
}
function restoreWhole(mesh, fixture) {
  const { camera, frustum } = cameraFor(fixture)
  const draws = collectDraws(mesh, camera, frustum)
  assert.equal(draws.length, 1, 'Overview retains a single complete draw')
  assert.equal(draws[0].count, fixture.data.count)
  return draws[0]
}

let totalFaces = 0
for (const wide of [false, true]) {
  const fixture = spatialFixture({ repetitions: 4096, wide }), data = fixture.data
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const mesh = new CompactFaceMesh(data, material)
  const originalArrays = Object.fromEntries(['compactCell', 'compactTemplate', 'compactCellY'].filter(name => mesh.geometry.attributes[name])
    .map(name => [name, mesh.geometry.attributes[name].array]))
  const originalBox = mesh.geometry.boundingBox.clone(), originalSphere = mesh.geometry.boundingSphere.clone()
  const scene = new THREE.Scene(); scene.add(mesh)
  enableSpatialFaces(mesh, options)
  const template = material.uniforms.compactQuads.value
  assert.ok(collectSceneResources(scene).retained.has(template), 'Template remains pinned through material array')
  assert.deepEqual(mesh.geometry.boundingBox, originalBox, 'Spatial culling does not change export framing')
  assert.deepEqual(mesh.geometry.boundingSphere, originalSphere, 'Original sort center and whole bounds stay stable')
  assert.deepEqual(originalBox, new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(exactPositions(fixture.faces), 3)))

  for (const index of [0, 2, 1, 0]) {
    const { camera, frustum } = cameraFor(fixture, index), draws = collectDraws(mesh, camera, frustum)
    const count = draws.reduce((sum, draw) => sum + draw.count, 0)
    assert.ok(count > 0 && count < data.count * .6, 'A narrow view removes offscreen faces')
    let previous = -1
    for (const draw of draws) {
      assert.ok(draw.cells.isInterleavedBufferAttribute)
      assert.equal(draw.cells.data.array, originalArrays.compactCell, 'Batches borrow the exact original CPU array')
      assert.equal(draw.templates.data.array, originalArrays.compactTemplate)
      const start = draw.cells.offset
      assert.ok(start > previous, 'Visible ranges preserve source face order')
      previous = start + draw.count - 1
      assert.ok(start >= 0 && previous < data.count)
      assert.equal(draw.templates.offset, start)
      for (let i = 0; i < draw.count; i++) {
        assert.equal(draw.cells.getX(i), data.cells[start + i])
        assert.equal(draw.templates.getX(i), data.templateIds[start + i])
        if (wide) { assert.equal(draw.ys.data.array, originalArrays.compactCellY); assert.equal(draw.ys.getX(i), data.cellYs[start + i]) }
      }
    }
    const ray = new THREE.Raycaster(new THREE.Vector3(...fixture.clusters[index]).add(new THREE.Vector3(0, -.5, 15)), new THREE.Vector3(0, 0, -1))
    const reference = new CompactFaceMesh(data, material.clone())
    reference.updateMatrixWorld(true); mesh.updateMatrixWorld(true)
    const expected = ray.intersectObject(reference), actual = ray.intersectObject(mesh)
    assert.ok(expected.length > 0)
    assert.deepEqual(actual.map(hit => [hit.compactBlockKey, hit.distance, ...hit.uv.toArray()]),
      expected.map(hit => [hit.compactBlockKey, hit.distance, ...hit.uv.toArray()]), 'Selection ignores the previous render visibility subset')
    assert.deepEqual(sourceForIntersection(actual[0], fixture), sourceForIntersection(expected[0], fixture))
    reference.geometry.dispose(); reference.material.dispose()
  }
  restoreWhole(mesh, fixture)
  const narrow = cameraFor(fixture, 0)
  const storage = restoreWhole(mesh, fixture)
  for (const batchFaces of [8192, 16384, 4096]) {
    configureSpatialFaces(mesh, { batchFaces })
    const whole = restoreWhole(mesh, fixture)
    assert.equal(whole.cells.data, storage.cells.data, 'Retuning batch sizes keeps the uploaded buffer')
    assert.equal(whole.templates.data, storage.templates.data)
    assert.equal(material.uniforms.compactQuads.value, template)
    assert.equal(mesh.spatialFaceStats.batches, Math.ceil(data.count / batchFaces))
  }
  configureSpatialFaces(mesh, { minFaces: data.count + 1 })
  assert.equal(mesh.spatialFaceStats.batches, 0)
  assert.equal(collectDraws(mesh, narrow.camera, narrow.frustum).reduce((sum, draw) => sum + draw.count, 0), data.count,
    'Raising the threshold restores whole drawing without changing the source data')
  configureSpatialFaces(mesh, { minFaces: options.minFaces })
  assert.equal(restoreWhole(mesh, fixture).cells.data, storage.cells.data)
  setSpatialFacesEnabled(mesh, false)
  configureSpatialFaces(mesh, { batchFaces: 8192 })
  assert.equal(collectDraws(mesh, narrow.camera, narrow.frustum).reduce((sum, draw) => sum + draw.count, 0), data.count,
    'Retuning preserves disabled mode')
  configureSpatialFaces(mesh, { batchFaces: 4096 }); setSpatialFacesEnabled(mesh, true)
  collectDraws(mesh, narrow.camera, narrow.frustum)
  const oldMin = originalBox.min.clone(), oldMax = originalBox.max.clone()
  mesh.rotation.y = .2; mesh.position.set(20, 0, 0); mesh.scale.set(1.1, .9, 1.2)
  mesh.updateMatrixWorld(true)
  const fresh = new CompactFaceMesh(data, material.clone())
  fresh.position.copy(mesh.position); fresh.rotation.copy(mesh.rotation); fresh.scale.copy(mesh.scale)
  enableSpatialFaces(fresh, options)
  const signature = object => collectDraws(object, narrow.camera, narrow.frustum).map(draw => [draw.cells.offset || 0, draw.count])
  assert.deepEqual(signature(mesh), signature(fresh), 'World-bound caches refresh after transforms')
  assert.deepEqual(mesh.geometry.boundingBox.min, oldMin); assert.deepEqual(mesh.geometry.boundingBox.max, oldMax)
  fresh.geometry.dispose(); (Array.isArray(fresh.material) ? fresh.material[0] : fresh.material).dispose()
  mesh.rotation.set(0, 0, 0); mesh.position.set(0, 0, 0); mesh.scale.set(1, 1, 1); mesh.updateMatrixWorld(true)
  collectDraws(mesh, narrow.camera, narrow.frustum)
  mesh.frustumCulled = false
  assert.equal(collectDraws(mesh, narrow.camera, narrow.frustum).reduce((sum, draw) => sum + draw.count, 0), data.count,
    'Disabling frustum culling restores the complete draw after a partial view')
  mesh.frustumCulled = true
  material.transparent = true
  assert.equal(collectDraws(mesh, narrow.camera, narrow.frustum).reduce((sum, draw) => sum + draw.count, 0), data.count,
    'A material becoming transparent safely restores its original rendering order')
  material.transparent = false
  const clone = mesh.clone()
  assert.deepEqual(clone.geometry.boundingBox, originalBox)
  restoreWhole(clone, fixture)
  collectDraws(mesh, narrow.camera, narrow.frustum)
  const restored = restoreWhole(mesh, fixture)
  assert.equal(restored.cells.getX(0), data.cells[0]); assert.equal(restored.cells.getX(data.count - 1), data.cells[data.count - 1])
  let disposed = 0; template.addEventListener('dispose', () => disposed++)
  mesh.geometry.dispose(); assert.equal(disposed, 1, 'One shared template is released once')
  material.dispose(); totalFaces += data.count
}

// Transparent two-pass rendering must preserve all-backfaces then all-frontfaces.
const fixture = spatialFixture({ repetitions: 4096 })
const blend = new CompactFaceMesh(fixture.data, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, opacity: .5 }))
const originalBlendMaterial = blend.material, originalBlendCell = blend.geometry.attributes.compactCell
enableSpatialFaces(blend, options)
assert.equal(blend.material, originalBlendMaterial, 'Transparent fallback leaves material and side-pass scheduling unchanged')
assert.equal(blend.geometry.attributes.compactCell, originalBlendCell, 'Large transparent groups retain their original attributes')
const narrow = cameraFor(fixture, 0), draws = collectDraws(blend, narrow.camera, narrow.frustum)
assert.equal(draws.reduce((sum, draw) => sum + draw.count, 0), fixture.data.count, 'Transparent materials use the original draw')
blend.geometry.dispose(); blend.material.dispose()

const pixels = new THREE.DataTexture(new Uint8Array([255,255,255,0, 255,255,255,255]), 2, 1)
const alpha = new THREE.MeshBasicMaterial({ map: pixels, alphaTest: .5 })
const hit = { object: { material: [alpha] }, face: { materialIndex: 0 } }
assert.equal(visibleIntersection({ ...hit, uv: new THREE.Vector2(.25, .5) }), false)
assert.equal(visibleIntersection({ ...hit, uv: new THREE.Vector2(.75, .5) }), true)
alpha.dispose(); pixels.dispose()

// A layer/region rebuild replaces the complete face group while the shader's
// uniform objects and texture material are reused by the viewer.
const reusedMaterial = new THREE.MeshBasicMaterial(), rebuildFixture = spatialFixture()
let previous, uniform, released = 0
for (const filter of [() => true, face => face.y % 2 === 0, face => face.x < 0, () => true]) {
  if (previous) previous.geometry.dispose()
  const faces = rebuildFixture.faces.filter(filter), data = new CompactFaceData(faces.length, rebuildFixture.bounds)
  for (const face of faces) data.write(face.quad, face.x, face.y, face.z, face.key)
  data.finish()
  const mesh = new CompactFaceMesh(data, reusedMaterial)
  const template = reusedMaterial.uniforms.compactQuads.value
  template.addEventListener('dispose', () => released++)
  if (uniform) assert.equal(reusedMaterial.uniforms.compactQuads, uniform, 'Layer rebuild preserves cached uniform reference')
  uniform = reusedMaterial.uniforms.compactQuads
  enableSpatialFaces(mesh, options)
  const draw = restoreWhole(mesh, { ...rebuildFixture, data })
  assert.equal(draw.count, faces.length)
  assert.equal(reusedMaterial.uniforms.compactQuads.value, template)
  assert.deepEqual(mesh.geometry.boundingBox, new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(exactPositions(faces), 3)))
  previous = mesh
}
previous.geometry.dispose(); reusedMaterial.dispose()
assert.equal(released, 4, 'Every replaced layer/region template is released exactly once')
console.log(`PASS spatial drawing: ${totalFaces} ordered faces, full/near camera transitions, shared arrays, exact bounds/picking, wide keys, alpha holes and disposal`)
