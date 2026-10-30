import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { AssetProvider } from '../src/assets.js'
import { withAbort } from '../src/loadingTask.js'
import { portalMaterial } from '../src/blockEffects.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 0)) }
const texture = name => { const tex = new THREE.Texture(); tex.name = name; tex.image = { width: 64, height: 64 }; return tex }

// A request can already be rejected when cancellation is observed. It must
// still have a rejection handler even though the caller sees AbortError.
{
  const controller = new AbortController(); controller.abort()
  await assert.rejects(withAbort(Promise.reject(new Error('Late request failure')), controller.signal), { name: 'AbortError' })
  const active = new AbortController()
  let fail
  const request = new Promise((_resolve, reject) => { fail = reject })
  const pending = withAbort(request, active.signal)
  active.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  fail(new Error('Network failed after cancellation')); await settle()
}
{
  const controller = new AbortController(), gate = deferred(), requested = []
  const pending = portalMaterial({ getTexture(key) { requested.push(key); return gate.promise } }, false, { signal: controller.signal })
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' })
  const sky = texture('sky'), version = sky.version
  gate.resolve(sky); await settle()
  assert.deepEqual(requested, ['environment/end_sky'], 'Cancel before requesting the next portal texture')
  assert.equal(sky.version, version, 'A late cancelled portal does not mutate borrowed textures')
}
function viewer() {
  const view = Object.create(Renderer.prototype)
  view.scene = new THREE.Scene()
  for (const name of ['entitiesGroup', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']) {
    view[name] = new THREE.Group(); view.scene.add(view[name])
  }
  return view
}
const aborted = promise => assert.rejects(promise, { name: 'AbortError' })
const addReplacement = group => { const replacement = new THREE.Group(); group.add(replacement); return replacement }

for (const [method, group, item, getter] of [
  ['renderPlayerHeads', 'headsGroup', { x: 0, y: 0, z: 0, skinUrl: 'pending' }, 'getExternalTexture'],
  ['renderStatues', 'statuesGroup', { x: 0, y: 0, z: 0, texKey: 'pending' }, 'getTexture'],
]) {
  const view = viewer(), gate = deferred(), controller = new AbortController(), tex = texture('borrowed')
  let requests = 0, disposed = 0
  tex.addEventListener('dispose', () => disposed++)
  const pending = view[method]([item, item], { [getter]: () => { requests++; return gate.promise } }, { signal: controller.signal })
  controller.abort(); await aborted(pending)
  const replacement = addReplacement(view[group])
  gate.resolve(tex); await settle()
  assert.equal(requests, 1, method + ': stop scheduling')
  assert.deepEqual(view[group].children, [replacement], method + ': late textures cannot attach old objects')
  assert.equal(disposed, 0, method + ': borrowed texture ownership remains with provider')
}

{
  const view = viewer(), gate = deferred(), controller = new AbortController(), tex = texture('private banner')
  let disposed = 0, requests = 0
  tex.addEventListener('dispose', () => disposed++)
  view._makeBannerTexture = () => { requests++; return gate.promise }
  const pending = view.renderBanners([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], {}, { signal: controller.signal })
  controller.abort(); await aborted(pending)
  const replacement = addReplacement(view.bannersGroup)
  gate.resolve(tex); await settle()
  assert.equal(disposed, 1, 'Late banner composite texture is privately owned and must be disposed')
  assert.equal(requests, 1)
  assert.deepEqual(view.bannersGroup.children, [replacement])
}

{
  const view = viewer(), gate = deferred(), controller = new AbortController(), requested = []
  const originalDocument = globalThis.document
  globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {}, fillRect() {} }) }) }
  try {
    const pending = view.renderBanners([{ x: 0, y: 0, z: 0, baseColor: 'white',
      patterns: ['first', 'second', 'third'].map(pattern => ({ pattern, color: 'red' })) }], {
      getTexture: key => { requested.push(key); return key.endsWith('/base') ? Promise.resolve(texture(key)) : gate.promise },
    }, { signal: controller.signal })
    await settle(); assert.deepEqual(requested, ['entity/banner/base', 'entity/banner/first'])
    controller.abort(); await aborted(pending)
    gate.resolve(texture('first')); await settle()
    assert.deepEqual(requested, ['entity/banner/base', 'entity/banner/first'], 'Cancelled banner composition stops requesting remaining patterns')
    assert.equal(view.bannersGroup.children.length, 0)
  } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument }
}

{
  const view = viewer(), gate = deferred(), controller = new AbortController(), blank = texture('blank'), pattern = texture('pattern')
  const original = THREE.Material.prototype.dispose, geometryDispose = THREE.BufferGeometry.prototype.dispose
  let disposed = 0, geometries = 0, textures = 0, began = false
  blank.addEventListener('dispose', () => textures++); pattern.addEventListener('dispose', () => textures++)
  THREE.Material.prototype.dispose = function () { if (this.map === blank) disposed++; return original.call(this) }
  THREE.BufferGeometry.prototype.dispose = function () { geometries++; return geometryDispose.call(this) }
  try {
    const pending = view.renderDecoratedPots([{ x: 0, y: 0, z: 0, sherds: { back: 'minecraft:skull_pottery_sherd' } }], {
      getTexture: key => key.endsWith('_side') ? Promise.resolve(blank) : (began = true, gate.promise),
    }, { signal: controller.signal })
    await settle(); assert.ok(began, 'First pot side exists before second texture is requested')
    controller.abort(); await aborted(pending)
    const replacement = addReplacement(view.potsGroup)
    gate.resolve(pattern); await settle()
    assert.equal(disposed, 1, 'Discard material for the built but unmounted side')
    assert.equal(geometries, 0, 'Global pot side geometry must remain reusable')
    assert.equal(textures, 0)
    assert.deepEqual(view.potsGroup.children, [replacement])
  } finally { THREE.Material.prototype.dispose = original; THREE.BufferGeometry.prototype.dispose = geometryDispose }
}

{
  const view = viewer(), controller = new AbortController(), clock = Object.getOwnPropertyDescriptor(performance, 'now')
  let time = 0, textures = 0, disposed = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => { time += 9; return time } })
  view._makeSignTexture = () => { textures++; const tex = texture('sign'); tex.addEventListener('dispose', () => disposed++); return tex }
  try {
    const signs = Array.from({ length: 100 }, (_, x) => ({ x, y: 0, z: 0, lines: ['same'] }))
    const pending = view.renderSigns(signs, {}, { signal: controller.signal })
    assert.equal(view.signsGroup.children.length, 1, 'Fixture reaches a deterministic UI yield')
    controller.abort(); await aborted(pending)
    view.clearSigns()
    const replacement = addReplacement(view.signsGroup)
    await settle()
    assert.equal(textures, 1); assert.equal(disposed, 1)
    assert.deepEqual(view.signsGroup.children, [replacement], 'A yielded sign loop cannot resume into replacement scene')
  } finally { if (clock) Object.defineProperty(performance, 'now', clock); else delete performance.now }
}
console.log('PASS head/statue borrowed textures, late banner composites, partially built pot materials and yielded sign cancellation')

function assetsFixture() {
  const assets = new AssetProvider(), textures = []
  assets._getJSON = async path => {
    const file = 'public/assets/minecraft/' + path
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
  assets._getTexture = async key => { const tex = texture(key); textures.push(tex); return tex }
  return { assets, textures }
}
const frame = (index, item = '__cancel_' + index) => ({ id: 'minecraft:item_frame', pos: [index * 2, 0, 0], rotation: [0, 0],
  nbt: { Facing: 3, ...(item ? { Item: { id: 'minecraft:' + item, count: 1 } } : {}) } })
{
  const view = viewer(), controller = new AbortController(), { assets, textures } = assetsFixture(), gates = new Map(), progress = []
  const getJSON = assets._getJSON.bind(assets), disposeGeometry = THREE.BufferGeometry.prototype.dispose
  let disposedGeometry = 0
  assets._getJSON = path => {
    const match = /^models\/item\/__cancel_(\d+)\.json$/.exec(path)
    if (!match) return getJSON(path)
    const gate = deferred(); gates.set(Number(match[1]), gate); return gate.promise
  }
  THREE.BufferGeometry.prototype.dispose = function () { disposedGeometry++; return disposeGeometry.call(this) }
  try {
    const pending = view.renderEntities(Array.from({ length: 64 }, (_, i) => frame(i)), assets, undefined,
      (_fraction, detail) => progress.push(detail), { signal: controller.signal })
    await settle(); assert.equal(gates.size, 50)
    gates.get(49).resolve({ textures: { layer0: 'item/__cancel_49' } })
    await settle(); assert.equal(gates.size, 51); assert.equal(progress.at(-1).completed, 1)
    controller.abort(); await aborted(pending)
    assert.ok(disposedGeometry > 0, 'Already built, unmounted entity geometry is released immediately')
    const count = progress.length, atAbort = disposedGeometry, replacement = addReplacement(view.entitiesGroup)
    let disposedTexture = 0
    for (const tex of textures) tex.addEventListener('dispose', () => disposedTexture++)
    for (const [index, gate] of gates) gate.resolve({ textures: { layer0: 'item/__cancel_' + index } })
    await settle(); await settle()
    assert.equal(gates.size, 51, 'Cancelled workers cannot start the next 13 entities')
    assert.equal(progress.length, count, 'Late model completions do not report stale progress')
    assert.ok(disposedGeometry > atAbort, 'In-flight geometry is disposed when it completes')
    assert.equal(disposedTexture, 0, 'Provider textures survive cancelled geometry')
    assert.deepEqual(view.entitiesGroup.children, [replacement])
  } finally { THREE.BufferGeometry.prototype.dispose = disposeGeometry; assets.clearCaches() }
}

{
  const view = viewer(), controller = new AbortController(), { assets } = assetsFixture(), gate = deferred()
  const getJSON = assets._getJSON.bind(assets)
  assets._getJSON = path => path === 'models/item/__cancel_0.json' ? gate.promise : getJSON(path)
  const pending = view.renderEntities([frame(0)], assets, undefined, null, { signal: controller.signal })
  await settle(); controller.abort(); await aborted(pending)
  await view.renderEntities([frame(100, '')], assets)
  const children = [...view.entitiesGroup.children]
  let disposed = 0
  view.entitiesGroup.traverse(object => {
    object.geometry?.addEventListener('dispose', () => disposed++)
    for (const mat of [object.material].flat()) mat?.addEventListener('dispose', () => disposed++)
  })
  gate.resolve({ textures: { layer0: 'item/__cancel_0' } }); await settle(); await settle()
  assert.equal(disposed, 0, 'Late cancelled frame retains shared geometry/materials already used by replacement')
  assert.deepEqual(view.entitiesGroup.children, children)
  view.clearEntities(); assets.clearCaches()
}

{
  const view = viewer(), controller = new AbortController(), { assets } = assetsFixture(), gate = deferred(), began = deferred()
  const getTexture = assets._getTexture.bind(assets), disposeGeometry = THREE.BufferGeometry.prototype.dispose
  let attempts = 0, disposed = 0
  assets._getTexture = key => {
    if (key !== 'block/item_frame') return getTexture(key)
    attempts++
    if (attempts < 3) return Promise.resolve(null)
    began.resolve(); return gate.promise
  }
  THREE.BufferGeometry.prototype.dispose = function () { disposed++; return disposeGeometry.call(this) }
  try {
    const pending = view.renderEntities([frame(0, 'diamond')], assets, undefined, null, { signal: controller.signal })
    await Promise.race([began.promise, pending.then(() => { throw new Error('Expected a pending frame-body repair') })])
    controller.abort(); await aborted(pending)
    const atAbort = disposed, replacement = addReplacement(view.entitiesGroup)
    gate.resolve(texture('block/item_frame')); await settle(); await settle()
    assert.ok(disposed > atAbort, 'A repaired old body created after cancellation is also released')
    assert.deepEqual(view.entitiesGroup.children, [replacement])
  } finally { THREE.BufferGeometry.prototype.dispose = disposeGeometry; assets.clearCaches() }
}
console.log('PASS entity pool immediate cancellation, stopped scheduling/progress, pending/late resource disposal, shared replacement resources and late frame repair cleanup')
