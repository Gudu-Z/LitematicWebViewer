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
  console.log(`PASS translucent blocks: vanilla/XK inner shells, contact culling, slices, ${checks} camera sorts, items/GUI/cached frames, pack sprite replacement and shared texture ownership`)
} finally { assets.clearCaches(); globalThis.fetch = originalFetch }
