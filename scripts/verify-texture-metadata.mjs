import assert from 'node:assert/strict'
import { AssetProvider } from '../src/assets.js'

const originalFetch = globalThis.fetch
const frames = { frametime: 3, interpolate: true, frames: [1, 0, { index: 2, time: 7 }] }
const index = { version: 1, animation: { 'block/water_still': frames, 'entity/static': false } }
let requests = [], mode = 'index'
globalThis.fetch = async url => {
  requests.push(url)
  if (String(url).endsWith('texture-metadata.json')) {
    if (mode === 'missing') return new Response(null, { status: 404 })
    if (mode === 'invalid') return Response.json({ version: 99, animation: {} })
    if (mode === 'offline') throw Error('offline fixture')
    return Response.json(index)
  }
  if (String(url).endsWith('/water_still.png.mcmeta')) return Response.json({ animation: frames })
  return new Response(null, { status: 404 })
}
const pack = metadata => ({ file: path => Object.hasOwn(metadata, path) ? { async: async () => JSON.stringify(metadata[path]) } : null })
try {
  const assets = new AssetProvider()
  const result = await Promise.all(['block/water_still', 'entity/static', ...Array.from({ length: 1000 }, (_, i) => 'block/static_' + i)].map(key => assets._isAnimated(key)))
  assert.deepEqual(result.slice(0, 2), [frames, false])
  assert.ok(result.slice(2).every(value => value === null), 'Absent metadata preserves existing heuristic detection')
  assert.equal(requests.length, 1, 'A thousand textures share one metadata request, without per-texture 404s')

  assets.addPack(pack({ 'assets/minecraft/textures/block/water_still.png.mcmeta': { animation: { frametime: 11 } } }), 'lower')
  assets.addPack(pack({ 'assets/minecraft/textures/block/water_still.png.mcmeta': { texture: {} } }), 'upper')
  // Explicit ordering avoids depending on the pack UI's insertion policy.
  assets.packs.reverse()
  assert.equal(await assets._isAnimated('block/water_still'), false, 'Top pack can disable vanilla animation')
  assets.packs.shift()
  assert.deepEqual(await assets._isAnimated('block/water_still'), { frametime: 11 }, 'Lower pack metadata remains intact')
  assets.packs.length = 0
  assert.deepEqual(await assets._isAnimated('block/water_still'), frames, 'Removing packs restores vanilla metadata')
  assert.equal(requests.length, 1, 'Changing packs keeps the unchanged vanilla index cached')
  assets.baseUrl = 'alternate/'
  assert.deepEqual(await assets._isAnimated('block/water_still'), frames)
  assert.equal(requests.at(-1), 'alternate/texture-metadata.json', 'Custom asset roots get their own index')

  for (mode of ['missing', 'invalid', 'offline']) {
    requests = []
    const fallback = new AssetProvider()
    assert.deepEqual(await fallback._isAnimated('block/water_still'), frames, mode + ': fall back to the original metadata file')
    assert.equal(await fallback._isAnimated('block/stone'), null)
    assert.equal(requests.filter(url => url.endsWith('texture-metadata.json')).length, mode === 'offline' ? 2 : 1,
      'An unavailable index must not retry separately for every texture')
  }
  console.log('PASS shared texture metadata: request count, frame timings, pack precedence, custom asset roots and unavailable-index fallback')
} finally { globalThis.fetch = originalFetch }
