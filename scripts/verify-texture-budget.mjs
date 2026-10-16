// Runtime-only lifecycle regressions; no browser, network, or Node > 20 APIs.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { AssetProvider, isAssetTexture } from '../src/assets.js'
import { getFrameModel } from '../src/frameModelCache.js'

function fixture({ width = 16, height = 16, animated = false } = {}) {
  const texture = new THREE.Texture({ width, height })
  const counts = { disposals: 0, updates: [] }
  texture.addEventListener('dispose', () => counts.disposals++)
  if (animated) texture.userData.updateAnimation = age => {
    counts.updates.push(age)
    // Two ticks per source frame, as in a real resource-pack animation.
    const frame = Math.floor(age / 2)
    if (frame !== texture.userData.frame) {
      texture.userData.frame = frame
      texture.needsUpdate = true
    }
  }
  return { texture, counts }
}

function provider(definitions = {}) {
  const assets = new AssetProvider(), loaded = new Map()
  assets._getTexture = async key => {
    const value = fixture(definitions[key])
    loaded.set(key, value)
    return value.texture
  }
  return { assets, loaded }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

const noIdle = { maxIdleCount: 0, maxIdleBytes: 0 }

{
  const { assets, loaded } = provider()
  const a = await assets.getTexture('a'), b = await assets.getTexture('b'), c = await assets.getTexture('c')
  assert.equal(await assets.getTexture('a'), a)
  const notifications = []
  const stop = assets.onTextureEvict(textures => notifications.push([...textures]))
  assert.deepEqual(assets.trimTextures({ maxIdleCount: 2, maxIdleBytes: Infinity }),
    { skipped: false, evicted: 1, idleCount: 2, idleBytes: 2 * 16 * 16 * 8 })
  assert.deepEqual(notifications, [[b]], 'Cache hits refresh LRU order without touching other textures')
  assert.equal(loaded.get('b').counts.disposals, 1)
  assert.equal(assets.textureCache.has('b'), false)
  assert.equal(assets._ownedTextures.size, 2)
  assert.equal(assets._textureRecords.size, 2)
  assert.equal(assets._cachedTextureRecords.size, 2)
  stop(); stop()
  assert.equal(assets.trimTextures(noIdle).evicted, 2)
  assert.equal(notifications.length, 1, 'Eviction listeners can unsubscribe')
  assert.equal(loaded.get('a').counts.disposals, 1)
  assert.equal(loaded.get('c').counts.disposals, 1)
  assert.equal(assets._textureRecords.size, 0)
  assert.equal(assets._cachedTextureRecords.size, 0)
  assert.ok(isAssetTexture(a), 'Late scene cleanup still recognizes an evicted provider texture')
  assert.notEqual(await assets.getTexture('b'), b, 'An evicted texture is reloadable')
  assets.clearCaches()
}

{
  const { assets, loaded } = provider({ huge: { width: 4096, height: 4096 } })
  const huge = await assets.getTexture('huge'), hidden = await assets.getTexture('hidden'), exported = await assets.getTexture('exported')
  const scene = {}, preview = {}
  assets.setTextureUsage(scene, new Set([huge, hidden]), new Set([huge]))
  assets.setTextureUsage(preview, new Set([exported, huge]))
  assert.equal(assets.trimTextures(noIdle).evicted, 0, 'Large active scenes, hidden layers and exports are never budget victims')
  assets.releaseTextureUsage(scene)
  assert.equal(assets.trimTextures(noIdle).evicted, 1, 'Releasing one scene cannot retire another owner\'s textures')
  assert.equal(loaded.get('hidden').counts.disposals, 1)
  assert.equal(loaded.get('huge').counts.disposals, 0)
  assets.releaseTextureUsage(preview)
  assets.releaseTextureUsage(preview)
  assert.equal(assets.trimTextures(noIdle).evicted, 2)
  assert.equal(assets._textureOwners.size, 0)
  assert.equal(assets._textureReferences.size, 0)
}

{
  const { assets, loaded } = provider({ large: { width: 1024, height: 1024 } })
  await assets.getTexture('small')
  await assets.getTexture('large')
  assert.equal(assets.trimTextures({ maxIdleCount: Infinity, maxIdleBytes: 1024 * 1024 }).evicted, 2,
    'The byte budget also bounds a small number of high-resolution idle images')
  assert.equal(loaded.get('large').counts.disposals, 1)
}

{
  const { assets, loaded } = provider()
  const existing = await assets.getTexture('existing')
  const end = assets.beginTextureLoad(), nestedEnd = assets.beginTextureLoad()
  assert.deepEqual(assets.trimTextures(noIdle), { skipped: true, evicted: 0 })
  end(); end()
  assert.equal(assets.trimTextures(noIdle).skipped, true, 'Nested loading transactions are independent and idempotent')
  nestedEnd()
  const pending = deferred()
  assets._getTexture = () => pending.promise
  const request = assets.getTexture('loading')
  assert.equal(assets.trimTextures(noIdle).skipped, true, 'An unresolved decoder also prevents trimming')
  pending.resolve(null)
  assert.equal(await request, null)
  assert.equal(assets._pendingTextures, 0)
  assert.equal(assets.trimTextures(noIdle).evicted, 1)
  assert.equal(loaded.get('existing').counts.disposals, 1)
  assert.equal(assets.textureCache.has('loading'), false)
  assert.ok(existing)
  assets._getTexture = () => { throw new Error('Synchronous loader failure') }
  assert.equal(await assets.getTexture('retry'), null)
  assert.equal(assets._pendingTextures, 0)
  assert.equal(assets.textureCache.has('retry'), false)
}

{
  const { assets, loaded } = provider({ active: { animated: true }, hidden: { animated: true }, idle: { animated: true } })
  const active = await assets.getTexture('active'), hidden = await assets.getTexture('hidden')
  await assets.getTexture('idle')
  const owner = {}, exportOwner = {}, clone = active.clone(), clone2 = active.clone()
  const privateTexture = fixture({ animated: true })
  assets.setTextureUsage(owner, [active, hidden, clone, clone2, privateTexture.texture], [active, clone, clone2])
  assert.equal(assets.hasAnimatedTextures(owner), true)
  assert.equal(assets.hasAnimatedTextures({}), false)
  assert.equal(assets.updateAnimations(10, owner), true)
  assert.equal(assets.updateAnimations(10.5, owner), false, 'The same tick must not rescan or upload cloned sources again')
  assert.equal(assets.updateAnimations(11, owner), false, 'An unchanged animation frame does not require a redraw')
  assert.deepEqual(loaded.get('active').counts.updates, [10, 11])
  assert.deepEqual(loaded.get('hidden').counts.updates, [])
  assert.deepEqual(loaded.get('idle').counts.updates, [])
  assert.deepEqual(privateTexture.counts.updates, [], 'A provider never adopts an unrelated scene texture')
  const before = clone.version
  assets.setTextureUsage(exportOwner, [active])
  assert.equal(assets.updateAnimations(0, exportOwner), true)
  assert.equal(assets.updateAnimations(10, owner), true, 'Returning from an export at another age restores the main scene frame')
  assert.equal(clone.version, before + 1, 'Source animations notify independently uploaded texture clones')
  assets.setTextureUsage(owner, [clone, clone2, hidden], [clone, clone2])
  assets.releaseTextureUsage(exportOwner)
  assert.equal(assets.trimTextures(noIdle).evicted, 1, 'Private clones keep the source animation alive')
  assert.equal(loaded.get('active').counts.disposals, 0)
  assert.equal(assets.updateAnimations(12, owner), true)
  assets.setTextureUsage(owner, [clone, hidden], [])
  assert.equal(assets.hasAnimatedTextures(owner), false)
  assert.equal(assets.updateAnimations(14, owner), false)
  assets.setTextureUsage(owner, [], [clone])
  assert.equal(assets.trimTextures(noIdle).evicted, 1, 'Visible resources are implicitly retained even if omitted by the caller')
  assets.releaseTextureUsage(owner)
  assert.equal(assets.trimTextures(noIdle).evicted, 1)
  clone.dispose(); clone2.dispose(); privateTexture.texture.dispose()
}

{
  const { assets, loaded } = provider({ animated: { animated: true } })
  const texture = await assets.getTexture('animated')
  assert.equal(assets.hasAnimatedTextures(), true)
  assert.equal(assets.updateAnimations(4), true)
  assert.equal(assets.updateAnimations(4.9), false)
  assert.equal(assets.updateAnimations(5), false)
  assert.deepEqual(loaded.get('animated').counts.updates, [4, 5], 'Default animation API retains whole-cache tick deduplication')
  const owner = {}
  assets.setTextureUsage(owner, [texture])
  assert.equal(assets.updateAnimations(0, owner), true)
  assert.equal(assets.updateAnimations(5), true, 'Default calls must recover after another owner changed the shared canvas')
  assets.releaseTextureUsage(owner)
  assets.clearCaches()
  assert.equal(assets.hasAnimatedTextures(), false)
}

{
  const { assets, loaded } = provider({ old: { animated: true } })
  const old = await assets.getTexture('old'), oldCounts = loaded.get('old').counts
  const scene = {}, preview = {}, clone = old.clone()
  assets.setTextureUsage(scene, [clone])
  assets.setTextureUsage(preview, [old])
  assets.clearCaches()
  assert.equal(oldCounts.disposals, 0, 'Pack replacement must not dispose a scene/export still using the previous pack')
  assert.equal(assets.textureCache.size, 0)
  assert.equal(assets._cachedTextureRecords.size, 0)
  const replacement = await assets.getTexture('old')
  assert.notEqual(replacement, old)
  assets.setTextureUsage(scene, [replacement])
  assert.equal(oldCounts.disposals, 0)
  assert.equal(assets.updateAnimations(6, preview), true, 'A retained old-pack export can still animate')
  assets.releaseTextureUsage(preview)
  assert.equal(oldCounts.disposals, 1, 'Retired pack resources are released when their last owner leaves')
  assert.equal(assets.animatedTextures.has(old), false)
  assets.releaseTextureUsage(scene)
  assert.equal(assets.trimTextures(noIdle).evicted, 1)
  clone.dispose()
}

{
  const { assets } = provider()
  let builds = 0
  const build = async source => {
    builds++
    return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: await source.getTexture('frame') }))
  }
  const first = await getFrameModel(assets, 'body', build)
  const cached = await getFrameModel(assets, 'body', build)
  assert.equal(builds, 1)
  assert.equal(cached.material.map, first.material.map)
  const owner = {}
  assets.setTextureUsage(owner, [first.material.map])
  assert.equal(assets.trimTextures(noIdle).evicted, 0)
  assert.equal((await getFrameModel(assets, 'body', build)).material, first.material)
  assets.releaseTextureUsage(owner)
  assert.equal(assets.trimTextures(noIdle).evicted, 1)
  const rebuilt = await getFrameModel(assets, 'body', build)
  assert.equal(builds, 2, 'CPU templates pointing to an evicted texture must rebuild')
  assert.notEqual(rebuilt.material.map, first.material.map)
  const gate = deferred(), entered = deferred()
  const pending = getFrameModel(assets, 'pending', async source => {
    const texture = await source.getTexture('second')
    entered.resolve()
    await gate.promise
    return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: texture }))
  })
  await entered.promise
  assert.equal(assets._pendingTextures, 0)
  assert.equal(assets.trimTextures(noIdle).skipped, true, 'A frame template awaiting later work protects its already-decoded textures')
  gate.resolve()
  const completed = await pending
  assert.equal(assets._textureLoadDepth, 0)
  await assert.rejects(getFrameModel(assets, 'broken', async () => { throw new Error('build failed') }), /build failed/)
  assert.equal(assets._textureLoadDepth, 0, 'Rejected template builds must also close their transaction')
  assets.clearCaches()
  for (const model of [first, rebuilt, completed]) { model.geometry.dispose(); model.material.dispose() }
}

console.log('PASS texture budget: idle LRU/bytes, nested loads, scene/export/hidden owners, cloned sources, active animation updates, pack retirement and frame-cache invalidation')
