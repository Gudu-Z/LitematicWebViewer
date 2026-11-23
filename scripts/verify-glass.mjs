// 26.3 Material.force_translucent, HalfTransparentBlock.skipRendering and
// IronBarsBlock.skipRendering; exercise actual vanilla/XK models and item paths.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { BlockModelResolver } from '../src/blocks.js'
import { bakeModel, resolveTexture } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { Renderer } from '../src/renderer.js'
import { buildItemPreview, buildGuiItem, buildEntityMesh } from '../src/entities.js'
import { collectSceneResources } from '../src/sceneResources.js'

const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const names = ['glass', 'tinted_glass', ...colors.map(c => c + '_stained_glass'), 'glass_pane', ...colors.map(c => c + '_stained_glass_pane')]
const props = { north: 'false', east: 'false', south: 'false', west: 'false', waterlogged: 'false' }
const bounds = { minX: 0, minY: 0, minZ: 0, width: 2, height: 2, depth: 2 }
const assets = new AssetProvider(), originalFetch = globalThis.fetch
assets.baseUrl = 'https://glass.test/'
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl))
  const path = 'public/assets/minecraft/' + String(url).slice(assets.baseUrl.length)
  return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 })
}
assets._getTexture = async key => { const t = new THREE.Texture({ width: 16, height: 16 }); t.name = key; return t }
const meshes = root => { const list = []; root.traverse(o => { if (o.isMesh) list.push(o) }); return list }
const dispose = root => { const list = meshes(root); new Set(list.map(m => m.geometry)).forEach(g => g.dispose()); new Set(list.map(m => m.material)).forEach(m => m.dispose()) }
try {
  for (const pack of [false, true]) {
    if (pack) assets.addPack(await JSZip.loadAsync(readFileSync('public/resourcepacks/XK redstone display 26.3.0.zip')), 'XK')
    const resolver = new BlockModelResolver(assets)
    for (const name of names) {
      const baked = await resolver.resolve(name, props), palette = [{ name, properties: props, baked }]
      const data = { palette, bounds, blocks: new Map([[0, 0]]) }
      const { groups } = await buildFaceGroups(palette, data.blocks, bounds)
      assert.ok(groups.size && [...groups.keys()].every(key => key.endsWith('|translucent')), name)
      const world = await Renderer.buildBlockPreview(data, assets)
      for (const mesh of meshes(world)) {
        assert.equal(mesh.material.transparent, true); assert.equal(mesh.material.opacity, 1)
        assert.equal(mesh.material.depthWrite, true); assert.equal(mesh.material.side, THREE.FrontSide)
        assert.equal(mesh.material.alphaTest, .1)
      }
      const resource = collectSceneResources(world)
      assert.ok([...resource.retained].some(t => t.name.includes('glass')), 'Original pack texture is retained')
      dispose(world)
      const item = { id: 'minecraft:' + name, count: 1 }
      for (const object of [await buildItemPreview(item, assets), await buildGuiItem(item, assets)]) {
        assert.ok(meshes(object).length, name)
        assert.ok(meshes(object).every(m => m.material.transparent && m.material.alphaTest === .1), 'Items/pane sprites keep fractional alpha: ' + name)
        dispose(object)
      }
      if (name === 'red_stained_glass' || name === 'red_stained_glass_pane') {
        const object = await buildEntityMesh({ id: 'minecraft:item_frame', pos: [0, 0, 0], rotation: [0, 0], nbt: { Facing: 2, Item: item } }, assets)
        assert.ok(meshes(object).some(m => m.material.transparent), 'Framed glass preserves transparency')
        dispose(object)
      }
    }
    const palette = await Promise.all(['red_stained_glass', 'blue_stained_glass', 'stone'].map(async name => ({ name, baked: await resolver.resolve(name, {}) })))
    for (const direction of [1, 2, 4]) {
      assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [direction, 0]]), bounds)).emitted, 10, 'Same colour hides touching faces')
      assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [direction, 1]]), bounds)).emitted, 12, 'Different colours retain the colour boundary')
      assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [direction, 2]]), bounds)).emitted, 11, 'Glass does not hide opaque blocks')
    }
    assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [4, 0]]), bounds, undefined, (_x, y) => y === 0)).emitted, 6, 'Slicing restores the exposed face')
  }
  const cube = (await new BlockModelResolver(assets).loadModel('block/cube_all'))
  const mixed = bakeModel({ ...cube, textures: { ...cube.textures, all: 'block/stone', translucent: { sprite: '#all', force_translucent: true } },
    elements: [{ ...cube.elements[0], faces: { ...cube.elements[0].faces, north: { texture: '#translucent' } } }] })
  assert.equal(mixed.quads.filter(q => q.forceTranslucent).length, 1)
  assert.deepEqual(resolveTexture('#a', { a: '#b', b: { sprite: 'minecraft:block/custom', force_translucent: true } }), { texKey: 'block/custom', forceTranslucent: true })
  const { groups } = await buildFaceGroups([{ name: 'stone', baked: mixed }], new Map([[0, 0]]), bounds)
  assert.equal(groups.size, 2, 'One sprite can appear on cutout and translucent faces without merging layers')
  assert.ok(groups.has('block/stone') && groups.has('block/stone|translucent'))
  // Custom pane models may supply cullfaces at the cell boundaries. Vanilla
  // requires horizontal connections on both neighbours, unlike glass cubes.
  const pane = bakeModel({ ...cube, textures: { ...cube.textures, all: 'block/glass' } })
  const palette = [props, { ...props, east: 'true' }, { ...props, west: 'true' }].map(properties => ({ name: 'glass_pane', properties, baked: pane }))
  assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [1, 0]]), bounds)).emitted, 12)
  assert.equal((await buildFaceGroups(palette, new Map([[0, 1], [1, 2]]), bounds)).emitted, 10)
  assert.equal((await buildFaceGroups(palette, new Map([[0, 0], [4, 0]]), bounds)).emitted, 10)
  console.log('PASS glass: 35 vanilla/XK blocks and panes, items/GUI/frames, real alpha, touching colours, pane connections, slices and per-face material flags')
} finally { assets.clearCaches(); globalThis.fetch = originalFetch }
