import * as THREE from 'three'
import { ENTITY_DIMENSIONS, BABY_DIMENSIONS } from './entityDimensionData.js'
import { isBaby } from './entityBabies.js'
import { vehicleId, ridingOffset } from './entityPassengers.js'

const f = Math.fround
const short = value => String(value || '').replace(/^minecraft:/, '')
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const scaled = (dims, scale) => dims.map(n => f(n * f(scale)))
const facing = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const overlays = new WeakMap()

function dragonParts(yaw, sitting) {
  // EnderDragon.aiStep/tickPart with stationary flight-history samples. Saved NBT
  // has no flight history or turn velocity; keep these logical boxes static too.
  const sin = Math.sin(yaw), cos = Math.cos(yaw), headY = sitting ? -1 : 0
  return [
    ['head', 1, 1, sin * 6.5, headY, -cos * 6.5],
    ['neck', 3, 3, sin * 5.5, headY, -cos * 5.5],
    ['body', 5, 3, sin * .5, 0, -cos * .5],
    ['tail1', 2, 2, -sin * 3.5, 1.5, cos * 3.5],
    ['tail2', 2, 2, -sin * 5.5, 1.5, cos * 5.5],
    ['tail3', 2, 2, -sin * 7.5, 1.5, cos * 7.5],
    ['wing1', 4, 2, cos * 4.5, 2, sin * 4.5],
    ['wing2', 4, 2, -cos * 4.5, 2, -sin * 4.5],
  ].map(([name, w, h, x, y, z]) => ({ name, min: [x - w / 2, y, z - w / 2], max: [x + w / 2, y + h, z + w / 2] }))
}

function entityScale(nbt) {
  const attributes = nbt.attributes ?? nbt.Attributes
  const attribute = Array.isArray(attributes) && attributes.find(a => ['scale', 'generic.scale'].includes(short(a.id ?? a.Name)))
  if (!attribute) return 1
  const modifiers = attribute.modifiers ?? attribute.Modifiers ?? []
  const operation = m => m.type ?? m.Operation
  const amount = m => number(m.amount ?? m.Amount)
  let base = number(attribute.base ?? attribute.Base, 1)
  if (Array.isArray(modifiers)) {
    for (const m of modifiers) if (['add_value', 0].includes(operation(m))) base += amount(m)
    let value = base
    for (const m of modifiers) if (['add_multiplied_base', 1].includes(operation(m))) value += base * amount(m)
    for (const m of modifiers) if (['add_multiplied_total', 2].includes(operation(m))) value *= 1 + amount(m)
    base = value
  }
  return f(clamp(base, .0625, 16))
}

// EntityDimensions.makeBoundingBox and each entity's getDefaultDimensions override,
// Minecraft 26.3. These are logical world-axis boxes, independent of model bounds.
// A schematic stores saved state, not the live pose/peek interpolation history.
export function getEntityHitbox(entity) {
  const id = vehicleId(entity), defaults = Object.hasOwn(ENTITY_DIMENSIONS, id) ? ENTITY_DIMENSIONS[id] : null
  if (!defaults) return null // Do not invent dimensions for modded entities.
  const n = entity.nbt || {}, living = !!defaults[3]
  const baby = id === 'armor_stand' ? !!n.Small : isBaby(n)
  const pose = typeof n.Pose === 'string' ? short(n.Pose).toLowerCase() : short(n.pose).toLowerCase()
  let dims = (baby && BABY_DIMENSIONS[id] || defaults).slice(0, 3)
  let scale = living && id !== 'ender_dragon' ? entityScale(n) : 1, peek = 0
  if (id === 'armor_stand' && n.Marker) dims = [0, 0, 0]
  if (['slime', 'magma_cube', 'sulfur_cube'].includes(id)) {
    const size = n.Size == null && id === 'sulfur_cube' ? (baby ? 1 : 2) : number(n.Size) + 1
    dims = scaled(defaults.slice(0, 3), clamp(Math.trunc(size), 1, 127))
  }
  if (id === 'pufferfish') dims = scaled(dims, [.5, .7, 1][clamp(Math.trunc(number(n.PuffState)), 0, 2)])
  if (id === 'salmon') dims = scaled(dims, { small: .5, medium: 1, large: 1.5 }[short(n.type ?? n.Type)] || 1)
  if (id === 'phantom') dims = scaled(dims, f(1 + f(f(.15) * clamp(Math.trunc(number(n.Size)), 0, 64))))
  if (['camel', 'camel_husk'].includes(id) && (pose === 'sitting' || n.Sitting || n.sitting || number(n.LastPoseTick) < 0)) {
    dims = baby ? [.95, .425, .41].map(f) : [defaults[0], f(defaults[1] - f(1.43)), f(.845)]
  }
  if (id === 'sniffer' && pose === 'digging') dims = scaled([defaults[0], f(defaults[1] - f(.4)), f(.81)], baby ? .5 : 1)
  if (id === 'warden' && ['digging', 'emerging'].includes(pose)) { dims = [dims[0], 1, f(.85)]; scale = 1 }
  if (living && (pose === 'sleeping' || n.sleeping_pos || n.SleepingX != null)) { dims = [f(.2), f(.2), f(.2)]; scale = 1 }
  if (id === 'shulker') {
    // Shulker.getPhysicalPeek, at the saved target Peek (0..100).
    peek = .5 - Math.cos(clamp(number(n.Peek ?? n.peek), 0, 100) / 100 * Math.PI) * .5
    if (number(n.AttachFace) === 0) dims[2] = f(dims[2] * f(1 + peek))
  }
  const [width, height, eyeHeight] = scaled(dims, scale)
  const min = [-width / 2, 0, -width / 2], max = [width / 2, height, width / 2]
  const rotation = entity.rotation || n.Rotation || [0, 0]
  const yaw = number(rotation[0]) * Math.PI / 180, pitch = number(rotation[1]) * Math.PI / 180
  let direction = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  if (id === 'shulker') {
    const attachment = facing[number(n.AttachFace)] || facing[0]
    attachment.forEach((value, axis) => { if (value > 0) min[axis] -= peek * scale; if (value < 0) max[axis] += peek * scale })
  }
  if (id === 'item_frame' || id === 'glow_item_frame') {
    // ItemFrame.createBoundingBox: centered on Pos, not based at its feet.
    direction = facing[number(n.Facing, 2)] || facing[2]
    const item = n.Item || {}, full = short(item.id) === 'filled_map' ? 1 : .75
    direction.forEach((value, axis) => { const half = (value ? .0625 : full) / 2; min[axis] = -half; max[axis] = half })
  }
  const parts = id === 'ender_dragon' ? dragonParts(yaw, [5, 6, 7].includes(number(n.DragonPhase))) : []
  return { min, max, eyeHeight, direction, living, width, parts, invisible: !!(n.Invisible || n.invisible) }
}

// Store the correction before a parent vehicle moves its children into local space.
// This also handles item frames, whose existing meshes use world-space vertices.
export function registerEntityHitbox(root, entity) {
  const bounds = getEntityHitbox(entity)
  if (!bounds) return root
  root.updateMatrix()
  const anchor = root.matrix.clone().invert().multiply(new THREE.Matrix4().makeTranslation(...entity.pos))
  root.userData.entityHitbox = { bounds, anchor, ridingOffset: entity.riding ? ridingOffset(entity) : null }
  return root
}

function makeOverlay(record, vehicle) {
  const { bounds: b } = record, positions = [], colors = []
  const line = (a, c, color) => { positions.push(...a, ...c); colors.push(...color, ...color) }
  const box = (min, max, color) => {
    for (let axis = 0; axis < 3; axis++) {
      const other = [0, 1, 2].filter(a => a !== axis)
      for (let side = 0; side < 4; side++) {
        const a = [...min], c = [...min]
        other.forEach((k, i) => { a[k] = c[k] = side & (1 << i) ? max[k] : min[k] })
        c[axis] = max[axis]; line(a, c, color)
      }
    }
  }
  box(b.min, b.max, [1, 1, 1])
  if (b.living) box([b.min[0], b.min[1] + b.eyeHeight - f(.01), b.min[2]], [b.max[0], b.min[1] + b.eyeHeight + f(.01), b.max[2]], [1, 0, 0])
  for (const part of b.parts) box(part.min, part.max, [63 / 255, 1, 0])
  if (vehicle && record.ridingOffset !== null) {
    const half = Math.min(b.width, vehicle.bounds.width) / 2, y = -record.ridingOffset
    box([-half, y, -half], [half, y + .0625, half], [1, 1, 0])
  }
  // EntityHitboxDebugRenderer: view vector starts at Pos + eye height, length 2.
  const origin = [0, b.eyeHeight, 0], end = b.direction.map((v, i) => origin[i] + v * 2)
  line(origin, end, [0, 0, 1])
  const dir = new THREE.Vector3(...b.direction), side = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize()
  for (const sign of [-1, 1]) line(end, end.map((v, i) => v - b.direction[i] * .12 + side.getComponent(i) * sign * .06), [0, 0, 1])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, fog: false, depthTest: true, depthWrite: false })
  const overlay = new THREE.LineSegments(geometry, material)
  overlay.name = 'entity-hitbox'; overlay.userData.isEntityHitbox = true
  overlay.matrix.copy(record.anchor); overlay.matrixAutoUpdate = false
  overlay.renderOrder = 100
  return overlay
}

// Lazily allocate once and toggle without rebuilding models, resetting cameras or loading packs.
export function setEntityHitboxesVisible(root, enabled) {
  const entities = []
  root?.traverse(o => { if (o.userData.entityHitbox) entities.push(o) })
  for (const object of entities) {
    const record = object.userData.entityHitbox
    let overlay = overlays.get(object)
    if (!overlay && enabled && !record.bounds.invisible) {
      let parent = object.parent
      while (parent && !parent.userData.entityHitbox) parent = parent.parent
      overlay = makeOverlay(record, parent?.userData.entityHitbox)
      overlays.set(object, overlay)
      object.add(overlay)
    }
    if (overlay) overlay.visible = !!enabled && !record.bounds.invisible
  }
}

export function bindEntityHitboxShortcut(toggle) {
  let f3 = false
  window.addEventListener('keydown', event => {
    if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.code === 'F3') { f3 = true; event.preventDefault() }
    if (event.code === 'KeyB' && f3) { event.preventDefault(); if (!event.repeat) toggle() }
  })
  window.addEventListener('keyup', event => { if (event.code === 'F3') f3 = false })
  window.addEventListener('blur', () => { f3 = false })
}
