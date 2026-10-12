import { materialIconId } from './materialItems.js'

// Minecraft 26.3: default item components (see scripts/gen-equipment-data.mjs),
// ShulkerBoxMenu.CONTAINER_SIZE and BlockItem.canFitInsideContainerItems.
// These are inventory capacity estimates for the existing placed-block counts;
// compound blocks are not expanded into a construction recipe here.
const COLORS = 'white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(' ')
const WOODS = 'oak spruce birch jungle acacia dark_oak mangrove cherry bamboo crimson warped pale_oak poplar'.split(' ')
const SHULKER_BOXES = new Set(['shulker_box', ...COLORS.map(color => `${color}_shulker_box`)])
const STACK_1 = new Set(['cake', 'water_bucket', 'lava_bucket', 'powder_snow_bucket', ...COLORS.map(color => `${color}_bed`)])
const STACK_16 = new Set([
  'straw_bed', ...COLORS.map(color => `${color}_banner`),
  ...WOODS.flatMap(wood => [`${wood}_sign`, `${wood}_hanging_sign`]),
])
const NO_ITEM = new Set([
  'air', 'cave_air', 'void_air', 'end_gateway', 'end_portal', 'nether_portal',
  'fire', 'soul_fire', 'frosted_ice', 'piston_head',
  'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron',
])
const PLANT_ITEMS = {
  bamboo_sapling: 'bamboo', big_dripleaf_stem: 'big_dripleaf',
  pitcher_crop: 'pitcher_pod', torchflower_crop: 'torchflower_seeds',
}

export function materialStorage(name, count) {
  // Modded namespaces do not have a known vanilla stack size.
  if (name.includes(':') && !name.startsWith('minecraft:')) return { reason: 'Unknown' }
  const block = name.replace(/^minecraft:/, '')
  if (NO_ITEM.has(block) || block.startsWith('potted_') || /(^|_)candle_cake$/.test(block)) return { reason: 'NoItem' }
  const item = PLANT_ITEMS[block] || materialIconId(block)
  if (SHULKER_BOXES.has(item)) return { reason: 'Nested' }
  const stackSize = STACK_1.has(item) ? 1 : STACK_16.has(item) ? 16 : 64
  const capacity = 27 * stackSize
  return { stackSize, capacity, boxes: Math.ceil(count / capacity) }
}
