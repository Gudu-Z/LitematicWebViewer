import assert from 'node:assert/strict'
import { createHeadTextureLoader } from '../src/headTextures.js'

const head = skinUrl => ({ skinUrl })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
const keyOf = entry => entry.skinUrl || null

function controlledAssets() {
  const requests = []
  let active = 0, maximum = 0, disposals = 0
  const request = key => {
    const gate = deferred()
    active++; maximum = Math.max(maximum, active)
    const entry = { key, done: false, texture: { key, dispose() { disposals++ } } }
    entry.resolve = (value = entry.texture) => {
      assert.equal(entry.done, false); entry.done = true; active--; gate.resolve(value)
    }
    entry.reject = error => {
      assert.equal(entry.done, false); entry.done = true; active--; gate.reject(error)
    }
    requests.push(entry)
    return gate.promise
  }
  return {
    requests,
    assets: {
      getExternalTexture: request,
      getTexture: key => { assert.equal(key, 'entity/player/wide/steve'); return request(null) },
    },
    get active() { return active },
    get maximum() { return maximum },
    get disposals() { return disposals },
  }
}

// Preload distinct raw keys, reuse every success, and let requests finish in
// arbitrary order without changing which texture each ordered head receives.
{
  const keys = ['slow', 'b', 'slow', null, 'b', ...Array.from({ length: 12 }, (_, i) => 'skin-' + i),
    'http://skin.test/a', 'https://skin.test/a', '', null]
  const heads = keys.map(head), fixture = controlledAssets()
  const loader = createHeadTextureLoader(heads, fixture.assets, { concurrency: 32 })
  assert.equal(fixture.requests.length, 8, 'The production ceiling remains eight requests')
  const consumed = []
  const consuming = (async () => { for (const entry of heads) consumed.push(await loader.get(entry)) })()
  const unique = new Set(heads.map(keyOf))
  while (fixture.requests.length < unique.size || fixture.requests.some(entry => !entry.done && entry.key !== 'slow')) {
    for (const request of [...fixture.requests].reverse()) if (!request.done && request.key !== 'slow') request.resolve()
    await turn()
  }
  assert.equal(consumed.length, 0, 'The first slow skin must not reorder head consumption')
  assert.equal(fixture.maximum, 8)
  assert.equal(fixture.active, 1)
  fixture.requests[0].resolve()
  await consuming
  assert.deepEqual(consumed.map(texture => texture.key), heads.map(keyOf))
  for (const key of unique) assert.equal(fixture.requests.filter(request => request.key === key).length, 1)
  assert.equal(consumed[0], consumed[2], 'Repeated heads reuse the successful texture')
  loader.stop()
  assert.equal(fixture.disposals, 0, 'Successful textures remain owned by the provider')
}

// A failure is consumed only once. This matches the previous sequential loader:
// each following head retries until a success is available, including Steve.
{
  const calls = new Map(), skin = {}, steve = {}
  const request = key => {
    const count = (calls.get(key) || 0) + 1
    calls.set(key, count)
    return Promise.resolve(key === null ? (count === 1 ? null : steve) : (count < 3 ? null : skin))
  }
  const heads = ['a', 'a', 'a', 'a', null, null, null].map(head)
  const loader = createHeadTextureLoader(heads, { getExternalTexture: request, getTexture: () => request(null) })
  await turn() // Even an already-settled prefetched failure must remain consumable once.
  const results = []
  for (const entry of heads) results.push(await loader.get(entry))
  assert.deepEqual(results, [null, null, skin, skin, null, steve, steve])
  assert.deepEqual([...calls], [['a', 3], [null, 2]])
  loader.stop()
}

// A retry is also subject to the limit; it cannot bypass eight occupied slots.
{
  const heads = ['bad', ...Array.from({ length: 8 }, (_, i) => 'held-' + i), 'bad'].map(head)
  const fixture = controlledAssets(), loader = createHeadTextureLoader(heads, fixture.assets)
  const first = loader.get(heads[0])
  fixture.requests[0].resolve(null)
  assert.equal(await first, null)
  assert.equal(fixture.requests.length, 9)
  const retry = loader.get(heads.at(-1))
  assert.equal(fixture.requests.length, 9, 'A retry waits for a slot')
  fixture.requests[1].resolve()
  await turn()
  assert.equal(fixture.requests.length, 10)
  assert.equal(fixture.requests[9].key, 'bad')
  fixture.requests[9].resolve()
  assert.equal(await retry, fixture.requests[9].texture)
  assert.equal(fixture.maximum, 8)
  loader.stop()
  for (const request of fixture.requests) if (!request.done) request.resolve()
  await turn()
}

const unhandled = []
const onUnhandled = error => unhandled.push(error)
process.on('unhandledRejection', onUnhandled)
try {
  // Neither synchronous exceptions nor an early rejected prefetch are exposed
  // until the relevant get(). Consuming the error also permits a later retry.
  {
    const syncError = new Error('Synchronous provider failure'), asyncError = new Error('Rejected prefetch')
    const calls = new Map(), texture = {}
    const loader = createHeadTextureLoader(['sync', 'async'].map(head), {
      getExternalTexture(key) {
        const count = (calls.get(key) || 0) + 1; calls.set(key, count)
        if (count > 1) return texture
        if (key === 'sync') throw syncError
        return Promise.reject(asyncError)
      },
    }, { concurrency: 1 })
    await turn()
    await assert.rejects(loader.get(head('sync')), error => error === syncError)
    await assert.rejects(loader.get(head('async')), error => error === asyncError)
    assert.equal(await loader.get(head('sync')), texture)
    assert.equal(await loader.get(head('async')), texture)
    assert.deepEqual([...calls], [['sync', 2], ['async', 2]])
    loader.stop()
  }

  // Stop immediately resolves a consumer waiting on a fetch that never ends.
  // Already-issued provider work may finish/reject later, without scheduling
  // another skin, disposing shared textures, or causing an unhandled rejection.
  {
    const fixture = controlledAssets(), heads = Array.from({ length: 15 }, (_, i) => head('skin-' + i))
    const loader = createHeadTextureLoader(heads, fixture.assets, { concurrency: 3 })
    const waiting = loader.get(heads[0])
    loader.stop(); loader.stop()
    const timedOut = Symbol('not settled')
    assert.equal(await Promise.race([waiting, turn().then(() => timedOut)]), null)
    assert.equal(await loader.get(heads[14]), null)
    assert.equal(fixture.requests.length, 3)
    fixture.requests[0].resolve()
    fixture.requests[1].reject(new Error('Network failure after cancellation'))
    fixture.requests[2].resolve()
    await turn()
    assert.equal(fixture.requests.length, 3, 'Stop discards all queued work')
    assert.equal(fixture.disposals, 0)
  }

  // isCurrent is checked before initial dispatch, on get(), and on completion.
  {
    const fixture = controlledAssets()
    const loader = createHeadTextureLoader([head('unused')], fixture.assets, { isCurrent: () => false })
    assert.equal(await loader.get(head('unused')), null)
    assert.equal(fixture.requests.length, 0)
  }
  for (const observeAt of ['get', 'completion']) {
    let current = true
    const fixture = controlledAssets(), heads = ['a', 'b', 'c'].map(head)
    const loader = createHeadTextureLoader(heads, fixture.assets, { isCurrent: () => current, concurrency: 1 })
    const waiting = loader.get(heads[0])
    current = false
    if (observeAt === 'get') assert.equal(await loader.get(heads[1]), null)
    fixture.requests[0].reject(new Error('Old revision failed'))
    assert.equal(await waiting, null)
    await turn()
    assert.equal(fixture.requests.length, 1, 'A stale render does not dispatch queued work')
    assert.equal(await loader.get(heads[2]), null)
  }
  await turn()
  assert.deepEqual(unhandled, [])
} finally {
  process.off('unhandledRejection', onUnhandled)
}

console.log('PASS head textures: bounded distinct prefetch, ordered consumption, failure retries, shared ownership, stop/stale handling and observed late rejections')
