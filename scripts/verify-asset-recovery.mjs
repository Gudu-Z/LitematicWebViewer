// Transient frame-model failures must recover without hiding the frame around its item.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh } from '../src/entities.js'

const root = 'public/assets/minecraft/'
const baseUrl = 'https://assets.test/'
const template = 'models/block/template_item_frame.json'
const pack = await JSZip.loadAsync(readFileSync('public/resourcepacks/XK redstone display 26.3.0.zip'))
const originalFetch = globalThis.fetch
const requests = new Map()
let failure = null

globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(baseUrl), 'Tests must not access the network')
  const path = String(url).slice(baseUrl.length)
  const attempt = (requests.get(path) || 0) + 1
  requests.set(path, attempt)
  const response = await failure?.(path, attempt)
  if (response) return response
  const file = root + path
  return existsSync(file)
    ? new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } })
    : new Response(null, { status: 404 })
}

function provider(withPack = false) {
  const assets = new AssetProvider()
  assets.baseUrl = baseUrl
  if (withPack) assets.addPack(pack, 'XK')
  // Keep production JSON loading/caching and resource-pack priority; replace only image decoding.
  assets._getTexture = async key => {
    const path = 'textures/' + key + '.png'
    const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
    const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
    const texture = new THREE.Texture()
    texture.name = key
    texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    return texture
  }
  return assets
}

const frame = (assets, id = 'item_frame') => buildEntityMesh({
  id: 'minecraft:' + id, pos: [7, 11, -3], rotation: [0, 0],
  nbt: { Facing: 3, ItemRotation: 0, Item: { id: 'minecraft:diamond', count: 1 } },
}, assets)

function assertFrame(group, id = 'item_frame') {
  const meshes = []
  group.traverse(mesh => { if (mesh.isMesh) meshes.push(mesh) })
  const count = key => meshes.filter(mesh => mesh.material.map?.name === key)
    .reduce((total, mesh) => total + mesh.geometry.attributes.position.count, 0)
  assert.equal(count('block/' + id), 8, 'Frame backing must survive a temporary model request failure')
  assert.equal(count('block/birch_planks'), 80, 'All four frame borders must remain visible')
  assert.ok(count('item/diamond') > 0, 'The displayed item must remain visible')
  for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose() }
}

function reset(inject = null) {
  requests.clear()
  failure = inject
}

try {
  // A single temporary exception or 503 must recover in the original render, with both packs.
  for (const withPack of [false, true]) for (const id of ['item_frame', 'glow_item_frame']) {
    for (const kind of ['network', '503']) {
      reset((path, attempt) => {
        if (path !== template || attempt > 1) return null
        if (kind === 'network') throw new TypeError('Simulated temporary network failure')
        return new Response(null, { status: 503 })
      })
      assertFrame(await frame(provider(withPack), id), id)
      assert.equal(requests.get(template), 2, 'Retry only the failed request before building the frame')
    }
  }

  // Sustained errors end with null, but reopening with this same provider must fetch again.
  for (const kind of ['network', '503']) {
    reset(path => {
      if (path !== template) return null
      if (kind === 'network') throw new TypeError('Simulated persistent network failure')
      return new Response(null, { status: 503 })
    })
    const assets = provider(true)
    assert.equal(await assets.getJSON(template), null, 'Persistent errors must degrade gracefully')
    const failedAttempts = requests.get(template)
    assert.equal(failedAttempts, 2, 'Retry only once before returning null')
    failure = null
    assertFrame(await frame(assets))
    assert.equal(requests.get(template), failedAttempts + 1, 'A temporary failure must not poison later loads')
  }

  // Absent optional models are common: keep their negative cache and avoid repeated 404 requests.
  reset()
  const absentAssets = provider(), absent = 'models/block/__missing_frame_recovery_fixture__.json'
  const missingLoad = absentAssets.getJSON(absent)
  assert.equal(await missingLoad, null)
  assert.equal(await absentAssets.getJSON(absent), null)
  assert.equal(requests.get(absent), 1, '404 responses must not be retried or requested again')

  reset(() => new Response('<!doctype html><title>SPA fallback</title>', { headers: { 'content-type': 'text/html' } }))
  const fallbackAssets = provider()
  assert.equal(await fallbackAssets.getJSON(absent), null)
  assert.equal(await fallbackAssets.getJSON(absent), null)
  assert.equal(requests.get(absent), 1, 'HTML fallback must remain a cached missing resource')

  // Concurrent frames share the same initial request and its retry instead of multiplying traffic.
  reset((path, attempt) => path === template && attempt === 1 ? new Response(null, { status: 503 }) : null)
  const concurrentAssets = provider(true)
  const loads = Array.from({ length: 50 }, () => concurrentAssets.getJSON(template))
  assert.ok(loads.every(load => load === loads[0]), 'Concurrent callers must share one in-flight load')
  const models = await Promise.all(loads)
  assert.ok(models[0]?.elements?.length, 'The shared retry must recover the frame template')
  assert.ok(models.every(model => model === models[0]))
  assert.equal(requests.get(template), 2, '50 callers must issue just one original request and one retry')

  // A request started before a pack switch must not evict the replacement pack's newer cache entry.
  reset()
  const switchedAssets = provider()
  const getJSON = switchedAssets._getJSON.bind(switchedAssets)
  let releaseOld
  switchedAssets._getJSON = path => {
    switchedAssets._getJSON = getJSON
    return new Promise((resolve, reject) => { releaseOld = () => reject(new TypeError('Stale request failure')) })
  }
  const oldLoad = switchedAssets.getJSON(template)
  const replacement = new JSZip().file('assets/minecraft/' + template, JSON.stringify({ marker: 'replacement-pack', elements: [] }))
  switchedAssets.addPack(replacement, 'Replacement')
  const newLoad = switchedAssets.getJSON(template)
  assert.equal((await newLoad).marker, 'replacement-pack')
  releaseOld()
  await oldLoad
  assert.equal(switchedAssets.jsonCache.get(template), newLoad, 'An old failure must not delete the new pack cache')
  assert.equal((await switchedAssets.getJSON(template)).marker, 'replacement-pack')

  // Image decoding can finish after a pack switch too; a stale null must preserve the new texture.
  const textureAssets = provider(), textureKey = 'block/item_frame'
  const getTexture = textureAssets._getTexture.bind(textureAssets)
  let releaseOldTexture
  textureAssets._getTexture = key => {
    textureAssets._getTexture = getTexture
    return new Promise(resolve => { releaseOldTexture = () => resolve(null) })
  }
  const oldTextureLoad = textureAssets.getTexture(textureKey)
  textureAssets.addPack(pack, 'XK')
  const newTextureLoad = textureAssets.getTexture(textureKey)
  const newTexture = await newTextureLoad
  assert.equal(newTexture.name, textureKey)
  releaseOldTexture()
  assert.equal(await oldTextureLoad, null)
  assert.equal(textureAssets.textureCache.get(textureKey), newTextureLoad, 'An old image failure must not delete the new texture cache')
  assert.equal(await textureAssets.getTexture(textureKey), newTexture)
  console.log('PASS asset recovery: vanilla/XK ordinary/glow frame geometry, temporary network/503 recovery, bounded failure, reopen, cached 404, concurrent retries and pack-switch isolation')
} finally {
  globalThis.fetch = originalFetch
}
