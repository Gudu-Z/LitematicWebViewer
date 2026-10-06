import { ALL_MOB_FIXTURES } from './entity-fixtures.mjs'
import { BABY_MOBS } from '../src/entityBabies.js'
import { CUSHION_COLORS } from '../src/cushion.js'
import { passengerCapacity } from '../src/entityPassengers.js'

const MOBS = new Map(ALL_MOB_FIXTURES.map(fixture => [fixture.id.slice(10), fixture]))
const field = (path, label, pairs) => ({ path, label, options: pairs.map(([value, label]) => ({ value, label })) })
export const BOAT_IDS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo']
  .flatMap(wood => ['', 'chest_'].map(chest => wood + '_' + chest + (wood === 'bamboo' ? 'raft' : 'boat')))

export function ridingFields(entry, values = {}, name) {
  const fields = []
  const cushionColors = () => field('ridingPreview.color', '坐垫颜色', CUSHION_COLORS.map(color => [color, name(color + '_cushion', 'item')]))
  if (entry.kind === 'mob') {
    fields.push(field('ridingPreview.vehicle', '乘坐载具', [['', '无'], ...['minecart', ...BOAT_IDS, 'cushion'].map(id => [id, name(id, id === 'cushion' ? 'entity' : 'item')])]))
    if (values['ridingPreview.vehicle'] === 'cushion') fields.push(cushionColors())
    return fields
  }
  const capacity = passengerCapacity(values.id || entry.fixture.id)
  if (!capacity) return fields
  const choices = [['', '无'], ...[...MOBS.keys()].map(id => [id, name(id, 'entity')])]
  for (let slot = 0; slot < capacity; slot++) {
    if (slot && !MOBS.has(values['ridingPreview.passenger0'])) break
    const key = 'ridingPreview.passenger' + slot
    fields.push(field(key, slot ? '第二位乘客' : '乘客', choices))
    if (BABY_MOBS.has(values[key])) fields.push(field(key + 'Age', slot ? '第二位乘客年龄' : '乘客年龄', [[0, '成年'], [-24000, '幼年']]))
  }
  return fields
}

export function applyRidingPreview(fixture, entry) {
  const preview = fixture.ridingPreview || {}
  delete fixture.ridingPreview
  if (entry.kind === 'mob') {
    if (!['minecart', ...BOAT_IDS, 'cushion'].includes(preview.vehicle)) return fixture
    return { id: 'minecraft:' + preview.vehicle, pos: [...fixture.pos], rotation: [...fixture.rotation], nbt: {
      ...(preview.vehicle === 'cushion' ? { color: preview.color || 'white' } : {}),
      Passengers: [{ ...fixture.nbt, id: fixture.id, Rotation: fixture.rotation }],
    } }
  }
  const passengers = []
  for (let slot = 0; slot < passengerCapacity(fixture.id); slot++) {
    const id = preview['passenger' + slot], source = MOBS.get(id)
    if (!source) break
    const nbt = structuredClone(source.nbt)
    if (BABY_MOBS.has(id)) nbt.Age = preview['passenger' + slot + 'Age'] || 0
    passengers.push({ ...nbt, id: source.id })
  }
  if (passengers.length) fixture.nbt.Passengers = passengers
  return fixture
}
