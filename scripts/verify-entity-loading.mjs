// Deterministic resource gates exercise the worker pool without wall-clock thresholds.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { buildEntityMesh } from '../src/entities.js'
import { getMobAppearance } from '../src/entityAppearance.js'

const gates = new Map(), started = [], completed = [], textures = new Map(), errors = []
const failedIndex = 7, unsupportedIndex = 60, failure = new Error('Synthetic entity model failure')
let active = 0, peak = 0
const assets = {
  cacheRevision: 0, jsonCache: new Map(),
  getJSON(path) {
    if (this.jsonCache.has(path)) return this.jsonCache.get(path)
    const match = /^models\/item\/__loading_(\d+)\.json$/.exec(path)
    let request
    if (match) {
      const index = Number(match[1])
      started.push(index); active++; peak = Math.max(peak, active)
      request = new Promise((resolve, reject) => gates.set(index, {
        release() {
          if (index === failedIndex) { active--; reject(failure) }
          else resolve({ textures: { layer0: 'item/__loading_' + index } })
        },
      }))
    } else {
      const file = 'public/assets/minecraft/' + path
      request = Promise.resolve(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)
    }
    this.jsonCache.set(path, request)
    return request
  },
  async getTexture(key) {
    if (!textures.has(key)) {
      const texture = new THREE.Texture(); texture.name = key; texture.image = { width: 16, height: 16 }
      textures.set(key, texture)
    }
    const match = /^item\/__loading_(\d+)$/.exec(key)
    if (match) { completed.push(Number(match[1])); active-- }
    return textures.get(key)
  },
}
const view = Object.create(Renderer.prototype)
view.scene = new THREE.Scene()
for (const key of ['entitiesGroup', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']) {
  view[key] = new THREE.Group(); view.scene.add(view[key])
}
view.setLayerVisibility('single', -1)
const entities = Array.from({ length: 64 }, (_, index) => ({
  id: index === unsupportedIndex ? 'minecraft:unsupported_loading_fixture' : 'minecraft:item_frame',
  pos: [index * 3, index % 4 - 2 + .25, 0], rotation: [0, 0],
  nbt: { Facing: 3, Item: { id: 'minecraft:__loading_' + index, count: 1 } },
}))
// Drain dependency microtasks and the shared UI yield before observing the next gate.
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 0))
}
const originalError = console.error
console.error = (...args) => errors.push(args)
try {
  const progress = []
  const loading = view.renderEntities(entities, assets, undefined, (fraction, state) => progress.push({ fraction, ...state }))
  await settle()
  assert.deepEqual(progress[0], { fraction: 0, completed: 0, total: 64, phase: 'models' })
  assert.deepEqual(started, Array.from({ length: 50 }, (_, index) => index), 'Start exactly 50 entity builds while every model is pending')
  assert.equal(completed.length, 0)
  // Keep entity 0 and the other early requests blocked. One free slot must keep progressing beyond the original batch.
  for (const [current, next] of [[49, 50], [50, 51], [51, 52], [52, 53], [53, 54], [54, 55], [55, 56], [56, 57], [57, 58], [58, 59], [59, 61], [61, 62], [62, 63]]) {
    gates.get(current).release()
    await settle()
    assert.ok(completed.includes(current), 'Released entity ' + current + ' must finish')
    assert.ok(gates.has(next), 'A free worker must start entity ' + next + ' without waiting for the initial slow request')
    assert.equal(completed.includes(0), false, 'The slow first model must still be pending')
    assert.ok(active <= 50, 'Rolling scheduling must retain the concurrency ceiling')
    assert.ok(progress.at(-1).completed > 0 && progress.at(-1).fraction < 1, 'Report real progress while another model is still pending')
  }
  gates.get(63).release()
  // Finish the earliest models in reverse order, including a deliberate failure.
  for (let index = 48; index >= 0; index--) gates.get(index).release()
  await loading
  assert.equal(peak, 50, 'The maximum active entity construction count must remain 50')
  assert.equal(active, 0)
  assert.equal(errors.length, 1, 'A failed model must be isolated and reported once')
  assert.equal(errors[0][2], failure)
  assert.deepEqual(progress.at(-1), { fraction: 1, completed: 64, total: 64, phase: 'done' })
  assert.ok(progress.some(p => p.phase === 'finishing' && p.fraction < 1), 'Completion follows frame repair and batching')
  assert.ok(progress.every((p, i) => p.total === 64 && (!i || p.fraction >= progress[i - 1].fraction)), 'Progress never moves backward')
  const expected = entities.filter((_, index) => index !== failedIndex && index !== unsupportedIndex)
  const roots = view.entitiesGroup.children.filter(object => object.userData.entityHitbox)
  assert.equal(roots.length, expected.length, 'Other entities must survive failed and unsupported neighbors')
  assert.deepEqual(roots.map(object => object.userData.entityHitbox.anchor.elements[12]), expected.map(entity => entity.pos[0]),
    'Out-of-order completions must retain the original entity order')
  assert.deepEqual(roots.map(object => object.userData.schematicLayer), expected.map(entity => Math.floor(entity.pos[1])),
    'Saved layers must stay associated with the original entity indices')
  assert.deepEqual(roots.map(object => object.visible), expected.map(entity => Math.floor(entity.pos[1]) === -1),
    'Newly completed entities must inherit the active layer filter')
  view.clearEntities()
  const emptyProgress = []
  await view.renderEntities([], assets, undefined, (fraction, state) => emptyProgress.push({ fraction, ...state }))
  assert.equal(view.entitiesGroup.children.length, 0)
  assert.deepEqual(emptyProgress, [{ fraction: 1, completed: 0, total: 0, phase: 'done' }])
  // Force CPU budget exhaustion without relying on the machine's speed. Cached
  // frames must let a pending input/paint task run before the whole scene ends.
  const cached = Array.from({ length: 240 }, (_, i) => ({ ...entities[0], pos: [i, 0, 0], nbt: { Facing: 3, Item: { id: 'minecraft:diamond' } } }))
  await view.renderEntities(cached.slice(0, 1), assets)
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let clock = 0, current = 0, completedAtPaint
  Object.defineProperty(performance, 'now', { configurable: true, value: () => { clock += 9; return clock } })
  try {
    const paint = new Promise(resolve => setTimeout(() => { completedAtPaint = current; resolve() }, 0))
    await view.renderEntities(cached, assets, undefined, (_fraction, state) => { current = state.completed })
    await paint
    assert.ok(completedAtPaint > 0 && completedAtPaint < cached.length, 'A cached build yields before all frames finish')
  } finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor)
    else delete performance.now
    view.clearEntities()
  }
  console.log('PASS entity loading: bounded 50-worker scheduling, accurate progress through slow/failed/empty loads, cached-build UI yields, original order/layers and isolated failures')
} finally {
  console.error = originalError
}

// A multi-layer entity must start independent texture reads together, while
// attaching materials in the original order even if decoding finishes backwards.
for (const id of ['warden', 'villager']) for (const missing of [false, true]) {
  const entity = {
    id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0],
    nbt: { Health: 20, VillagerData: { type: 'minecraft:desert', profession: 'minecraft:librarian', level: 5 } },
  }
  const appearance = getMobAppearance(entity, id)
  const keys = [appearance.texture, ...appearance.layers.map(layer => layer.texture)]
  const waiting = new Map()
  const pending = buildEntityMesh(entity, {
    getTexture(key) {
      assert.ok(!waiting.has(key), 'This fixture uses distinct feature textures')
      return new Promise(resolve => waiting.set(key, () => {
        const texture = new THREE.Texture(); texture.name = key
        texture.image = { width: appearance.model.w, height: appearance.model.h }
        resolve(missing && key === keys[2] ? null : texture)
      }))
    },
  })
  await settle()
  assert.deepEqual([...waiting.keys()], keys, id + ': all feature reads must start before any image is released')
  for (const key of [...keys].reverse()) { waiting.get(key)(); await settle() }
  const group = await pending
  const layers = group.children.filter(object => object.isSkinnedMesh)
  const expected = [{ name: 'body', texture: appearance.texture }, ...appearance.layers]
    .filter(layer => !missing || layer.texture !== keys[2])
  assert.deepEqual(layers.map(layer => layer.name), expected.map(layer => layer.name), id + ': preserve visible layer order after out-of-order image completion')
  assert.deepEqual(layers.map(layer => layer.material.map.name), expected.map(layer => layer.texture))
  assert.ok(layers.every((layer, i) => !i || layer.material.id > layers[i - 1].material.id), 'Material order must be independent of request completion')
  for (const layer of layers) { layer.geometry.dispose(); layer.material.map.dispose(); layer.material.dispose() }
}
console.log('PASS entity feature loading: parallel body/layer requests, deterministic material order and missing optional texture isolation')
