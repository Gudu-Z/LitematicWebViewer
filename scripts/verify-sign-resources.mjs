import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'

function viewer() {
  const view = Object.create(Renderer.prototype)
  view.scene = new THREE.Scene()
  view.signsGroup = new THREE.Group()
  view.scene.add(view.signsGroup)
  view.drawn = []
  view._makeSignTexture = (lines, color) => {
    view.drawn.push({ lines, color })
    return new THREE.Texture({ width: 512, height: 128 })
  }
  return view
}

const view = viewer()
const sign = { x: 3, y: 2, z: -1, rotation: 0, color: 'black', lines: ['箱子', 'Storage', '', '12'] }
const signs = Array.from({ length: 20547 }, (_, i) => ({ ...sign, x: i, y: i % 3, lines: [String(i % 22)] }))
let yieldedAt = null
const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
let clock = 0
try {
  // Even a fast machine must yield before finishing thousands of cached labels.
  Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += .01) })
  const timer = new Promise(resolve => setTimeout(() => { yieldedAt = view.signsGroup.children.length; resolve() }, 0))
  await view.renderSigns(signs)
  await timer
} finally {
  if (originalNow) Object.defineProperty(performance, 'now', originalNow)
  else delete performance.now
}
assert.ok(yieldedAt > 0 && yieldedAt < signs.length, 'Input/paint tasks run before all signs finish')
const meshes = view.signsGroup.children
assert.equal(meshes.length, signs.length, 'All sign instances remain in the scene')
assert.equal(view.drawn.length, 22, 'Repeated labels draw only one full-resolution canvas each')
assert.equal(new Set(meshes.map(mesh => mesh.material)).size, 22)
assert.equal(new Set(meshes.map(mesh => mesh.geometry)).size, 1)
assert.ok(meshes.every(mesh => mesh.material.map.image.width === 512 && mesh.material.map.image.height === 128))
assert.ok(meshes.every(mesh => mesh.material.transparent && mesh.material.side === THREE.DoubleSide))
assert.ok(meshes.every(mesh => mesh.material.forceSinglePass), 'Flat labels avoid duplicate draws and material switches in large storage schematics')

view._layerMode = 'single'; view._layerY = 1
for (const mesh of meshes) view._applyLayerVisibility(mesh)
assert.deepEqual(meshes.map(mesh => mesh.visible), signs.map(sign => sign.y === 1), 'Shared labels still have independent layer visibility')
assert.deepEqual(meshes[22].position.toArray(), [22.5, 1.83, -.45], 'Shared geometry retains each sign position')
console.log('PASS 20,547 signs: 22 full-resolution textures, independent placement/layers and cooperative loading')

const disposed = new Map()
for (const mesh of meshes) for (const resource of [mesh.geometry, mesh.material, mesh.material.map]) {
  if (disposed.has(resource)) continue
  disposed.set(resource, 0)
  resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1))
}
const other = viewer()
await other.renderSigns([sign])
let otherDisposals = 0
other.signsGroup.children[0].material.map.addEventListener('dispose', () => otherDisposals++)
await view.renderSigns([sign])
assert.ok([...disposed.values()].every(count => count === 1), 'Rebuild releases every shared resource exactly once')
assert.equal(otherDisposals, 0, 'Clearing one scene never invalidates another preview')
assert.equal(view.signsGroup.children.length, 1)
assert.notEqual(view.signsGroup.children[0].material.map, other.signsGroup.children[0].material.map)
view.clearSigns(); view.clearSigns()
assert.ok([...disposed.values()].every(count => count === 1), 'Repeated clear does not dispose old resources again')
console.log('PASS sign resources are released once and owned independently by each scene')

const labels = viewer()
await labels.renderSigns([
  { ...sign, lines: ['a', 'b'] },
  { ...sign, lines: ['a', 'b', '', '', 'not rendered'], facing: 'east', hanging: true },
  { ...sign, lines: ['ab', ''] },
  { ...sign, lines: ['a', 'b'], color: 'red' },
  { ...sign, lines: ['a', 'b'], color: null },
  { ...sign, lines: ['a', 'b'], color: 'unknown' },
])
const [first, same, differentText, differentColor, fallback, sameFallback] = labels.signsGroup.children
assert.equal(first.material, same.material, 'Orientation and unused extra lines do not change the text texture')
assert.notEqual(first.material, differentText.material, 'Line boundaries cannot collide')
assert.notEqual(first.material, differentColor.material, 'Dye colors remain distinct')
assert.notEqual(first.material, fallback.material, 'Default dark text remains distinct from black dye')
assert.equal(fallback.material, sameFallback.material, 'Equivalent default colors reuse the same texture')
assert.notDeepEqual(first.matrixWorld.elements, same.matrixWorld.elements, 'Shared text does not share orientation')
labels.clearSigns(); other.clearSigns()
console.log('PASS sign text keys preserve colors, line breaks, orientation and the original four-line rendering')
