// Exercise the complete entity pass: the first worker group must not keep missing
// frame bodies after a later group has successfully loaded the same template.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { Renderer } from '../src/renderer.js'

const root = 'public/assets/minecraft/'
const baseUrl = 'https://frame-body-recovery.test/'
const template = 'models/block/template_item_frame.json'
const pack = await JSZip.loadAsync(readFileSync('public/resourcepacks/XK redstone display 26.3.0.zip'))
const originalFetch = globalThis.fetch
let active

const increment = (map, key) => {
  const count = (map.get(key) || 0) + 1
  map.set(key, count)
  return count
}
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(baseUrl), 'Recovery tests must not access the network')
  const path = String(url).slice(baseUrl.length)
  const attempt = increment(active.requests, path)
  const intercepted = await active.intercept?.(path, attempt)
  if (intercepted) return intercepted
  const fault = active.fault
  if (path === template && fault?.kind !== 'texture' && attempt <= (fault?.attempts || 0)) {
    if (fault.kind === 'html') return new Response('<!doctype html><title>Temporary SPA fallback</title>', { headers: { 'content-type': 'text/html' } })
    return new Response(null, { status: fault.kind === '404' ? 404 : 503 })
  }
  return existsSync(root + path)
    ? new Response(readFileSync(root + path), { headers: { 'content-type': 'application/json' } })
    : new Response(null, { status: 404 })
}

function fixture(withPack, id, fault = null, count = 60) {
  const state = { requests: new Map(), jsonLoads: new Map(), decodes: new Map(), fault }
  const assets = new AssetProvider()
  assets.baseUrl = baseUrl
  if (withPack) assets.addPack(pack, 'XK')
  const readJSON = assets._getJSON.bind(assets)
  assets._getJSON = path => { increment(state.jsonLoads, path); return readJSON(path) }
  // Retain the production provider's in-flight sharing, failure handling, pack
  // priority and ownership; replace browser-only image decoding with PNG sizes.
  assets._getTexture = async key => {
    const attempt = increment(state.decodes, key)
    const frameTexture = key === 'block/' + id || (state.fault?.allFrameTextures && key === 'block/birch_planks')
    if (state.fault?.kind === 'texture' && frameTexture && attempt <= state.fault.attempts) return null
    const path = 'textures/' + key + '.png'
    const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
    if (!entry && !existsSync(root + path)) return null
    const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
    const texture = new THREE.Texture()
    texture.name = key
    texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    return texture
  }
  const view = Object.create(Renderer.prototype)
  view.scene = new THREE.Scene()
  for (const key of ['group', 'entitiesGroup', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']) {
    view[key] = new THREE.Group()
    view.scene.add(view[key])
  }
  const entities = Array.from({ length: count }, (_, i) => ({
    id: 'minecraft:' + id, pos: [i * 2, i % 3, -1], rotation: [0, 0],
    nbt: { Facing: 3, ItemRotation: i % 8, Item: { id: 'minecraft:diamond', count: 1 } },
  }))
  return {
    state, assets, view, entities,
    async render() { active = state; await view.renderEntities(entities, assets) },
    dispose() { view.clearEntities(); assets.releaseTextureUsage(view); assets.clearCaches() },
  }
}

function summary(view) {
  const records = new Map()
  view.scene.updateMatrixWorld(true)
  view.entitiesGroup.traverse(mesh => {
    if (!mesh.isMesh) return
    const key = mesh.material.map?.name
    if (!records.has(key)) records.set(key, { vertices: 0, origins: [] })
    const record = records.get(key)
    for (let i = 0; i < (mesh.isInstancedMesh ? mesh.count : 1); i++) {
      const matrix = mesh.matrixWorld.clone()
      if (mesh.isInstancedMesh) {
        const instance = new THREE.Matrix4()
        mesh.getMatrixAt(i, instance)
        matrix.multiply(instance)
      }
      record.vertices += mesh.geometry.attributes.position.count
      record.origins.push(matrix.elements.slice(12, 15).map(n => Math.round(n * 1e6) / 1e6))
    }
  })
  for (const record of records.values()) record.origins.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  return Object.fromEntries([...records].sort(([a], [b]) => a.localeCompare(b)))
}

function assertItems(value, count = 60) {
  assert.equal(value['item/diamond']?.origins.length, count, 'Every displayed item must survive a missing frame body')
}
function assertComplete(test, id, reference, label) {
  const value = summary(test.view)
  const count = test.entities.length
  assertItems(value, count)
  assert.equal(value['block/' + id]?.vertices, count * 8, label + ': every backing must be present, including the first worker group')
  assert.equal(value['block/birch_planks']?.vertices, count * 80, label + ': every frame must retain all four borders')
  if (reference) assert.deepEqual(value, reference, label + ': repaired bodies must retain the healthy transforms and item geometry')
  assert.equal(test.view.entitiesGroup.children.filter(o => o.userData.entityHitbox).length, count,
    label + ': recovery must preserve one logical entity root per frame')
  return value
}
function assertSuccessfulResourcesShared(state, baseline, failureKey, label, allowMissing = false) {
  const failureKeys = new Set([failureKey].flat())
  for (const [path, count] of baseline.jsonLoads) {
    if (!failureKeys.has(path) && (!allowMissing || state.jsonLoads.has(path))) assert.equal(state.jsonLoads.get(path), count, label + ': do not reload successful JSON ' + path)
  }
  for (const [key, count] of baseline.decodes) {
    if (!failureKeys.has(key) && (!allowMissing || state.decodes.has(key))) assert.equal(state.decodes.get(key), count, label + ': do not decode successful texture ' + key + ' again')
  }
  assert.equal(state.decodes.get('item/diamond'), 1, label + ': body repair must reuse the successful item texture')
}

try {
  for (const withPack of [false, true]) for (const id of ['item_frame', 'glow_item_frame']) {
    const label = (withPack ? 'XK' : 'vanilla') + ' ' + id
    const healthy = fixture(withPack, id)
    await healthy.render()
    const reference = assertComplete(healthy, id, null, label + ' healthy')
    assert.equal(healthy.state.requests.get(template), 1, label + ': healthy frames share one template request')
    assert.ok([...healthy.state.jsonLoads.values()].every(n => n === 1), label + ': healthy JSON must not gain recovery requests')
    assert.ok([...healthy.state.decodes.values()].every(n => n === 1), label + ': healthy textures must decode only once')
    const baseline = { jsonLoads: new Map(healthy.state.jsonLoads), decodes: new Map(healthy.state.decodes) }
    const requestsBefore = [...healthy.state.requests], decodesBefore = [...healthy.state.decodes]
    await healthy.render()
    assertComplete(healthy, id, reference, label + ' healthy reopen')
    assert.deepEqual([...healthy.state.requests], requestsBefore, label + ': a healthy reopen must reuse cached JSON')
    assert.deepEqual([...healthy.state.decodes], decodesBefore, label + ': a healthy reopen must reuse decoded images')
    healthy.dispose()

    for (const fault of [
      { kind: '503', attempts: 4 },
      { kind: '404', attempts: 1 },
      { kind: 'html', attempts: 1 },
      { kind: 'texture', attempts: 1 },
      { kind: 'texture', attempts: 2 },
    ]) {
      const test = fixture(withPack, id, fault)
      try {
        await test.render()
        const name = label + ' ' + fault.kind + ' x' + fault.attempts
        assertComplete(test, id, reference, name)
        const failureKey = fault.kind === 'texture' ? 'block/' + id : template
        assertSuccessfulResourcesShared(test.state, baseline, failureKey, name)
        if (fault.kind === 'texture') assert.equal(test.state.decodes.get(failureKey), fault.attempts + 1,
          name + ': concurrent frames must share the recovered image')
        else assert.equal(test.state.requests.get(template), fault.attempts + 1,
          name + ': the final repair must reuse the template loaded by later workers')
      } finally { test.dispose() }
    }

    for (const kind of ['503', '404', 'html', 'texture']) {
      const test = fixture(withPack, id, { kind, attempts: Infinity })
      try {
        await test.render()
        const failed = summary(test.view)
        assertItems(failed)
        assert.ok((failed['block/' + id]?.origins.length || 0) < 60, label + ': persistent failure fixture must actually omit body geometry')
        const key = kind === 'texture' ? 'block/' + id : template
        const requests = kind === 'texture' ? test.state.decodes : test.state.requests
        const attempts = requests.get(key)
        assert.ok(attempts > 0 && attempts <= (kind === '503' ? 12 : 6),
          label + ' ' + kind + ': permanent failures must have a bounded shared request budget, got ' + attempts)
        assertSuccessfulResourcesShared(test.state, baseline, key, label + ' persistent ' + kind, true)
        test.state.fault = null
        await test.render()
        assertComplete(test, id, reference, label + ' recovered reopen ' + kind)
        assert.equal(requests.get(key), attempts + 1, label + ': reopening must recover with one fresh dependency load')
        assertSuccessfulResourcesShared(test.state, baseline, key, label + ' recovered reopen ' + kind)
      } finally { test.dispose() }
    }

    // No later worker exists to populate the body cache: completion must itself
    // fetch the failed texture once, while retaining the already built items.
    const smallHealthy = fixture(withPack, id, null, 40)
    await smallHealthy.render()
    const smallReference = assertComplete(smallHealthy, id, null, label + ' small healthy')
    smallHealthy.dispose()
    for (const allFrameTextures of [false, true]) {
      const test = fixture(withPack, id, { kind: 'texture', attempts: 2, allFrameTextures }, 40)
      try {
        await test.render()
        const name = label + (allFrameTextures ? ' all body textures' : ' backing texture') + ' exhausted initial retries'
        assertComplete(test, id, smallReference, name)
        const keys = allFrameTextures ? ['block/' + id, 'block/birch_planks'] : ['block/' + id]
        for (const key of keys) assert.equal(test.state.decodes.get(key), 3, name + ': the final repair must issue exactly one fresh decode')
        assert.equal(test.state.requests.get(template), 1, name + ': successful frame JSON must stay cached')
        assertSuccessfulResourcesShared(test.state, baseline, keys, name)
      } finally { test.dispose() }
    }

    for (const oldResponse of ['404', 'html']) {
      const test = fixture(withPack, id, { kind: '503', attempts: 4 }, 40)
      let releaseOld, began
      const started = new Promise(resolve => { began = resolve })
      test.state.intercept = (path, attempt) => {
        if (path !== template || attempt !== 5) return null
        return new Promise(resolve => {
          releaseOld = () => resolve(oldResponse === '404'
            ? new Response(null, { status: 404 })
            : new Response('<!doctype html><title>Stale fallback</title>', { headers: { 'content-type': 'text/html' } }))
          began()
        })
      }
      const previousLoad = test.render()
      try {
        await Promise.race([started, previousLoad.then(() => { throw new Error('The exhausted initial build must enter the gated final repair') })])
        assert.equal(test.state.requests.get(template), 5, label + ': the fifth request must be the final repair, after four failed initial attempts')
        assert.equal(test.view.entitiesGroup.children.length, 0, label + ': incomplete roots must wait for final repair before batching')
        test.state.fault = null
        test.assets.addPack(new JSZip().file('assets/minecraft/' + template, readFileSync(root + template)), 'Replacement')
        const replacementEntities = test.entities.map(entity => ({ ...entity, pos: [entity.pos[0] + 500, ...entity.pos.slice(1)] }))
        await test.view.renderEntities(replacementEntities, test.assets)
        const replacement = assertComplete(test, id, null, label + ' replacement while repair is pending')
        const children = [...test.view.entitiesGroup.children]
        const currentTemplate = test.assets.jsonCache.get(template)
        const reads = [...test.state.requests]
        releaseOld()
        await previousLoad
        assert.deepEqual(test.view.entitiesGroup.children, children, label + ': an old repair must not append to or clear the replacement scene')
        assert.deepEqual(summary(test.view), replacement, label + ': a stale repair must leave new body/item placements untouched')
        assert.equal(test.assets.jsonCache.get(template), currentTemplate, label + ': an old ' + oldResponse + ' must not evict the replacement JSON')
        assert.deepEqual([...test.state.requests], reads, label + ': stale repair completion must not retry against the replacement pack')
      } finally {
        releaseOld?.()
        await previousLoad
        test.dispose()
      }
    }

    const empty = fixture(withPack, id, null, 40)
    try {
      const bodyPath = 'models/block/' + id + '.json'
      empty.assets.addPack(new JSZip().file('assets/minecraft/' + bodyPath, JSON.stringify({ elements: [] })), 'Intentionally hidden frames')
      empty.assets.movePack('Intentionally hidden frames', -1)
      const getJSON = empty.assets.getJSON.bind(empty.assets)
      let bodyLookups = 0
      empty.assets.getJSON = path => { if (path === bodyPath) bodyLookups++; return getJSON(path) }
      await empty.render()
      const output = summary(empty.view)
      assertItems(output, 40)
      assert.equal(output['block/' + id], undefined, label + ': a valid empty resource-pack body must stay invisible')
      assert.equal(output['block/birch_planks'], undefined, label + ': an intentionally empty body must not gain default borders')
      assert.equal(bodyLookups, 1, label + ': a valid empty body must not trigger a recovery build')
      assert.equal(empty.state.requests.get(template), undefined, label + ': empty models must not fall back to the vanilla template')
    } finally { empty.dispose() }
  }
  console.log('PASS frame body recovery: vanilla/XK ordinary/glow, 60-frame first-worker repair, 40-frame partial/empty texture recovery, required 404/HTML, exact body/item placement, bounded failures/reopen, successful resource reuse, gated pack switches and intentionally empty bodies')
} finally {
  globalThis.fetch = originalFetch
}
