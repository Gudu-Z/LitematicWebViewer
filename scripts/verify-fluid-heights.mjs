// Minecraft 26.3 reference: LiquidBlock maps LEVEL 1..7 to amount 8-LEVEL;
// FlowingFluid.getOwnHeight divides amount by 9. FluidRenderer.addWeightedHeight
// includes height zero (air) but excludes -1 (solid). Checked against the official
// client SHA-1 e877b6a07acd633fb3bb475002175cec036e7b87, not the viewer's formulas.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as THREE from 'three'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups, fluidHeight } from '../src/geometry.js'
import { parseLitematicaRaw } from '../src/litematica.js'
import { Renderer } from '../src/renderer.js'

const assets = { async getJSON(path) {
  try { return JSON.parse(readFileSync('public/assets/minecraft/' + path, 'utf8')) } catch { return null }
} }
const resolver = new BlockModelResolver(assets)
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 2e-6, `${message}: ${actual} != ${expected}`)
const ownHeights = [8, 7, 6, 5, 4, 3, 2, 1, 8, 8, 8, 8, 8, 8, 8, 8].map(amount => amount / 9)
const fluid = (level, kind = 'water') => [kind, { level: String(level) }]
async function fixture(cells) {
  const bounds = {}, palette = [], blocks = new Map(), ids = new Map()
  for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
    bounds['min' + axis] = Math.min(...cells.map(c => c[i]))
    bounds['max' + axis] = Math.max(...cells.map(c => c[i]))
  }
  for (const [axis, size] of [['X', 'width'], ['Y', 'height'], ['Z', 'depth']]) bounds[size] = bounds['max' + axis] - bounds['min' + axis] + 1
  for (const [x, y, z, name, properties = {}] of cells) {
    const id = JSON.stringify([name, properties])
    if (!ids.has(id)) {
      ids.set(id, palette.length)
      palette.push({ name: 'minecraft:' + name, properties, baked: await resolver.resolve('minecraft:' + name, properties) })
    }
    blocks.set(x - bounds.minX + (z - bounds.minZ) * bounds.width + (y - bounds.minY) * bounds.width * bounds.depth, ids.get(id))
  }
  return { bounds, palette, blocks }
}
async function top(data, x = 0, y = 0, z = 0, filter) {
  const { groups } = await buildFaceGroups(data.palette, data.blocks, data.bounds, null, filter)
  for (const [texture, g] of groups) {
    if (!/^block\/(water|lava)_/.test(texture)) continue
    for (let i = 0; i < g.positions.length; i += 12) {
      const p = Array.from({ length: 4 }, (_, n) => Array.from(g.positions.subarray(i + n * 3, i + n * 3 + 3)))
      const normalY = (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2])
      if (normalY <= 0 || Math.min(...p.map(v => v[0])) !== x || Math.min(...p.map(v => v[2])) !== z || Math.floor(p[0][1]) !== y) continue
      return { texture, heights: p.map(v => v[1] - y + .001), vertices: p, uv: Array.from(g.uvs.subarray(i / 3 * 2, i / 3 * 2 + 8)) }
    }
  }
  return null
}

for (const kind of ['water', 'lava']) for (let level = 0; level < 16; level++) {
  close(fluidHeight(String(level)), ownHeights[level], `${kind} level ${level}`)
  const cells = []
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) cells.push([x, 0, z, ...fluid(level, kind)])
  const data = await fixture(cells), face = await top(data)
  for (const h of face.heights) close(h, ownHeights[level], `${kind} flat interior ${level}`)
  const bakedHeight = Math.max(...data.palette[0].baked.quads.flatMap(q => q.verts.map(v => v[1])))
  close(bakedHeight, ownHeights[level], `${kind} standalone model ${level}`)
}
console.log('PASS all 16 water/lava levels in world geometry and standalone models')

for (const [level, expected] of [[0, 20 / 27], [1, 7 / 27], [7, 1 / 27], [8, 20 / 27]]) {
  const face = await top(await fixture([[-3, -4, -5, ...fluid(level)]]), -3, -4, -5)
  for (const h of face.heights) close(h, expected, 'Open air weights at a negative-coordinate boundary')
}
for (const [name, properties] of [
  ['stone', {}], ['glass', {}], ['smooth_stone_slab', { type: 'bottom' }],
  ['smooth_stone_slab', { type: 'top' }], ['oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' }],
]) {
  const cells = [[0, 0, 0, ...fluid(1)]]
  for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) cells.push([x, 0, z, name, properties])
  const data = await fixture(cells), face = await top(data)
  for (const h of face.heights) close(h, 7 / 9, 'Solid banks exclude their height: ' + name)
  if (name.endsWith('_slab') || name.endsWith('_stairs')) {
    const { groups } = await buildFaceGroups(data.palette, data.blocks, data.bounds)
    assert.ok(groups.get('block/water_flow')?.positions.length, 'Partial banks must not cull every water side')
  }
}
console.log('PASS air-edge slopes, solid banks, glass, slabs and stairs')

const ramp = []
for (let x = 0; x < 8; x++) for (let z = -1; z <= 1; z++) ramp.push([x, 0, z, ...fluid(x)])
const rampData = await fixture(ramp), faces = []
for (let x = 0; x < 8; x++) faces.push(await top(rampData, x))
for (let x = 0; x < 7; x++) {
  close(faces[x].heights[1], faces[x + 1].heights[0], 'Shared south corner')
  close(faces[x].heights[3], faces[x + 1].heights[2], 'Shared north corner')
  assert.ok(faces[x].heights.reduce((a, b) => a + b) > faces[x + 1].heights.reduce((a, b) => a + b), 'The stream descends away from its source')
}
// Eastward flow: these UVs come from the original FluidRenderer's east rotation.
const eastUV = [.25, .25, .25, .75, .75, .25, .75, .75]
assert.equal(faces[3].texture, 'block/water_flow')
faces[3].uv.forEach((v, i) => close(v, eastUV[i], 'Flow direction follows decreasing water height'))

const column = await fixture([[0, 0, 0, ...fluid(8)], [0, 1, 0, ...fluid(8)]])
assert.equal(await top(column), null, 'Same-fluid upper block hides the internal top')
const slice = await top(column, 0, 0, 0, (_x, y) => y === 0)
for (const h of slice.heights) close(h, 20 / 27, 'Hidden upper water is excluded from sliced geometry')
const neighbors = await fixture([[0, 0, 0, ...fluid(1)], [1, 0, 0, ...fluid(8)], [1, 1, 0, ...fluid(8)]])
const raised = await top(neighbors)
close(raised.heights[1], 1, 'A neighboring water column fills its shared south corner')
close(raised.heights[3], 1, 'A neighboring water column fills its shared north corner')
for (const [name, properties] of [['bubble_column', {}], ['oak_slab', { waterlogged: 'true', type: 'bottom' }], ['seagrass', {}]]) {
  const face = await top(await fixture([[0, 0, 0, name, properties]]))
  for (const h of face.heights) close(h, 20 / 27, name + ' behaves as source water')
}
console.log('PASS continuous descending flow, UV direction, falling columns, slices and waterlogged blocks')

// Fog uses the original fluid's own height, rather than the blended render corners.
const holder = { camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), _fogEnabled: true,
  _waterFog: new THREE.Fog(0x050533, -8, 48), _waterFogColor: new THREE.Color(0x050533), _bgColor: 0x172332 }
for (const level of [1, 7, 8]) {
  const data = await fixture([[0, 0, 0, ...fluid(level)]])
  holder._bounds = data.bounds; Renderer.prototype._computeWaterSurface.call(holder, data)
  close(holder._waterSurface.get(0), ownHeights[level], 'Fog threshold')
  holder.camera.position.set(.5, ownHeights[level] - .01, .5)
  Renderer.prototype._updateUnderwaterFog.call(holder); assert.equal(holder.scene.fog, holder._waterFog)
  holder.camera.position.y = ownHeights[level] + .01
  Renderer.prototype._updateUnderwaterFog.call(holder); assert.equal(holder.scene.fog, null)
}
console.log('PASS underwater fog switches at the corrected fluid heights')

const sample = await parseLitematicaRaw(new Uint8Array(gunzipSync(readFileSync('schematics/投影预览测试-水流.litematic'))))
for (const p of sample.palette) p.baked = await resolver.resolve(p.name, p.properties)
const low = [], high = []
for (let x = 2; x <= 8; x++) low.push((await top(sample, x, 1, 1)).heights.reduce((a, b) => a + b) / 4)
for (let x = 6; x <= 9; x++) high.push((await top(sample, x, 5, 1)).heights.reduce((a, b) => a + b) / 4)
assert.ok(low.every((h, i) => i === 0 || h < low[i - 1]), 'Saved lower channel descends toward level 7')
assert.ok(high.every((h, i) => i === 0 || h > high[i - 1]), 'Saved upper channel descends in the opposite direction')
console.log('PASS real water-flow schematic: both channel slopes follow the saved levels')
