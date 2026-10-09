import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createOverview, setOverviewDetail, setOverviewFilter, disposeOverview } from '../src/overviewRenderer.js'
import { bakeModel } from '../src/modelBaker.js'
import { Renderer } from '../src/renderer.js'

const baked = bakeModel({ textures: { all: 'block/test' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['up', 'down', 'north', 'south', 'east', 'west'].map(face => [face, { texture: '#all' }])) }] })
const texture = new THREE.DataTexture(new Uint8Array([255, 64, 32, 255]), 1, 1)
let textureRequests = 0
const assets = { getTexture: async () => { textureRequests++; return texture } }
const bounds = { minX: -3, minY: -5, minZ: 7, maxX: 2, maxY: 0, maxZ: 12, width: 6, height: 6, depth: 6 }
const data = { bounds, palette: [{ name: 'minecraft:stone', properties: {}, baked }], overview: { step: 4, width: 2, height: 2, depth: 2, states: new Uint32Array(8).fill(1) } }
const group = await createOverview(data, assets)
assert.equal(textureRequests, 1, 'reuses one texture average across every coarse face')
assert.deepEqual(group.userData.stats, { faces: 24, textures: 1 }, 'omits all shared interior faces')
const worldBox = new THREE.Box3().setFromObject(group)
assert.deepEqual(worldBox.min.toArray(), [-3, -5, 7])
assert.deepEqual(worldBox.max.toArray(), [3, 1, 13], 'partial final cells never exceed schematic bounds')
const middle = worldBox.getCenter(new THREE.Vector3())
for (const mesh of group.children) {
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let offset = 0; offset < index.count; offset += 3) {
    a.fromBufferAttribute(position, index.getX(offset))
    b.fromBufferAttribute(position, index.getX(offset + 1))
    c.fromBufferAttribute(position, index.getX(offset + 2))
    const normal = b.clone().sub(a).cross(c.clone().sub(a))
    const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3)
    assert.ok(normal.dot(centre.sub(middle)) > 0, 'all face triangles point outwards')
  }
}
const ray = new THREE.Raycaster(new THREE.Vector3(2, 9, 12), new THREE.Vector3(0, -1, 0))
assert.ok(ray.intersectObject(group, true).length > 0)
setOverviewDetail(group, { minX: 1, minY: -1, minZ: 11, maxX: 2, maxY: 0, maxZ: 12 })
assert.equal(ray.intersectObject(group, true).length, 0, 'picking excludes clipped detail including partial edge cells')
setOverviewDetail(group, null)
assert.ok(ray.intersectObject(group, true).length > 0)

await setOverviewFilter(group, { mode: 'single', layerY: -3 })
let slice = new THREE.Box3().setFromObject(group)
assert.equal(slice.min.y, -3)
assert.equal(slice.max.y, -2)
assert.equal(group.userData.stats.faces, 16, 'single layer exposes both caps')
await setOverviewFilter(group, { mode: 'below', layerY: -3 })
slice = new THREE.Box3().setFromObject(group)
assert.equal(slice.min.y, -5)
assert.equal(slice.max.y, -2)
await setOverviewFilter(group, { mode: 'above', layerY: -3 })
slice = new THREE.Box3().setFromObject(group)
assert.equal(slice.min.y, -3)
assert.equal(slice.max.y, 1)
await setOverviewFilter(group, { hiddenRegions: [bounds] })
assert.equal(group.children.length, 0)
await setOverviewFilter(group, null)
assert.equal(group.userData.stats.faces, 24)

let disposedGeometries = 0, disposedMaterials = 0, disposedTextures = 0
for (const mesh of group.children) mesh.geometry.addEventListener('dispose', () => disposedGeometries++)
group.userData.overview.material.addEventListener('dispose', () => disposedMaterials++)
texture.addEventListener('dispose', () => disposedTextures++)
const geometryCount = group.children.length
disposeOverview(group)
disposeOverview(group)
assert.equal(disposedGeometries, geometryCount)
assert.equal(disposedMaterials, 1)
assert.equal(disposedTextures, 0, 'overview never owns the shared asset textures')
console.log('Overview rendering: occlusion, face winding, resource colours, bounds, detail picking, layer caps and disposal passed.')

// Exercise the real staging path without creating a WebGL context. The visible
// scene must remain intact until a complete, still-current window is installed.
const renderer = Object.create(Renderer.prototype)
renderer.scene = new THREE.Scene()
for (const name of ['group', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup', 'entitiesGroup']) {
  renderer[name] = new THREE.Group()
  renderer.scene.add(renderer[name])
}
renderer.overviewGroup = await createOverview(data, assets)
renderer.scene.add(renderer.overviewGroup)
renderer._bounds = bounds
renderer._bgColor = 0x2a2a2a
const original = new THREE.Object3D()
renderer.group.add(original)
const detail = { bounds: { minX: 1, maxX: 1, minY: -1, maxY: -1, minZ: 11, maxZ: 11, width: 1, height: 1, depth: 1 }, palette: data.palette, blocks: new Map([[0, 0]]), tileEntities: [], entities: [] }
const stage = await renderer.prepareDetail(detail, assets)
assert.deepEqual(renderer.group.children, [original], 'preparing a window never changes the visible scene')
assert.equal(stage.group.children.length, 1)
renderer.installDetail(stage, detail)
assert.equal(renderer.detailData, detail)
assert.equal(renderer.group.children.length, 1)
assert.equal(renderer._bounds, bounds, 'installing detail preserves the whole-model bounds')
assert.equal(renderer._waterBounds, detail.bounds, 'water lookup uses the detail-local coordinate grid')
assert.equal(renderer.overviewGroup.userData.overview.detail.minX, 1)
renderer.disposeDetail(stage)
assert.equal(renderer.group.children.length, 1, 'consumed stages cannot dispose installed geometry')
const currentMesh = renderer.group.children[0]
await assert.rejects(renderer.prepareDetail(detail, assets, { isCurrent: () => false }), { name: 'AbortError' })
assert.equal(renderer.group.children[0], currentMesh)
let textureFinished
let current = true
const delayedAssets = { getTexture: () => new Promise(resolve => { textureFinished = () => { current = false; resolve(texture) } }) }
const preparing = renderer.prepareDetail(detail, delayedAssets, { isCurrent: () => current })
while (!textureFinished) await new Promise(resolve => setTimeout(resolve, 0))
textureFinished()
await assert.rejects(preparing, { name: 'AbortError' })
assert.equal(renderer.group.children[0], currentMesh, 'a request cancelled during texture loading preserves the old detail')
renderer.clearDetail()
assert.equal(renderer.group.children.length, 0)
assert.equal(renderer.detailData, null)
assert.equal(renderer.overviewGroup.userData.overview.detail, null)
assert.equal(renderer._bounds, bounds)
assert.equal(disposedTextures, 0, 'staging and detail swaps preserve shared asset textures')
disposeOverview(renderer.overviewGroup)
console.log('Overview integration: atomic detail install, cancellation, shared resource ownership and water bounds passed.')

// Resource-pack changes invalidate caches before old decode promises necessarily
// finish. Both an installed window and a cancelled late decode must release
// those textures, while ordinary swaps leave current cached textures intact.
renderer.overlay = new THREE.Group()
renderer.regionGroup = new THREE.Group()
const packTexture = new THREE.DataTexture(new Uint8Array([32, 64, 255, 255]), 1, 1)
let packDisposals = 0
packTexture.addEventListener('dispose', () => packDisposals++)
const cachedAssets = { textureCache: new Map(), getTexture(key) {
  if (!this.textureCache.has(key)) this.textureCache.set(key, Promise.resolve(packTexture))
  return this.textureCache.get(key)
} }
const cachedStage = await renderer.prepareDetail(detail, cachedAssets)
renderer.installDetail(cachedStage, detail)
renderer.clearDetail()
assert.equal(packDisposals, 0, 'normal detail eviction preserves textures still held by the asset cache')
const replacedStage = await renderer.prepareDetail(detail, cachedAssets)
renderer.installDetail(replacedStage, detail)
cachedAssets.textureCache.clear()
renderer.clear(true)
assert.equal(packDisposals, 1, 'clearing for a resource-pack change releases installed detail textures exactly once')

const lateTexture = new THREE.DataTexture(new Uint8Array([64, 255, 32, 255]), 1, 1)
let lateDisposals = 0, finishDecode, lateCurrent = true
lateTexture.addEventListener('dispose', () => lateDisposals++)
const lateAssets = { textureCache: new Map(), getTexture(key) {
  if (!this.textureCache.has(key)) this.textureCache.set(key, new Promise(resolve => { finishDecode = () => resolve(lateTexture) }))
  return this.textureCache.get(key)
} }
const lateStage = renderer.prepareDetail(detail, lateAssets, { isCurrent: () => lateCurrent })
while (!finishDecode) await new Promise(resolve => setTimeout(resolve, 0))
lateAssets.textureCache.clear()
lateCurrent = false
finishDecode()
await assert.rejects(lateStage, { name: 'AbortError' })
assert.equal(lateDisposals, 1, 'cancelled stages release late textures whose original cache entry was invalidated')

const skinTexture = new THREE.DataTexture(new Uint8Array([255, 200, 170, 255]), 1, 1)
let skinDisposals = 0
skinTexture.addEventListener('dispose', () => skinDisposals++)
const skinUrl = 'https://example.test/player-skin.png'
const skinAssets = { textureCache: new Map([[skinUrl, Promise.resolve(skinTexture)]]), getTexture: assets.getTexture,
  async getExternalTexture(key) { return this.textureCache.get(key) },
}
assert.notEqual(skinAssets.getExternalTexture(skinUrl), skinAssets.textureCache.get(skinUrl), 'async accessors wrap the actual cached promise')
const skull = { id: 'minecraft:skull', x: 1, y: -1, z: 11, nbt: { profile: { properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({ textures: { SKIN: { url: skinUrl } } })).toString('base64') }] } } }
const headData = { ...detail, palette: [{ name: 'minecraft:player_head', properties: {}, baked }], tileEntities: [skull] }
const skinStage = await renderer.prepareDetail(headData, skinAssets)
assert.equal(skinStage.headsGroup.children.length, 1)
renderer.disposeDetail(skinStage)
assert.equal(skinDisposals, 0, 'async external skin accessors do not make still-cached textures appear orphaned')
const activeSkinStage = await renderer.prepareDetail(headData, skinAssets)
renderer.installDetail(activeSkinStage, headData)
skinAssets.textureCache.clear()
renderer.clear(true)
assert.equal(skinDisposals, 1, 'invalidated external skins still dispose exactly once on resource-pack changes')
console.log('Overview texture lifecycle: cached swaps, resource-pack changes and cancelled late decodes passed.')
