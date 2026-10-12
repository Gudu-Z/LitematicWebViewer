import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { MaterialIcons } from '../src/materialIcons.js'

// Exercise scheduling and resource ownership without a GPU or network. The full
// viewer browser check separately verifies decoded PNGs and pack load/unload.
const idle = new Map()
let idleId = 0
globalThis.requestIdleCallback = callback => { idle.set(++idleId, callback); return idleId }
globalThis.cancelIdleCallback = id => idle.delete(id)
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback }
  observe() {}
  unobserve() {}
  disconnect() {}
  show(slots, isIntersecting = true) { this.callback(slots.map(target => ({ target, isIntersecting }))) }
}
globalThis.fetch = () => { throw Error('Material icon unit tests must not access the network') }

function slot(name) {
  const classes = new Set(), image = { hidden: true, removeAttribute(key) { delete this[key] } }
  return {
    dataset: { material: name }, isConnected: true, image,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    querySelector: () => image,
  }
}

function fixture(names, source = new AssetProvider()) {
  const list = { slots: names.map(slot), querySelectorAll() { return this.slots } }
  const icons = new MaterialIcons(list, source)
  const jobs = []
  icons.render = (id, assets) => new Promise(resolve => jobs.push({ id, assets, resolve }))
  return { list, icons, jobs }
}

async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5) }
  throw Error('Timeout: ' + label)
}

async function finish(icons, jobs) {
  for (let i = 0; i < 300; i++) {
    for (const job of jobs) job.resolve('png:' + job.id)
    if (!icons.state.active && !icons.queue.length) return
    await delay(5)
  }
  throw Error('Icon queue did not finish')
}

const names = Array.from({ length: 24 }, (_, i) => 'material_' + i)
{
  const { icons, list, jobs } = fixture(names)
  const prepare = idle.get(icons.warmup)
  prepare()
  assert.equal(jobs.length, 4, 'Prepare several icons concurrently, with a bounded worker count')
  icons.observer.show(list.slots.slice(20))
  jobs[0].resolve('png:first')
  await until(() => jobs.length === 5, 'next visible icon')
  assert.equal(jobs[4].id, names[20], 'Scrolling into a new row takes priority over background preparation')
  assert.equal(icons.state.active, 4, 'Never launch the whole material list at once')
  await finish(icons, jobs)
  assert.equal(jobs.length, 16, 'Only the first 12 rows and the four visible rows are prepared')
  assert.ok(list.slots.slice(12, 20).every(slot => !slot.image.src), 'Offscreen rows stay lazy')
  const count = jobs.length
  icons.observe()
  assert.ok(list.slots.slice(0, 12).every(slot => slot.image.src), 'Reopening restores cached PNGs immediately')
  assert.equal(jobs.length, count, 'Reopening does not rebuild cached thumbnails')
}

{
  const { icons, list, jobs } = fixture(['water', 'bubble_column', 'oak_wall_sign', 'oak_sign'])
  icons.observer.show(list.slots)
  assert.deepEqual(jobs.map(job => job.id), ['water_bucket', 'oak_sign'], 'Aliases share their in-flight icon')
  const detached = [...list.slots]
  detached.forEach(slot => { slot.isConnected = false })
  list.slots = ['oak_sign', 'water'].map(slot)
  icons.observe()
  icons.observer.show(list.slots)
  await finish(icons, jobs)
  assert.equal(jobs.length, 2, 'Sorting while loading reuses the original jobs')
  assert.ok(detached.every(slot => !slot.image.src), 'Detached rows must not be painted')
  assert.deepEqual(list.slots.map(slot => slot.image.src), ['png:oak_sign', 'png:water_bucket'])
}

{
  const { icons, list, jobs } = fixture(names.slice(0, 4))
  icons.observer.show(list.slots)
  const retired = icons.state
  icons.reset()
  icons.observer.show(list.slots)
  assert.equal(jobs.length, 8, 'A pack switch starts new work without waiting for old requests')
  for (const job of jobs.slice(4)) job.resolve('png:new-pack')
  await until(() => !icons.state.active, 'replacement pack')
  for (const job of jobs.slice(0, 4)) job.resolve('png:old-pack')
  await until(() => !retired.active, 'retired pack')
  assert.ok(list.slots.every(slot => slot.image.src === 'png:new-pack'), 'Late results must not overwrite the new pack')
  assert.ok([...icons.cache.values()].every(url => url === 'png:new-pack'), 'Late results must not poison the PNG cache')
}

function texture(size = 16) { return new THREE.Texture({ width: size, height: size }) }
const pack = marker => ({ file: () => ({ async: async () => JSON.stringify({ marker }) }) })
{
  const source = new AssetProvider(), original = texture(), json = { marker: 'scene' }
  source.addPack(pack('old-pack'), 'pack')
  source.jsonCache.set('models/block/stone.json', Promise.resolve(json))
  source.textureCache.set('block/stone', Promise.resolve(original))
  const { icons } = fixture([], source), assets = icons.state.assets
  assert.equal(await assets.getJSON('models/block/stone.json'), json, 'Reuse the scene model without another fetch')
  const a = assets.getTexture('block/stone'), b = assets.getTexture('block/stone')
  assert.equal(a, b, 'Parallel icons share one texture load')
  const clone = await a
  assert.notEqual(clone, original, 'Icons own their GPU texture objects')
  assert.equal(clone.image, original.image, 'Reuse the decoded source image')
  let originalDisposals = 0, cloneDisposals = 0
  original.addEventListener('dispose', () => originalDisposals++)
  clone.addEventListener('dispose', () => cloneDisposals++)
  source.clearPacks(); source.addPack(pack('new-pack'), 'pack')
  source.jsonCache.set('models/block/other.json', Promise.resolve({ marker: 'new-scene' }))
  assert.equal((await assets.getJSON('models/block/other.json')).marker, 'old-pack', 'An old snapshot cannot borrow a new pack model')
  icons.reset()
  assert.equal(cloneDisposals, 1, 'Reset releases retired icon textures')
  assert.equal(originalDisposals, 0, 'Icon cleanup must never dispose the main scene texture')
  assert.equal((await icons.state.assets.getJSON('models/block/other.json')).marker, 'new-scene')
}

{
  const source = new AssetProvider(), { icons } = fixture([], source), assets = icons.state.assets
  for (let i = 0; i < 100; i++) source.textureCache.set('texture_' + i, Promise.resolve(texture()))
  await Promise.all([...source.textureCache.keys()].map(key => assets.getTexture(key)))
  assets.trim()
  assert.equal(assets.textureCache.size, 96, 'Retained texture count is bounded')
  assets.trim(0, 0)
  for (let i = 0; i < 6; i++) source.textureCache.set('large_' + i, Promise.resolve(texture(1024)))
  await Promise.all(Array.from({ length: 6 }, (_, i) => assets.getTexture('large_' + i)))
  assets.trim()
  assert.equal(assets.textureCache.size, 4, 'High-resolution packs also respect the pixel budget')
}

console.log('Passed material icon concurrency, visible-row priority, bounded prefetch, alias/sort reuse, stale pack isolation, scene resource reuse and texture ownership/budgets.')
