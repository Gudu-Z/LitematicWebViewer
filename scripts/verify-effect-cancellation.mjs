import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { addBlockEffects } from '../src/blockEffects.js'
import { addMovingPistons } from '../src/movingPistons.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = () => new Promise(resolve => setImmediate(resolve))
const aborted = async promise => {
  let timer
  try {
    await Promise.race([assert.rejects(promise, { name: 'AbortError' }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Cancellation kept waiting for a resource')), 500)
    })])
  } finally { clearTimeout(timer) }
}
const until = async (test, label) => {
  for (let n = 0; n < 100; n++) { if (test()) return; await settle() }
  assert.fail(label)
}
const bounds = width => ({ minX: 0, minY: 0, minZ: 0, maxX: width - 1, maxY: 0, maxZ: 0, width, height: 1, depth: 1 })
const bells = count => ({ bounds: bounds(count), palette: [{ name: 'minecraft:bell', properties: {} }],
  blocks: new Map(Array.from({ length: count }, (_, key) => [key, 0])) })
const texture = new THREE.Texture({ width: 32, height: 32 })
let textureDisposals = 0
texture.addEventListener('dispose', () => textureDisposals++)

// The viewer must settle on cancel before a delayed bell texture finishes.
{
  const gate = deferred(), controller = new AbortController(), view = Object.create(Renderer.prototype)
  view.group = new THREE.Group(); view.requestRender = () => {}
  view.clearBlocks = () => { view.group.clear(); view._blockState = null }
  let requests = 0, geometryDisposals = 0, materialDisposals = 0
  const geometryDispose = THREE.BufferGeometry.prototype.dispose, materialDispose = THREE.Material.prototype.dispose
  THREE.BufferGeometry.prototype.dispose = function () { geometryDisposals++; return geometryDispose.call(this) }
  THREE.Material.prototype.dispose = function () { materialDisposals++; return materialDispose.call(this) }
  try {
    const pending = view._buildBlockMeshes(bells(3), {
      cacheRevision: 0, getTexture: () => { requests++; return gate.promise },
    }, null, null, { signal: controller.signal })
    await until(() => requests === 1, 'Bell texture request')
    controller.abort()
    await aborted(pending)
    const replacement = new THREE.Group(), group = view._blockState.effects
    group.add(replacement)
    gate.resolve(texture); await settle()
    assert.deepEqual(group.children, [replacement], 'Late bell cannot attach to the replacement scene')
    assert.equal(requests, 1, 'Cancellation must stop scheduling the remaining bells')
    assert.equal(geometryDisposals, 1, 'Dispose the late rig geometry, not its cached template')
    assert.equal(materialDisposals, 1)
  } finally { THREE.BufferGeometry.prototype.dispose = geometryDispose; THREE.Material.prototype.dispose = materialDispose }
}

// Remove only this job's already-built effects when a later texture is canceled.
{
  const group = new THREE.Group(), gate = deferred(), controller = new AbortController()
  let requests = 0, firstDisposals = 0
  const pending = addBlockEffects(group, bells(3), { getTexture: () => ++requests === 1 ? Promise.resolve(texture) : gate.promise }, null, { signal: controller.signal })
  await until(() => requests === 2, 'Second bell texture')
  assert.equal(group.children.length, 1)
  group.traverse(object => object.geometry?.addEventListener('dispose', () => firstDisposals++))
  controller.abort(); await aborted(pending)
  assert.equal(firstDisposals, 1); assert.equal(group.children.length, 0)
  const replacement = new THREE.Group(); group.add(replacement)
  gate.resolve(texture); await settle()
  assert.deepEqual(group.children, [replacement]); assert.equal(requests, 2)
}

// Cached resources must still yield so a real input/timer can cancel long batches.
{
  const group = new THREE.Group(), controller = new AbortController()
  let requests = 0
  const timer = setTimeout(() => controller.abort(), 0)
  const pending = addBlockEffects(group, bells(10000), { getTexture: async () => { requests++; return null } }, null, { signal: controller.signal })
  await aborted(pending); clearTimeout(timer)
  assert.ok(requests > 0 && requests < 10000, 'An input task runs before cached effects finish')
}

const pistons = { bounds: bounds(2), palette: [{ name: 'minecraft:moving_piston', properties: {} }],
  blocks: new Map([[0, 0], [1, 0]]), tileEntities: [0, 1].map(x => ({ x, y: 0, z: 0, id: 'minecraft:piston',
    nbt: { blockState: { Name: 'minecraft:stone' }, facing: 5, progress: .5, extending: 1 } })) }

{
  const gate = deferred(), controller = new AbortController(), group = new THREE.Group()
  let requests = 0, previews = 0
  const pending = addMovingPistons(group, pistons, { getJSON: () => { requests++; return gate.promise } }, null,
    () => { previews++; return new THREE.Group() }, { signal: controller.signal })
  controller.abort(); await aborted(pending)
  gate.resolve(null); await settle()
  assert.equal(previews, 0); assert.equal(requests, 1)
}

// A real temporary preview builder may finish after cancel; release only its
// private mesh resources and close its own texture-load scope before discarding it.
{
  const gate = deferred(), controller = new AbortController(), group = new THREE.Group()
  let previews = 0, textureRequests = 0, loads = 0, geometryDisposals = 0, materialDisposals = 0
  const assets = {
    cacheRevision: 0, getTexture: () => { textureRequests++; return gate.promise },
    getJSON: async path => JSON.parse(readFileSync('public/assets/minecraft/' + path, 'utf8')),
    beginTextureLoad: () => { loads++; return () => { loads-- } },
  }
  const pending = addMovingPistons(group, pistons, assets, null, async (...args) => {
    previews++
    const root = await Renderer.buildBlockPreview(...args)
    root.traverse(object => {
      object.geometry?.addEventListener('dispose', () => geometryDisposals++)
      for (const mat of [object.material].flat()) mat?.addEventListener('dispose', () => materialDisposals++)
    })
    return root
  }, { signal: controller.signal })
  await until(() => textureRequests > 0, 'Moving piston preview texture')
  controller.abort(); await aborted(pending)
  const replacement = new THREE.Group(); group.add(replacement)
  gate.resolve(texture); await settle()
  assert.equal(previews, 1, 'Do not create another moving-piston preview after cancellation')
  assert.equal(loads, 0, 'Late temporary builder finishes its texture-load scope')
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1)
  assert.deepEqual(group.children, [replacement])
}
assert.equal(textureDisposals, 0, 'Borrowed textures must survive canceled effect and piston loads')
console.log('PASS cancel bell/book effects and moving pistons promptly; discard late private resources without touching textures or replacement scenes')
