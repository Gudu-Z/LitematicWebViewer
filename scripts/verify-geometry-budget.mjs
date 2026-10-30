import assert from 'node:assert/strict'
import { estimateGeometryBytes, geometryLimit, MAX_GEOMETRY_BYTES } from '../src/geometryBudget.js'
import { buildFaceGroups } from '../src/geometry.js'
import { bakeModel } from '../src/modelBaker.js'
import { transferBuffers } from '../src/workerProtocol.js'

const bounds = { minX: 0, minY: 0, minZ: 0, width: 100, height: 1, depth: 1 }
const counts = new Map([['block/stone', 16383], ['particle/bubble', 3], ['special/end_portal', 16384]])
assert.equal(estimateGeometryBytes(counts, bounds), 16383 * 92 + 3 * 12 + 16384 * 104)
assert.equal(estimateGeometryBytes(counts, bounds, null), estimateGeometryBytes(counts, bounds))
assert.equal(estimateGeometryBytes(counts, bounds, { trackBlocks: true }), 16383 * 96 + 3 * 12 + 16384 * 108)
assert.equal(estimateGeometryBytes(counts, bounds, { compactFaces: true }), 16383 * 8 + 4 * 72 + 72 + 3 * 12 + 16384 * 104)
const wide = { ...bounds, width: 65536, depth: 65536, height: 2 }
assert.equal(estimateGeometryBytes(new Map([['block/stone', 1]]), wide, { compactFaces: true }), 12 + 72 + 72)
assert.equal(estimateGeometryBytes(new Map([['block/stone', 1]]), wide, { trackBlocks: true }), 100)
for (const limit of [-1, NaN, Infinity, .5, MAX_GEOMETRY_BYTES + 1]) assert.throws(() => geometryLimit(0, limit), RangeError)
assert.throws(() => estimateGeometryBytes(new Map([['block/stone', 2 ** 31]]), bounds), { code: 'FILE_TOO_LARGE', reason: 'geometry' })

const palette = [{ name: 'minecraft:stone', baked: bakeModel({ textures: { all: 'block/stone' }, elements: [{
  from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
}] }) }]
const blocks = new Map([[0, 0], [1, 0], [3, 0]])
for (const compactFaces of [false, true]) {
  const stages = [], fractions = []
  const result = await buildFaceGroups(palette, blocks, bounds, f => fractions.push(f), null, { compactFaces, trackBlocks: true, onStage: stage => stages.push(stage) })
  assert.equal(result.geometryBytes, transferBuffers(result).reduce((sum, buffer) => sum + buffer.byteLength, 0), 'Budget includes all actual output buffers')
  assert.deepEqual([...new Set(stages.map(stage => stage.phase))], ['count', 'allocate', 'fill'])
  assert.ok(fractions.every((value, index) => !index || value >= fractions[index - 1]))
  assert.equal(fractions.at(-1), 1)
  let allocated = false
  await assert.rejects(buildFaceGroups(palette, blocks, bounds, null, null, { compactFaces, maxGeometryBytes: 1, onStage: stage => { if (stage.phase === 'allocate') allocated = true } }), { code: 'FILE_TOO_LARGE', reason: 'geometry', maxBytes: 1 })
  assert.equal(allocated, false, 'Reject before allocating any geometry')
  const controller = new AbortController()
  const observed = []
  await assert.rejects(buildFaceGroups(palette, blocks, bounds, null, null, { compactFaces, signal: controller.signal, onStage: stage => {
    observed.push(stage.phase)
    if (stage.phase === 'allocate') controller.abort()
  } }), { name: 'AbortError' })
  assert.ok(!observed.includes('fill'), 'Cancellation stops before the fill pass')
}
console.log('PASS exact geometry budgets, index/key widths, pre-allocation limits, stage order and cancellation')
