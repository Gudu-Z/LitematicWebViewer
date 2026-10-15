// 展示框模型复用回归：输出基线在引入缓存之前采集，包含几何、UV、材质及世界矩阵。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh } from '../src/entities.js'
import { Renderer } from '../src/renderer.js'

const root = 'public/assets/minecraft/', baseUrl = 'https://frame-cache.test/'
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
const originalFetch = globalThis.fetch, requests = new Map()
let failure = null
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(baseUrl), 'Tests must not access the network')
  const path = String(url).slice(baseUrl.length)
  requests.set(path, (requests.get(path) || 0) + 1)
  const failed = failure?.(path)
  if (failed) return failed
  const file = root + path
  return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 })
}

function provider(withPack = false) {
  const assets = new AssetProvider(); assets.baseUrl = baseUrl
  if (withPack) assets.addPack(pack, 'XK')
  // Use real model JSON, pack precedence and PNG dimensions; only browser image decoding is mocked.
  assets._getTexture = async key => {
    if (assets.failTexture === key) return null
    const path = 'textures/' + key + '.png'
    const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
    if (!entry && !existsSync(root + path)) return null
    const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
    const texture = new THREE.Texture(); texture.name = key
    texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    return texture
  }
  return assets
}

const makeItem = (name, data = {}) => ({ id: 'minecraft:' + name, count: 1, ...data })
const frame = (assets, item = makeItem('stone'), options = {}) => buildEntityMesh({
  id: 'minecraft:' + (options.id || 'item_frame'), pos: options.pos || [3, 5, 7], rotation: [0, 0],
  nbt: { Facing: options.facing ?? 2, ItemRotation: options.rotation ?? 0, Item: item },
}, assets)
function meshes(object) {
  const result = []
  object.traverse(o => { if (o.isMesh) result.push(o) })
  return result
}
function resources(objects) {
  const all = objects.flatMap(meshes)
  return { meshes: all, geometries: new Set(all.map(o => o.geometry)), materials: new Set(all.flatMap(o => [o.material].flat())) }
}
function clear(objects) {
  const entitiesGroup = new THREE.Group()
  entitiesGroup.add(...objects.filter(Boolean))
  Renderer.prototype.clearEntities.call({ entitiesGroup })
  assert.equal(entitiesGroup.children.length, 0)
}
const rounded = values => Array.from(values, value => Math.round(value * 1e8) / 1e8)
function snapshot(object) {
  object.updateMatrixWorld(true)
  return meshes(object).map(mesh => {
    const material = mesh.material
    return {
      matrix: rounded(mesh.matrixWorld.elements),
      attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, value]) => [name, rounded(value.array)])),
      index: [...mesh.geometry.index.array],
      material: { type: material.type, map: material.map?.name, color: rounded(material.color.toArray()), side: material.side, alphaTest: material.alphaTest, transparent: material.transparent, opacity: material.opacity, flatShading: material.flatShading, vertexColors: material.vertexColors },
    }
  })
}
function sameResources(first, second, label) {
  const a = meshes(first), b = meshes(second)
  assert.equal(a.length, b.length, label)
  a.forEach((mesh, i) => {
    assert.equal(mesh.geometry, b[i].geometry, label + ' geometry')
    assert.equal(mesh.material, b[i].material, label + ' material')
  })
}
function hasCompleteFrame(object) {
  const count = key => meshes(object).filter(o => o.material.map?.name === key)
    .reduce((total, o) => total + o.geometry.attributes.position.count, 0)
  assert.equal(count('block/item_frame'), 8, 'Frame backing must be complete')
  assert.equal(count('block/birch_planks'), 80, 'All four borders must be present')
}

const sherds = ['angler', 'archer', 'arms_up', 'skull'].map(id => 'minecraft:' + id + '_pottery_sherd')
const fixtures = [
  ['stone'], ['diamond'], ['copper_chest'], ['waxed_copper_chest'],
  ...['standing', 'running', 'sitting', 'star'].map(pose => ['copper_golem_statue', { components: { 'minecraft:block_state': { copper_golem_pose: pose } } }]),
  ['waxed_copper_golem_statue'], ['skeleton_skull'], ['shulker_box'], ['red_bed'], ['red_banner'],
  ['decorated_pot'],
  ['decorated_pot', { components: { 'minecraft:pot_decorations': Object.fromEntries(['back', 'left', 'right', 'front'].map((side, i) => [side, sherds[i]])) } }],
  ['decorated_pot', { tag: { BlockEntityTag: { sherds: sherds.toReversed() } } }],
  ['potion', { tag: { CustomPotionColor: 0xff0000 } }], ['potion', { tag: { CustomPotionColor: 0x00ff00 } }],
]
// Captured from the pre-cache renderer. Existing verify-frame-items independently checks vanilla sizes and pot ray intersections.
const expected = {
  vanilla: '05443a17f99a3c2968e6c8abdbdd264952715405e06857b3f667576a293f83b9',
  XK: '9f8825edb37634c340fb1d6c70ce78ccaf4f2ab2dee9aaf6cd5444fe837123ba',
}

try {
  for (const withPack of [false, true]) {
    const assets = provider(withPack), built = [], snapshots = []
    // Build all variants concurrently, then inspect: later variants must not recolor or reshape earlier ones.
    for (const [index, [name, data = {}]] of fixtures.entries()) for (const facing of [0, 2, 5]) {
      built.push(frame(assets, makeItem(name, data), { id: index % 2 ? 'glow_item_frame' : 'item_frame', facing, rotation: index % 8 }))
    }
    const objects = await Promise.all(built)
    for (const object of objects) snapshots.push(snapshot(object))
    const label = withPack ? 'XK' : 'vanilla'
    assert.equal(createHash('sha256').update(JSON.stringify(snapshots)).digest('hex'), expected[label], label + ' frame output must match the pre-cache renderer')
    clear(objects)

    const repeated = await Promise.all(Array.from({ length: 1000 }, (_, i) => frame(assets, makeItem('stone'), {
      pos: [i % 20, Math.floor(i / 20), 3], facing: i % 6, rotation: i % 8,
    })))
    const used = resources(repeated)
    assert.equal(used.meshes.length, 3000, 'Every frame must retain its backing, border and displayed block')
    assert.equal(used.geometries.size, 3, '1000 identical frames must share three geometries')
    assert.equal(used.materials.size, 3, '1000 identical frames must share three materials')
    const original = snapshot(repeated[1])
    repeated[0].children[1].position.set(100, 200, 300)
    repeated[0].children[1].quaternion.identity()
    assert.deepEqual(snapshot(repeated[1]), original, 'Instance transforms must remain independent')
    const disposals = new Map()
    for (const resource of [...used.geometries, ...used.materials]) {
      disposals.set(resource, 0)
      resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1))
    }
    let textureDisposals = 0
    for (const texture of new Set([...used.materials].map(m => m.map))) texture.addEventListener('dispose', () => textureDisposals++)
    clear(repeated)
    assert.ok([...disposals.values()].every(count => count === 1), 'Clearing shared frame meshes must dispose each geometry/material only once')
    assert.equal(textureDisposals, 0, 'Clearing entities must preserve AssetProvider textures')
    const reopened = await frame(assets)
    hasCompleteFrame(reopened)
    sameResources(repeated[1], reopened, 'Reopening should reuse the cached CPU template')
    clear([reopened])

    // Parsed NBT can include signed long values and typed arrays. Key construction must handle them and ignore property insertion order.
    const itemA = makeItem('stone', { tag: { CustomData: { serial: 1234567890123456789n, bytes: new Uint8Array([1, 2, 3]) } } })
    const itemB = { tag: { CustomData: { bytes: new Uint8Array([1, 2, 3]), serial: 1234567890123456789n } }, count: 1, id: 'minecraft:stone' }
    const [typedA, typedB] = await Promise.all([frame(assets, itemA), frame(assets, itemB)])
    sameResources(typedA, typedB, 'Equivalent NBT values must reuse a template')
    assert.equal(meshes(typedA.children[1]).length, 1)
    clear([typedA, typedB])

    // Large container/custom NBT must still render, without copying it into a permanent cache key.
    const largeItem = makeItem('stone', { tag: { CustomData: new Uint8Array(65536) } })
    const largeA = await frame(assets, largeItem), largeB = await frame(assets, largeItem)
    assert.deepEqual(snapshot(largeA), snapshot(largeB), 'Skipping an oversized NBT key must preserve output')
    sameResources(largeA.children[0], largeB.children[0], 'Large item NBT must not disable frame-body reuse')
    assert.notEqual(meshes(largeA.children[1])[0].geometry, meshes(largeB.children[1])[0].geometry, 'Oversized NBT must bypass item-template caching')
    clear([largeA, largeB])
  }

  // A failed first build may still contain its item or a partial body. Such results must never poison later openings.
  for (const failedPath of ['models/block/template_item_frame.json', 'models/block/cube_all.json', 'models/item/template_chest.json']) {
    const assets = provider(true), item = makeItem(failedPath.includes('chest') ? 'copper_chest' : 'stone')
    failure = path => path === failedPath ? new Response(null, { status: 503 }) : null
    const partial = await frame(assets, item)
    const failedRequests = requests.get(failedPath)
    assert.ok(failedRequests, 'Failure fixture must exercise ' + failedPath)
    failure = null
    const recovered = await frame(assets, item), clean = await frame(provider(true), item)
    hasCompleteFrame(recovered)
    assert.deepEqual(snapshot(recovered), snapshot(clean), failedPath + ' must recover the complete model and transforms')
    assert.ok(requests.get(failedPath) > failedRequests, 'A failed dependency must be requested again')
    clear([partial, recovered, clean])
  }
  for (const texture of ['block/item_frame', 'block/birch_planks', 'block/stone']) {
    const assets = provider(); assets.failTexture = texture
    const partial = await frame(assets)
    assets.failTexture = null
    const recovered = await frame(assets), clean = await frame(provider())
    assert.deepEqual(snapshot(recovered), snapshot(clean), texture + ' must recover after image failure')
    clear([partial, recovered, clean])
  }

  const replacement = new JSZip().file('assets/minecraft/items/stone.json', JSON.stringify({ model: { type: 'minecraft:model', model: 'minecraft:block/diamond_block' } }))
  const switched = provider(), before = await frame(switched)
  switched.addPack(replacement, 'replacement')
  const after = await frame(switched)
  assert.deepEqual([...new Set(meshes(after.children[1]).map(o => o.material.map?.name))], ['block/diamond_block'])
  assert.notEqual(meshes(before.children[1])[0].geometry, meshes(after.children[1])[0].geometry, 'Pack switching must invalidate frame templates')
  switched.removePack('replacement')
  const restored = await frame(switched)
  assert.deepEqual(snapshot(restored), snapshot(before), 'Removing a pack must restore the original frame output')
  clear([before, after, restored])

  // An earlier in-flight item load must not replace or evict templates produced after a pack switch.
  for (const rejectOld of [false, true]) {
    const assets = provider(), realGetJSON = assets._getJSON.bind(assets)
    let releaseOld, started
    const pending = new Promise(resolve => { started = resolve })
    assets._getJSON = path => {
      if (path !== 'items/stone.json') return realGetJSON(path)
      assets._getJSON = realGetJSON
      return new Promise((resolve, reject) => {
        releaseOld = () => rejectOld ? reject(new TypeError('Old pack load failed')) : resolve(JSON.parse(readFileSync(root + path, 'utf8')))
        started()
      })
    }
    const oldLoad = frame(assets)
    await pending
    assets.addPack(replacement, 'replacement')
    const replacementFrame = await frame(assets)
    releaseOld()
    const oldFrame = await oldLoad
    assert.equal(oldFrame, null, 'A frame started with an earlier pack must not return a mixed or incomplete model')
    const nextFrame = await frame(assets)
    assert.deepEqual(snapshot(nextFrame), snapshot(replacementFrame), 'A stale load must not alter the replacement pack result')
    sameResources(replacementFrame, nextFrame, 'A stale load must not evict replacement templates')
    clear([oldFrame, replacementFrame, nextFrame])
  }
  const cachedAssets = provider(), cachedFrame = await frame(cachedAssets)
  const cachedLoad = frame(cachedAssets)
  cachedAssets.clearCaches()
  assert.equal(await cachedLoad, null, 'A cached template must also be cancelled when its revision changes before the async caller resumes')
  const refreshedFrame = await frame(cachedAssets)
  hasCompleteFrame(refreshedFrame)
  assert.deepEqual(snapshot(refreshedFrame), snapshot(cachedFrame))
  clear([cachedFrame, refreshedFrame])
  console.log('PASS frame cache: 108 pre-cache output snapshots, vanilla/XK 1000-frame geometry/material reuse, independent transforms, shared resource cleanup/reopen, typed NBT keys, dependency recovery and pack-switch races')
} finally {
  globalThis.fetch = originalFetch
}
