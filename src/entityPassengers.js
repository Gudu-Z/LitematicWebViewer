import { isBaby } from './entityBabies.js'

const short = id => String(id || '').replace(/^minecraft:/, '')
const DEG = Math.PI / 180
// EntityTypes.Builder.ridingOffset: added to the vehicle seat's Y coordinate.
// Minecraft 26.3: world/entity/EntityTypes, Entity.positionRider and EntityAttachment.
// https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/world/entity/entitytypes/
const RIDING_OFFSETS = {
  allay: .04, vex: .04, ghast: .5, happy_ghast: .5, phantom: -.125, giant: -3.75,
  zombie: -.7, husk: -.7, drowned: -.7, zombie_villager: -.7,
  skeleton: -.7, stray: -.7, bogged: -.7, wither_skeleton: -.875,
  piglin: -.7, piglin_brute: -.7, zombified_piglin: -.7,
  evoker: -.6, vindicator: -.6, illusioner: -.6, pillager: -.6,
}
const BABY_OFFSETS = { zombie: -.1875, husk: -.1875, drowned: -.1875, zombie_villager: -.125, piglin: -.1875, zombified_piglin: -.1875 }
// AbstractBoat uses Animal (not all living entities) for the second-seat offset and sideways pose.
const ANIMALS = new Set(['armadillo', 'axolotl', 'bee', 'camel', 'cat', 'chicken', 'cow', 'donkey', 'fox', 'frog', 'goat', 'happy_ghast', 'hoglin', 'horse', 'llama', 'mooshroom', 'mule', 'ocelot', 'panda', 'parrot', 'pig', 'polar_bear', 'rabbit', 'sheep', 'skeleton_horse', 'sniffer', 'strider', 'trader_llama', 'turtle', 'wolf', 'zombie_horse'])

export function vehicleId(entity) {
  const id = short(entity.id)
  return ['boat', 'chest_boat'].includes(id) ? short(entity.nbt?.Type || 'oak') + '_' + id : id
}
export const isBoat = id => /_(boat|raft)$/.test(short(id)) || ['boat', 'chest_boat'].includes(short(id))
export function passengerCapacity(id) {
  id = short(id)
  if (isBoat(id)) return id.includes('chest') ? 1 : 2
  return ['minecart', 'cushion'].includes(id) ? 1 : 0
}
export function ridingOffset(entity) {
  const id = short(entity.id), offset = RIDING_OFFSETS[id] || 0
  if (!isBaby(entity.nbt || {})) return offset
  return BABY_OFFSETS[id] ?? offset * (id === 'happy_ghast' ? .2375 : .5)
}
const position = value => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)

// Seats are world-space attachments, independent of the model's yaw correction or rail pitch.
// AbstractBoat: first/second seats +0.2/-0.6, animals +0.2; chest boat single seat +0.15.
// Boat.rideHeight = 0.5625/3; Raft = 0.5. Minecart lowers villagers to Y=0.
// Cushion inherits its default passenger attachment at its bounding-box height, Y=0.25.
export function createPassengerEntity(vehicle, nbt, index, count) {
  const id = vehicleId(vehicle), passengerId = short(nbt.id)
  const yaw = Number(vehicle.rotation?.[0]) || 0
  const rotation = Array.isArray(nbt.Rotation) ? [...nbt.Rotation] : [yaw, 0]
  const passenger = { id: nbt.id, nbt, rotation, riding: true, region: vehicle.region, renderOptions: vehicle.renderOptions }
  let seat = [0, 0, 0]
  if (isBoat(id)) {
    const animal = ANIMALS.has(passengerId)
    const forward = count > 1 ? (index === 0 ? .2 : -.6) + (animal ? .2 : 0) : id.includes('chest') ? .15 : 0
    seat = [-Math.sin(yaw * DEG) * forward, id.endsWith('_raft') ? .5 : .1875, Math.cos(yaw * DEG) * forward]
    // Breeze is the vanilla CAN_TURN_IN_BOATS exception. Runtime entity IDs are not saved;
    // preserve a saved sideways animal yaw, otherwise use a stable direction per seat.
    if (passengerId !== 'breeze') {
      const delta = ((Number(rotation[0]) - yaw) % 360 + 540) % 360 - 180
      rotation[0] = yaw + (animal && count === passengerCapacity(id) ? (Math.abs(Math.abs(delta) - 90) < 1 ? delta : index % 2 ? -90 : 90) : 0)
    }
  } else if (id === 'minecart' || id.endsWith('_minecart')) {
    seat[1] = ['villager', 'wandering_trader'].includes(passengerId) ? 0 : .1875
  } else if (id === 'cushion') {
    seat[1] = .25
  } else if (position(nbt.Pos) && position(vehicle.nbt?.Pos)) {
    // Other mounts can still retain their saved relative position in a nested passenger tree.
    passenger.pos = vehicle.pos.map((n, axis) => n + nbt.Pos[axis] - vehicle.nbt.Pos[axis])
    return passenger
  }
  seat[1] += ridingOffset(passenger)
  passenger.pos = vehicle.pos.map((n, axis) => n + seat[axis])
  return passenger
}
