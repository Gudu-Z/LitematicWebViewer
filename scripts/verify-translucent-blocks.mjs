// Minecraft 26.3 slime/honey JSON + HalfTransparentBlock.skipRendering. Texture
// alpha comes from the pack; no hardcoded opacity or rebuilt replacement models.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups } from '../src/geometry.js'
import { Renderer } from '../src/renderer.js'
import { buildEntityMesh, buildItemPreview, buildGuiItem } from '../src/entities.js'
import { collectSceneResources } from '../src/sceneResources.js'
import { batchItemFrames } from '../src/frameBatches.js'
import { mergeTranslucentBlocks } from '../src/translucentBlocks.js'
import { createFaceRadixSort } from '../src/translucentFaceOrder.js'
import { blockFaceKeys, setBlockFaceKeys } from '../src/selectionSources.js'

const assets = new AssetProvider(), originalFetch = globalThis.fetch, root = 'public/assets/minecraft/'
assets.baseUrl = 'https://translucent.test/'
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl))
  const path = root + String(url).slice(assets.baseUrl.length)
  return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 })
}
assets._getTexture = async key => {
  const texture = new THREE.Texture({ width: 16, height: 16 }); texture.name = key
  return texture
}
const bounds = { minX: 0, minY: 0, minZ: 0, width: 2, height: 2, depth: 2 }
const dataFor = (palette, entries) => ({ palette, blocks: new Map(entries), bounds })
const meshes = root => { const out = []; root.traverse(o => { if (o.isMesh) out.push(o) }); return out }
const translucent = root => meshes(root).filter(m => m.material.translucentMaps)
const dispose = root => { const geos = new Set(), mats = new Set(); root.traverse(o => { if (o.geometry) geos.add(o.geometry); if (o.material) mats.add(o.material) }); geos.forEach(g => g.dispose()); mats.forEach(m => m.dispose()) }
let checks = 0
function checkSort(mesh, position) {
  const camera = new THREE.PerspectiveCamera(); camera.position.fromArray(position); camera.updateMatrixWorld(true)
  mesh.updateWorldMatrix(true, false); mesh.onBeforeRender(null, null, camera)
  const p = mesh.geometry.attributes.position, index = mesh.geometry.index.array
  let previous = Infinity
  for (let i = 0; i < index.length; i += 6) {
    const b = index[i], center = new THREE.Vector3()
    assert.deepEqual([...index.slice(i, i + 6)], [b, b + 1, b + 2, b + 2, b + 1, b + 3])
    for (let k = 0; k < 4; k++) center.add(new THREE.Vector3().fromBufferAttribute(p, b + k))
    const distance = center.multiplyScalar(.25).applyMatrix4(mesh.matrixWorld).distanceToSquared(camera.position)
    assert.ok(distance <= previous + 1e-7, 'All sprites share far-to-near quad order')
    previous = distance
  }
  const version = mesh.geometry.index.version
  mesh.onBeforeRender(null, null, camera)
  assert.equal(mesh.geometry.index.version, version, 'Stationary previews do not repeatedly sort/upload')
  checks++
}

function checkSortDependencies(mesh) {
  const camera = new THREE.PerspectiveCamera(), rig = new THREE.Group()
  rig.position.set(-2, 1, 4); rig.add(camera); camera.position.set(4, 3, 5)
  mesh.updateWorldMatrix(true, false); rig.updateMatrixWorld(true)
  const index = mesh.geometry.index, positions = mesh.geometry.attributes.position.array
  const exactReference = () => {
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    const faces = Array.from({ length: index.count / 6 }, (_, face) => {
      const center = new THREE.Vector3()
      for (let axis = 0; axis < 3; axis++) center.setComponent(axis, (positions[face * 12 + axis] + positions[face * 12 + 9 + axis]) / 2)
      return { face, distance: center.applyMatrix4(mesh.matrixWorld).distanceToSquared(eye) }
    }).sort((a, b) => b.distance - a.distance || a.face - b.face)
    return Uint32Array.from(faces.flatMap(({ face }) => [0, 1, 2, 2, 1, 3].map(i => face * 4 + i)))
  }
  mesh.onBeforeRender(null, null, camera)
  const initial = index.array.slice(), version = index.version
  assert.deepEqual(index.array, exactReference())
  for (const rotation of [[.4, 1.2, 0], [-1, -2.5, .7], [0, Math.PI, 0]]) {
    camera.rotation.set(...rotation); rig.updateMatrixWorld(true)
    mesh.onBeforeRender(null, null, camera)
    assert.equal(index.version, version, 'Turning in place does not sort or upload identical indices')
    assert.deepEqual(index.array, initial)
    assert.deepEqual(index.array, exactReference(), 'Cached yaw/pitch/roll order equals full distance sort')
  }
  camera.fov = 35; camera.updateProjectionMatrix(); mesh.onBeforeRender(null, null, camera)
  assert.equal(index.version, version, 'Projection changes do not change world-space distance ordering')
  camera.position.x += .125; rig.updateMatrixWorld(true); mesh.onBeforeRender(null, null, camera)
  assert.equal(index.version, version + 1); assert.deepEqual(index.array, exactReference())
  rig.position.z -= .5; rig.updateMatrixWorld(true); mesh.onBeforeRender(null, null, camera)
  assert.equal(index.version, version + 2, 'A parent moving the camera invalidates the cache')
  assert.deepEqual(index.array, exactReference())
  const matrix = mesh.matrix.clone(), auto = mesh.matrixAutoUpdate, worldAuto = mesh.matrixWorldAutoUpdate
  mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = true
  mesh.matrix.elements[12] += 2; mesh.updateWorldMatrix(true, false, true)
  mesh.onBeforeRender(null, null, camera)
  assert.equal(index.version, version + 3, 'A changed mesh transform invalidates the cache')
  assert.deepEqual(index.array, exactReference())
  mesh.matrix.copy(matrix); mesh.matrixAutoUpdate = auto; mesh.updateWorldMatrix(true, false, true); mesh.matrixWorldAutoUpdate = worldAuto
  mesh.onBeforeRender(null, null, camera); assert.deepEqual(index.array, exactReference())
}
try {
  const xk = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
  for (const pack of [null, xk]) {
    if (pack) assets.addPack(pack, 'XK')
    const resolver = new BlockModelResolver(assets)
    const palette = await Promise.all(['slime_block', 'honey_block', 'stone'].map(async id => ({ name: 'minecraft:' + id, properties: {}, baked: await resolver.resolve(id, {}) })))
    assert.equal(palette[0].baked.quads.length, 12)
    assert.equal(palette[1].baked.quads.length, 12)
    for (const id of [0, 1]) {
      for (const direction of [1, 2, 4]) {
        const same = await buildFaceGroups(palette, new Map([[0, id], [direction, id]]), bounds)
        const mixed = await buildFaceGroups(palette, new Map([[0, id], [direction, 1 - id]]), bounds)
        const stone = await buildFaceGroups(palette, new Map([[0, id], [direction, 2]]), bounds)
        assert.equal(same.emitted, 22, 'Only outer shared faces disappear; both inner cubes remain')
        assert.equal(mixed.emitted, 24, 'Slime and honey do not hide each other')
        assert.equal(stone.emitted, 17, 'Stone hides one outer face; translucent blocks do not hide stone')
      }
      const duplicates = [palette[id], { ...palette[id] }]
      assert.equal((await buildFaceGroups(duplicates, new Map([[0, 0], [1, 1]]), bounds)).emitted, 22)
      const filtered = await buildFaceGroups(palette, new Map([[0, id], [4, id]]), bounds, null, (_x, y) => y === 0)
      assert.equal(filtered.emitted, 12, 'Slicing restores the exposed outer face')
      const world = await Renderer.buildBlockPreview(dataFor(palette, [[0, id], [1, id]]), assets)
      const [mesh] = translucent(world)
      assert.equal(translucent(world).length, 1, 'Nested layers use one draw call')
      assert.equal(mesh.geometry.index.count / 6, 22)
      assert.equal(mesh.material.opacity, 1); assert.equal(mesh.material.depthWrite, true)
      assert.equal(mesh.material.side, THREE.FrontSide); assert.equal(mesh.material.transparent, true)
      assert.ok(mesh.material.alphaTest < 1 / 255)
      assert.equal(mesh.material.translucentMaps.length, id === 0 ? 1 : 3)
      assert.equal(collectSceneResources(world).retained.size, id === 0 ? 1 : 3)
      for (const position of [[4, 3, 5], [-4, -3, -5], [1, 10, 1]]) checkSort(mesh, position)
      checkSortDependencies(mesh)
      const clone = mesh.clone(); clone.position.set(3, 1, -2)
      checkSort(clone, [6, 2, -4]); clone.geometry.dispose()
      dispose(world)

      const item = { id: palette[id].name, count: 1 }
      for (const build of [buildItemPreview, buildGuiItem]) {
        const object = await build(item, assets)
        assert.equal(translucent(object).length, 1)
        assert.equal(translucent(object)[0].geometry.index.count / 6, 12)
        checkSort(translucent(object)[0], [3, 4, 5]); dispose(object)
      }
      const frame = pos => buildEntityMesh({ id: 'minecraft:item_frame', pos, rotation: [0, 0], nbt: { Facing: 2, Item: item } }, assets)
      const [a, b] = await Promise.all([frame([0, 0, 0]), frame([20, 0, 0])])
      const ma = translucent(a)[0], mb = translucent(b)[0]
      assert.notEqual(ma.geometry, mb.geometry, 'Cached frames cannot share mutable sorting buffers')
      assert.equal(ma.material, mb.material, 'Cached frames still share materials/textures')
      checkSort(ma, [4, 3, 5]); const indices = ma.geometry.index.array.slice()
      checkSort(mb, [-4, -3, -5]); assert.deepEqual(ma.geometry.index.array, indices)
      const frames = new THREE.Group(); frames.add(a, b); batchItemFrames(frames, [a, b])
      assert.equal(translucent(frames).length, 2, 'Transparent items retain independent rendering after frame batching')
      dispose(frames)
    }
    const mixed = await Renderer.buildBlockPreview(dataFor(palette, [[0, 0], [1, 1], [4, 0], [5, 1]]), assets)
    assert.equal(translucent(mixed).length, 1); assert.equal(translucent(mixed)[0].material.translucentMaps.length, 4)
    checkSort(translucent(mixed)[0], [-4, 3, 5]); dispose(mixed)
    const view = Object.create(Renderer.prototype); view.group = new THREE.Group()
    const data = dataFor(palette, [[0, 1], [4, 1]])
    await view.renderBlocks(data, assets)
    const privateMaterial = translucent(view.group)[0].material
    let disposed = 0; privateMaterial.addEventListener('dispose', () => disposed++)
    const filter = (_x, y) => y === 0; filter.descriptor = { mode: 'single', layerY: 0 }
    await view.renderBlocks(data, assets, filter)
    assert.equal(disposed, 1, 'A slice rebuild releases its private shader material')
    assert.equal(translucent(view.group)[0].geometry.index.count / 6, 12)
    view.clearBlocks(true); assert.equal(disposed, 1)
  }
  // A pack may replace both the geometry and every sprite name. Keep the layer
  // tied to the block/item identity, without making other users of that sprite transparent.
  const pack = new JSZip()
  pack.file('assets/minecraft/models/block/slime_block.json', JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } }))
  assets.addPack(pack, 'replacement')
  const resolver = new BlockModelResolver(assets)
  const palette = await Promise.all(['slime_block', 'stone'].map(async id => ({ name: 'minecraft:' + id, baked: await resolver.resolve(id, {}) })))
  const world = await Renderer.buildBlockPreview(dataFor(palette, [[0, 0], [1, 1]]), assets)
  assert.equal(translucent(world)[0].geometry.index.count / 6, 5)
  assert.equal(meshes(world).filter(m => !m.material.transparent).length, 1)
  dispose(world)
  const complex = new JSZip(), model = JSON.parse(readFileSync(root + 'models/block/honey_block.json', 'utf8'))
  const paths = ['stone', 'dirt', 'sand', 'gravel', 'oak_planks', 'birch_planks', 'acacia_planks', 'cobblestone', 'netherrack']
  model.elements.forEach((element, i) => Object.values(element.faces).forEach((face, j) => { face.texture = 'block/' + paths[(i * 6 + j) % paths.length] }))
  complex.file('assets/minecraft/models/block/honey_block.json', JSON.stringify(model)); assets.addPack(complex, 'many sprites')
  const item = await buildItemPreview({ id: 'minecraft:honey_block', count: 1 }, assets)
  assert.equal(translucent(item).length, 12, 'Complex packs fall back to sortable faces within sampler limits')
  translucent(item).forEach(mesh => assert.equal(mesh.material.translucentMaps.length, 1)); dispose(item)
  console.log(`PASS translucent blocks: vanilla/XK inner shells, contact culling, slices, ${checks} camera sorts, exact yaw/pitch/roll cache, camera/mesh movement invalidation, items/GUI/cached frames, pack sprite replacement and shared texture ownership`)
} finally { assets.clearCaches(); globalThis.fetch = originalFetch }

// Independent oracle: use the original Three world transform, double squared
// distance, prior Uint32 order and comparator. Compare every original triangle.
let random = 0x9e3779b9
function nextWord() { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random }
const count = 6151
for (const [custom, nonFinite] of [[false, false], [true, false], [true, true]]) {
  const source = new THREE.BufferGeometry(), positions = new Float32Array(count * 12), uvs = new Float32Array(count * 8)
  const index = new Uint32Array(count * 6), keys = Float64Array.from({ length: count }, (_, id) => 2 ** 32 + id)
  for (let i = 0; i < count; i++) {
    // Pairs at ±1 have distinct double distances that round to the same float
    // from a slightly off-centre eye. Repeated centres require stable ties.
    const x = i % 8 < 2 ? (i % 8 ? -1 : 1) : (nextWord() % 16384 - 8192) / 16
    const y = i % 8 < 2 ? 0 : (nextWord() % 31 - 15) / 8, z = i % 8 < 2 ? 0 : (nextWord() % 4096 - 2048) / 16
    for (let k = 0; k < 4; k++) { const j = i * 12 + k * 3; positions[j] = x + (k & 1 ? .125 : -.125); positions[j + 1] = y + (k & 2 ? .125 : -.125); positions[j + 2] = z }
    const triangle = custom && i % 17 === 0 ? [3, 2, 1, 1, 2, 0] : [0, 1, 2, 2, 1, 3]
    for (let k = 0; k < 6; k++) index[i * 6 + k] = i * 4 + triangle[k]
    uvs[i * 8] = i / count
  }
  if (nonFinite) positions[(count - 2) * 12] = Infinity // Existing comparator for non-finite centres, including identity 0*Infinity.
  source.setAttribute('position', new THREE.BufferAttribute(positions, 3)); source.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  source.setIndex(new THREE.BufferAttribute(index, 1)); setBlockFaceKeys(source, keys)
  const inputMaterial = new THREE.MeshLambertMaterial({ map: new THREE.Texture() })
  const [mesh] = mergeTranslucentBlocks([new THREE.Mesh(source, inputMaterial)])
  const camera = new THREE.PerspectiveCamera(), order = Uint32Array.from({ length: count }, (_, i) => i), distance = new Float64Array(count)
  const point = new THREE.Vector3(), expected = new Uint32Array(index.length)
  for (const [step, eye] of [[1e-9, 0, 0], [0, 0, 0], [840.125, 241.5, -516.75], [840.5, 241.75, -516.125],
    [-29999999.75, 50, 30000000.5], [-29999999.75, 50, 30000000.5], [-30000000.15, 50.5, 29999999.5],
    [1e200, 2, 3], [4, -1, 7]].entries()) {
    if (step === 4) { mesh.position.set(-30000000, 51, 30000000); mesh.rotation.set(.2, -.1, .7); mesh.scale.set(.5, 2, -1.5) }
    if (step === 5) camera.rotation.y += .8
    if (step === 8) { mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1) }
    mesh.updateMatrixWorld(true); camera.position.fromArray(eye); camera.updateMatrixWorld(true)
    for (let i = 0, j = 0; i < count; i++, j += 12) {
      point.set((positions[j] + positions[j + 9]) / 2, (positions[j + 1] + positions[j + 10]) / 2, (positions[j + 2] + positions[j + 11]) / 2)
      distance[i] = point.applyMatrix4(mesh.matrixWorld).distanceToSquared(camera.position)
    }
    if (!step) { assert.notEqual(distance[0], distance[1]); assert.equal(Math.fround(distance[0]), Math.fround(distance[1])) }
    if (step !== 5) order.sort((a, b) => distance[b] - distance[a] || a - b)
    for (let i = 0; i < count; i++) for (let k = 0; k < 6; k++) expected[i * 6 + k] = index[order[i] * 6 + k]
    const version = mesh.geometry.index.version
    mesh.onBeforeRender(null, null, camera)
    assert.deepEqual(mesh.geometry.index.array, expected)
    if (step === 5) assert.equal(mesh.geometry.index.version, version, 'Camera direction does not reorder or upload')
  }
  assert.deepEqual(mesh.geometry.attributes.position.array, positions); assert.deepEqual(mesh.geometry.attributes.uv.array, uvs)
  if (!nonFinite) {
    // Moving straight away from a coplanar set adds the same exact constant
    // to all these dyadic squared distances, so the existing upload is valid.
    mesh.scale.z = 0; mesh.updateMatrixWorld(true)
    camera.position.set(0, 0, 1); camera.updateMatrixWorld(true); mesh.onBeforeRender(null, null, camera)
    const version = mesh.geometry.index.version, sorted = mesh.geometry.index.array.slice()
    camera.position.z = 2; camera.updateMatrixWorld(true); mesh.onBeforeRender(null, null, camera)
    assert.equal(mesh.geometry.index.version, version); assert.deepEqual(mesh.geometry.index.array, sorted)
  }
  assert.deepEqual(blockFaceKeys(mesh.geometry), keys, 'Picking provenance still follows the original position vertices')
  const clone = mesh.clone(); assert.deepEqual(clone.geometry.index.array, index, 'Clone starts from the original (including custom) triangles')
  assert.deepEqual(blockFaceKeys(clone.geometry), keys); assert.notEqual(clone.geometry.index.array.buffer, mesh.geometry.index.array.buffer)
  clone.geometry.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); inputMaterial.map.dispose(); inputMaterial.dispose()
}
// Exercise the whole nonnegative double key domain, not only distances from a
// typical world: subnormals, adjacent mantissas, many exponent bands and ties.
{
  const distances = new Float64Array(8193), raw = new DataView(new ArrayBuffer(8))
  const special = [-0, 0, Number.MIN_VALUE, Number.MIN_VALUE * 2, 1, 1 + Number.EPSILON, 2 ** 32, 2 ** 53, Number.MAX_VALUE]
  for (let i = 0; i < distances.length; i++) {
    raw.setUint32(0, nextWord() & 0x7fefffff); raw.setUint32(4, nextWord())
    distances[i] = i % 4 === 0 ? special[(i / 4) % special.length] : raw.getFloat64(0)
  }
  const order = Uint32Array.from({ length: distances.length }, (_, i) => distances.length - 1 - i), radix = createFaceRadixSort(distances)
  for (const vary of [true, false]) {
    if (!vary) distances.fill(17.5)
    const expected = order.slice().sort((a,b) => distances[b] - distances[a] || a - b)
    radix(order); assert.deepEqual(order, expected)
  }
}
console.log('PASS large translucent camera paths: original triangle bytes, exact doubles/ties, far transforms, non-finite fallback, stable clone geometry and picking')
