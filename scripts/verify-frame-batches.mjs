// Compare expanded GPU instances against the existing individual-frame renderer.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh } from '../src/entities.js'
import { Renderer } from '../src/renderer.js'

const root = 'public/assets/minecraft/', baseUrl = 'https://frame-batches.test/'
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
const originalFetch = globalThis.fetch
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(baseUrl), 'Tests must not access the network')
  const path = root + String(url).slice(baseUrl.length)
  return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 })
}
function provider(withPack = false) {
  const assets = new AssetProvider(); assets.baseUrl = baseUrl
  if (withPack) assets.addPack(pack, 'XK')
  assets._getTexture = async key => {
    const path = 'textures/' + key + '.png'
    const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
    if (!entry && !existsSync(root + path)) return null
    const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
    const texture = new THREE.Texture(); texture.name = key
    texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    return texture
  }
  return assets
}
function renderer() {
  const value = Object.create(Renderer.prototype)
  value.scene = new THREE.Scene()
  for (const key of ['group', 'entitiesGroup', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup']) {
    value[key] = new THREE.Group(); value.scene.add(value[key])
  }
  return value
}
const item = (id, data = {}) => ({ id: 'minecraft:' + id, count: 1, ...data })
const position = i => [2 + i % 10, 2 + Math.floor(i / 10) % 10, 2 + Math.floor(i / 100)]
const frame = (value, i, options = {}) => ({
  id: 'minecraft:' + (options.id || 'item_frame'), pos: options.pos || position(i), rotation: [0, 0],
  nbt: { Facing: options.facing ?? i % 6, ItemRotation: options.rotation ?? i % 8, Item: value, ...options.nbt },
})
const logicalRoots = view => view.entitiesGroup.children.filter(o => o.userData.entityHitbox)
const batches = view => view.entitiesGroup.children.filter(o => o.isInstancedMesh)
const matrixTextures = new WeakMap()
function matrixTexture(batch) {
  if (!matrixTextures.has(batch)) {
    const shader = { uniforms: {}, vertexShader: '#include <project_vertex>\n#include <defaultnormal_vertex>' }
    batch.material.onBeforeCompile(shader)
    assert.ok(shader.uniforms.frameViewMatrices?.value?.isDataTexture, 'Instanced shaders must use precise per-instance view matrices')
    assert.ok(!shader.vertexShader.includes('#include <project_vertex>') && !shader.vertexShader.includes('#include <defaultnormal_vertex>'))
    matrixTextures.set(batch, shader.uniforms.frameViewMatrices.value)
  }
  return matrixTextures.get(batch)
}
const materialState = m => JSON.stringify({ type: m.type, color: m.color.toArray(), map: m.map?.uuid, side: m.side, alphaTest: m.alphaTest,
  transparent: m.transparent, opacity: m.opacity, blending: m.blending, flatShading: m.flatShading, vertexColors: m.vertexColors,
  depthWrite: m.depthWrite, depthTest: m.depthTest, toneMapped: m.toneMapped, premultipliedAlpha: m.premultipliedAlpha })
function geometryState(geometry) {
  const hash = createHash('sha256')
  for (const attribute of [...Object.values(geometry.attributes), geometry.index]) {
    hash.update(new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength))
  }
  return hash.digest('hex')
}
function expanded(root) {
  root.updateMatrixWorld(true)
  const entries = []
  root.traverseVisible(mesh => {
    if (!mesh.isMesh) return
    if (mesh.isInstancedMesh) {
      for (let i = 0; i < mesh.count; i++) {
        const instance = new THREE.Matrix4(); mesh.getMatrixAt(i, instance)
        entries.push({ mesh, geometry: mesh.geometry, material: mesh.material, instance, instanceIndex: i, world: mesh.matrixWorld.clone().multiply(instance) })
      }
    } else entries.push({ mesh, geometry: mesh.geometry, material: mesh.material, world: mesh.matrixWorld.clone() })
  })
  return entries
}
function ordered(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = entry.geometry.uuid + ':' + materialState(entry.material)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  const axes = [12, 13, 14, 0, 1, 2, 4, 5, 6, 8, 9, 10]
  for (const values of groups.values()) values.sort((a, b) => {
    for (const axis of axes) {
      const delta = Math.round(a.world.elements[axis] * 1000) - Math.round(b.world.elements[axis] * 1000)
      if (delta) return delta
    }
    return 0
  })
  return groups
}
let vertices = 0, maxWorldError = 0, maxGPUError = 0
const f = Math.fround
function multiplyFloat(matrix, v) {
  return Array.from({ length: 4 }, (_, row) => {
    let value = f(matrix[row] * v[0])
    for (let column = 1; column < 4; column++) value = f(value + f(matrix[column * 4 + row] * v[column]))
    return value
  })
}
function compare(actualEntries, expectedEntries, label, camera = null) {
  const actual = ordered(actualEntries), expected = ordered(expectedEntries)
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), label + ': preserve geometry references and material properties')
  if (camera) for (const mesh of new Set(actualEntries.map(e => e.mesh))) if (mesh.isInstancedMesh) mesh.onBeforeRender({}, null, camera)
  const a = new THREE.Vector3(), b = new THREE.Vector3()
  for (const [key, wanted] of expected) {
    const got = actual.get(key)
    assert.equal(got.length, wanted.length, label + ': preserve mesh/instance count')
    for (let i = 0; i < wanted.length; i++) {
      const target = wanted[i], value = got[i], attr = target.geometry.attributes.position
      const view = camera && (value.instance
        ? matrixTexture(value.mesh).image.data.subarray(value.instanceIndex * 32, value.instanceIndex * 32 + 16)
        : new Float32Array(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, value.mesh.matrixWorld).elements))
      const expectedView = camera && new Float32Array(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, target.world).elements)
      if (camera && value.instance) {
        const normal = new Float32Array(new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, target.world)).elements)
        const pixels = matrixTexture(value.mesh).image.data, offset = value.instanceIndex * 32 + 16
        for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++) {
          assert.equal(pixels[offset + column * 4 + row], normal[column * 3 + row], 'Lighting normal matrices must match the individual mesh exactly')
        }
      }
      for (let p = 0; p < attr.count; p++) {
        a.fromBufferAttribute(attr, p).applyMatrix4(value.world)
        b.fromBufferAttribute(attr, p).applyMatrix4(target.world)
        const error = a.distanceTo(b); maxWorldError = Math.max(maxWorldError, error)
        assert.ok(error < 3e-6, `${label}: vertex ${p} world error ${error}`)
        if (camera) {
          let gpu = [attr.getX(p), attr.getY(p), attr.getZ(p), 1]
          gpu = multiplyFloat(view, gpu)
          const original = multiplyFloat(expectedView, [attr.getX(p), attr.getY(p), attr.getZ(p), 1])
          const gpuError = Math.hypot(...gpu.slice(0, 3).map((n, axis) => n - original[axis]))
          maxGPUError = Math.max(maxGPUError, gpuError)
          assert.ok(gpuError < 2e-5, `${label}: camera-relative GPU vertex error ${gpuError}`)
        }
        vertices++
      }
    }
  }
}
async function baseline(entities, assets) {
  const root = new THREE.Group()
  root.add(...await Promise.all(entities.map(entity => buildEntityMesh(entity, assets))))
  root.updateMatrixWorld(true)
  return root
}
function assertFrozen(root) {
  root.traverse(o => {
    assert.equal(o.matrixAutoUpdate, false, 'Static frame local matrices must be frozen')
    assert.equal(o.matrixWorldAutoUpdate, false, 'Static frame world matrices must be frozen')
  })
}
function verifyCleanup(view) {
  const counts = new Map(), maps = new Set()
  view.entitiesGroup.traverse(o => {
    for (const resource of [o.isInstancedMesh ? o : null, o.isInstancedMesh ? matrixTexture(o) : null, o.geometry, ...[o.material].flat()]) {
      if (!resource || counts.has(resource)) continue
      counts.set(resource, 0)
      resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1))
    }
    for (const material of [o.material].flat()) if (material?.map) maps.add(material.map)
  })
  let textureDisposals = 0
  for (const map of maps) map.addEventListener('dispose', () => textureDisposals++)
  view.clearEntities()
  assert.equal(view.entitiesGroup.children.length, 0)
  assert.ok([...counts.values()].every(n => n === 1), 'Clear must dispose each instance buffer, geometry and material once')
  assert.equal(textureDisposals, 0, 'Clear must retain provider-owned texture objects')
  view.clearEntities()
  assert.ok([...counts.values()].every(n => n === 1), 'An empty clear must not dispose resources again')
}
function verifyStableView(view, camera) {
  for (const batch of batches(view).filter(o => o.visible)) {
    batch.onBeforeRender({}, null, camera)
    const texture = matrixTexture(batch), version = texture.version
    batch.onBeforeRender({}, null, camera)
    assert.equal(texture.version, version, 'Unchanged cameras and visible instances must not upload matrices again')
  }
}

const sherds = ['angler', 'archer', 'arms_up', 'skull'].map(id => 'minecraft:' + id + '_pottery_sherd')
const variants = [item('stone'), item('diamond'), item('copper_chest'), item('waxed_copper_chest'),
  ...['standing', 'running', 'sitting', 'star'].map(pose => item('copper_golem_statue', { components: { 'minecraft:block_state': { copper_golem_pose: pose } } })),
  item('waxed_copper_golem_statue'), item('decorated_pot'),
  item('decorated_pot', { components: { 'minecraft:pot_decorations': Object.fromEntries(['back', 'left', 'right', 'front'].map((side, i) => [side, sherds[i]])) } }),
  item('decorated_pot', { tag: { BlockEntityTag: { sherds: sherds.toReversed() } } }),
  item('potion', { tag: { CustomPotionColor: 0xff0000 } }), item('potion', { tag: { CustomPotionColor: 0x00ff00 } }),
  item('red_banner'), item('shulker_box'), item('red_bed'), item('skeleton_skull'),
]

try {
  for (const withPack of [false, true]) {
    const assets = provider(withPack), view = renderer(), label = withPack ? 'XK' : 'vanilla'
    const entities = Array.from({ length: 1000 }, (_, i) => frame(item('stone'), i))
    const original = await baseline(entities, assets)
    await view.renderEntities(entities, assets)
    assert.equal(logicalRoots(view).length, 1000, 'Keep one logical root per frame for filtering and hitboxes')
    assert.equal(batches(view).length, 3, label + ': 1000 frames in one chunk must use three draw nodes')
    assert.ok(batches(view).every(batch => batch.count === 1000))
    compare(expanded(view.entitiesGroup), expanded(original), label + ' 1000 frames')
    for (const object of view.entitiesGroup.children) assertFrozen(object)
    verifyCleanup(view)

    await view.renderEntities(Array.from({ length: 1300 }, (_, i) => frame(item('stone'), i % 1000)), assets)
    assert.equal(batches(view).length, 6, 'Large same-chunk groups must split into bounded batches')
    assert.deepEqual(batches(view).map(b => b.count).sort((a, b) => a - b), [276, 276, 276, 1024, 1024, 1024])
    assert.ok(batches(view).every(b => matrixTexture(b).image.height <= 1024), 'Matrix textures must respect the batch capacity')
    verifyCleanup(view)

    const varied = []
    for (const value of variants) for (let facing = 0; facing < 6; facing++) for (let rotation = 0; rotation < 8; rotation++) {
      varied.push(frame(value, varied.length, { facing, rotation, id: varied.length % 2 ? 'glow_item_frame' : 'item_frame' }))
    }
    const full = await baseline(varied, assets), before = expanded(full)
    const geometries = new Map(before.map(e => [e.geometry, geometryState(e.geometry)]))
    const materials = new Map(before.map(e => [e.material, materialState(e.material)]))
    await view.renderEntities(varied, assets)
    assert.ok(batches(view).length < before.length / 10, label + ': repeated special items must reduce draw nodes')
    compare(expanded(view.entitiesGroup), before, label + ' six faces / eight rotations / special items')
    for (const [geometry, state] of geometries) assert.equal(geometryState(geometry), state, 'Batching must not edit geometry, UVs, normals or indices')
    for (const [material, state] of materials) assert.equal(materialState(material), state, 'Batching must preserve item colors, textures and render state')

    const layerCamera = new THREE.PerspectiveCamera(45, 1, .1, 100)
    layerCamera.position.set(18, 17, 20); layerCamera.lookAt(7, 7, 7); layerCamera.updateMatrixWorld(true)
    verifyStableView(view, layerCamera)
    for (const [mode, layer] of [['single', 5], ['below', 4], ['above', 8], ['single', -1], ['all', 0]]) {
      const versions = new Map(batches(view).map(b => [b, matrixTexture(b).version]))
      view.setLayerVisibility(mode, layer)
      const visible = y => mode === 'single' ? y === layer : mode === 'below' ? y <= layer : mode === 'above' ? y >= layer : true
      full.children.forEach((object, i) => { object.visible = visible(Math.floor(varied[i].pos[1])) })
      compare(expanded(view.entitiesGroup), expanded(full), label + ' layer ' + mode, layerCamera)
      assert.ok(batches(view).every(batch => batch.visible === (batch.count > 0)), 'Empty batches must be hidden')
      for (const batch of batches(view).filter(o => o.visible)) assert.ok(matrixTexture(batch).version > versions.get(batch), 'Layer changes must refresh visible view-matrix records')
      verifyStableView(view, layerCamera)
    }
    view.setEntityHitboxesVisible(true)
    view.scene.updateMatrixWorld(true)
    const roots = logicalRoots(view)
    roots.forEach((object, i) => {
      const hitbox = object.getObjectByName('entity-hitbox')
      assert.ok(hitbox?.visible, 'Every batched frame must retain its own F3+B overlay')
      assert.ok(new THREE.Vector3().setFromMatrixPosition(hitbox.matrixWorld).distanceTo(new THREE.Vector3(...varied[i].pos)) < 1e-8)
    })
    view.setEntitiesVisible(false)
    view.setLayerVisibility('single', 5)
    assert.equal(expanded(view.entitiesGroup).length, 0, 'Layer filtering must preserve the global entity toggle')
    let hitboxes = 0; view.entitiesGroup.traverseVisible(o => { if (o.userData.isEntityHitbox) hitboxes++ })
    assert.equal(hitboxes, 0)
    view.setEntitiesVisible(true)
    view.entitiesGroup.traverseVisible(o => { if (o.userData.isEntityHitbox) hitboxes++ })
    assert.equal(hitboxes, varied.filter(e => Math.floor(e.pos[1]) === 5).length, 'Hitboxes follow the same saved layer as their batched instances')
    view.setEntityHitboxesVisible(false)
    verifyCleanup(view)

    // A nonzero negative/positive chunk origin must survive freezing, and must stay outside float32 instance translations.
    view.setLayerVisibility('all', 0)
    for (const offset of [[80, -64, -97], [29999980, 320, -29999980], [-29999980, -64, 29999980]]) {
      const far = Array.from({ length: 96 }, (_, i) => frame(variants[i % variants.length], i, {
        facing: i % 6, rotation: i % 8, pos: [offset[0] + 2 + i % 8 + .123456789, offset[1] + 2 + Math.floor(i / 8) + .987654321, offset[2] + .234567891],
      }))
      const reference = await baseline(far, assets)
      await view.renderEntities(far, assets)
      assert.ok(batches(view).length, 'Far-away fixtures must actually exercise instancing')
      for (const batch of batches(view)) for (let i = 0; i < batch.count; i++) {
        const matrix = new THREE.Matrix4(); batch.getMatrixAt(i, matrix)
        assert.ok(matrix.elements.slice(12, 15).every(n => Math.abs(n) <= 32), 'Instance translations must remain chunk-relative')
      }
      const camera = new THREE.PerspectiveCamera(45, 1, .1, 100)
      camera.position.set(offset[0] + 9, offset[1] + 12, offset[2] + 18)
      camera.lookAt(new THREE.Vector3(offset[0] + 6, offset[1] + 6, offset[2]))
      camera.updateMatrixWorld(true)
      compare(expanded(view.entitiesGroup), expanded(reference), label + ' far ' + offset, camera)
      verifyStableView(view, camera)
      const versions = new Map(batches(view).map(b => [b, matrixTexture(b).version]))
      camera.position.x += .25; camera.updateMatrixWorld(true)
      compare(expanded(view.entitiesGroup), expanded(reference), label + ' moved camera ' + offset, camera)
      for (const batch of batches(view)) assert.ok(matrixTexture(batch).version > versions.get(batch), 'Camera movement must refresh view matrices')
      verifyStableView(view, camera)
      verifyCleanup(view)
    }

    const replacement = new JSZip().file('assets/minecraft/items/stone.json', JSON.stringify({ model: { type: 'minecraft:model', model: 'minecraft:block/diamond_block' } }))
    const rebuilt = entities.slice(0, 100)
    assets.addPack(replacement, 'replacement')
    // Give the replacement priority over XK.
    assets.movePack('replacement', -1)
    view.setLayerVisibility('single', 5)
    const packReference = await baseline(rebuilt, assets)
    packReference.children.forEach((o, i) => { o.visible = Math.floor(rebuilt[i].pos[1]) === 5 })
    await view.renderEntities(rebuilt, assets)
    compare(expanded(view.entitiesGroup), expanded(packReference), label + ' pack rebuild retains active layer')
    assert.ok(expanded(view.entitiesGroup).some(e => e.material.map?.name === 'block/diamond_block'))
    verifyCleanup(view)

    view.setLayerVisibility('all', 0)
    const mixed = [frame(item('stone'), 0), frame(item('stone'), 1),
      { id: 'minecraft:pig', pos: [4, 4, 4], rotation: [0, 0], nbt: { Health: 20 } },
      frame(item('stone'), 4, { nbt: { Passengers: [{ id: 'minecraft:pig', Health: 20, Pos: [4, 4, 4], Rotation: [0, 0] }] } }),
    ]
    await view.renderEntities(mixed, assets)
    const mixedRoots = logicalRoots(view)
    for (const object of mixedRoots.slice(0, 2)) assertFrozen(object)
    for (const object of mixedRoots.slice(2)) object.traverse(o => {
      assert.equal(o.matrixAutoUpdate, true, 'Animated entities and passenger trees must retain local matrix updates')
      assert.equal(o.matrixWorldAutoUpdate, true, 'Animated entities and passenger trees must retain world matrix updates')
    })
    assert.ok(mixedRoots[3].getObjectByName('passenger-0'), 'Passenger frames must preserve their original hierarchy')
    let animated = 0
    for (const object of mixedRoots.slice(2)) object.traverse(o => {
      if (!o.userData.updateAnimation) return
      o.userData.updateAnimation(37); o.updateWorldMatrix(true, true); o.skeleton?.update(); animated++
    })
    assert.ok(animated >= 2, 'Both ordinary and passenger mobs must still animate')
    verifyCleanup(view)
    assets.clearCaches()
  }
  console.log(`PASS frame batches: vanilla/XK 1000 frames -> 3 draw nodes, ${vertices} world/GPU vertices, six faces/eight rotations/special item variants, layers/hitboxes/pack rebuild/cleanup and dynamic passengers; max world error ${maxWorldError.toExponential(2)}, GPU error ${maxGPUError.toExponential(2)} blocks`)
} finally {
  globalThis.fetch = originalFetch
}
