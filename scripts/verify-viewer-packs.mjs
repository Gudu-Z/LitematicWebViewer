import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { ViewerPacks } from '../src/viewerPacks.js'
import { AssetProvider } from '../src/assets.js'

const key = 'viewer-resource-packs-v1'
const preferences = new Map(), files = new Map()
const storage = { getItem: id => preferences.get(id) ?? null, setItem: (id, value) => preferences.set(id, value) }
async function zip(value) {
  const pack = new JSZip()
  pack.file('pack.mcmeta', '\uFEFF{"pack":{"description":"test","pack_format":85}}')
  pack.file('assets/minecraft/models/block/stone.json', JSON.stringify({ value }))
  return pack.generateAsync({ type: 'uint8array' })
}
const builtinData = await zip('XK'), a = await zip('A'), b = await zip('B')
const file = (name, data) => ({ name, arrayBuffer: async () => data })
let rejectApply = false, failNetwork = false, failWrite = false
let applied = []
const options = {
  storage,
  read: async () => [...files.values()],
  write: async pack => { if (failWrite) throw Error('quota'); files.set(pack.id, pack) },
  fetchPack: async path => {
    if (failNetwork) throw Error('offline')
    return path.endsWith('manifest.json')
      ? Response.json([{ name: 'XK builtin', file: 'xk.zip' }]) : new Response(builtinData)
  },
  apply: async packs => { if (rejectApply) throw Error('render failed'); applied = packs },
}
const value = async () => {
  const assets = new AssetProvider()
  for (const pack of applied) assets.addPack(pack.zip, pack.id)
  return (await assets.getJSON('models/block/stone.json'))?.value
}
let manager = new ViewerPacks(options)
assert.equal(await manager.init(), '')
assert.equal(await value(), 'XK', 'first visit loads XK')
await manager.importFiles([file('a.zip', a), file('b.zip', b)])
assert.deepEqual(manager.loaded, ['local:a.zip', 'local:b.zip', 'builtin:xk.zip'])
assert.equal(await value(), 'A', 'new local imports have priority')
await manager.move('local:b.zip', -1); assert.equal(await value(), 'B')
await manager.unload('local:b.zip'); assert.equal(await value(), 'A')
assert.ok(manager.available.some(pack => pack.id === 'local:b.zip'), 'unloaded local pack stays available')
await manager.load('local:b.zip'); assert.equal(await value(), 'B')
manager = new ViewerPacks(options); await manager.init()
assert.equal(await value(), 'B', 'reload restores ZIP contents and priority')
await manager.importFiles([file('b.zip', a)]); assert.equal(await value(), 'A', 'same file replaces old content')
const before = [...manager.loaded], saved = storage.getItem(key)
await assert.rejects(manager.importFiles([file('new.zip', b), file('invalid.zip', new Uint8Array([1, 2]))]), /ZIP/)
assert.deepEqual(manager.loaded, before)
assert.ok(!manager.library.has('local:new.zip'), 'invalid batch must not partially import')
rejectApply = true
await assert.rejects(manager.importFiles([file('b.zip', b)]), /render failed/)
await assert.rejects(manager.unload('local:b.zip'), /render failed/)
assert.deepEqual(manager.loaded, before)
assert.equal(storage.getItem(key), saved, 'failed operation must not overwrite saved state')
rejectApply = false
await manager.load('local:b.zip'); assert.equal(await value(), 'A', 'failed replacement restores original pack')
await manager.unloadAll(); assert.deepEqual(manager.loaded, [])
manager = new ViewerPacks(options); await manager.init()
assert.deepEqual(manager.loaded, [], 'explicit vanilla preference persists')
assert.equal(manager.available.length, 3)
await manager.load('builtin:xk.zip')
const savedBeforeOutage = storage.getItem(key)
failNetwork = true
manager = new ViewerPacks(options)
assert.equal(await manager.init(), 'packManifestUnavailable')
assert.equal(storage.getItem(key), savedBeforeOutage, 'transient failures must not erase preferences')
failNetwork = false; failWrite = true
assert.equal(await manager.importFiles([file('session.zip', b)]), 'packSaveFailed')
assert.equal(await value(), 'B', 'storage failure still permits session use')
console.log('Passed viewer packs: default XK, batch import, priority, unload/reload, persistent ZIPs/order/vanilla, replacement, atomic failures, rendering rollback and storage/network fallback')
