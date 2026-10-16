import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { updateArmorGlintMatrix, applyArmorGlint, trimmedArmorGlint } from '../src/equipmentGlint.js'
import { buildEntityMesh } from '../src/entities.js'
import { collectSceneResources } from '../src/sceneResources.js'

// Independent TextureTransform.setupGlintTexturing reference, including both
// period boundaries and the millisecond-to-tick conversion used by preview/export.
const times = [0, 1, 30, 149.999, 150, 150.001, 549.999, 550, 550.001, 1650, 12345.678]
let samples = 0
for (const age of times) {
  const matrix = new THREE.Matrix3(); updateArmorGlintMatrix(matrix, age)
  const time = Math.trunc(age * 200), angle = Math.PI / 18
  for (const [u, v] of [[0, 0], [.125, .25], [.9, .75], [1, 1]]) {
    const expected = new THREE.Vector2(.16 * (u * Math.cos(angle) - v * Math.sin(angle)) - time % 110000 / 110000,
      .16 * (u * Math.sin(angle) + v * Math.cos(angle)) + time % 30000 / 30000)
    assert.ok(new THREE.Vector2(u, v).applyMatrix3(matrix).distanceTo(expected) < 1e-12)
    samples++
  }
}

const source = new THREE.Texture(), material = new THREE.MeshLambertMaterial()
source.colorSpace = THREE.SRGBColorSpace; source.magFilter = source.minFilter = THREE.NearestFilter
const before = source.toJSON()
applyArmorGlint(material, source)
assert.equal(material.glintMap.source, source.source, 'Keep resource-pack source ownership')
assert.equal(material.glintMap.minFilter, THREE.LinearFilter, 'Vanilla glint texture metadata requests blur')
assert.equal(material.glintMap.colorSpace, THREE.NoColorSpace, 'Glint samples use the original encoded RGB')
material.userData.updateGlint(150)
assert.deepEqual(source.toJSON(), before, 'Glint must not mutate shared texture transforms, filters or color space')
let disposed = 0; material.glintMap.addEventListener('dispose', () => disposed++)
material.dispose(); material.dispose()
assert.equal(disposed, 1, 'The material owns and releases its cloned glint texture exactly once')
const overlay = trimmedArmorGlint(source, { blur: false })
assert.equal(overlay.glintMap.minFilter, THREE.NearestFilter, 'Resource packs can opt out of blur')
assert.equal(overlay.depthFunc, THREE.EqualDepth, 'Trim glint cannot fill armor cutouts or shine through occluders')
assert.equal(overlay.depthWrite, false)
assert.equal(overlay.blendSrc, THREE.SrcColorFactor)
assert.equal(overlay.blendDst, THREE.OneFactor)
assert.equal(overlay.blendSrcAlpha, THREE.ZeroFactor)
assert.equal(overlay.blendDstAlpha, THREE.OneFactor, 'Glint must preserve alpha in transparent exports')
assert.equal(overlay.forceSinglePass, true, 'Do not add the glow twice on double-sided armor')
overlay.dispose()

const root = 'public/assets/minecraft/', textures = new Map()
const assets = {
  async getJSON(path) { return existsSync(root + path) ? JSON.parse(readFileSync(root + path, 'utf8')) : null },
  async getTexture(key) {
    if (!textures.has(key)) {
      const png = readFileSync(root + 'textures/' + key + '.png'), texture = new THREE.Texture()
      texture.name = key; texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      textures.set(key, texture)
    }
    return textures.get(key)
  },
}
const enchanted = id => ({ id: 'minecraft:' + id, count: 1, components: { 'minecraft:enchantment_glint_override': true } })
const cases = [
  ['armor_stand', { head: enchanted('chainmail_helmet'), chest: enchanted('leather_chestplate'), legs: enchanted('diamond_leggings'), feet: enchanted('netherite_boots') }],
  ['zombie', { chest: enchanted('elytra') }],
  ['horse', { body: enchanted('diamond_horse_armor') }],
  ['wolf', { body: enchanted('wolf_armor') }],
]
let layers = 0
for (const [id, equipment] of cases) {
  const object = await buildEntityMesh({ id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt: { Health: 20, equipment } }, assets)
  const meshes = []; object.traverse(mesh => { if (mesh.material?.glintMap) meshes.push(mesh) })
  assert.equal(meshes.length, Object.keys(equipment).length)
  const used = collectSceneResources(object)
  for (const mesh of meshes) {
    assert.ok(used.retained.has(mesh.material.glintMap), 'Resource tracking must see shader-owned glint textures')
    mesh.userData.animationAge = 37
    mesh.onBeforeRender()
    const expected = mesh.material.glintMap.matrix.clone()
    for (const age of [0, 1500, 25, 37]) { mesh.userData.animationAge = age; mesh.onBeforeRender() }
    assert.ok(mesh.material.glintMap.matrix.equals(expected), 'Pause, seek and export must not accumulate texture transforms')
    delete mesh.userData.animationAge
    layers++
  }
  const renderer = { info: { render: { frame: 9 } } }
  for (const mesh of meshes) mesh.onBeforeRender(renderer)
  for (const mesh of meshes) assert.ok(mesh.material.glintMap.matrix.equals(meshes[0].material.glintMap.matrix), 'All armor slots must share the same glint phase')
  object.traverse(mesh => { mesh.geometry?.dispose(); mesh.material?.dispose() })
}
console.log(`PASS equipment glint: ${samples} source-derived UV samples, ${layers} equipped layers, pack filtering, shader texture ownership, trim blend/depth/alpha and deterministic preview/export animation`)
