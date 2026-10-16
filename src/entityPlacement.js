import * as THREE from 'three'
import { isBaby } from './entityBabies.js'
import { entityScale } from './entityScale.js'
import { getEntityHitbox } from './entityHitboxes.js'

const DEG = Math.PI / 180, f = Math.fround
const flip = new THREE.Vector3(-1, -1, 1)
const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
// Inverse of compileModel's (x, 24-y, -z) / 16, in block units.
const toVanilla = new THREE.Matrix4().makeScale(1, -1, -1).multiply(new THREE.Matrix4().makeTranslation(0, -1.5, 0))
// Direction.getRotation, indexed by the opposite of AttachFace (DOWN..EAST).
const attachments = [[0, 0, 0], [Math.PI, 0, 0], [Math.PI / 2, 0, 0], [Math.PI / 2, 0, Math.PI], [Math.PI / 2, 0, -Math.PI / 2], [Math.PI / 2, 0, Math.PI / 2]]
  .map(angles => new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles, 'XYZ')))
const bedDirections = { south: [0, 0, 1, 90], west: [-1, 0, 0, 0], north: [0, 0, -1, 270], east: [1, 0, 0, 180] }

function sleepingDirection(state, data) {
  if (!data?.bounds || !data.blocks) return null
  // Sleeping Pos is on the bed. NBT sleeping_pos can still contain coordinates
  // from the source world, whereas this entity position is already region-relative.
  const b = data.bounds, [x, y, z] = state.pos.map(Math.floor)
  if (x < b.minX || x >= b.minX + b.width || y < b.minY || y >= b.minY + b.height || z < b.minZ || z >= b.minZ + b.depth) return null
  const block = data.palette[data.blocks.get(x - b.minX + (z - b.minZ) * b.width + (y - b.minY) * b.width * b.depth)]
  return block?.name?.endsWith('_bed') ? bedDirections[block.properties?.facing] || null : null
}

// Minecraft 26.3 renderer transforms, applied to every visual layer. Pos and the
// group's logical origin stay fixed; saved attributes also scale the attachments.
// Client-only flight/turn/squish/attack interpolation is not stored in a schematic.
export function createMobPlacement(group, id, state, appearance, data) {
  const n = state.nbt || {}, baseScale = id === 'ender_dragon' ? 1 : entityScale(n)
  const yaw = Number(state.rotation?.[0]) || 0, pitch = Number(state.rotation?.[1]) || 0
  const scale = appearance.scale ?? 1, modelScale = appearance.modelScale ?? scale
  group.scale.setScalar(scale * baseScale)
  group.rotation.y = -yaw * DEG - (id === 'ender_dragon' ? Math.PI : 0)
  if (id === 'ender_dragon') return mesh => mesh.position.set(0, f(1.501) - 1.5, -1)

  const inverseGroup = new THREE.Matrix4().compose(new THREE.Vector3(), group.quaternion, group.scale).invert()
  const matrix = new THREE.Matrix4(), temporary = new THREE.Matrix4(), quaternion = new THREE.Quaternion()
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), meshScale = new THREE.Vector3()
  const translate = (x, y, z) => matrix.multiply(temporary.makeTranslation(x, y, z))
  const rotate = (axis, degrees) => matrix.multiply(temporary.makeRotationAxis(axes[axis], degrees * DEG))
  const scaleVector = new THREE.Vector3()
  const uniformScale = value => matrix.scale(scaleVector.setScalar(value))
  const sleeping = String(n.Pose ?? n.pose).replace(/^minecraft:/, '').toLowerCase() === 'sleeping' || n.sleeping_pos != null || n.SleepingX != null
  const bed = sleeping ? sleepingDirection(state, data) : null
  const standing = sleeping ? getEntityHitbox({ ...state, nbt: { ...n, Pose: 'standing', pose: 'standing', sleeping_pos: undefined, SleepingX: undefined } }) : null
  const height = getEntityHitbox(state)?.max[1] || 0
  const flipDegrees = ['spider', 'cave_spider', 'silverfish', 'endermite'].includes(id) ? 180 : 90
  const fish = ['cod', 'salmon', 'tropical_fish'].includes(id)
  const dynamic = fish || id === 'pufferfish'
  let lastAge
  return (mesh, age = 0) => {
    if (lastAge === undefined || (dynamic && age !== lastAge)) {
      lastAge = age
      matrix.identity()
      if (bed) translate(-bed[0] * (standing.eyeHeight - .1), 0, -bed[2] * (standing.eyeHeight - .1))
      uniformScale(baseScale)
      if (id === 'squid' || id === 'glow_squid') {
        // xBodyRot/zBodyRot are client-only values, so retain the neutral rotation.
        translate(0, isBaby(n) ? .25 : .5, 0)
        rotate('y', 180 - yaw)
        translate(0, isBaby(n) ? f(-.6) : f(-1.2), 0)
      } else {
        if (id === 'pufferfish') translate(0, Math.cos(age * .05) * .08, 0)
        if (!sleeping || id === 'armor_stand') rotate('y', (id === 'shulker' ? 0 : 180) - yaw)
        if (id !== 'armor_stand') {
          if (Number(n.DeathTime) > 0) rotate('z', Math.min(1, Math.sqrt(Math.max(0, (Number(n.DeathTime) - 1) / 20 * 1.6))) * flipDegrees)
          else if (sleeping) { rotate('y', bed?.[3] ?? yaw); rotate('z', flipDegrees); rotate('y', 270) }
          else if (state.upsideDown) { translate(0, (height + .1) / baseScale, 0); rotate('z', 180) }
        }
        if (id === 'phantom') rotate('x', pitch)
        if (id === 'shulker') {
          translate(0, .5, 0)
          quaternion.copy(attachments[Number(n.AttachFace)] || attachments[0])
          matrix.multiply(temporary.makeRotationFromQuaternion(quaternion))
          translate(0, -.5, 0)
        }
        if (fish) {
          const drySalmon = id === 'salmon' && !state.touchingWater
          rotate('y', 4.3 * (drySalmon ? 1.3 : 1) * Math.sin(age * .6 * (drySalmon ? 1.7 : 1)))
          if (!state.touchingWater) { translate(id === 'cod' ? .1 : .2, .1, id === 'cod' ? -.1 : 0); rotate('z', 90) }
        }
      }
      matrix.scale(flip)
      uniformScale(scale / modelScale)
      if (id === 'slime' || id === 'sulfur_cube') translate(0, f(.001) * f(.999) / scale, 0)
      if (id === 'phantom') translate(0, 1.3125, .1875)
      // Sulfur cube data already bakes its renderer-origin shift (including 1.501).
      translate(0, id === 'sulfur_cube' ? -1.5 : -f(1.501), 0)
      // MeshTransformer.scaling preserves the feet at model Y=24. Its translation
      // must not scale the renderer's 1.501 offset or a fish's dry-land offset.
      translate(0, 1.5 * (1 - modelScale), 0)
      uniformScale(modelScale)
      matrix.multiply(toVanilla).premultiply(inverseGroup).decompose(position, rotation, meshScale)
    }
    mesh.position.copy(position); mesh.quaternion.copy(rotation); mesh.scale.copy(meshScale)
  }
}
