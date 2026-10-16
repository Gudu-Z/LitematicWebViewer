// Resource providers own shared textures; scene/thumbnail cleanup must not retire another owner.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { AssetProvider, isAssetTexture } from '../src/assets.js'
import { MaterialIcons } from '../src/materialIcons.js'

function fixture(animated = false) {
  const texture = new THREE.Texture({ width: 16, height: 16 })
  const counts = { disposals: 0, updates: [] }
  texture.addEventListener('dispose', () => counts.disposals++)
  if (animated) texture.userData.updateAnimation = age => counts.updates.push(age)
  return { texture, counts }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

{
  const assets = new AssetProvider(), { texture, counts } = fixture(), notifications = []
  assets._getTexture = async () => texture
  await assets.getTexture('block/subscribed')
  const unsubscribe = assets.onCacheClear(() => notifications.push([assets.cacheRevision, counts.disposals]))
  assets.clearCaches()
  assert.deepEqual(notifications, [[1, 0]], 'Derived caches release CPU references after the revision changes and before texture disposal')
  assert.equal(counts.disposals, 1)
  assets.clearCaches()
  assert.deepEqual(notifications, [[1, 0], [2, 1]], 'One subscription observes later invalidations too')
  unsubscribe()
  unsubscribe()
  assets.clearCaches()
  assert.equal(notifications.length, 2, 'Unsubscribed listeners must no longer run')
}

{
  const assets = new AssetProvider(), { texture, counts } = fixture(true)
  let requests = 0
  assets._getTexture = async () => { requests++; return texture }
  const pending = Array.from({ length: 100 }, () => assets.getTexture('block/shared'))
  assert.ok(pending.every(value => value === pending[0]), 'Concurrent models share one texture request')
  assert.ok((await Promise.all(pending)).every(value => value === texture))
  assert.equal(requests, 1)
  assert.ok(isAssetTexture(texture), 'Scene cleanup can identify textures owned by the provider')
  assert.equal(isAssetTexture(null), false)
  assets.updateAnimations(12)
  assert.deepEqual(counts.updates, [12])
  const clone = texture.clone()
  assert.equal(isAssetTexture(clone), false, 'Ownership must not leak through Texture.clone userData')
  clone.dispose()
  assert.equal(counts.disposals, 0, 'A separate texture object must not retire the shared source')
  assets.clearCaches()
  assert.equal(assets.cacheRevision, 1)
  assert.equal(counts.disposals, 1, 'Clearing 100 references disposes the shared texture exactly once')
  assert.equal(assets._ownedTextures.size, 0)
  assert.equal(assets.textureCache.size, 0)
  assert.equal(assets.animatedTextures.size, 0)
  assert.ok(isAssetTexture(texture), 'Late scene cleanup must still recognize retired provider textures')
  assets.updateAnimations(24)
  assets.clearCaches()
  assert.deepEqual(counts.updates, [12], 'Retired animation callbacks must not run')
  assert.equal(counts.disposals, 1, 'An empty cache must not dispose a texture again')
}

for (const fail of [false, true]) {
  const assets = new AssetProvider(), pending = deferred()
  const old = fixture(true), current = fixture(true)
  assets._getTexture = () => pending.promise
  const oldLoad = assets.getTexture('block/shared')
  assets.addPack({ file: () => null }, 'replacement')
  assets._getTexture = async () => current.texture
  const currentLoad = assets.getTexture('block/shared')
  assert.equal(await currentLoad, current.texture)
  if (fail) pending.reject(new Error('Old decoder failed after the pack switch'))
  else pending.resolve(old.texture)
  assert.equal(await oldLoad, null, 'A stale request must not return a texture from the replaced pack')
  assert.equal(assets.textureCache.get('block/shared'), currentLoad)
  assert.deepEqual([...assets.animatedTextures], [current.texture], 'Old animations must not enter the replacement cache')
  assert.equal(old.counts.disposals, fail ? 0 : 1, 'Successfully decoded stale textures must be released')
  assert.equal(current.counts.disposals, 0)
  assets.clearCaches()
  assert.equal(current.counts.disposals, 1)
}

{
  const assets = new AssetProvider(), first = deferred(), second = fixture()
  assets._getTexture = () => first.promise
  const initial = assets.getTexture('block/retry')
  first.resolve(null)
  assert.equal(await initial, null)
  assert.equal(assets.textureCache.has('block/retry'), false, 'Failed images must remain retryable')
  assets._getTexture = async () => second.texture
  assert.equal(await assets.getTexture('block/retry'), second.texture)
  assets.clearCaches()
  assert.equal(second.counts.disposals, 1)
}

const originalObserver = globalThis.IntersectionObserver
globalThis.IntersectionObserver = class { disconnect() {} }
try {
  const source = new AssetProvider(), original = fixture()
  source._getTexture = async () => original.texture
  await source.getTexture('block/shared')
  const icons = new MaterialIcons({ querySelectorAll: () => [] }, source)
  const assets = icons.state.assets, clone = await assets.getTexture('block/shared')
  assert.notEqual(clone, original.texture)
  assert.equal(clone.image, original.texture.image)
  assert.ok(isAssetTexture(clone), 'The icon provider adopts its independent clone')
  let cloneDisposals = 0
  clone.addEventListener('dispose', () => cloneDisposals++)
  assets.trim(0, 0)
  assert.equal(cloneDisposals, 1)
  assert.equal(assets._ownedTextures.size, 0, 'Icon budget eviction must release ownership references')
  assert.equal(assets.animatedTextures.size, 0)
  assets.clearCaches()
  assert.equal(cloneDisposals, 1, 'Clearing after trim must not dispose icon textures twice')
  assert.equal(original.counts.disposals, 0, 'Icon eviction must preserve the scene texture')
  source.clearCaches()
  assert.equal(original.counts.disposals, 1)
} finally {
  globalThis.IntersectionObserver = originalObserver
}

const originalFetch = globalThis.fetch, originalImage = globalThis.Image
const requests = []
globalThis.Image = class {
  width = 16
  height = 16
  set src(value) { queueMicrotask(() => this.onload()) }
}
globalThis.fetch = async url => {
  requests.push(url)
  return new Response(new Blob(['decoded by the test Image fixture']))
}
try {
  const assets = new AssetProvider(), url = 'http://skin.test/player.png'
  const [a, b] = await Promise.all([assets.getExternalTexture(url), assets.getExternalTexture(url)])
  assert.equal(a, b, 'Player heads share external skin texture objects too')
  assert.ok(isAssetTexture(a))
  assert.deepEqual(requests, ['https://skin.test/player.png'])
  let disposals = 0
  a.addEventListener('dispose', () => disposals++)
  assets.clearCaches()
  assert.equal(disposals, 1, 'Provider cache invalidation also releases external skins')
  assert.notEqual(await assets.getExternalTexture(url), a)
  assets.clearCaches()
} finally {
  globalThis.fetch = originalFetch
  globalThis.Image = originalImage
}

// Exceptions inside Image.onload are outside the Promise executor. They must
// reject the load, not leave every frame sharing the texture pending forever.
{
  const saved = { fetch: globalThis.fetch, Image: globalThis.Image, document: globalThis.document,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  const unhandled = [], revoked = [], images = []
  let fail = true, id = 0, drawCalls = 0
  const decoded = deferred()
  globalThis.fetch = async () => new Response(new Blob(['image fixture']))
  URL.createObjectURL = () => 'blob:texture-callback-' + (++id)
  URL.revokeObjectURL = url => revoked.push(url)
  globalThis.Image = class {
    width = 16
    height = 32
    constructor() { images.push(this) }
    set src(value) { queueMicrotask(() => { try { this.onload() } catch (error) { unhandled.push(error) } finally { decoded.resolve() } }) }
  }
  globalThis.document = { createElement: () => ({ getContext: () => ({
    clearRect() {}, drawImage() { if (fail) throw Error('Transient animation canvas failure'); drawCalls++ },
  }) }) }
  try {
    const assets = new AssetProvider()
    assets._isAnimated = async () => ({ frametime: 2 })
    let settled = false
    const initial = assets.getTexture('block/magma')
    const waiting = Array.from({ length: 50 }, () => assets.getTexture('block/magma'))
    assert.ok(waiting.every(load => load === initial), 'Frames must share the pending texture')
    initial.then(() => { settled = true })
    await decoded.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, true, 'A canvas exception must settle all waiting frames')
    assert.deepEqual(unhandled, [], 'Image callbacks must not leak uncaught exceptions')
    assert.equal(await initial, null)
    assert.equal(assets._pendingTextures, 0)
    assert.equal(assets.textureCache.has('block/magma'), false, 'The next frame must be able to retry')
    assert.deepEqual(revoked, ['blob:texture-callback-1'])
    fail = false
    const texture = await assets.getTexture('block/magma')
    assert.ok(texture?.userData.updateAnimation, 'A later successful decode retains the animation')
    assert.ok(drawCalls > 0)
    assert.deepEqual(revoked, ['blob:texture-callback-1', 'blob:texture-callback-2'])
    assert.ok(images.every(image => !image.onload && !image.onerror), 'Settled decoders release their handlers')
    assets.clearCaches()
  } finally {
    globalThis.fetch = saved.fetch; globalThis.Image = saved.Image; globalThis.document = saved.document
    URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke
  }
}

console.log('PASS texture lifecycle: shared ownership, animation cleanup, pack revisions/subscriptions, stale async results, decode/callback failure recovery, independent thumbnail clones/budgets and external skins')
