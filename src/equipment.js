import * as THREE from 'three'
import { createEntityRig } from './entityModel.js'
import { EQUIPMENT_MODELS } from './equipmentModelData.js'
import { RELEASE_MODELS } from './releaseModelData.js'
import { HUMANOID_ARMOR, ARMED_MOBS, HEAD_ITEMS, BODY_EQUIPMENT, SADDLED_MOBS, readEquipment, equippable, equipmentDye, itemComponent, itemName, hasGlint, EQUIPMENT_ITEMS } from './equipmentState.js'
import { isBaby } from './entityBabies.js'
import { BABY_MODELS } from './babyEntityModels.js'

const short = value => String(value || '').replace(/^minecraft:/, '')
const DEG = Math.PI / 180
const clone = value => structuredClone(value)
const visit = (parts, fn) => { for (const [name, part] of Object.entries(parts)) { fn(part, name); visit(part.children || {}, fn) } }
// 按原版 BabyModelTransform 缩放几何但保留 UV；在绑定骨骼上应用，因此盔甲和手持物一起缩放。
export function applyArmorStandPose(mesh, nbt, yaw = 0) {
  mesh.userData.resetPose()
  const defaults = { Head: [0, 0, 0], Body: [0, 0, 0], LeftArm: [-10, 0, -10], RightArm: [-15, 0, 10], LeftLeg: [-1, 0, -1], RightLeg: [1, 0, 1] }
  const names = { head: 'Head', body: 'Body', left_arm: 'LeftArm', right_arm: 'RightArm', left_leg: 'LeftLeg', right_leg: 'RightLeg', right_body_stick: 'Body', left_body_stick: 'Body', shoulder_stick: 'Body' }
  for (const [name, key] of Object.entries(names)) {
    const bone = mesh.userData.parts[name]; if (!bone) continue
    const angles = nbt.Pose?.[key] || defaults[key]
    bone.rotation.set(...angles.map(v => (Number(v) || 0) * DEG), 'ZYX')
  }
  const base = mesh.userData.parts.base_plate
  if (base) base.rotation.y = -yaw * DEG
  if (nbt.Small) for (const bone of mesh.skeleton.bones[0].children) {
    const head = bone.name === 'head', scale = head ? .75 : .5
    bone.position.y += head ? 16 : 24; bone.position.multiplyScalar(scale); bone.scale.setScalar(scale)
  }
}

export function armorModel(id, slot, baby = false) {
  const family = baby && id !== 'armor_stand' ? (id.includes('piglin') ? 'BabyPiglin' : 'Baby')
    : id === 'armor_stand' ? 'ArmorStand' : id === 'zombie_villager' ? 'ZombieVillager' : id.includes('piglin') ? 'Piglin' : 'Humanoid'
  const model = clone(EQUIPMENT_MODELS[family + (slot === 'legs' ? '_inner' : '_outer')])
  const allowed = { head: ['head', 'hat'], chest: ['body', 'left_arm', 'right_arm'], legs: [baby && id !== 'armor_stand' ? 'waist' : 'body', 'left_leg', 'right_leg'], feet: baby && id !== 'armor_stand' ? ['left_foot', 'right_foot'] : ['left_leg', 'right_leg'] }[slot]
  visit(model.parts, (part, name) => { if (!allowed.includes(name)) part.cuboids = [] })
  return model
}

function syncedLayer(group, body, model, material, name, { stand, offset, scale = 1, extraPose } = {}) {
  const mesh = createEntityRig(model, material)
  mesh.geometry.computeVertexNormals()
  mesh.name = name; mesh.userData.equipment = true
  const sync = age => {
    body.userData.updateAnimation?.(age)
    mesh.userData.resetPose()
    if (stand) applyArmorStandPose(mesh, stand.nbt, stand.rotation?.[0])
    else for (const [key, bone] of Object.entries(mesh.userData.parts)) {
      const source = body.userData.parts[key]
      if (source) {
        bone.position.add(source.position).sub(source.userData.restPosition)
        bone.quaternion.copy(source.quaternion); bone.scale.copy(source.scale)
      }
    }
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion)
    mesh.scale.copy(body.scale).multiplyScalar(scale)
    if (offset) mesh.position.add(new THREE.Vector3(...offset))
    extraPose?.(mesh, age)
  }
  mesh.userData.updateAnimation = sync; sync(0)
  const start = performance.now()
  mesh.onBeforeRender = () => { sync(mesh.userData.animationAge ?? (performance.now() - start) / 50); mesh.updateMatrixWorld(true); mesh.skeleton.update() }
  group.add(mesh)
  return mesh
}

async function trimTexture(stack, type, info, assets) {
  const trim = itemComponent(stack, 'trim') || stack.tag?.Trim
  if (!trim || !['humanoid', 'humanoid_leggings'].includes(type) || typeof document === 'undefined') return null
  let pattern = short(trim.pattern?.asset_id || trim.pattern), palette = short(trim.material?.palette || 'trim/' + short(trim.material))
  if (!pattern || !palette) return null
  for (const rule of info.trim_overrides || []) {
    if ((!rule.when?.material || short(rule.when.material) === short(trim.material)) && (!rule.when?.pattern || short(rule.when.pattern) === short(trim.pattern))) {
      pattern = short(rule.texture || pattern); palette = rule.palette ? short(rule.palette) : rule.texture ? null : palette; break
    }
  }
  const source = await assets.getTexture('trims/entity/' + type + '/' + pattern)
  if (!source || !palette) return source
  const [base, colors] = await Promise.all([assets.getTexture('palettes/trim_base'), assets.getTexture('palettes/' + palette)])
  if (!base || !colors) return null
  const pixels = texture => {
    const canvas = document.createElement('canvas'), img = texture.image
    canvas.width = img.width; canvas.height = img.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0)
    return { canvas, ctx, data: ctx.getImageData(0, 0, img.width, img.height) }
  }
  const lookup = new Map(), a = pixels(base).data.data, b = pixels(colors).data.data
  for (let i = 0; i < Math.min(a.length, b.length); i += 4) lookup.set((a[i] << 16) | (a[i + 1] << 8) | a[i + 2], b.slice(i, i + 4))
  const out = pixels(source), p = out.data.data
  for (let i = 0; i < p.length; i += 4) {
    const color = lookup.get((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]); if (!color) continue
    p[i] = color[0]; p[i + 1] = color[1]; p[i + 2] = color[2]; p[i + 3] = Math.round(p[i + 3] * color[3] / 255)
  }
  out.ctx.putImageData(out.data, 0, 0)
  const texture = new THREE.CanvasTexture(out.canvas)
  texture.flipY = false; texture.magFilter = texture.minFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

async function equipmentLayers(group, body, stack, slot, type, model, assets, options = {}) {
  const equipment = equippable(stack)
  if (!equipment?.asset_id || equipment.slot !== slot || !model) return []
  const info = await assets.getJSON('equipment/' + short(equipment.asset_id) + '.json')
  const layers = info?.layers?.[type] || [], meshes = []
  for (const [index, layer] of layers.entries()) {
    const dye = equipmentDye(stack), color = layer.dyeable ? dye ?? layer.dyeable.color_when_undyed : 0xffffff
    if (color == null) continue
    const map = await assets.getTexture('entity/equipment/' + type + '/' + short(layer.texture))
    if (!map) continue
    const material = new THREE.MeshLambertMaterial({ map, color: color & 0xffffff, alphaTest: .1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - index, polygonOffsetUnits: -1 })
    meshes.push(syncedLayer(group, body, model, material, 'equipment_' + slot + '_' + index, options))
  }
  if (!meshes.length) return meshes
  const trim = await trimTexture(stack, type, info, assets)
  if (trim) meshes.push(syncedLayer(group, body, model, new THREE.MeshLambertMaterial({ map: trim, alphaTest: .1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 'equipment_' + slot + '_trim', options))
  if (hasGlint(stack)) {
    const texture = await assets.getTexture('misc/enchanted_glint_armor')
    if (texture) {
      const map = texture.clone(); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(8, 8); map.rotation = -Math.PI / 6
      const material = new THREE.MeshBasicMaterial({ map, color: 0x8040cc, transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 })
      // 光效沿用装备原始 UV 的透明遮罩，不能把头盔眼孔、鞘翅空白等区域填实。
      const mask = meshes[0].material.map
      material.onBeforeCompile = shader => {
        shader.uniforms.equipmentMask = { value: mask }
        shader.vertexShader = 'varying vec2 equipmentUv;\n' + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nequipmentUv = uv;')
        shader.fragmentShader = 'uniform sampler2D equipmentMask;\nvarying vec2 equipmentUv;\n' + shader.fragmentShader.replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (texture2D(equipmentMask, equipmentUv).a < 0.1) discard;')
      }
      const extraPose = options.extraPose
      meshes.push(syncedLayer(group, body, model, material, 'equipment_' + slot + '_glint', { ...options, extraPose(mesh, age) { extraPose?.(mesh, age); map.offset.set(age * .002 % 1, age * .001 % 1) } }))
    }
  }
  return meshes
}

function saddleModel(id, base, ridden) {
  if (id.includes('nautilus')) return RELEASE_MODELS.NautilusSaddleModel
  const model = clone(base)
  if (['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse'].includes(id)) {
    visit(model.parts, p => { p.cuboids = [] })
    const pieces = clone(EQUIPMENT_MODELS.HorseSaddle.parts)
    model.parts.body.children ||= {}; model.parts.head_parts.children ||= {}
    for (const [key, part] of Object.entries(pieces)) if (ridden || !key.endsWith('_line')) (key === 'saddle' ? model.parts.body.children : model.parts.head_parts.children)[key] = part
  } else if (id === 'camel' || id === 'camel_husk') {
    visit(model.parts, p => { p.cuboids = [] })
    const pieces = clone(EQUIPMENT_MODELS.CamelSaddle.parts), body = model.parts.body
    body.children.saddle = pieces.saddle; body.children.head.children.bridle = pieces.bridle
    if (ridden) body.children.head.children.reins = pieces.reins
  } else if (id === 'pig') visit(model.parts, p => { for (const c of p.cuboids) c.dil = (c.dil || [0, 0, 0]).map(v => v + .5) })
  return model
}

export async function attachEquipment(group, body, entity, assets, buildItem) {
  const id = short(entity.id), nbt = entity.nbt || {}, items = readEquipment(nbt), baby = isBaby(nbt), stand = id === 'armor_stand' ? entity : null
  const options = { stand }
  if (HUMANOID_ARMOR.has(id)) for (const slot of ['head', 'chest', 'legs', 'feet']) if (items[slot]) {
    await equipmentLayers(group, body, items[slot], slot, baby ? 'humanoid_baby' : slot === 'legs' ? 'humanoid_leggings' : 'humanoid', armorModel(id, slot, baby), assets, options)
  }
  if (HUMANOID_ARMOR.has(id) && items.chest && equippable(items.chest)?.slot === 'chest') {
    await equipmentLayers(group, body, items.chest, 'chest', 'wings', EQUIPMENT_MODELS.Elytra, assets, { offset: [0, 0, -.125], scale: baby || nbt.Small ? .5 : 1 })
  }
  const base = body.userData.model
  if (items.body && BODY_EQUIPMENT[id] && (!baby || id.includes('llama') || id === 'happy_ghast')) {
    let model = base
    if (id === 'wolf') model = EQUIPMENT_MODELS.WolfArmor
    if (id.includes('nautilus')) model = RELEASE_MODELS.NautilusArmorModel
    if (id.includes('horse')) model = EQUIPMENT_MODELS.HorseArmor
    if (id.includes('llama')) {
      model = clone(baby ? BABY_MODELS.Llama : EQUIPMENT_MODELS.LlamaDecor)
      if (baby) visit(model.parts, p => { for (const c of p.cuboids) c.dil = (c.dil || [0, 0, 0]).map(v => v + .2) })
      if (!nbt.ChestedHorse) visit(model.parts, (p, name) => { if (name.endsWith('_chest')) p.cuboids = [] })
    }
    if (id === 'happy_ghast') model = EQUIPMENT_MODELS.Harness
    const opts = id === 'happy_ghast' ? { scale: (baby ? .2375 : 1) * 4 / (group.scale.x || 1), extraPose(mesh) { const p = mesh.userData.parts.goggles; p.rotation.x = nbt.Passengers?.length ? 0 : -.7854; p.position.y = nbt.Passengers?.length ? 14 : 9 } } : {}
    await equipmentLayers(group, body, items.body, 'body', BODY_EQUIPMENT[id], model, assets, opts)
    if (id === 'wolf' && itemName(items.body) === 'wolf_armor') {
      const damage = Number(itemComponent(items.body, 'damage') ?? items.body.Damage ?? 0), max = EQUIPMENT_ITEMS.wolf_armor.maxDamage
      const fraction = 1 - damage / max, crack = fraction < .32 ? 'high' : fraction < .69 ? 'medium' : fraction < .95 ? 'low' : null
      if (crack) {
        const map = await assets.getTexture('entity/wolf/wolf_armor_crackiness_' + crack)
        if (map) syncedLayer(group, body, model, new THREE.MeshLambertMaterial({ map, transparent: true, alphaTest: .1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 }), 'equipment_body_cracks')
      }
    }
  }
  if (items.saddle && SADDLED_MOBS.has(id) && !baby) await equipmentLayers(group, body, items.saddle, 'saddle', id.includes('nautilus') ? 'nautilus_saddle' : id + '_saddle', saddleModel(id, base, !!nbt.Passengers?.length), assets)
  if (!buildItem) return
  const leftMain = !!nbt.LeftHanded
  if (ARMED_MOBS.has(id)) for (const slot of ['mainhand', 'offhand']) {
    const stack = items[slot]; if (!stack) continue
    const left = slot === 'mainhand' ? leftMain : !leftMain, bone = body.userData.parts[left ? 'left_arm' : 'right_arm']
    if (!bone) continue
    const item = await buildItem(stack, assets, left ? 'thirdperson_lefthand' : 'thirdperson_righthand')
    if (!item) continue
    const pivot = new THREE.Group(); pivot.name = 'equipment_' + slot; pivot.userData.equipment = true
    // 骨骼坐标单位是像素；原版 hand transform = Rx(-90) Ry(180) T(±1,2,-10)。
    pivot.rotation.set(-Math.PI / 2, Math.PI, 0, 'XYZ')
    const offset = baby ? [0, 1, -4.5] : [left ? -1 : 1, 2, -10]
    const holder = new THREE.Group(); holder.position.fromArray(offset); holder.scale.setScalar(16); holder.add(item)
    pivot.add(holder)
    if (id === 'vex') {
      const hand = new THREE.Group(), position = new THREE.Group()
      hand.scale.setScalar(.55); position.position.set(left ? -.75 : .75, -2.5, 1.25)
      position.add(pivot); hand.add(position); bone.add(hand)
    } else if (id === 'allay') {
      const hand = new THREE.Group(), position = new THREE.Group(), offset = new THREE.Group()
      hand.position.set(0, 1, 3); position.scale.setScalar(.7); offset.position.x = 1
      offset.add(pivot); position.add(offset); hand.add(position); body.userData.parts.body.add(hand)
      const update = body.userData.updateAnimation
      body.userData.updateAnimation = age => { update(age); hand.rotation.x = body.userData.parts.right_arm.rotation.x }
      body.userData.updateAnimation(0)
    } else bone.add(pivot)
  }
  if (items.head && HEAD_ITEMS.has(id) && !equippable(items.head)?.asset_id) {
    const head = body.userData.parts.head
    if (head && await attachWornSkull(head, items.head, id, assets)) return
    const item = head && await buildItem(items.head, assets, 'head')
    if (item) { const pivot = new THREE.Group(); pivot.name = 'equipment_head_item'; pivot.userData.equipment = true; pivot.position.y = -4 - (id === 'villager' || id === 'wandering_trader' ? 1.875 : 0); pivot.rotation.y = Math.PI; pivot.scale.set(10, -10, -10); pivot.add(item); head.add(pivot) }
  }
}

async function attachWornSkull(head, stack, id, assets) {
  const skulls = {
    skeleton_skull: ['Skull', 'skeleton/skeleton'], wither_skeleton_skull: ['Skull', 'skeleton/wither_skeleton'],
    creeper_head: ['Skull', 'creeper/creeper'], zombie_head: ['HumanoidHead', 'zombie/zombie'],
    piglin_head: ['PiglinHead', 'piglin/piglin'], dragon_head: ['DragonHead', 'enderdragon/dragon'],
  }
  const spec = skulls[itemName(stack)]; if (!spec) return false
  const map = await assets.getTexture('entity/' + spec[1]); if (!map) return false
  const mesh = createEntityRig(EQUIPMENT_MODELS[spec[0]], new THREE.MeshLambertMaterial({ map, alphaTest: .1, side: THREE.DoubleSide }))
  mesh.geometry.computeVertexNormals()
  if (spec[0] === 'DragonHead') { mesh.userData.parts.head.scale.setScalar(.75); mesh.userData.parts.jaw.rotation.x = .2 }
  if (spec[0] === 'PiglinHead') { mesh.userData.parts.left_ear.rotation.z = -.7; mesh.userData.parts.right_ear.rotation.z = .7 }
  // EntityRig 的世界坐标转回头骨坐标（像素、Y/Z 向下/后），再施加 SKULL_SCALE。
  mesh.scale.set(16, -16, -16); mesh.position.y = 24
  const pivot = new THREE.Group(); pivot.name = 'equipment_head_item'; pivot.userData.equipment = true
  pivot.scale.setScalar(1.1875)
  if (id === 'villager' || id === 'wandering_trader') pivot.position.y = -1.1875
  pivot.add(mesh); head.add(pivot)
  return true
}
