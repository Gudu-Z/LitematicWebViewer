// Preload the first request for each skin while the renderer consumes heads in
// input order. A failed first request belongs only to its first head: the next
// head with that skin must still be able to retry through AssetProvider.
export function createHeadTextureLoader(heads, assets, { isCurrent = () => true, concurrency = 8 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid head texture concurrency')
  const limit = Math.min(8, concurrency)
  const records = new Map()
  let queue = [], next = 0, active = 0, stopped = false

  function stop() {
    if (stopped) return
    stopped = true
    isCurrent = null // A late provider request no longer needs its scene/job guard.
    // The provider owns both the requests and textures. Settle our consumers
    // without cancelling a shared fetch or disposing a borrowed texture.
    for (const record of records.values()) record.resolve({ texture: null })
    records.clear()
    queue = []
    next = 0
  }

  function current() {
    if (stopped) return false
    if (!isCurrent()) { stop(); return false }
    return true
  }

  function enqueue(key) {
    let resolve
    const promise = new Promise(done => { resolve = done })
    const record = { key, promise, resolve }
    records.set(key, record)
    queue.push(record)
    return record
  }

  function pump() {
    while (current() && active < limit && next < queue.length) {
      const record = queue[next]
      queue[next++] = null
      if (next === queue.length) { queue = []; next = 0 }
      active++
      let request
      try {
        request = record.key === null
          ? assets.getTexture('entity/player/wide/steve')
          : assets.getExternalTexture(record.key)
      } catch (error) {
        request = Promise.reject(error)
      }
      // Background requests never reject an unobserved promise. Preserve the
      // error as data until the corresponding get() actually consumes it.
      Promise.resolve(request).then(
        texture => finish(record, { texture }),
        error => finish(record, { error, failed: true }),
      )
    }
  }

  function finish(record, result) {
    active--
    if (!current()) return
    record.resolve(result)
    pump()
  }

  for (const head of heads || []) {
    const key = head.skinUrl || null
    if (!records.has(key)) enqueue(key)
  }
  pump()

  return {
    // The renderer awaits get() for each head in original input order. Keep
    // successful results, but consume a failure only once rather than caching
    // it for every later head sharing this URL.
    async get(head) {
      if (!current()) return null
      const key = head.skinUrl || null
      const record = records.get(key) || enqueue(key)
      pump()
      const result = await record.promise
      if (!current()) return null
      if (result.failed || !result.texture) {
        if (records.get(key) === record) records.delete(key)
      }
      if (result.failed) throw result.error
      return result.texture
    },
    stop,
  }
}

// The file load already owns a texture transaction. Keep the same first
// results (including failures) from parse completion through ordered rendering.
export function createPlayerHeadPreparation(heads, assets, { signal } = {}) {
  if (!heads.length || signal?.aborted) return { heads, take: () => null, stop() {} }

  const revision = assets.cacheRevision
  let claimed = false, stopped = false, offClear
  const current = () => !stopped && !signal?.aborted && revision === assets.cacheRevision
  const loader = createHeadTextureLoader(heads, assets, { isCurrent: current })
  function stop() {
    if (stopped) return
    stopped = true
    signal?.removeEventListener('abort', stop)
    offClear?.()
    loader.stop()
  }
  if (current()) {
    signal?.addEventListener('abort', stop, { once: true })
    offClear = assets.onCacheClear?.(stop)
  } else stop() // A synchronous provider may invalidate the load during dispatch.

  return {
    heads,
    take(list, provider) {
      if (claimed) return null
      if (list !== heads || provider !== assets || !current()) { stop(); return null }
      claimed = true
      return { get: loader.get, stop }
    },
    stop,
  }
}
