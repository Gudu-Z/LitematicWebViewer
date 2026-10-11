// 展示框尺寸回归：使用资源中的 fixed 变换与独立矩阵计算预期顶点，不读取生产 holder 的缩放。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh, buildGuiItem } from '../src/entities.js'
import { EXTRA_MODELS } from '../src/extraEntityModels.js'

const root = 'public/assets/minecraft/'
const pack = await JSZip.loadAsync(readFileSync('resourcepacks/XK redstone display 26.3.0.zip'))
const assets = new AssetProvider(), oldFetch = globalThis.fetch
assets.baseUrl = 'https://frame-items.test/'
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith(assets.baseUrl), '不得访问网络')
  const file = root + String(url).slice(assets.baseUrl.length)
  return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 })
}
assets._getTexture = async key => {
  const path = 'textures/' + key + '.png'
  const entry = assets.packs.map(p => p.zip.file('assets/minecraft/' + path)).find(Boolean)
  if (!entry && !existsSync(root + path)) return null
  const png = entry ? await entry.async('nodebuffer') : readFileSync(root + path)
  const texture = new THREE.Texture(); texture.name = key
  texture.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  return texture
}
const DEG = Math.PI / 180, EPS = 2e-6
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z)
const S = (x, y = x, z = x) => new THREE.Matrix4().makeScale(x, y, z)
const R = (angles, order = 'XYZ', factor = DEG) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...angles.map(v => v * factor), order))
const vector = a => new THREE.Vector3(...a)
const corners = (from, to) => [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => vector([x ? to[0] : from[0], y ? to[1] : from[1], z ? to[2] : from[2]]))))
const boxes = list => list.flatMap(([from, to]) => corners(from, to).map(v => v.multiplyScalar(1 / 16)))
const near = (actual, expected, label) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < EPS, `${label}[${i}]: ${v} != ${expected[i]}`))
const dispose = object => object.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose() } })

async function model(path, parents = 0) {
  assert.ok(parents < 20)
  const own = await assets.getJSON('models/' + path.replace(/^minecraft:/, '') + '.json')
  if (!own) return {}
  const parent = own.parent ? await model(own.parent, parents + 1) : {}
  return { ...parent, ...own, textures: { ...parent.textures, ...own.textures }, display: { ...parent.display, ...own.display } }
}
function definition(def, pose, transforms = []) {
  if (!def) return []
  transforms = def.transformation ? [...transforms, def.transformation] : transforms
  if (def.type === 'minecraft:select') {
    const selected = def.property === 'minecraft:block_state' ? pose : 'fixed'
    return definition(def.cases?.find(c => [c.when].flat().includes(selected))?.model || def.fallback, pose, transforms)
  }
  if (def.type === 'minecraft:condition') return definition(def.on_false, pose, transforms)
  if (def.type === 'minecraft:range_dispatch') return definition(def.fallback, pose, transforms)
  if (def.type === 'minecraft:composite') return def.models.flatMap(d => definition(d, pose, transforms))
  return [{ ...def, transforms }]
}
function localTransform(value) {
  const result = T(...(value.translation || [0, 0, 0]))
  if (value.left_rotation) result.multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...value.left_rotation)))
  result.multiply(S(...(value.scale || [1, 1, 1])))
  if (value.right_rotation) result.multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...value.right_rotation)))
  return result
}
function fixedMatrix(display = {}) {
  return T(...(display.translation || [0, 0, 0]).map(v => v / 16))
    .multiply(R(display.rotation || [0, 0, 0])).multiply(S(...(display.scale || [1, 1, 1]))).multiply(T(-.5, -.5, -.5))
}
function jsonPoints(m) {
  return (m.elements || []).flatMap(element => {
    // XK 的反向黄色外壳不属于铜制品本体，避免把加粗描边当作尺寸误差。
    const texture = face => {
      let key = face.texture
      for (let i = 0; i < 20 && key?.startsWith('#'); i++) key = m.textures[key.slice(1)]
      return key?.replace(/^minecraft:/, '')
    }
    if (Object.values(element.faces || {}).every(f => texture(f) === 'block/waxed_block')) return []
    const points = corners(element.from, element.to)
    if (element.rotation) {
      const { origin, axis, angle, rescale } = element.rotation, angles = [0, 0, 0]
      angles['xyz'.indexOf(axis)] = angle
      const scale = [1, 1, 1].map((n, i) => rescale && i !== 'xyz'.indexOf(axis) ? 1 / Math.cos(angle * DEG) : n)
      const matrix = T(...origin).multiply(R(angles)).multiply(S(...scale)).multiply(T(...origin.map(v => -v)))
      points.forEach(p => p.applyMatrix4(matrix))
    }
    return points.map(p => p.multiplyScalar(1 / 16))
  })
}
function statuePoints(pose) {
  // ModelPart 的像素坐标与 rotationZYX，独立于 compileModel / buildFrameItem。
  // 官方 statue item 特殊模型进入 display 前为 (.5 - x/16, y/16, .5 - z/16)。
  const result = []
  const walk = (parts, parent) => {
    for (const part of Object.values(parts)) {
      const matrix = parent.clone().multiply(T(...(part.pivot || [0, 0, 0]))).multiply(R(part.rot || [0, 0, 0], 'ZYX', 1))
      for (const c of part.cuboids || []) {
        const dil = c.dil || [0, 0, 0], from = [c.x, c.y, c.z].map((v, i) => v - dil[i])
        const to = [c.x + c.dx, c.y + c.dy, c.z + c.dz].map((v, i) => v + dil[i])
        for (const p of corners(from, to)) {
          p.applyMatrix4(matrix)
          result.push(vector([.5 - p.x / 16, p.y / 16, .5 - p.z / 16]))
        }
      }
      walk(part.children || {}, matrix)
    }
  }
  walk(EXTRA_MODELS['CopperStatue_' + pose].parts, new THREE.Matrix4())
  return result
}
function specialPoints(special) {
  switch (special.type) {
    case 'minecraft:chest': return boxes([[[1, 0, 1], [15, 10, 15]], [[1, 9, 1], [15, 14, 15]], [[7, 7, 15], [9, 11, 16]]])
    case 'minecraft:copper_golem_statue': return statuePoints(special.pose)
    // 原版 skull 经 item 的 Rx(180) 后位于 y=0..8；fixed +4px 与 T(-.5) 抵消，最终居中。
    case 'minecraft:head': return boxes([[[4, 0, 4], [12, 8, 12]]])
    // items/shulker_box 的 .9995 缩放已包含在下列范围内。
    case 'minecraft:shulker_box': return corners([.00025, .00025, .00025], [.99975, .99975, .99975])
    case 'minecraft:decorated_pot': return boxes([[[4, 17, 4], [12, 20, 12]], [[5, 16, 5], [11, 17, 11]], [[1, 0, 1], [15, 16, 15]]])
    default: throw new Error('无独立预期几何：' + special.type)
  }
}
async function expectedPoints(name, pose) {
  const item = await assets.getJSON('items/' + name + '.json'), result = []
  for (const def of definition(item.model, pose)) {
    const isSpecial = def.type === 'minecraft:special', m = await model(isSpecial ? def.base : def.model)
    const points = isSpecial ? specialPoints(def.model) : jsonPoints(m), matrix = fixedMatrix(m.display?.fixed)
    // specialPoints 已把官方特殊渲染器及其 item transformation 换算到方块坐标。
    if (!isSpecial) for (const transform of def.transforms) matrix.multiply(localTransform(transform))
    result.push(...points.map(p => p.applyMatrix4(matrix)))
  }
  assert.ok(result.length, name + ' 预期顶点不能为空')
  return result
}
const FACING = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
function frameMatrix(pos, facing, rotation) {
  const dir = FACING[facing], horizontal = [0, 0, 180, 0, 90, 270][facing]
  return T(...pos.map((v, i) => v + dir[i] * 15 / 32))
    .multiply(R([-90 * dir[1], 0, 0])).multiply(R([0, dir[1] ? 180 : 180 - horizontal, 0]))
    .multiply(T(0, 0, 7 / 16)).multiply(R([0, 0, rotation * 45])).multiply(S(.5))
}
function actualPoints(object) {
  const result = []
  object.updateMatrixWorld(true)
  object.traverse(mesh => {
    if (!mesh.isMesh || mesh.material.map?.name === 'block/waxed_block') return
    const attribute = mesh.geometry.attributes.position
    for (let i = 0; i < attribute.count; i++) result.push(new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld))
  })
  return result
}
let checked = 0
async function check(name, pose = 'standing', facing = 2, rotation = 0) {
  const pos = [7, 11, -3], item = { id: 'minecraft:' + name, count: 1, components: { 'minecraft:block_state': { copper_golem_pose: pose } } }
  const frame = await buildEntityMesh({ id: 'minecraft:item_frame', pos, rotation: [0, 0], nbt: { Facing: facing, ItemRotation: rotation, Item: item } }, assets)
  assert.equal(frame.children.length, 2, name + ' 框体与物品都必须存在')
  frame.updateMatrixWorld(true)
  const actual = new THREE.Box3().setFromPoints(actualPoints(frame.children[1]))
  const transform = frameMatrix(pos, facing, rotation), expected = new THREE.Box3().setFromPoints((await expectedPoints(name, pose)).map(p => p.applyMatrix4(transform)))
  const label = `${assets.packs[0]?.name || '原版'} ${name}/${pose} facing=${facing} rotation=${rotation}`
  near(actual.min.toArray(), expected.min.toArray(), label + ' min'); near(actual.max.toArray(), expected.max.toArray(), label + ' max')
  // 标准头颅应以框内原点居中，不能重复叠加已烘焙的 +4px 偏移。
  if (name === 'skeleton_skull' && !assets.packs.some(p => p.name === 'override')) near(actual.getCenter(new THREE.Vector3()).toArray(), vector([0, 0, 0]).applyMatrix4(transform).toArray(), label + ' center')
  dispose(frame); checked++
}

try {
  for (const packName of ['原版', 'XK']) {
    if (packName === 'XK') assets.addPack(pack, 'XK')
    for (const wax of ['', 'waxed_']) for (const oxidation of ['', 'exposed_', 'weathered_', 'oxidized_']) {
      await check(wax + oxidation + 'copper_chest')
      for (const pose of ['standing', 'running', 'sitting', 'star']) await check(wax + oxidation + 'copper_golem_statue', pose)
    }
    // 六个附着面、八档旋转：包围盒同时约束尺寸、位置和旋转次序。
    for (const name of ['stone', 'chest', 'copper_chest', 'waxed_copper_chest', 'copper_golem_statue', 'waxed_copper_golem_statue', 'skeleton_skull', 'shulker_box', 'decorated_pot', 'red_bed']) {
      for (let facing = 0; facing < 6; facing++) for (let rotation = 0; rotation < 8; rotation++) await check(name, 'standing', facing, rotation)
    }
    for (const name of ['trapped_chest', 'ender_chest', 'red_shulker_box', 'creeper_head', 'zombie_head', 'wither_skeleton_skull']) await check(name)
    for (const name of ['copper_chest', 'copper_golem_statue', 'waxed_copper_golem_statue', 'skeleton_skull', 'shulker_box', 'decorated_pot', 'stone', 'red_bed']) {
      const gui = await buildGuiItem({ id: 'minecraft:' + name, count: 1 }, assets)
      assert.ok(gui, name + ' GUI 不可丢失')
      const points = actualPoints(gui); assert.ok(points.length && points.every(p => p.toArray().every(Number.isFinite)), name + ' GUI 顶点必须有限')
      dispose(gui)
    }
  }
  assets.clearPacks()
  const override = new JSZip(), fixed = { rotation: [15, 40, -20], translation: [2, -3, 1], scale: [.3, .7, 1.2] }
  for (const name of ['template_chest', 'template_copper_golem_statue', 'template_skull', 'template_shulker_box']) {
    const original = JSON.parse(readFileSync(root + 'models/item/' + name + '.json', 'utf8'))
    override.file('assets/minecraft/models/item/' + name + '.json', JSON.stringify({ ...original, display: { ...original.display, fixed } }))
  }
  assets.addPack(override, 'override')
  for (const name of ['copper_chest', 'copper_golem_statue', 'skeleton_skull', 'shulker_box']) for (const facing of [0, 2, 5]) for (const rotation of [0, 1, 3]) await check(name, 'standing', facing, rotation)
  assets.removePack('override')
  for (const name of ['copper_chest', 'copper_golem_statue', 'skeleton_skull', 'shulker_box']) await check(name)
  console.log(`通过：${checked} 个展示框尺寸/位置/姿态组合，原版与 XK、铜制品全部氧化/涂蜡状态、雕像四姿势、特殊 base 覆盖和卸载恢复、GUI 有限性。`)
} finally {
  globalThis.fetch = oldFetch
}
