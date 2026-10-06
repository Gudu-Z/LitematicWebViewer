import { EQUIPMENT_ITEMS } from './equipmentItemData.js'
export { EQUIPMENT_ITEMS }
export const HUMANOID_ARMOR = new Set(['armor_stand', 'zombie', 'husk', 'drowned', 'zombie_villager', 'giant', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'piglin', 'piglin_brute', 'zombified_piglin'])
export const ARMED_MOBS = new Set([...HUMANOID_ARMOR, 'pillager', 'allay', 'vex'])
export const HEAD_ITEMS = new Set([...HUMANOID_ARMOR, 'villager', 'wandering_trader'])
export const SADDLED_MOBS = new Set(['pig', 'strider', 'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'camel'])
export const BODY_EQUIPMENT = { horse: 'horse_body', skeleton_horse: 'horse_body', zombie_horse: 'horse_body', wolf: 'wolf_body', llama: 'llama_body', trader_llama: 'llama_body', happy_ghast: 'happy_ghast_body' }
export const itemName = stack => String(stack?.id || '').replace(/^minecraft:/, '')
export function equipmentStack(value) {
  return value?.id && itemName(value) !== 'air' && Number(value.count ?? value.Count ?? 1) > 0 ? value : null
}
export function readEquipment(nbt = {}) {
  const old = { head: nbt.ArmorItems?.[3], chest: nbt.ArmorItems?.[2], legs: nbt.ArmorItems?.[1], feet: nbt.ArmorItems?.[0],
    mainhand: nbt.HandItems?.[0], offhand: nbt.HandItems?.[1], body: nbt.body_armor_item || nbt.ArmorItem || nbt.DecorItem,
    saddle: nbt.SaddleItem || (nbt.Saddle ? { id: 'minecraft:saddle', count: 1 } : null) }
  return Object.fromEntries(Object.keys(old).map(slot => [slot, equipmentStack(Object.hasOwn(nbt.equipment || {}, slot) ? nbt.equipment[slot] : old[slot])]))
}
export function itemComponent(stack, key) {
  return stack?.components?.['minecraft:' + key] ?? stack?.components?.[key]
}
export function equippable(stack) {
  return itemComponent(stack, 'equippable') || EQUIPMENT_ITEMS[itemName(stack)]?.equippable
}
export function equipmentDye(stack) {
  const value = itemComponent(stack, 'dyed_color') ?? stack?.tag?.display?.color
  const color = typeof value === 'object' ? value?.rgb : value
  return Number.isFinite(color) ? color & 0xffffff : null
}
export function hasGlint(stack) {
  const override = itemComponent(stack, 'enchantment_glint_override')
  if (override !== undefined) return !!override
  const enchants = itemComponent(stack, 'enchantments')
  return !!(Object.keys(enchants?.levels || enchants || {}).length || stack?.tag?.Enchantments?.length || stack?.tag?.ench?.length)
}
