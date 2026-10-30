import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { BlockModelResolver } from '../src/blocks.js'
import { bakeModel } from '../src/modelBaker.js'
import { buildFaceGroups } from '../src/geometry.js'
import { CompactFaceData, compactFaceKey, canCompactFaces, readCompactFace } from '../src/compactFaceData.js'
import { CompactFaceMesh } from '../src/compactFaceMesh.js'
import { sourceForIntersection } from '../src/selectionPicking.js'
import { collectSceneResources } from '../src/sceneResources.js'
import { PagedBlockStore, encodeBlockPage, blockPageBytes } from '../src/pagedBlocks.js'

function assertCompactBounds(group, positions) {
  const expected = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(positions, 3))
  assert.deepEqual(group.worldBounds, Float64Array.from([...expected.min.toArray(), ...expected.max.toArray()]),
    'Compact world bounds exactly match the legacy Float32 vertices for unchanged export framing')
  for (let face = 0; face < group.count; face += 4096) {
    const batch = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(positions.subarray(face * 12, (face + 4096) * 12), 3))
    assert.deepEqual(group.faceBounds.subarray(face / 4096 * 6, face / 4096 * 6 + 6),
      Float32Array.from([...batch.min.toArray(), ...batch.max.toArray()]), 'Spatial batches enclose exact original vertices')
  }
  return expected
}

const root = 'public/assets/minecraft/', assets = new AssetProvider(), originalFetch = globalThis.fetch
assets.baseUrl = 'https://compact-faces.test/'
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl))
  const file = root + String(url).slice(assets.baseUrl.length)
  return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 })
}
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
const specs = []
for (const name of ['stone', 'andesite', 'glass', 'slime_block', 'honey_block', 'water', 'lava', 'bubble_column', 'redstone_wire', 'decorated_pot']) {
  specs.push({ name: 'minecraft:' + name, properties: { level: '0', power: '15' } })
}
for (const facing of ['north', 'east', 'south', 'west']) for (const name of ['hopper', 'oak_stairs', 'chest', 'piston', 'oak_wall_sign', 'dragon_wall_head', 'piglin_wall_head']) {
  specs.push({ name: 'minecraft:' + name, properties: { facing, half: 'bottom', shape: 'outer_left', type: 'single', enabled: 'true', extended: 'false', waterlogged: 'false' } })
}
for (let rotation = 0; rotation < 16; rotation++) specs.push({ name: 'minecraft:oak_sign', properties: { rotation: String(rotation) } })
let compared = 0, variants = 0, reused = 0
try {
  for (const xk of [false, true]) {
    assets.packs = xk ? [{ name: 'XK', zip: pack }] : []; assets.clearCaches()
    const resolver = new BlockModelResolver(assets), palette = []
    for (const spec of specs) palette.push({ ...spec, baked: await resolver.resolve(spec.name, spec.properties) })
    // Arbitrary fractional/overhanging pack models and coplanar overlays.
    for (const angle of [22.5, -45, 13.12345]) palette.push({ name: 'minecraft:custom', baked: bakeModel({ textures: { all: 'block/stone' }, elements: [{
      from: [-5, .000001, -3], to: [19, 13.23456, 18], rotation: { axis: 'y', angle, origin: [8, 8, 8] },
      faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all' }])),
    }] }) })
    const blocks = new Map(), width = 32, depth = 32, height = 12
    for (let i = 0; i < 1200; i++) blocks.set((i * 7919) % (width * depth * height), i % palette.length)
    for (const offset of [-8192, -1, 0, 8192, 1_000_000]) {
      const bounds = { minX: offset, minY: offset, minZ: -offset, width, height, depth }
      for (const filter of [null, (_x, y) => y === offset + 3]) {
        const old = await buildFaceGroups(palette, blocks, bounds, null, filter, { trackBlocks: true })
        const next = await buildFaceGroups(palette, blocks, bounds, null, filter, { trackBlocks: true, compactFaces: true })
        assert.equal(old.emitted, next.emitted); assert.deepEqual([...old.groups.keys()], [...next.groups.keys()])
        for (const [key, group] of next.groups) {
          const before = old.groups.get(key)
          if (!group.isCompactFaceData) { assert.deepEqual(group, before); continue }
          assertCompactBounds(group, before.positions)
          assert.deepEqual(group.cells, before.blockKeys, 'Face/source order remains exact')
          const positions = new Float32Array(12), uvs = new Float32Array(8)
          for (let i = 0; i < group.count; i++) {
            readCompactFace(group, i, positions, uvs)
            assert.deepEqual(positions, before.positions.subarray(i * 12, i * 12 + 12), `${xk}/${offset}/${key}/${i}: exact Float32 positions`)
            assert.deepEqual(uvs, before.uvs.subarray(i * 8, i * 8 + 8), 'Exact UVs')
          }
          compared += group.count; variants += group.variants; reused += group.count - group.templateCount
        }
      }
    }
  }
} finally { globalThis.fetch = originalFetch; assets.clearCaches() }
assert.ok(reused > 0)
console.log(`PASS compact geometry: ${compared} exact ordered faces, ${variants} precision-corrected instances, ${reused} reused templates; vanilla/XK, fluids, overhangs, slices and large/negative coordinates`)

const cube = bakeModel({ textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(['up', 'down', 'east', 'west', 'north', 'south'].map(face => [face, { texture: '#all', cullface: face }])),
}] })
const bounds = { minX: -3, minY: -2, minZ: -4, width: 20, height: 2, depth: 3 }
const data = { bounds, blocks: new Map([[0, 0], [2, 0], [19, 0]]), palette: [{ name: 'minecraft:stone', baked: cube }] }
const build = async filter => (await buildFaceGroups(data.palette, data.blocks, bounds, null, filter, { compactFaces: true })).groups.get('block/stone')
const material = new THREE.MeshLambertMaterial(), mesh = new CompactFaceMesh(await build(), material), scene = new THREE.Scene()
scene.add(mesh); scene.updateMatrixWorld(true)
const texture = material.uniforms.compactQuads.value, uniform = material.uniforms.compactQuads
assert.ok(collectSceneResources(scene).retained.has(texture))
for (const x of [-2.5, -.5, 16.5]) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, -1.5, -9), new THREE.Vector3(0, 0, 1))
  const hits = ray.intersectObject(mesh)
  assert.ok(hits.length > 0)
  assert.equal(sourceForIntersection(hits[0], data).key, Math.floor(x) + 3)
  assert.ok(hits[0].uv.toArray().every(Number.isFinite))
}
assert.equal(mesh.clone().compactData, mesh.compactData)
let disposed = 0; texture.addEventListener('dispose', () => disposed++)
mesh.geometry.dispose(); assert.equal(disposed, 1)
const replacement = new CompactFaceMesh(await build(x => x < 0), material)
assert.equal(material.uniforms.compactQuads, uniform, 'Cached shader uniforms survive a layer rebuild')
assert.notEqual(uniform.value, texture)
assert.ok(replacement.geometry.boundingBox.containsPoint(new THREE.Vector3(-3, -2, -4)))
replacement.geometry.dispose(); material.dispose()
console.log('PASS compact mesh picking, bounds, cloning, private texture disposal and cached shader uniform replacement')

// A resource pack may extend far beyond its owning cell. Picking must bound the
// actual Float32 face, including points just outside the original double bounds.
const overhangQuad = {
  verts: [[1_000_000, 0, 0], [1_000_000.06, 0, 0], [1_000_000, 1, 0], [1_000_000.06, 1, 0]],
  uvs: [[0, 0], [1, 0], [0, 1], [1, 1]],
}
const overhangData = new CompactFaceData(1, { minX: 0, minY: 0, minZ: 0, width: 1, height: 1, depth: 1 })
overhangData.write(overhangQuad, 0, 0, 0, 0); overhangData.finish()
const overhang = new CompactFaceMesh(overhangData, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
overhang.updateMatrixWorld(true)
assert.deepEqual(overhang.geometry.boundingBox, assertCompactBounds(overhangData, Float32Array.from(overhangQuad.verts.flat())))
const overhangHits = new THREE.Raycaster(new THREE.Vector3(1_000_000.061, .5, 10), new THREE.Vector3(0, 0, -1)).intersectObject(overhang)
assert.ok(overhangHits.length > 0, 'Outward Float32 rounding remains selectable outside the source model bounds')
overhang.geometry.dispose(); overhang.material.dispose()

// Texture rounding near the signed integer boundary must never reach the GLSL
// integer addition. The exact absolute-coordinate fallback keeps these models.
const extremeQuad = { ...overhangQuad, verts: overhangQuad.verts.map(v => [-(2 ** 31) - 1, v[1], v[2]]) }
const negativeBounds = { minX: -1, minY: 0, minZ: 0, width: 1, height: 1, depth: 1 }
const negative = new CompactFaceData(1, negativeBounds)
negative.write(extremeQuad, -1, 0, 0, 0); negative.finish()
assert.ok(negative.templateIds[0] & 0x80000000, 'Signed integer overflow uses exact absolute coordinates')
const extremePositions = new Float32Array(12), extremeUVs = new Float32Array(8)
readCompactFace(negative, 0, extremePositions, extremeUVs)
assert.deepEqual(extremePositions, Float32Array.from(extremeQuad.verts.flatMap(v => [v[0] - 1, v[1], v[2]])))
console.log('PASS compact picking includes rounded overhangs and extreme shader integer anchors fall back exactly')

// Palace-sized sparse bounds span 8.7 billion cells. A separate uint Y keeps
// their vertices and selection keys exact without expanded legacy geometry.
const palaceBounds = { minX: -2560, minY: -64, minZ: -3328, width: 5120, height: 256, depth: 6656 }
assert.ok(canCompactFaces(palaceBounds, 'block/stone'))
assert.ok(!canCompactFaces({ ...palaceBounds, width: 100_000, depth: 100_000 }, 'block/stone'))
const palaceStride = palaceBounds.width * palaceBounds.depth
const palaceBlocks = new Map([0, 125, 127, 128, 255].map((y, i) => [y * palaceStride + i * 7919, 0]))
const palacePalette = [{ name: 'minecraft:stone', baked: cube }]
const legacyPalace = (await buildFaceGroups(palacePalette, palaceBlocks, palaceBounds, null, null, { trackBlocks: true })).groups.get('block/stone')
const compactPalace = (await buildFaceGroups(palacePalette, palaceBlocks, palaceBounds, null, null, { compactFaces: true })).groups.get('block/stone')
assert.ok(compactPalace.isCompactFaceData && compactPalace.cellYs instanceof Uint32Array)
const palaceBox = assertCompactBounds(compactPalace, legacyPalace.positions)
const palacePositions = new Float32Array(12), palaceUVs = new Float32Array(8)
for (let i = 0; i < compactPalace.count; i++) {
  readCompactFace(compactPalace, i, palacePositions, palaceUVs)
  assert.deepEqual(palacePositions, legacyPalace.positions.subarray(i * 12, i * 12 + 12))
  assert.deepEqual(palaceUVs, legacyPalace.uvs.subarray(i * 8, i * 8 + 8))
  assert.equal(compactFaceKey(compactPalace, i), legacyPalace.blockKeys[i])
}
const palaceMesh = new CompactFaceMesh(compactPalace, new THREE.MeshLambertMaterial())
palaceMesh.updateMatrixWorld(true)
assert.deepEqual(palaceMesh.geometry.boundingBox, palaceBox)
assert.ok(palaceMesh.geometry.getAttribute('compactCellY'))
assert.equal(palaceMesh.geometry.getAttribute('compactCellY').gpuType, THREE.IntType)
for (const key of palaceBlocks.keys()) {
  const x = key % palaceBounds.width + palaceBounds.minX
  const y = Math.floor(key / palaceStride) + palaceBounds.minY
  const z = Math.floor(key / palaceBounds.width) % palaceBounds.depth + palaceBounds.minZ
  const hits = new THREE.Raycaster(new THREE.Vector3(x + .5, y + .5, z - 2), new THREE.Vector3(0, 0, 1)).intersectObject(palaceMesh)
  assert.ok(hits.length > 0)
  assert.equal(sourceForIntersection(hits[0], { bounds: palaceBounds, blocks: palaceBlocks }).key, key)
}
const palaceShader = { uniforms: {}, vertexShader: '#include <common>\n#include <uv_vertex>\n#include <begin_vertex>' }
palaceMesh.material.onBeforeCompile(palaceShader)
assert.ok(palaceShader.vertexShader.startsWith('#define COMPACT_SEPARATE_Y\n'))
assert.notEqual(palaceMesh.material.customProgramCacheKey(), replacement.material.customProgramCacheKey())
palaceMesh.geometry.dispose(); palaceMesh.material.dispose()
console.log('PASS compact Palace-sized bounds above 2^32 cells: exact vertices, UVs, full selection keys and separate shader variant')

// Enforce the texture budget while interning, before a pathological pack can
// accumulate an unbounded template map during the entire geometry build.
const saturated = new CompactFaceData(1, negativeBounds)
saturated.intern(new Float32Array(32))
saturated.templates.length = 1024 * 2048 / 8
assert.equal(saturated.intern(new Float32Array(32)), 0, 'Existing templates remain reusable at the budget')
const distinctTemplate = new Float32Array(32); distinctTemplate[0] = 1
assert.throws(() => saturated.intern(distinctTemplate), error => error.code === 'FILE_TOO_LARGE' && error.reason === 'geometry')
assert.equal(saturated.lookup.size, 1, 'Reject new templates before retaining them')
console.log('PASS compact template memory limit is checked during interning')

// Region boundaries are storage boundaries only. Solid culling, water heights,
// glass overlays and slices still consult the complete world and retain Map order.
const seamBounds = { minX: -2, minY: -1, minZ: -1, width: 8, height: 2, depth: 3 }
const seamPalette = [{ name: 'minecraft:stone', baked: cube },
  { name: 'minecraft:water', properties: { level: '0' }, baked: cube }, { name: 'minecraft:glass', baked: cube }]
const seamMap = new Map()
const seamRegions = [[-2, 4], [2, 4], [0, 3]].map(([minX, width], ri) => {
  const volume = width * 2 * 3, values = Uint32Array.from({ length: volume }, (_, i) => (i + ri * 2) % 4)
  const page = encodeBlockPage(values), counts = new Float64Array(3)
  for (let i = 0; i < volume; i++) if (values[i]) {
    counts[values[i] - 1]++
    const x = minX - seamBounds.minX + i % width, y = Math.floor(i / (width * 3)), z = Math.floor(i / width) % 3
    seamMap.set(x + z * seamBounds.width + y * seamBounds.width * seamBounds.depth, values[i] - 1)
  }
  return { minX, minY: -1, minZ: -1, maxX: minX + width - 1, maxY: 0, maxZ: 1, width, height: 2, depth: 3,
    localToGlobal: [0, 1, 2], states: { volume, pages: [page], counts, count: counts.reduce((a, b) => a + b, 0), bytes: blockPageBytes(page) } }
})
const seamPaged = new PagedBlockStore(seamRegions, seamBounds, seamPalette.length)
assert.deepEqual([...seamPaged], [...seamMap])
for (const filter of [null, (_x, y) => y === -1, x => x >= 0 && x <= 3]) {
  const baseline = await buildFaceGroups(seamPalette, seamMap, seamBounds, null, filter, { trackBlocks: true })
  const pagedGeometry = await buildFaceGroups(seamPalette, seamPaged, seamBounds, null, filter, { trackBlocks: true })
  assert.deepEqual(pagedGeometry, baseline, 'Cross-region culling and fluids match the original Map')
  const compactGeometry = await buildFaceGroups(seamPalette, seamPaged, seamBounds, null, filter, { compactFaces: true, trackBlocks: true })
  for (const [key, group] of compactGeometry.groups) {
    const before = baseline.groups.get(key)
    if (!group.isCompactFaceData) { assert.deepEqual(group, before); continue }
    assertCompactBounds(group, before.positions)
    for (let i = 0; i < group.count; i++) {
      readCompactFace(group, i, palacePositions, palaceUVs)
      assert.deepEqual(palacePositions, before.positions.subarray(i * 12, i * 12 + 12))
      assert.deepEqual(palaceUVs, before.uvs.subarray(i * 8, i * 8 + 8))
      assert.equal(compactFaceKey(group, i), before.blockKeys[i])
    }
  }
}
console.log('PASS paged region seams, overlaps, stone/water/glass culling and slices match Map geometry exactly')
