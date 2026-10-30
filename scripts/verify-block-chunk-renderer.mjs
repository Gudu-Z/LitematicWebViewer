import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { WebGLRenderLists } from 'three/src/renderers/webgl/WebGLRenderLists.js'
import { AssetProvider } from '../src/assets.js'
import { Renderer } from '../src/renderer.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'

const directions = ['up', 'down', 'east', 'west', 'north', 'south']
const cube = (texture, height = 16) => bakeModel({ textures: { all: texture }, elements: [{
  from: [0, 0, 0], to: [16, height, 16],
  faces: Object.fromEntries(directions.map(direction => [direction, { texture: '#all', cullface: direction }])),
}] })
const bounds = { minX: -45, minY: -20, minZ: -5, width: 96, height: 96, depth: 4 }
const palette = [
  { name: 'minecraft:stone', baked: cube('block/stone') },
  { name: 'minecraft:dirt', baked: cube('block/dirt') },
  { name: 'minecraft:water', properties: { level: '0' } },
]
const blocks = new Map()
const keyAt = (x, y, z) => x + z * bounds.width + y * bounds.width * bounds.depth
for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) for (let z = 0; z < 2; z++) {
  blocks.set(keyAt(x, y, z), x % 3 === 0 ? 1 : 0)
}
for (let y = 39; y < 43; y++) blocks.set(keyAt(32, y, 3), 2)
const data = { palette, blocks, bounds }
const view = Object.create(Renderer.prototype)
view.scene = new THREE.Scene()
view.group = new THREE.Group()
view.scene.add(view.group)
const assets = new AssetProvider()
const disposal = new Map()
function watch(resource) {
  if (!resource || disposal.has(resource)) return
  disposal.set(resource, 0)
  resource.addEventListener('dispose', () => disposal.set(resource, disposal.get(resource) + 1))
}
const textures = []
assets._getTexture = async key => {
  const texture = new THREE.Texture({ width: 16, height: 16 })
  texture.name = key
  textures.push(texture)
  watch(texture)
  return texture
}
function filterFor(mode, localY, regionKey = '') {
  const layerY = localY + bounds.minY
  const filter = (_x, y) => mode === 'single' ? y === layerY
    : mode === 'below' ? y <= layerY : mode === 'above' ? y >= layerY : true
  filter.descriptor = { mode, layerY, regionKey }
  return filter
}
function capture() {
  const parts = new Map()
  for (const [id, part] of view._blockState.parts) {
    const meshes = [...part.root.children]
    for (const mesh of meshes) { watch(mesh.geometry); watch(mesh.material) }
    parts.set(id, { root: part.root, meshes })
  }
  return parts
}
let renders = 0
async function render(filter) {
  const stats = await view.renderBlocks(data, assets, filter)
  const expected = await buildFaceGroups(palette, blocks, bounds, null, filter)
  assert.equal(stats.faces, expected.emitted, 'Renderer stats match full geometry rebuild')
  assert.equal(stats.textures, expected.groups.size, 'Renderer retains only textures still drawn')
  const usedByKey = new Map()
  view.scene.updateMatrixWorld(true)
  view.group.traverse(mesh => {
    if (!mesh.isMesh) return
    assert.equal(mesh.matrixAutoUpdate, false, 'Static block meshes stay frozen')
    assert.equal(mesh.matrixWorldAutoUpdate, false)
    assert.deepEqual(mesh.matrixWorld.elements, new THREE.Matrix4().elements, 'World Float32 vertices use identity matrices')
    const key = mesh.material.map.name
    if (usedByKey.has(key)) assert.equal(mesh.material, usedByKey.get(key), 'Every chunk shares its texture material')
    usedByKey.set(key, mesh.material)
  })
  renders++
  return capture()
}

let previous = await render(null)
assert.equal(view._blockState.index.enabled, true)
assert.equal(view._blockState.index.chunks.size, 9)
assert.equal(view._lastBlockUpdate.fullRebuild, true)
const firstState = view._blockState

previous = await render(filterFor('below', 40))
const originalMaterials = new Map(view._blockState.materials)
const next = await render(filterFor('below', 41))
const dirty = new Set(view._lastBlockUpdate.dirty)
assert.equal(view._blockState, firstState, 'Layer updates reuse the block index and scene state')
assert.equal(dirty.size, 4, 'Boundary row and the adjacent global water group rebuild')
assert.ok(view._lastBlockUpdate.scannedBlocks < blocks.size / 2)
for (const [id, before] of previous) {
  const after = next.get(id)
  assert.equal(after.root, before.root, 'Existing chunk roots remain stable')
  if (dirty.has(id)) {
    for (const oldMesh of before.meshes) {
      assert.ok(!after.meshes.includes(oldMesh), 'Affected chunk replaces its old draw meshes')
      assert.equal(disposal.get(oldMesh.geometry), 1, 'Replaced geometry is disposed exactly once')
    }
  } else {
    assert.deepEqual(after.meshes, before.meshes, 'Unaffected chunk keeps its meshes and geometry')
    for (const mesh of after.meshes) assert.equal(disposal.get(mesh.geometry), 0)
  }
}
for (const [key, material] of originalMaterials) {
  assert.equal(view._blockState.materials.get(key), material)
  assert.equal(disposal.get(material), 0, 'Shared material is not disposed while replacing one chunk')
}

await render(filterFor('below', 31))
previous = capture()
await render(filterFor('below', 32))
assert.equal(view._lastBlockUpdate.dirty.length, 6, 'Crossing the chunk edge rebuilds both adjoining rows')
for (const [id, before] of previous) if (!view._lastBlockUpdate.dirty.includes(id)) {
  assert.deepEqual(capture().get(id).meshes, before.meshes)
}

await render(filterFor('single', -1))
assert.equal(view.group.children.length, 0, 'An empty layer removes all draw nodes')
assert.equal(view._blockState.materials.size, 0, 'Empty layers release unused materials')
await render(null)
assert.ok(view.group.children.length > 0, 'Returning to all layers restores the full scene')

const beforeUnknown = capture()
await render((_x, y) => y <= bounds.minY + 41)
assert.equal(view._lastBlockUpdate.fullRebuild, true, 'Opaque callbacks cannot use a guessed layer delta')
for (const [id, before] of beforeUnknown) for (const oldMesh of before.meshes) {
  assert.ok(!capture().get(id).meshes.includes(oldMesh))
}
await render(filterFor('below', 41))
assert.equal(view._lastBlockUpdate.fullRebuild, true, 'The first known descriptor after an opaque filter rebuilds fully')
await render(filterFor('below', 41, 'regions-changed'))
assert.equal(view._lastBlockUpdate.fullRebuild, true)

const beforeRevision = view._blockState
const oldMaterials = [...beforeRevision.materials.values()]
// A resource pack can change which baked models are safe to split, even on the same data object.
palette[0] = { ...palette[0], baked: cube('block/stone', 8) }
assets.clearCaches()
await render(null)
assert.notEqual(view._blockState, beforeRevision)
assert.equal(view._lastBlockUpdate.fullRebuild, true)
assert.equal(view._blockState.index.splitGroups.has('block/stone'), false, 'New baked models invalidate the old split classification')
for (const material of oldMaterials) assert.equal(disposal.get(material), 1)

const currentMaterials = [...view._blockState.materials.values()]
view.clearBlocks(true)
assert.equal(view.group.children.length, 0)
assert.equal(view._blockState, null)
for (const material of currentMaterials) assert.equal(disposal.get(material), 1, 'Shared materials are cleared once across all chunks')
for (const [resource, count] of disposal) if (!resource.isTexture) assert.equal(count, 1, 'Every retired mesh resource is disposed once')
const cachedTextures = [...assets._ownedTextures]
for (const texture of cachedTextures) assert.equal(disposal.get(texture), 0, 'Scene cleanup preserves provider-owned textures')
view.clearBlocks(true)
for (const material of currentMaterials) assert.equal(disposal.get(material), 1, 'Repeated cleanup does not dispose twice')
view._syncSceneResources(assets)
assets.clearCaches()
for (const texture of textures) assert.equal(disposal.get(texture), 1, 'The provider eventually releases each texture exactly once')

// A temporary missing texture must not turn the selected layer into a cache hit.
palette[0] = { ...palette[0], baked: cube('block/stone') }
const loadTexture = assets._getTexture
let missingStone = true
assets._getTexture = key => missingStone && key === 'block/stone' ? null : loadTexture(key)
const sameLayer = filterFor('all', 0)
await view.renderBlocks(data, assets, sameLayer)
capture()
assert.equal(view._blockState.materials.has('block/stone'), false)
assert.equal(view._blockState.descriptor, undefined, 'An incomplete scene remains retryable')
missingStone = false
await render(sameLayer)
assert.equal(view._lastBlockUpdate.fullRebuild, true)
assert.equal(view._blockState.materials.has('block/stone'), true, 'Retrying the same layer restores missing geometry')

// A failed incremental build invalidates its old descriptor before mutating parts.
const appendMeshes = view._appendBlockMeshes
view._appendBlockMeshes = async function (...args) {
  await appendMeshes.apply(this, args)
  capture()
  throw new Error('injected append failure')
}
await assert.rejects(view.renderBlocks(data, assets, filterFor('below', 40)), /injected append failure/)
assert.equal(view._blockState.descriptor, undefined, 'A partially mutated scene cannot retain its old cache descriptor')
view._appendBlockMeshes = appendMeshes
await render(sameLayer)
assert.equal(view._lastBlockUpdate.fullRebuild, true, 'Returning to the layer selected before failure repairs every part')
view.clearBlocks(true)
view._syncSceneResources(assets)

// First-build failure after appending meshes but before attaching its root must
// release those orphaned geometries as well as the already loaded materials.
let orphans
view._appendBlockMeshes = async function (...args) {
  await appendMeshes.apply(this, args)
  capture()
  orphans = [...view._blockState.parts.values()].flatMap(part => part.root.children)
  throw new Error('injected unattached part failure')
}
await assert.rejects(view.renderBlocks(data, assets, null), /injected unattached part failure/)
assert.ok(orphans.length > 0)
assert.ok([...view._blockState.parts.values()].every(part => part.root.children.length === 0))
for (const mesh of orphans) assert.equal(disposal.get(mesh.geometry), 1, 'Unattached geometry is disposed immediately after failure')
assert.equal(view.group.children.length, 0)
const unattachedMaterials = [...view._blockState.materials.values()]
view.clearBlocks(true)
for (const mesh of orphans) assert.equal(disposal.get(mesh.geometry), 1, 'Unattached geometry is disposed after build failure')
for (const material of unattachedMaterials) assert.equal(disposal.get(material), 1, 'Unattached material is disposed after build failure')
view._appendBlockMeshes = appendMeshes
view._syncSceneResources(assets)
assets.clearCaches()
for (const [resource, count] of disposal) assert.equal(count, 1, `Every resource is disposed exactly once: ${resource.type || 'texture'}`)

// Grass side and overlay are coplanar. Their material order follows the model,
// regardless of which texture request finishes first.
const grassData = {
  palette: [{ name: 'minecraft:grass_block', properties: { snowy: 'false' },
    baked: bakeModel(JSON.parse(readFileSync('public/assets/minecraft/models/block/grass_block.json', 'utf8'))) }],
  blocks: new Map([[0, 0]]), bounds: { minX: 0, minY: 0, minZ: 0, width: 1, height: 1, depth: 1 },
}
const grassReference = await buildFaceGroups(grassData.palette, grassData.blocks, grassData.bounds)
const baseKey = 'block/grass_block_side', overlayKey = 'block/grass_block_side_overlay'
const grassKeys = [...grassReference.groups.keys()]
assert.ok(grassKeys.indexOf(baseKey) < grassKeys.indexOf(overlayKey))
const requests = new Map(), started = [], completed = [], concurrentMaterials = new Map(), concurrentTextures = []
const pendingMaterials = view._loadBlockMaterials(grassReference.groups, {
  getTexture(key) {
    started.push(key)
    return new Promise(resolve => requests.set(key, resolve))
  },
}, concurrentMaterials)
assert.deepEqual(started, grassKeys, 'Every texture request starts before any request is resolved')
function finishTexture(key) {
  const texture = new THREE.Texture({ width: 16, height: 16 })
  texture.name = key
  concurrentTextures.push(texture)
  completed.push(key)
  requests.get(key)(texture)
}
finishTexture(overlayKey)
await Promise.resolve()
assert.equal(concurrentMaterials.size, 0, 'An early overlay cannot claim an earlier material id')
for (const key of grassKeys) if (key !== overlayKey && key !== baseKey) finishTexture(key)
await Promise.resolve()
assert.equal(concurrentMaterials.size, 0, 'Material creation waits for the unresolved base without serializing texture requests')
finishTexture(baseKey)
await pendingMaterials
assert.equal(completed[0], overlayKey)
assert.equal(completed.at(-1), baseKey)
assert.deepEqual([...concurrentMaterials.keys()], grassKeys)
assert.ok(concurrentMaterials.get(baseKey).id < concurrentMaterials.get(overlayKey).id,
  'The base draws before the overlay even when its texture completes last')
for (const material of concurrentMaterials.values()) material.dispose()
for (const texture of concurrentTextures) texture.dispose()

// A cached overlay from a failed first load must not retain an earlier id when
// the missing base becomes available on an otherwise identical layer retry.
let missingGrassBase = true
assets._getTexture = key => missingGrassBase && key === baseKey ? null : loadTexture(key)
const partialStats = await view.renderBlocks(grassData, assets, sameLayer)
capture()
const partialState = view._blockState
const partialOverlay = partialState.materials.get(overlayKey)
assert.ok(partialOverlay)
assert.equal(partialState.materials.has(baseKey), false)
assert.equal(partialState.descriptor, undefined)
assert.equal(partialStats.textures, grassReference.groups.size - 1)
const partialMeshes = [...partialState.parts.values()].flatMap(part => part.root.children)
assert.ok(!partialMeshes.some(mesh => mesh.material.map.name === baseKey))
missingGrassBase = false
const recoveredStats = await view.renderBlocks(grassData, assets, sameLayer)
capture()
assert.notEqual(view._blockState, partialState, 'An incomplete scene rebuilds material ordering when retried')
assert.equal(view._lastBlockUpdate.fullRebuild, true)
assert.equal(disposal.get(partialOverlay), 1)
assert.ok(view._blockState.materials.get(baseKey).id < view._blockState.materials.get(overlayKey).id,
  'Retrying the same filter keeps the recovered base underneath its overlay')
assert.equal(recoveredStats.faces, grassReference.emitted)
assert.equal(recoveredStats.textures, grassReference.groups.size)
const recoveredMeshes = [...view._blockState.parts.values()].flatMap(part => part.root.children)
assert.equal(recoveredMeshes.length, grassReference.groups.size)
for (const [key, expected] of grassReference.groups) {
  const mesh = recoveredMeshes.find(candidate => candidate.material.map.name === key)
  assert.ok(mesh, `Recovered mesh exists: ${key}`)
  assert.deepEqual(mesh.geometry.attributes.position.array, expected.positions)
  assert.deepEqual(mesh.geometry.attributes.uv.array, expected.uvs)
  assert.deepEqual(mesh.geometry.index.array, expected.indices)
}
// A paused rebuild cannot wait for the next frame to drop the last render's
// references to the old multi-gigabyte buffers. Exercise Three's real cache.
const renderLists = new WebGLRenderLists()
const oldList = renderLists.get(view.scene, 0)
for (const mesh of recoveredMeshes) oldList.push(mesh, mesh.geometry, mesh.material, 0, 0, null, { reversedDepth: false })
assert.equal(oldList.opaque.length, recoveredMeshes.length)
view.renderer = { renderLists }
const beforeIncremental = view._blockState
const forceRebuild = () => true
forceRebuild.descriptor = { mode: 'all', regionKey: 'paused-region-update', hiddenRegions: [] }
await view._buildBlockMeshes(grassData, assets, null, forceRebuild)
capture()
assert.equal(view._blockState, beforeIncremental, 'Exercise an incremental state, without clearBlocks')
assert.notEqual(renderLists.get(view.scene, 0), oldList, 'A paused layer/region rebuild releases the last frame references immediately')
view.clearBlocks(true)
view.renderer = null
assert.notEqual(renderLists.get(view.scene, 0), oldList, 'Clearing blocks releases the previous draw list without another render')
assert.equal(renderLists.get(view.scene, 0).opaque.length, 0)
view._syncSceneResources(assets)
assets.clearCaches()
for (const [resource, count] of disposal) assert.equal(count, 1, `Every recovery resource is disposed once: ${resource.type || 'texture'}`)

console.log(`Block chunk renderer regression passed: ${renders + 2} scene/layer builds; untouched geometry reused, boundary rebuilding, revision invalidation, shared disposal and concurrent overlay ordering verified.`)
