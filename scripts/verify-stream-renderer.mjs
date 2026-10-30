import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroupsStream } from '../src/geometry.js'
import { filterFromDescriptor } from '../src/workerProtocol.js'

const bounds = { minX: 0, minY: 0, minZ: 0, width: 128, height: 2, depth: 128 }
const cube = texture => bakeModel({ textures: { all: texture }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(['up', 'down', 'north', 'south', 'east', 'west'].map(face => [face, { texture: '#all', cullface: face }])) }] })
const palette = [
  { name: 'minecraft:stone', baked: cube('block/stone') },
  { name: 'minecraft:slime_block', baked: cube('block/slime_block') },
  { name: 'minecraft:water', properties: { level: '0' } },
]
const blocks = new Map()
for (let z = 0; z < 32; z += 2) for (let x = 0; x < 128; x += 2) blocks.set(x + z * bounds.width, x % 3)
// Exercise the paged renderer route with a tiny iterable fixture. Real page
// encoding and real Worker transfer are covered separately by their suites.
blocks.isPagedBlockStore = true
blocks.regions = [{ minY: 0, maxY: 1 }]
blocks.keyView = { length: blocks.size, [Symbol.iterator]: () => blocks.keys() }
const data = { bounds, palette, blocks }
const view = Object.create(Renderer.prototype)
view.scene = new THREE.Scene(); view.group = new THREE.Group(); view.scene.add(view.group)
view.selectable = true
const textures = new Map()
const assets = { cacheRevision: 0, getTexture: async key => {
  if (!textures.has(key)) { const texture = new THREE.Texture(); texture.name = key; textures.set(key, texture) }
  return textures.get(key)
} }
let jobs = 0, ranges = [], cleanups = 0, prepared = [], abortOnBatch
view.workerClient = {
  canBuild: () => true, canStream: () => true,
  build: () => assert.fail('Capable worker must stream'),
  async buildStream(_data, options, handlers, controls) {
    jobs++
    const context = { signal: controls.signal }
    return buildFaceGroupsStream(palette, blocks, bounds, handlers.onProgress, filterFromDescriptor(options.descriptor), {
      ...options, ...controls, batchBytes: 2048,
      onLayout: layout => handlers.onLayout(layout, context),
      onBatch: async batch => {
        await handlers.onBatch(batch, context)
        abortOnBatch?.()
        return { slabs: batch.slabs }
      },
    })
  },
}
view._gpuUpload = {
  async uploadRange(array, offset, count) { ranges.push({ array, offset, count }) },
  async prepareObject(root, { skipIndex, onProgress }) {
    prepared = root.children.map(object => ({ object, skipIndex: skipIndex(object) }))
    onProgress(1)
  },
  releaseUnused() { cleanups++ }, clear() {},
}
const progress = [], stages = []
const stats = await view._buildBlockMeshes(data, assets, fraction => progress.push(fraction), null,
  { onStage: stage => stages.push(stage.phase) })
assert.equal(jobs, 1)
assert.ok(stats.faces > 0 && ranges.length > 20)
assert.ok(progress.every((fraction, index) => !index || fraction >= progress[index - 1]))
assert.ok(stages.includes('upload'))
const kept = new Set()
for (const { object, skipIndex } of prepared) {
  assert.equal(skipIndex, !!object.material?.translucentMaps)
  for (const attribute of Object.values(object.geometry.attributes)) kept.add(attribute.array)
  if (object.geometry.index) kept.add(object.geometry.index.array)
}
assert.ok(ranges.every(range => kept.has(range.array)), 'Only retained final GPU arrays are uploaded during streaming')
assert.ok(prepared.some(entry => entry.skipIndex), 'Merged translucent indices remain camera-dependent')
assert.equal(cleanups, 1)
const controller = new AbortController()
abortOnBatch = () => controller.abort()
const filter = () => true
filter.descriptor = { mode: 'below', layerY: 0 }
await assert.rejects(view.renderBlocks(data, assets, filter, { signal: controller.signal }), error => error.name === 'AbortError')
assert.equal(cleanups, 2, 'A failed packet releases provisional GPU allocations')
assert.equal(view._blockState.descriptor, undefined)
abortOnBatch = null; ranges = []
await view.renderBlocks(data, assets, null)
assert.equal(jobs, 3, 'A cancelled stream can rebuild the original full view')
assert.equal([...view._blockState.parts.values()].every(part => part.complete), true)
const prepare = view._gpuUpload.prepareObject
for (const cancel of [false, true]) {
  const controller = new AbortController(), owned = new Set(), disposed = new Set()
  view._gpuUpload.prepareObject = async function (...args) {
    await prepare.apply(this, args)
    for (const object of args[0].children) {
      owned.add(object.geometry)
      object.geometry.addEventListener('dispose', () => disposed.add(object.geometry))
    }
    if (cancel) controller.abort()
    else throw new Error('Injected GPU preparation failure')
  }
  await assert.rejects(view.renderBlocks(data, assets, filter, { signal: controller.signal }),
    error => cancel ? error.name === 'AbortError' : /GPU preparation failure/.test(error.message))
  assert.ok(owned.size > 0)
  assert.deepEqual(disposed, owned, 'A partially attached upload releases every geometry immediately')
  assert.equal(view.group.children.length, 0, 'An incremental failure never exposes its partial root')
  assert.ok([...view._blockState.parts.values()].every(part => part.root.children.length === 0 && !part.complete))
  assert.equal(view._blockState.materials.size, 0, 'Failed compact shader closures cannot retain full CPU arrays')
  view._gpuUpload.prepareObject = prepare
  await view.renderBlocks(data, assets, null)
}
view.clearBlocks()
for (const texture of textures.values()) texture.dispose()
console.log('Stream renderer: retained arrays, translucent merge, progress, cancellation and rebuild passed')
