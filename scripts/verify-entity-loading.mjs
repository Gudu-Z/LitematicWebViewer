// Deterministic resource gates exercise the worker pool without wall-clock thresholds.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'

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
// All real dependency callbacks are promises; this drains their microtasks before observing the next stable gate state.
const settle = () => new Promise(resolve => setImmediate(resolve))
const originalError = console.error
console.error = (...args) => errors.push(args)
try {
  const loading = view.renderEntities(entities, assets)
  await settle()
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
  }
  gates.get(63).release()
  // Finish the earliest models in reverse order, including a deliberate failure.
  for (let index = 48; index >= 0; index--) gates.get(index).release()
  await loading
  assert.equal(peak, 50, 'The maximum active entity construction count must remain 50')
  assert.equal(active, 0)
  assert.equal(errors.length, 1, 'A failed model must be isolated and reported once')
  assert.equal(errors[0][2], failure)
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
  await view.renderEntities([], assets)
  assert.equal(view.entitiesGroup.children.length, 0)
  console.log('PASS entity loading: bounded 50-worker scheduling, progress past a slow first request, original order/layers, isolated failures and unsupported entities')
} finally {
  console.error = originalError
}
