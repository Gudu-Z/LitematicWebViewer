// 展示框尺寸回归：使用资源中的 fixed 变换与独立矩阵计算预期顶点，不读取生产 holder 的缩放。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import * as THREE from 'three'
import { AssetProvider } from '../src/assets.js'
import { buildEntityMesh, buildGuiItem, buildEquippedItem } from '../src/entities.js'
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

// Official 26.3 client (SHA-1 e877b6a07acd633fb3bb475002175cec036e7b87):
// DragonHeadModel.createHeadLayer/setupAnim, PiglinModel.addHead and
// PiglinHeadModel.setupAnim, independently evaluated with matrices.
// PartPose.scaled scales the dragon's pivot as well.
function skullPoints({ kind, animation = 0 }) {
  const cube = (from, to, matrix = new THREE.Matrix4()) => corners(from, to).map(p => p.applyMatrix4(matrix).multiplyScalar(1 / 16))
  if (kind === 'dragon') {
    const head = S(.75).multiply(T(0, -7.986666, 0))
    const jaw = head.clone().multiply(T(0, 4, -8)).multiply(R([(Math.sin(animation * Math.PI * .2) + 1) * .2, 0, 0], 'ZYX', 1))
    return [
      ...cube([-6, -1, -24], [6, 4, -8], head), ...cube([-8, -8, -10], [8, 8, 6], head),
      ...cube([-5, -12, -4], [-3, -8, 2], head), ...cube([3, -12, -4], [5, -8, 2], head),
      ...cube([-5, -3, -22], [-3, -1, -18], head), ...cube([3, -3, -22], [5, -1, -18], head),
      ...cube([-6, 0, -16], [6, 4, 0], jaw),
    ]
  }
  const left = T(4.5, -6, 0).multiply(R([0, 0, -(Math.cos(animation * Math.PI * .2 * 1.2) + 2.5) * .2], 'ZYX', 1))
  const right = T(-4.5, -6, 0).multiply(R([0, 0, (Math.cos(animation * Math.PI * .2) + 2.5) * .2], 'ZYX', 1))
  return [
    ...cube([-5, -8, -4], [5, 0, 4]), ...cube([-2, -4, -5], [2, 0, -4]),
    ...cube([2, -2, -5], [3, 0, -4]), ...cube([-3, -2, -5], [-2, 0, -4]),
    ...cube([0, 0, -2], [1, 5, 2], left), ...cube([-1, 0, -2], [0, 5, 2], right),
  ]
}
const isAnimatedSkull = def => def.type === 'minecraft:special' && def.model?.type === 'minecraft:head' && ['dragon', 'piglin'].includes(def.model.kind)
async function expectedPoints(name, pose) {
  const item = await assets.getJSON('items/' + name + '.json'), result = []
  for (const def of definition(item.model, pose)) {
    const isSpecial = def.type === 'minecraft:special', m = await model(isSpecial ? def.base : def.model)
    const skull = isAnimatedSkull(def)
    const points = skull ? skullPoints(def.model) : isSpecial ? specialPoints(def.model) : jsonPoints(m), matrix = fixedMatrix(m.display?.fixed)
    // specialPoints 已把官方特殊渲染器及其 item transformation 换算到方块坐标。
    if (!isSpecial || skull) for (const transform of def.transforms) matrix.multiply(localTransform(transform))
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
let checked = 0, potSurfaceChecks = 0
async function check(name, pose = 'standing', facing = 2, rotation = 0) {
  const pos = [7, 11, -3], item = { id: 'minecraft:' + name, count: 1, components: { 'minecraft:block_state': { copper_golem_pose: pose } } }
  const frame = await buildEntityMesh({ id: 'minecraft:item_frame', pos, rotation: [0, 0], nbt: { Facing: facing, ItemRotation: rotation, Item: item } }, assets)
  assert.equal(frame.children.length, 2, name + ' 框体与物品都必须存在')
  frame.updateMatrixWorld(true)
  const actualVertices = actualPoints(frame.children[1]), actual = new THREE.Box3().setFromPoints(actualVertices)
  const transform = frameMatrix(pos, facing, rotation), expectedVertices = (await expectedPoints(name, pose)).map(p => p.applyMatrix4(transform))
  const expected = new THREE.Box3().setFromPoints(expectedVertices)
  const label = `${assets.packs[0]?.name || '原版'} ${name}/${pose} facing=${facing} rotation=${rotation}`
  near(actual.min.toArray(), expected.min.toArray(), label + ' min'); near(actual.max.toArray(), expected.max.toArray(), label + ' max')
  if (name === 'chest' || name.endsWith('_chest') || ['dragon_head', 'piglin_head'].includes(name)) {
    // ChestModel lock is offset(0,9,1) + addBox(7,-2,14,2,4,1): y=7..11.
    // The body hides a displaced lock from an AABB-only check; compare corners too.
    for (const point of actualVertices) assert.ok(expectedVertices.some(p => p.distanceTo(point) < EPS), label + ' unexpected corner ' + point.toArray())
    for (const point of expectedVertices) assert.ok(actualVertices.some(p => p.distanceTo(point) < EPS), label + ' missing corner ' + point.toArray())
  }
  // 标准头颅应以框内原点居中，不能重复叠加已烘焙的 +4px 偏移。
  if (name === 'skeleton_skull' && !assets.packs.some(p => p.name === 'override')) near(actual.getCenter(new THREE.Vector3()).toArray(), vector([0, 0, 0]).applyMatrix4(transform).toArray(), label + ' center')
  dispose(frame); checked++
}

async function checkSkullContexts(name) {
  const item = { id: 'minecraft:' + name, count: 1 }, def = (await assets.getJSON('items/' + name + '.json')).model
  const base = await model(def.base)
  for (const context of ['gui', 'thirdperson_righthand', 'thirdperson_lefthand']) {
    const object = context === 'gui' ? await buildGuiItem(item, assets) : await buildEquippedItem(item, assets, context)
    const display = structuredClone(base.display?.[context] || base.display?.thirdperson_righthand || {})
    if (context === 'thirdperson_lefthand') {
      display.rotation = (display.rotation || [0, 0, 0]).map((v, i) => i ? -v : v)
      display.translation = (display.translation || [0, 0, 0]).map((v, i) => i ? v : -v)
    }
    const matrix = fixedMatrix(display).multiply(localTransform(def.transformation || {}))
    const expected = skullPoints(def.model).map(p => p.applyMatrix4(matrix)), actual = actualPoints(object)
    for (const p of expected) assert.ok(actual.some(v => v.distanceTo(p) < EPS), `${name}/${context}: missing skull corner ${p.toArray()}`)
    for (const p of actual) assert.ok(expected.some(v => v.distanceTo(p) < EPS), `${name}/${context}: unexpected skull corner ${p.toArray()}`)
    dispose(object)
  }
}

// Check actual textured surfaces, including mirrored dragon horns and tilted ears.
// Coordinates/UVs are from vanilla ModelPart.Cube, before the item transformation.
async function checkSkullSurfaces(name) {
  const def = (await assets.getJSON('items/' + name + '.json')).model, base = await model(def.base)
  const frame = await buildEntityMesh({ id: 'minecraft:item_frame', pos: [0, 0, 0], rotation: [0, 0], nbt: { Facing: 2, Item: { id: 'minecraft:' + name } } }, assets)
  frame.updateMatrixWorld(true)
  const matrix = frameMatrix([0, 0, 0], 2, 0).multiply(fixedMatrix(base.display.fixed)).multiply(localTransform(def.transformation)).multiply(S(1 / 16))
  const dragon = name === 'dragon_head'
  if (dragon) matrix.multiply(S(.75)).multiply(T(0, -7.986666, 0))
  const samples = dragon ? [
    { point: [-4.5, -11, -4], uv: [7.5 / 256, 7 / 256] },
    { point: [3.5, -11, -4], uv: [6.5 / 256, 7 / 256] },
    { point: [0, 0, -24], uv: [198 / 256, 61 / 256] },
  ] : [
    { point: [0, -3, -5], uv: [34 / 64, 3 / 64] },
    { point: [2.5, -1, -5], uv: [3.5 / 64, 6 / 64] },
    { point: [-2.5, -1, -5], uv: [3.5 / 64, 2 / 64] },
    { point: [.5, 4, -2], uv: [55.5 / 64, 14 / 64], part: T(4.5, -6, 0).multiply(R([0, 0, -.7], 'ZYX', 1)) },
    { point: [-.5, 4, -2], uv: [43.5 / 64, 14 / 64], part: T(-4.5, -6, 0).multiply(R([0, 0, .7], 'ZYX', 1)) },
  ]
  for (const sample of samples) {
    const transform = matrix.clone().multiply(sample.part || new THREE.Matrix4()), point = vector(sample.point).applyMatrix4(transform)
    const normal = vector([0, 0, -1]).transformDirection(transform)
    const ray = new THREE.Raycaster(point.clone().addScaledVector(normal, .02), normal.clone().negate(), 0, .04)
    const hit = ray.intersectObject(frame.children[1], true)[0]
    assert.ok(hit, `${name}: missing surface ${sample.point}`)
    near(hit.point.toArray(), point.toArray(), name + ' surface')
    near(hit.uv.toArray(), sample.uv, name + ' UV')
    assert.equal(hit.object.material.map.name, dragon ? 'entity/enderdragon/dragon' : 'entity/piglin/piglin')
  }
  dispose(frame)
}

// 包围盒无法发现陶罐只剩罐口/罐底：射线必须真正命中四面罐身。
// 官方 DecoratedPotRenderer.createSidesLayer：14×16 面，像素 UV [1,0]..[15,16]。
// 从各侧外面看，上 v=0；front 的 u 随 +x，back 随 -x，left 随 +z，right 随 -z。
const POT_BLANK = 'entity/decorated_pot/decorated_pot_side'
const POT_SIDES = {
  front: { normal: [0, 0, 1], point: (u, v) => [16 * u, 16 * (1 - v), 15] },
  back: { normal: [0, 0, -1], point: (u, v) => [16 * (1 - u), 16 * (1 - v), 1] },
  left: { normal: [-1, 0, 0], point: (u, v) => [1, 16 * (1 - v), 16 * u] },
  right: { normal: [1, 0, 0], point: (u, v) => [15, 16 * (1 - v), 16 * (1 - u)] },
}
const potTextures = (back, left, right, front) => Object.fromEntries(Object.entries({ back, left, right, front })
  .map(([side, name]) => [side, name ? 'entity/decorated_pot/' + name + '_pottery_pattern' : POT_BLANK]))
const potSherds = ['angler', 'archer', 'arms_up', 'skull'].map(name => 'minecraft:' + name + '_pottery_sherd')
const potDecorations = Object.fromEntries(['back', 'left', 'right', 'front'].map((side, index) => [side, potSherds[index]]))
const patternedPot = potTextures('angler', 'archer', 'arms_up', 'skull')
const blankPot = potTextures()
const potItem = data => ({ id: 'minecraft:decorated_pot', count: 1, ...data })

function assertPotSides(object, transform, textures, label) {
  object.updateMatrixWorld(true)
  for (const [side, { normal, point }] of Object.entries(POT_SIDES)) {
    for (const uv of [[.5, .5], [.25, .25], [.75, .75]]) {
      const target = vector(point(...uv)).multiplyScalar(1 / 16).applyMatrix4(transform)
      const outward = vector(normal).transformDirection(transform)
      const ray = new THREE.Raycaster(target.clone().addScaledVector(outward, 2), outward.clone().negate())
      const hit = ray.intersectObject(object, true)[0], detail = `${label} ${side} UV=${uv}`
      assert.ok(hit, detail + ' 必须命中罐身，不能穿过缺失的侧面')
      near(hit.point.toArray(), target.toArray(), detail + ' 表面位置')
      assert.equal(hit.object.material.map?.name, textures[side], detail + ' 图案/侧面顺序')
      near(hit.uv.toArray(), uv, detail + ' UV不能倒置或镜像')
      const geometricNormal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
      assert.ok(geometricNormal.dot(outward) > 1 - EPS, detail + ' 三角形必须朝外，不能靠双面材质掩盖反向绕序')
      potSurfaceChecks++
    }
  }
}
async function makePotFrame(data, facing = 2, rotation = 0) {
  const pos = [3, 5, 7], frame = await buildEntityMesh({
    id: 'minecraft:item_frame', pos, rotation: [0, 0], nbt: { Facing: facing, ItemRotation: rotation, Item: potItem(data) },
  }, assets)
  assert.equal(frame.children.length, 2, '陶罐框体与物品都必须存在')
  frame.updateMatrixWorld(true)
  const display = (await model('item/decorated_pot')).display.fixed
  return { frame, object: frame.children[1], transform: frameMatrix(pos, facing, rotation).multiply(fixedMatrix(display)) }
}
async function checkPots(packName) {
  const modern = { components: { 'minecraft:pot_decorations': potDecorations } }
  const cases = [
    ['空白', {}, blankPot],
    ['26.3字符串对象', modern, patternedPot],
    ['26.3物品对象', { components: { 'minecraft:pot_decorations': Object.fromEntries(Object.entries(potDecorations).map(([k, id]) => [k, { id }])) } }, patternedPot],
    ['旧四元素列表', { components: { 'minecraft:pot_decorations': potSherds } }, patternedPot],
    ['旧BlockEntityTag', { tag: { BlockEntityTag: { sherds: potSherds } } }, patternedPot],
    ['block_entity_data', { components: { 'minecraft:block_entity_data': { sherds: potSherds } } }, patternedPot],
    ['缺省/砖块/非陶片/缺失贴图', { components: { 'minecraft:pot_decorations': {
      back: 'minecraft:brick', left: { id: 'minecraft:stone' }, right: 'minecraft:missing_pottery_sherd', front: { id: potSherds[1] },
    } } }, potTextures(null, null, null, 'archer')],
    ['部分面缺省', { components: { 'minecraft:pot_decorations': { front: potSherds[3] } } }, potTextures(null, null, null, 'skull')],
    ['现代空对象优先于旧标签', { components: { 'minecraft:pot_decorations': {} }, tag: { BlockEntityTag: { sherds: potSherds } } }, blankPot],
  ]
  // 同一资源提供器并发创建不同装饰；所有对象建完后再检查，捕获共享缓存/材质串图。
  const built = await Promise.all(cases.map(async ([label, data, textures]) => ({ ...(await makePotFrame(data)), label, textures })))
  for (const entry of built) assertPotSides(entry.object, entry.transform, entry.textures, `${packName} ${entry.label}`)
  for (const entry of built) dispose(entry.frame)

  for (let facing = 0; facing < 6; facing++) for (let rotation = 0; rotation < 8; rotation++) {
    const entry = await makePotFrame(modern, facing, rotation)
    assertPotSides(entry.object, entry.transform, patternedPot, `${packName} pot facing=${facing} rotation=${rotation}`)
    dispose(entry.frame)
  }
  for (const context of ['gui', 'thirdperson_righthand', 'firstperson_righthand']) {
    const object = context === 'gui' ? await buildGuiItem(potItem(modern), assets) : await buildEquippedItem(potItem(modern), assets, context)
    assert.ok(object, context + ' 陶罐不可丢失')
    const transform = fixedMatrix((await model('item/decorated_pot')).display[context])
    assertPotSides(object, transform, patternedPot, `${packName} pot ${context}`)
    dispose(object)
  }
}

try {
  for (const packName of ['原版', 'XK']) {
    if (packName === 'XK') assets.addPack(pack, 'XK')
    for (const wax of ['', 'waxed_']) for (const oxidation of ['', 'exposed_', 'weathered_', 'oxidized_']) {
      await check(wax + oxidation + 'copper_chest')
      for (const pose of ['standing', 'running', 'sitting', 'star']) await check(wax + oxidation + 'copper_golem_statue', pose)
    }
    // 六个附着面、八档旋转：包围盒同时约束尺寸、位置和旋转次序。
    const copperChests = ['', 'waxed_'].flatMap(wax => ['', 'exposed_', 'weathered_', 'oxidized_'].map(stage => wax + stage + 'copper_chest'))
    for (const name of ['stone', 'chest', ...copperChests, 'copper_golem_statue', 'waxed_copper_golem_statue', 'skeleton_skull', 'dragon_head', 'piglin_head', 'shulker_box', 'decorated_pot', 'red_bed']) {
      for (let facing = 0; facing < 6; facing++) for (let rotation = 0; rotation < 8; rotation++) await check(name, 'standing', facing, rotation)
    }
    for (const name of ['trapped_chest', 'ender_chest', 'red_shulker_box', 'creeper_head', 'zombie_head', 'wither_skeleton_skull']) await check(name)
    for (const name of ['copper_chest', 'copper_golem_statue', 'waxed_copper_golem_statue', 'skeleton_skull', 'dragon_head', 'piglin_head', 'shulker_box', 'decorated_pot', 'stone', 'red_bed']) {
      const gui = await buildGuiItem({ id: 'minecraft:' + name, count: 1 }, assets)
      assert.ok(gui, name + ' GUI 不可丢失')
      const points = actualPoints(gui); assert.ok(points.length && points.every(p => p.toArray().every(Number.isFinite)), name + ' GUI 顶点必须有限')
      dispose(gui)
    }
    await checkPots(packName)
    for (const name of ['dragon_head', 'piglin_head']) {
      await checkSkullContexts(name)
      await checkSkullSurfaces(name)
    }
  }
  assets.clearPacks()
  const override = new JSZip(), fixed = { rotation: [15, 40, -20], translation: [2, -3, 1], scale: [.3, .7, 1.2] }
  for (const name of ['template_chest', 'template_copper_golem_statue', 'template_skull', 'template_shulker_box']) {
    const original = JSON.parse(readFileSync(root + 'models/item/' + name + '.json', 'utf8'))
    override.file('assets/minecraft/models/item/' + name + '.json', JSON.stringify({ ...original, display: { ...original.display, fixed } }))
  }
  assets.addPack(override, 'override')
  for (const name of ['copper_chest', 'copper_golem_statue', 'skeleton_skull', 'dragon_head', 'piglin_head', 'shulker_box']) for (const facing of [0, 2, 5]) for (const rotation of [0, 1, 3]) await check(name, 'standing', facing, rotation)
  assets.removePack('override')
  for (const name of ['copper_chest', 'copper_golem_statue', 'skeleton_skull', 'dragon_head', 'piglin_head', 'shulker_box']) await check(name)
  const skullOverride = new JSZip()
  for (const name of ['dragon_head', 'piglin_head']) {
    const original = JSON.parse(readFileSync(root + 'items/' + name + '.json', 'utf8'))
    original.model.model.animation = 2.75
    original.model.model.texture = 'minecraft:skull_audit/' + name
    original.model.transformation = {
      translation: [.7, -.15, .4], scale: [.8, 1.2, .6],
      left_rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, -.4, .1)).toArray(),
      right_rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(-.3, .1, .4)).toArray(),
    }
    skullOverride.file('assets/minecraft/items/' + name + '.json', JSON.stringify(original))
    skullOverride.file('assets/minecraft/textures/entity/skull_audit/' + name + '.png', readFileSync(root + 'textures/entity/piglin/piglin.png'))
  }
  assets.addPack(skullOverride, 'skull-override')
  for (const name of ['dragon_head', 'piglin_head']) {
    await check(name); await check(name, 'standing', 5, 3); await checkSkullContexts(name)
    const gui = await buildGuiItem({ id: 'minecraft:' + name }, assets)
    gui.traverse(o => { if (o.isMesh) assert.equal(o.material.map.name, 'entity/skull_audit/' + name) })
    dispose(gui)
  }
  assets.removePack('skull-override')
  const skullReplacement = new JSZip()
  for (const name of ['dragon_head', 'piglin_head']) skullReplacement.file('assets/minecraft/items/' + name + '.json', JSON.stringify({ model: { type: 'minecraft:model', model: 'minecraft:block/diamond_block' } }))
  assets.addPack(skullReplacement, 'skull-replacement')
  for (const name of ['dragon_head', 'piglin_head']) await check(name)
  assets.removePack('skull-replacement')
  for (const name of ['dragon_head', 'piglin_head']) { await check(name); await checkSkullSurfaces(name) }
  // 资源包用普通模型替代陶罐时，应完整尊重模型，不能再叠加特殊渲染器侧面。
  const replacement = new JSZip()
  replacement.file('assets/minecraft/items/decorated_pot.json', JSON.stringify({ model: { type: 'minecraft:model', model: 'minecraft:block/diamond_block' } }))
  assets.addPack(replacement, 'pot-replacement')
  const customPot = await makePotFrame({ components: { 'minecraft:pot_decorations': potDecorations } })
  const textureNames = new Set()
  customPot.object.traverse(o => { if (o.isMesh) textureNames.add(o.material.map?.name) })
  assert.deepEqual([...textureNames], ['block/diamond_block'], '普通资源包模型应优先于陶罐特殊侧面')
  dispose(customPot.frame); assets.removePack('pot-replacement')
  const restoredPot = await makePotFrame({})
  assertPotSides(restoredPot.object, restoredPot.transform, blankPot, '卸载普通模型恢复完整陶罐')
  dispose(restoredPot.frame)
  console.log(`通过：${checked} 个展示框尺寸/位置/姿态组合、${potSurfaceChecks} 次陶罐表面射线，原版与 XK、龙首/猪灵头颅顶点及表面 UV、铜制品变种、雕像四姿势、陶片格式/朝向与 GUI/手持、资源包覆盖和卸载恢复。`)
} finally {
  globalThis.fetch = oldFetch
}
