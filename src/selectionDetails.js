import { blockKey } from './selectionSources.js'
import { readEquipment, equipmentStack, itemComponent } from './equipmentState.js'
import { ENTITY_DIMENSIONS } from './entityDimensionData.js'

const tileIndexes = new WeakMap()
export const shortId = id => String(id || '').replace(/^minecraft:/, '')
const numeric = n => n !== null && n !== undefined && Number.isFinite(Number(n)) ? Number(n) : null

export function textComponent(value, depth = 0) {
  if (depth > 16 || value == null) return ''
  if (typeof value === 'string') {
    if (/^[\[{"]/.test(value)) {
      try { return textComponent(JSON.parse(value), depth + 1) } catch { /* legacy plain text */ }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(v => textComponent(v, depth + 1)).join('')
  if (typeof value !== 'object') return String(value)
  return String(value.text ?? value.translate ?? '') + textComponent(value.extra, depth + 1)
}

export function stackName(stack) {
  return textComponent(itemComponent(stack, 'custom_name') ?? itemComponent(stack, 'item_name') ?? stack?.tag?.display?.Name)
}

export function containerSize(id) {
  id = shortId(id)
  if (id.includes(':')) return null
  if (['chest', 'trapped_chest', 'barrel', 'chest_minecart', 'shulker_box'].includes(id) ||
    /(?:^|_)copper_chest$|_shulker_box$|_chest_boat$|_chest_raft$/.test(id) || id === 'chest_boat') return 27
  return { hopper: 5, hopper_minecart: 5, dispenser: 9, dropper: 9, crafter: 9,
    furnace: 3, blast_furnace: 3, smoker: 3, brewing_stand: 5, chiseled_bookshelf: 6,
    decorated_pot: 1, lectern: 1, jukebox: 1, campfire: 4, soul_campfire: 4 }[id] ?? null
}

export function readInventory(nbt, id) {
  const capacity = containerSize(id)
  let list = nbt?.Items ?? nbt?.items ?? nbt?.Inventory
  if (!Array.isArray(list)) list = itemComponent(nbt, 'container')
  const singleKey = { decorated_pot: 'item', lectern: 'Book', jukebox: 'RecordItem',
    item_frame: 'Item', glow_item_frame: 'Item', item: 'Item' }[shortId(id)]
  if (singleKey && nbt && Object.hasOwn(nbt, singleKey)) list = [nbt[singleKey]]
  if (capacity === null && !Array.isArray(list) && !singleKey && !nbt?.LootTable && !nbt?.loot_table) return null
  const known = Array.isArray(list)
  const entries = (known ? list : []).flatMap((value, index) => {
    const stack = equipmentStack(value?.item ?? value)
    if (!stack || !Number.isFinite(Number(stack.count ?? stack.Count ?? 1))) return []
    // Legacy Slot is a signed NBT byte. New container components use an int.
    const slot = numeric(value.slot) ?? (numeric(value.Slot) === null ? index : Number(value.Slot) & 255)
    return [{ slot, stack, count: Number(stack.count ?? stack.Count ?? 1) }]
  }).sort((a, b) => a.slot - b.slot)
  return { capacity: capacity ?? (singleKey ? 1 : null), known, entries,
    occupied: new Set(entries.map(e => e.slot)).size,
    total: entries.reduce((sum, e) => sum + e.count, 0), lootTable: nbt?.LootTable ?? nbt?.loot_table ?? null }
}

function tileAt(data, position) {
  let index = tileIndexes.get(data)
  if (!index) {
    index = new Map()
    for (const tile of data.tileEntities || []) index.set([tile.x, tile.y, tile.z].join(','), tile)
    tileIndexes.set(data, index)
  }
  return index.get(position.join(','))
}

export function savedMaxHealth(nbt) {
  const attributes = nbt?.attributes || nbt?.Attributes
  const attribute = (Array.isArray(attributes) ? attributes : []).find(a =>
    a && ['max_health', 'generic.max_health'].includes(shortId(a.id ?? a.Name)))
  let base = numeric(attribute?.base ?? attribute?.Base)
  if (base === null) return null
  const savedModifiers = attribute.modifiers || attribute.Modifiers
  const modifiers = Array.isArray(savedModifiers) ? savedModifiers.filter(Boolean) : []
  const amount = m => numeric(m.amount ?? m.Amount) ?? 0
  const op = m => m.operation ?? m.Operation
  base += modifiers.filter(m => op(m) === 0 || op(m) === 'add_value').reduce((n, m) => n + amount(m), 0)
  let value = base + base * modifiers.filter(m => op(m) === 1 || op(m) === 'add_multiplied_base').reduce((n, m) => n + amount(m), 0)
  for (const m of modifiers) if (op(m) === 2 || op(m) === 'add_multiplied_total') value *= 1 + amount(m)
  return Number.isFinite(value) ? Math.max(1, Math.min(1024, value)) : null
}

export function facingFromYaw(yaw) {
  return ['south', 'west', 'north', 'east'][((Math.round(Number(yaw) / 90) % 4) + 4) % 4]
}

export function inspectSelection(data, selection) {
  if (!data || !selection) return null
  if (selection.kind === 'entity') {
    const entity = selection.entity, nbt = entity.nbt || {}, id = entity.id
    const living = !!ENTITY_DIMENSIONS[shortId(id)]?.[3]
    const rotation = nbt.Rotation || entity.rotation
    return { kind: living ? 'mob' : 'entity', id, position: entity.pos, regions: entity.region ? [entity.region] : [],
      customName: textComponent(nbt.CustomName ?? nbt.custom_name), nbt,
      health: numeric(nbt.Health ?? nbt.health), maxHealth: savedMaxHealth(nbt),
      rotation, facing: nbt.Facing == null ? (rotation ? facingFromYaw(rotation[0]) : null)
        : ['down', 'up', 'north', 'south', 'west', 'east'][nbt.Facing],
      equipment: Object.entries(readEquipment(nbt)).filter(([, stack]) => stack),
      passengers: (Array.isArray(nbt.Passengers) ? nbt.Passengers : []).filter(Boolean).map(p => ({ id: p.id, name: textComponent(p.CustomName ?? p.custom_name) })),
      containers: [readInventory(nbt, id)].filter(Boolean), riding: !!entity.riding,
    }
  }
  const key = selection.key ?? blockKey(selection.position, data.bounds)
  const entry = data.palette[data.blocks.get(key)]
  if (!entry) return null
  const position = selection.position, tile = tileAt(data, position), nbt = tile?.nbt
  const texts = []
  if (nbt && shortId(entry.name).endsWith('_sign')) {
    for (const side of ['front', 'back']) {
      const messages = nbt[side + '_text']?.messages ?? (side === 'front' && Object.hasOwn(nbt, 'Text1') ? [nbt.Text1, nbt.Text2, nbt.Text3, nbt.Text4] : null)
      if (Array.isArray(messages)) texts.push({ side, text: messages.map(v => textComponent(v)).join('\n') })
    }
  }
  const container = readInventory(nbt, entry.name)
  const containers = container ? [{ ...container, position }] : []
  // Show both saved halves of an unambiguous double chest. Retain each half's
  // slot numbering and missing-data status instead of silently treating it empty.
  if (container?.capacity === 27 && ['left', 'right'].includes(entry.properties?.type)) {
    const facing = entry.properties.facing
    const axis = ['north', 'south'].includes(facing) ? 0 : 2
    const neighbours = [-1, 1].map(offset => {
      const pos = [...position]; pos[axis] += offset
      const neighbourKey = blockKey(pos, data.bounds), p = neighbourKey === null ? null : data.palette[data.blocks.get(neighbourKey)]
      return { pos, p }
    }).filter(({ p }) => p?.name === entry.name && p.properties?.facing === facing &&
      p.properties.type === (entry.properties.type === 'left' ? 'right' : 'left'))
    if (neighbours.length === 1) {
      const pos = neighbours[0].pos
      containers.push({ ...readInventory(tileAt(data, pos)?.nbt, entry.name), position: pos, otherHalf: true })
    }
  }
  return { kind: 'block', id: entry.name, position, properties: entry.properties || {},
    regions: tile?.region ? [tile.region] : (data.regions || []).filter(r =>
      position[0] >= r.minX && position[0] <= r.maxX && position[1] >= r.minY && position[1] <= r.maxY && position[2] >= r.minZ && position[2] <= r.maxZ).map(r => r.name),
    customName: textComponent(nbt?.CustomName ?? nbt?.custom_name), nbt, tileId: tile?.id, containers, texts,
    privateInventory: shortId(entry.name) === 'ender_chest' }
}
