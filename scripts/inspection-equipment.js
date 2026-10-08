import { HUMANOID_ARMOR, ARMED_MOBS, HEAD_ITEMS, SADDLED_MOBS, BODY_EQUIPMENT, EQUIPMENT_ITEMS, readEquipment, equippable, itemName } from '../src/equipmentState.js'
import { isBaby } from '../src/entityBabies.js'

const MATERIALS = ['leather', 'chainmail', 'copper', 'iron', 'golden', 'diamond', 'netherite']
const HAND_ITEMS = ['iron_sword', 'diamond_sword', 'netherite_sword', 'golden_sword', 'wooden_sword', 'stone_sword', 'copper_sword', 'iron_axe', 'diamond_axe', 'golden_axe', 'netherite_axe', 'iron_pickaxe', 'diamond_pickaxe', 'bow', 'crossbow', 'trident', 'mace', 'shield', 'totem_of_undying', 'torch', 'lantern', 'book', 'emerald', 'gold_ingot', 'carrot', 'poppy', 'stone', 'oak_planks']
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const DYES = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21]
// 原版可染色的穿戴装备；地毯和挽具的颜色通过更换物品选择。
const DYEABLE = new Set(['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots', 'leather_horse_armor', 'wolf_armor'])
function equipmentCapabilities(fixture) {
  const id = itemName(fixture), nbt = fixture.nbt || {}, baby = id !== 'armor_stand' && isBaby(nbt)
  const items = readEquipment(nbt), slots = {}
  const body = !!BODY_EQUIPMENT[id] && (!baby || id.includes('llama') || id === 'happy_ghast')
  const saddle = SADDLED_MOBS.has(id) && !baby
  for (const [slot, stack] of Object.entries(items)) {
    const definition = equippable(stack)
    if (!definition?.asset_id || definition.slot !== slot) continue
    const armor = HUMANOID_ARMOR.has(id) && ['head', 'chest', 'legs', 'feet'].includes(slot)
    if (!armor && !(slot === 'body' && body) && !(slot === 'saddle' && saddle)) continue
    const name = itemName(stack)
    slots[slot] = {
      dye: DYEABLE.has(name), glint: true,
      trim: armor && !baby && /_(helmet|chestplate|leggings|boots)$/.test(name),
      damage: id === 'wolf' && slot === 'body' && name === 'wolf_armor',
    }
  }
  return { slots, body, saddle, hands: !!(items.mainhand || items.offhand) }
}

// 不传 fixture 时返回完整字段集，供搜索索引和资源回归使用；详情页传入当前状态。
export function equipmentFields(entry, officialName, itemIds, fixture = null, values = {}) {
  const id = entry.id, fields = []
  const capabilities = fixture && equipmentCapabilities(fixture)
  const available = key => !capabilities || Object.values(capabilities.slots).some(slot => slot[key])
  const field = (path, label, values) => fields.push({ path, label, options: values.map(([value, label]) => ({ value, label })) })
  const slot = (key, label, ids) => field('nbt.equipment.' + key, label, [[{}, '无'], ...ids.filter(id => itemIds.includes(id)).map(id => [{ id: 'minecraft:' + id, count: 1 }, officialName(id, 'item')])])
  if (HEAD_ITEMS.has(id)) slot('head', '头部装备', [...(HUMANOID_ARMOR.has(id) ? [...MATERIALS.map(m => m + '_helmet'), 'turtle_helmet'] : []), 'carved_pumpkin', 'skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'creeper_head', 'piglin_head', 'dragon_head'])
  if (HUMANOID_ARMOR.has(id)) {
    slot('chest', '胸部装备', [...MATERIALS.map(m => m + '_chestplate'), 'elytra'])
    slot('legs', '腿部装备', MATERIALS.map(m => m + '_leggings'))
    slot('feet', '脚部装备', MATERIALS.map(m => m + '_boots'))
  }
  if (ARMED_MOBS.has(id)) {
    if (!capabilities || capabilities.hands) field('nbt.LeftHanded', '惯用手', [[false, '右手'], [true, '左手']])
    slot('mainhand', '主手', HAND_ITEMS)
    slot('offhand', '副手', HAND_ITEMS)
  }
  if (SADDLED_MOBS.has(id) && (!capabilities || capabilities.saddle)) slot('saddle', '鞍具', ['saddle'])
  const type = BODY_EQUIPMENT[id]
  if (type && (!capabilities || capabilities.body)) slot('body', '身体装备', type === 'horse_body' ? MATERIALS.filter(m => m !== 'chainmail').map(m => m + '_horse_armor')
    : type === 'nautilus_body' ? MATERIALS.map(m => m + '_nautilus_armor')
    : type === 'wolf_body' ? ['wolf_armor'] : COLORS.map(c => c + (type === 'llama_body' ? '_carpet' : '_harness')))
  if ((HUMANOID_ARMOR.has(id) || type) && available('dye')) field('preview.equipment_dye', '装备染色', [[null, '默认'], ...COLORS.map((c, i) => [DYES[i], officialName(c + '_dye', 'item')])])
  if ((HUMANOID_ARMOR.has(id) || type || SADDLED_MOBS.has(id)) && available('glint')) field('preview.equipment_glint', '附魔光效', [[false, '否'], [true, '是']])
  if (HUMANOID_ARMOR.has(id) && available('trim')) {
    field('preview.equipment_trim', '盔甲纹饰', [['', '无'], ...itemIds.filter(s => s.endsWith('_armor_trim_smithing_template')).map(s => [s.replace('_armor_trim_smithing_template', ''), officialName(s, 'item')])])
    if (!capabilities || values['preview.equipment_trim']) field('preview.equipment_trim_material', '纹饰材质', [['gold', officialName('gold_ingot', 'item')], ['diamond', officialName('diamond', 'item')], ['emerald', officialName('emerald', 'item')], ['redstone', officialName('redstone', 'item')], ['iron', officialName('iron_ingot', 'item')], ['amethyst', officialName('amethyst_shard', 'item')], ['copper', officialName('copper_ingot', 'item')], ['netherite', officialName('netherite_ingot', 'item')], ['quartz', officialName('quartz', 'item')], ['lapis', officialName('lapis_lazuli', 'item')], ['resin', officialName('resin_brick', 'item')]])
  }
  if (id === 'wolf' && available('damage')) field('preview.equipment_damage', '装备损伤', [[0, '无'], [.1, '轻度'], [.55, '中度'], [.8, '重度']])
  if (id === 'armor_stand') field('nbt.Pose', '盔甲架姿态', [[{}, '默认'], [{ Head: [20, 25, 0], RightArm: [-65, 0, 10], LeftArm: [-20, 0, -10] }, '举手'], [{ Body: [0, 15, 0], RightArm: [-90, -10, 0], LeftArm: [-60, 20, 0], RightLeg: [-15, 0, 0], LeftLeg: [15, 0, 0] }, '持武器']])
  return fields
}

export function applyEquipmentPreview(fixture) {
  const settings = fixture.preview
  if (!settings) return fixture
  const { slots } = equipmentCapabilities(fixture)
  for (const [slot, stack] of Object.entries(fixture.nbt?.equipment || {})) if (stack.id) {
    stack.components ||= {}
    if (slots[slot]?.dye && settings.equipment_dye != null) stack.components['minecraft:dyed_color'] = settings.equipment_dye
    if (slots[slot]?.glint && settings.equipment_glint) stack.components['minecraft:enchantment_glint_override'] = true
    if (slots[slot]?.trim && settings.equipment_trim) stack.components['minecraft:trim'] = { pattern: 'minecraft:' + settings.equipment_trim, material: 'minecraft:' + (settings.equipment_trim_material || 'gold') }
    if (slots[slot]?.damage && settings.equipment_damage) stack.components['minecraft:damage'] = Math.floor(settings.equipment_damage * EQUIPMENT_ITEMS.wolf_armor.maxDamage)
  }
  delete fixture.preview
  return fixture
}
