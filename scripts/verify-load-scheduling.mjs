import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'

// Fake CPU time, real event-loop yields: many cheap meshes must not each incur
// a timer delay, but construction must still let an input/paint task run midway.
const view = Object.create(Renderer.prototype), target = new THREE.Group(), mat = new THREE.MeshBasicMaterial()
const groups = new Map(Array.from({ length: 512 }, (_, i) => ['block/' + i, {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  uvs: new Float32Array(8), indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
}]))
const materials = new Map([...groups.keys()].map(key => [key, mat]))
const originalNow = Object.getOwnPropertyDescriptor(performance, 'now'), originalTimer = globalThis.setTimeout
let clock = 0, timers = 0, yieldedAt
try {
  Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += .1) })
  globalThis.setTimeout = (...args) => { timers++; return originalTimer(...args) }
  const input = new Promise(resolve => originalTimer(() => { yieldedAt = target.children.length; resolve() }, 0))
  await view._appendBlockMeshes(groups, materials, target); await input
} finally {
  globalThis.setTimeout = originalTimer
  if (originalNow) Object.defineProperty(performance, 'now', originalNow)
  else delete performance.now
}
assert.equal(target.children.length, 512)
assert.ok(yieldedAt > 0 && yieldedAt < 512, 'Loading remains responsive')
assert.ok(timers < 20, 'Hundreds of cheap meshes must not incur hundreds of clamped timers')
for (const mesh of target.children) mesh.geometry.dispose()
mat.dispose()
console.log('PASS mesh assembly yields to input by CPU budget without a timer per small texture batch')

const bannerView = () => {
  const view = Object.create(Renderer.prototype)
  view.bannersGroup = new THREE.Group(); view.composites = []
  view._makeBannerTexture = async (...args) => {
    view.composites.push(args)
    return new THREE.Texture({ width: 64, height: 64 })
  }
  return view
}
const banners = Array.from({ length: 228 }, (_, x) => ({ x, y: 3, z: -5,
  baseColor: x % 2 ? 'red' : 'white', patterns: [{ pattern: 'stripe_top', color: 'blue' }] }))
const first = bannerView(), second = bannerView()
await first.renderBanners(banners, {})
assert.equal(first.composites.length, 2, 'Identical banner images are composed once')
assert.equal(first.bannersGroup.children.length, banners.length)
const flag = group => group.children[0]
const a = flag(first.bannersGroup.children[0]), b = flag(first.bannersGroup.children[2])
assert.equal(a.material, b.material)
a.userData.updateAnimation(17); b.userData.updateAnimation(17)
assert.notEqual(a.rotation.x, b.rotation.x, 'Sharing the image must not synchronize independent flag phases')
assert.equal(first.bannersGroup.children[2].position.x, 2.5)
const disposed = new Map()
for (const group of first.bannersGroup.children) for (const resource of [flag(group).material, flag(group).material.map]) {
  if (disposed.has(resource)) continue
  disposed.set(resource, 0); resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1))
}
await second.renderBanners(banners.slice(0, 1), {})
let otherDisposals = 0
flag(second.bannersGroup.children[0]).material.map.addEventListener('dispose', () => otherDisposals++)
await first.renderBanners(banners.slice(0, 1), {})
assert.ok([...disposed.values()].every(count => count === 1), 'Scene-owned shared banner resources are each disposed exactly once')
assert.equal(otherDisposals, 0)
assert.notEqual(flag(first.bannersGroup.children[0]).material, flag(second.bannersGroup.children[0]).material)
first.clearBanners(); first.clearBanners(); second.clearBanners()
assert.ok([...disposed.values()].every(count => count === 1))
console.log('PASS repeated banners share textures while preserving placement, animation and independent scene lifetimes')
