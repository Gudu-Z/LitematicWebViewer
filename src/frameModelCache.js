// Cache only fixed item-frame models. GUI/equipment can edit their own materials and geometry.
const caches = new WeakMap()
const watchedAssets = new WeakSet()
const MAX_MODELS = 512

export function frameItemKey(item) {
  // NBT may contain longs/typed arrays. Keep types and every component/tag in the key;
  // two pots, potion colours or statue poses must never accidentally share a model.
  const seen = new Set()
  let budget = 32768
  const spend = size => {
    budget -= size
    if (budget < 0) throw new RangeError('Item data exceeds model cache budget')
  }
  function encode(value) {
    spend(8)
    if (value === null) return null
    if (typeof value !== 'object') {
      const text = String(value)
      spend(text.length)
      return [typeof value, text]
    }
    if (seen.has(value)) throw new TypeError('Cyclic item data')
    seen.add(value)
    let result
    if (ArrayBuffer.isView(value)) {
      spend(value.byteLength * 4)
      result = [value.constructor.name, Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))]
    } else if (Array.isArray(value)) {
      spend(value.length)
      result = ['array', value.map(encode)]
    } else {
      const keys = Object.keys(value)
      spend(keys.length * 4)
      result = ['object', keys.sort().map(key => { spend(key.length); return [key, encode(value[key])] })]
    }
    seen.delete(value)
    return result
  }
  try {
    const key = JSON.stringify(encode(item))
    return key.length <= 32768 ? 'item:' + key : null
  } catch {
    return null // Unusual data can still render without entering the shared cache.
  }
}

export async function getFrameModel(assets, key, build) {
  if (assets.onCacheClear && !watchedAssets.has(assets)) {
    watchedAssets.add(assets)
    assets.onCacheClear(() => {
      // Cached materials also retain decoded images. Release them immediately on
      // pack changes, even when the next schematic contains no item frames.
      caches.get(assets)?.models.clear()
      caches.delete(assets)
    })
  }
  const revision = assets.cacheRevision
  let cache = caches.get(assets)
  if (!cache || cache.revision !== revision) {
    cache = { revision, models: new Map() }
    caches.set(assets, cache)
  }
  let pending = key && cache.models.get(key)
  if (pending) {
    cache.models.delete(key)
    cache.models.set(key, pending)
  } else {
    let complete = true
    const tracked = Object.create(assets)
    for (const method of ['getJSON', 'getTexture', 'getExternalTexture']) {
      if (!assets[method]) continue
      tracked[method] = async path => {
        const request = assets[method](path)
        const result = await request
        // Cached missing JSON is an optional resource (404/builtin parent), not a
        // transient failure. Failed loads are evicted by AssetProvider for retry.
        if (!result && (method !== 'getJSON' || assets.jsonCache?.get(path) !== request)) complete = false
        return result
      }
    }
    pending = Promise.resolve().then(() => build(tracked)).then(model => {
      if (!complete || !model || assets.cacheRevision !== revision) {
        if (key && cache.models.get(key) === pending) cache.models.delete(key)
      }
      return assets.cacheRevision === revision ? model : null
    }, error => {
      if (key && cache.models.get(key) === pending) cache.models.delete(key)
      throw error
    })
    if (key) {
      cache.models.set(key, pending)
      // Templates retain CPU data only. Live scene instances own GPU lifetime and
      // release each shared geometry/material once when the scene is cleared.
      while (cache.models.size > MAX_MODELS) cache.models.delete(cache.models.keys().next().value)
    }
  }
  const template = await pending
  if (!template || assets.cacheRevision !== revision) return null
  const instance = template.clone(true)
  // Object3D.clone JSON-serializes userData, which otherwise erases Quaternion's type.
  if (template.userData.fixedRot) instance.userData.fixedRot = template.userData.fixedRot.clone()
  if (template.userData.fixedTrans) instance.userData.fixedTrans = [...template.userData.fixedTrans]
  return instance
}
