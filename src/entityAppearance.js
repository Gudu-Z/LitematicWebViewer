// 原版实体的外观、NBT 变种与 feature layer 选择。
import { ENTITY_MODELS } from './entityModelData.js'
import { EXTRA_MODELS } from './extraEntityModels.js'
import { babyModel, isBaby, BABY_MOBS } from './entityBabies.js'
import { readEquipment } from './equipmentState.js'

// 生物实体 id -> [模型键, 贴图键]
export const MOB_TABLE = {
  pig: ['PigEntityModel', 'entity/pig/pig_temperate'],
  cow: ['CowEntityModel', 'entity/cow/cow_temperate'],
  mooshroom: ['CowEntityModel', 'entity/cow/mooshroom_red'],
  sheep: ['SheepEntityModel', 'entity/sheep/sheep'],
  goat: ['GoatEntityModel', 'entity/goat/goat'],
  panda: ['PandaEntityModel', 'entity/panda/panda'],
  polar_bear: ['PolarBearEntityModel', 'entity/bear/polarbear'],
  wolf: ['WolfEntityModel', 'entity/wolf/wolf'],
  cat: ['Feline', 'entity/cat/cat_tabby', 0.8],
  ocelot: ['Feline', 'entity/cat/ocelot'],
  fox: ['FoxEntityModel', 'entity/fox/fox'],
  rabbit: ['AdultRabbitModel', 'entity/rabbit/rabbit_brown'],
  horse: ['Horse', 'entity/horse/horse_brown', 1.1],
  donkey: ['Horse', 'entity/horse/donkey'],
  mule: ['Horse', 'entity/horse/mule'],
  llama: ['LlamaEntityModel', 'entity/llama/llama_creamy'],
  turtle: ['TurtleEntityModel', 'entity/turtle/turtle'],
  chicken: ['ChickenEntityModel', 'entity/chicken/chicken_temperate'],
  frog: ['FrogEntityModel', 'entity/frog/frog_temperate'],
  axolotl: ['AxolotlEntityModel', 'entity/axolotl/axolotl_wild'],
  camel: ['CamelEntityModel', 'entity/camel/camel'],
  sniffer: ['SnifferEntityModel', 'entity/sniffer/sniffer'],
  armadillo: ['ArmadilloEntityModel', 'entity/armadillo/armadillo'],
  allay: ['AllayEntityModel', 'entity/allay/allay'],
  hoglin: ['HoglinEntityModel', 'entity/hoglin/hoglin'],
  zoglin: ['HoglinEntityModel', 'entity/hoglin/zoglin'],
  strider: ['StriderEntityModel', 'entity/strider/strider'],
  dolphin: ['DolphinEntityModel', 'entity/dolphin/dolphin'],
  squid: ['SquidEntityModel', 'entity/squid/squid'],
  glow_squid: ['SquidEntityModel', 'entity/squid/glow_squid'],
  cod: ['CodEntityModel', 'entity/fish/cod'],
  salmon: ['SalmonEntityModel', 'entity/fish/salmon'],
  pufferfish: ['MediumPufferfishEntityModel', 'entity/fish/pufferfish'],
  bat: ['BatEntityModel', 'entity/bat/bat'],
  parrot: ['ParrotEntityModel', 'entity/parrot/parrot_red_blue'],
  bee: ['BeeEntityModel', 'entity/bee/bee'],
  zombie: ['Biped', 'entity/zombie/zombie'],
  husk: ['Biped', 'entity/zombie/husk', 1.0625],
  drowned: ['DrownedEntityModel', 'entity/zombie/drowned', 1, ['entity/zombie/drowned_outer_layer']],
  zombie_villager: ['ZombieVillagerEntityModel', 'entity/zombie_villager/zombie_villager'],
  skeleton: ['SkeletonEntityModel', 'entity/skeleton/skeleton'],
  stray: ['SkeletonEntityModel', 'entity/skeleton/stray', 1, ['entity/skeleton/stray_overlay']],
  bogged: ['BoggedEntityModel', 'entity/skeleton/bogged', 1, ['entity/skeleton/bogged_overlay']],
  wither_skeleton: ['SkeletonEntityModel', 'entity/skeleton/wither_skeleton', 1.2],
  creeper: ['CreeperEntityModel', 'entity/creeper/creeper'],
  spider: ['SpiderEntityModel', 'entity/spider/spider'],
  cave_spider: ['SpiderEntityModel', 'entity/spider/cave_spider', 0.7],
  enderman: ['EndermanEntityModel', 'entity/enderman/enderman'],
  witch: ['WitchEntityModel', 'entity/witch/witch', 0.9375],
  blaze: ['BlazeEntityModel', 'entity/blaze/blaze'],
  ghast: ['GhastEntityModel', 'entity/ghast/ghast'],
  phantom: ['PhantomEntityModel', 'entity/phantom/phantom'],
  slime: ['SlimeEntityModel', 'entity/slime/slime'],
  magma_cube: ['MagmaCubeEntityModel', 'entity/slime/magmacube'],
  silverfish: ['SilverfishEntityModel', 'entity/silverfish/silverfish'],
  endermite: ['EndermiteEntityModel', 'entity/endermite/endermite'],
  shulker: ['ShulkerEntityModel', 'entity/shulker/shulker'],
  guardian: ['GuardianEntityModel', 'entity/guardian/guardian'],
  elder_guardian: ['GuardianEntityModel', 'entity/guardian/guardian_elder', 2.35],
  wither: ['WitherEntityModel', 'entity/wither/wither', 2],
  ravager: ['RavagerEntityModel', 'entity/illager/ravager'],
  vex: ['VexEntityModel', 'entity/illager/vex'],
  warden: ['WardenEntityModel', 'entity/warden/warden'],
  breeze: ['BreezeEntityModel', 'entity/breeze/breeze'],
  creaking: ['CreakingEntityModel', 'entity/creaking/creaking'],
  villager: ['Villager', 'entity/villager/villager', 0.9375],
  wandering_trader: ['Villager', 'entity/wandering_trader/wandering_trader', 0.9375],
  pillager: ['IllagerEntityModel', 'entity/illager/pillager', 0.9375],
  vindicator: ['IllagerEntityModel', 'entity/illager/vindicator', 0.9375],
  evoker: ['IllagerEntityModel', 'entity/illager/evoker', 0.9375],
  illusioner: ['IllagerEntityModel', 'entity/illager/illusioner', 0.9375],
  iron_golem: ['IronGolemEntityModel', 'entity/iron_golem/iron_golem'],
  snow_golem: ['SnowGolemEntityModel', 'entity/snow_golem/snow_golem'],
  piglin: ['Piglin', 'entity/piglin/piglin'],
  piglin_brute: ['Piglin', 'entity/piglin/piglin_brute'],
  zombified_piglin: ['Piglin', 'entity/piglin/zombified_piglin'],
  // 之前漏掉的实体（26.3 新增/旧实体）：
  ender_dragon: ['DragonEntityModel', 'entity/enderdragon/dragon'],
  happy_ghast: ['HappyGhastEntityModel', 'entity/ghast/happy_ghast'],
  copper_golem: ['CopperGolemEntityModel', 'entity/copper_golem/copper_golem'],
  tadpole: ['TadpoleEntityModel', 'entity/tadpole/tadpole'],
  tropical_fish: ['SmallTropicalFishEntityModel', 'entity/fish/tropical_a'],
  trader_llama: ['LlamaEntityModel', 'entity/llama/llama_creamy', 1, ['entity/equipment/llama_body/trader_llama']],
  skeleton_horse: ['Horse', 'entity/horse/horse_skeleton'],
  zombie_horse: ['Horse', 'entity/horse/horse_zombie'],
  giant: ['Biped', 'entity/zombie/zombie', 6],
}

export const DYE_COLORS = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21]
const DYE_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const short = value => String(value ?? '').replace(/^minecraft:/, '')
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
const choice = (value, names, fallback = names[0]) => typeof value === 'number' ? (names[value] || fallback) : (names.includes(short(value)) ? short(value) : fallback)
const dye = value => DYE_COLORS[typeof value === 'string' ? Math.max(0, DYE_NAMES.indexOf(short(value))) : clamp(value, 0, 15)]
const getModel = key => ENTITY_MODELS[key] || EXTRA_MODELS[key]
const woolColors = DYE_COLORS.map((color, i) => i === 0 ? 0xe6e6e6 : [16, 8, 0].reduce((rgb, shift) => rgb | Math.floor((color >> shift & 255) * 0.75) << shift, 0))
function customName(nbt) {
  let value = nbt.CustomName ?? nbt.custom_name ?? ''
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* 普通字符串名称 */ } }
  const flatten = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(flatten).join('') : v ? (v.text || '') + (v.extra || []).map(flatten).join('') : ''
  return flatten(value)
}
function rainbowWool(age) {
  const index = Math.floor(age / 25) % 16, fraction = age % 25 / 25
  return [16, 8, 0].reduce((rgb, shift) => {
    const a = woolColors[index] >> shift & 255, b = woolColors[(index + 1) % 16] >> shift & 255
    return rgb | Math.floor(a + (b - a) * fraction) << shift
  }, 0)
}

export function transformEntityModel(model, visit) {
  const copy = structuredClone(model)
  const walk = nodes => { for (const [name, node] of Object.entries(nodes)) { visit(node, name); walk(node.children || {}) } }
  walk(copy.parts)
  return copy
}
export function dilateEntityModel(model, amount) {
  return transformEntityModel(model, node => {
    for (const box of node.cuboids || []) box.dil = (box.dil || [0, 0, 0]).map(n => n + amount)
  })
}
export function selectEntityParts(model, names) {
  const included = new Set(names)
  return transformEntityModel(model, (node, name) => { if (!included.has(name)) node.cuboids = [] })
}

function entitySeed(entity) {
  let seed = 2166136261
  for (const char of JSON.stringify(entity.nbt?.UUID || entity.pos)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619)
  return seed >>> 0
}

function isInWater(entity, data) {
  if (!data?.bounds || !data.blocks) return !entity.nbt?.OnGround
  const b = data.bounds
  const x = Math.floor(entity.pos[0]) - b.minX, y = Math.floor(entity.pos[1]) - b.minY, z = Math.floor(entity.pos[2]) - b.minZ
  if (x < 0 || y < 0 || z < 0 || x >= b.width || y >= b.height || z >= b.depth) return false
  const entry = data.palette[data.blocks.get(x + z * b.width + y * b.width * b.depth)]
  return ['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(short(entry?.name)) || entry?.properties?.waterlogged === 'true'
}

export function getMobAppearance(entity, id, data) {
  const entry = MOB_TABLE[id]
  if (!entry) return null
  const n = entity.nbt || {}, seed = entitySeed(entity)
  const state = {
    ...entity, seed, touchingWater: isInWater(entity, data),
    squidSpeed: 0.2 / (1 + seed % 1000 / 1000),
    sitting: !!(n.Sitting || n.sitting || (id === 'camel' && Number(n.LastPoseTick) < 0)),
    rolledUp: ['scared', 'rolling'].includes(short(n.state)),
  }
  let model = getModel(entry[0]), texture = entry[1], scale = entry[2] || model?.scale || 1, tint = 0xffffff
  const layers = []
  const add = (name, tex, layerModel = model, options = {}) => layers.push({ name, texture: tex, model: layerModel, mode: 'cutout', ...options })
  const variant = n['minecraft:variant'] ?? n.variant ?? n.Variant
  // 使用投影保存的变种，不把所有个体强制渲染成同一皮肤。
  if (['pig', 'cow', 'chicken'].includes(id)) texture = `entity/${id}/${id}_${choice(variant, ['temperate', 'warm', 'cold'])}`
  if (id === 'mooshroom') texture = `entity/cow/mooshroom_${choice(n.Type ?? variant, ['red', 'brown'])}`
  if (id === 'axolotl') texture = `entity/axolotl/axolotl_${choice(variant, ['lucy', 'wild', 'gold', 'cyan', 'blue'], 'wild')}`
  if (id === 'frog') texture = `entity/frog/frog_${choice(variant, ['temperate', 'warm', 'cold'])}`
  if (id === 'parrot') texture = `entity/parrot/parrot_${choice(variant, ['red_blue', 'blue', 'green', 'yellow_blue', 'grey'])}`
  if (id === 'fox') texture = `entity/fox/${choice(n.Type ?? variant, ['red', 'snow']) === 'snow' ? 'snow_fox' : 'fox'}${n.Sleeping ? '_sleep' : ''}`
  if (id === 'rabbit') texture = 'entity/rabbit/rabbit_' + (customName(n) === 'Toast' ? 'toast' : n.RabbitType === 99 ? 'caerbannog' : choice(n.RabbitType ?? variant, ['brown', 'white', 'black', 'white_splotched', 'gold', 'salt']))
  if (id === 'cat') {
    const cat = choice(variant ?? n.CatType, ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black'])
    texture = `entity/cat/${cat === 'all_black' ? 'all_black' : 'cat_' + cat}`
    if (n.Owner || n.OwnerUUID) add('collar', 'entity/cat/cat_collar', model, { tint: dye(n.CollarColor ?? 14) })
  }
  if (id === 'wolf') {
    const wolf = choice(variant, ['pale', 'spotted', 'snowy', 'black', 'ashen', 'rusty', 'woods', 'chestnut', 'striped'])
    const tamed = !!(n.Owner || n.OwnerUUID), angry = n.AngerTime > 0
    texture = `entity/wolf/wolf${wolf === 'pale' ? '' : '_' + wolf}${angry ? '_angry' : tamed ? '_tame' : ''}`
    if (tamed) add('collar', 'entity/wolf/wolf_collar', model, { tint: dye(n.CollarColor ?? 14) })
  }
  if (id === 'panda') {
    const gene = choice(n.MainGene, ['normal', 'lazy', 'worried', 'playful', 'brown', 'weak', 'aggressive'])
    const recessive = ['brown', 'weak'].includes(gene) && n.HiddenGene !== gene
    texture = `entity/panda/${recessive || gene === 'normal' ? 'panda' : gene + '_panda'}`
  }
  if (id === 'horse') {
    const packed = Number(n.Variant) || 0
    texture = 'entity/horse/horse_' + choice(packed & 255, ['white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'darkbrown'], 'brown')
    const markings = ['', 'white', 'whitefield', 'whitedots', 'blackdots'][(packed >>> 8) & 255]
    if (markings) add('markings', 'entity/horse/horse_markings_' + markings)
  }
  if (id === 'llama' || id === 'trader_llama') texture = 'entity/llama/llama_' + choice(variant, ['creamy', 'white', 'brown', 'gray'])
  if (id === 'donkey' || id === 'mule') {
    scale = id === 'donkey' ? 0.87 : 0.92
    model = transformEntityModel(model, (node, name) => {
      if (name === 'body' && n.ChestedHorse) for (const [side, sign] of [['left', 1], ['right', -1]]) node.children[side + '_chest'] = {
        pivot: [6 * sign, -8, 0], rot: [0, -sign * Math.PI / 2, 0],
        cuboids: [{ u: 26, v: 21, x: -4, y: 0, z: -2, dx: 8, dy: 8, dz: 3 }],
      }
      if (name === 'left_ear' || name === 'right_ear') {
        const sign = name === 'left_ear' ? 1 : -1
        node.pivot = [sign * 1.25, -10, 4]; node.rot = [Math.PI / 12, 0, sign * Math.PI / 12]
        node.cuboids = [{ u: 0, v: 12, x: -1, y: -7, z: 0, dx: 2, dy: 7, dz: 1 }]
      }
    })
  }
  if (id === 'bee') texture = 'entity/bee/bee' + (n.AngerTime > 0 ? '_angry' : '') + (n.HasNectar ? '_nectar' : '')
  if (id === 'strider' && (n.shivering || n.Shivering)) texture = 'entity/strider/strider_cold'
  if (id === 'copper_golem') {
    const oxidation = choice(n.weather_state ?? n.oxidation_level, ['unaffected', 'exposed', 'weathered', 'oxidized'])
    texture = 'entity/copper_golem/copper_golem' + (oxidation === 'unaffected' ? '' : '_' + oxidation)
    add('eyes', texture.replace('copper_golem/copper_golem', 'copper_golem/copper_golem_eyes'), selectEntityParts(model, ['head']), { mode: 'eyes' })
  }
  if (id === 'pufferfish') model = getModel(['SmallPufferfishEntityModel', 'MediumPufferfishEntityModel', 'LargePufferfishEntityModel'][clamp(n.PuffState, 0, 2)])
  if (id === 'salmon') scale *= ({ small: 0.5, medium: 1, large: 1.5 })[short(n.type ?? n.Type)] || 1
  if (id === 'tropical_fish') {
    const packed = Number(n.Variant) >>> 0
    const large = (packed & 255) === 1, kind = large ? 'b' : 'a'
    model = getModel(large ? 'LargeTropicalFishEntityModel' : 'SmallTropicalFishEntityModel')
    texture = `entity/fish/tropical_${kind}`
    tint = dye((packed >>> 16) & 255)
    add('pattern', `entity/fish/tropical_${kind}_pattern_${clamp((packed >>> 8) & 255, 0, 5) + 1}`, model, { tint: dye((packed >>> 24) & 255) })
  }
  if (id === 'slime' || id === 'magma_cube') {
    scale *= clamp((Number(n.Size) || 0) + 1, 1, 128)
    if (id === 'slime') add('slime_shell', texture, EXTRA_MODELS.SlimeOuterEntityModel, { mode: 'translucent' })
  }
  if (id === 'phantom') scale *= 1 + 0.15 * clamp(n.Size, 0, 64)
  if (id === 'shulker') {
    if (n.Color != null && Number(n.Color) >= 0 && Number(n.Color) < 16) texture += '_' + DYE_NAMES[Number(n.Color)]
    // 原解析器只提取了共用箱体 getModelData，实体还需要 getTexturedModelData 添加的头部。
    model = structuredClone(model)
    model.parts.head = { pivot: [0, 12, 0], cuboids: [{ u: 0, v: 52, x: -3, y: 0, z: -3, dx: 6, dy: 6, dz: 6 }] }
  }
  if (id === 'creeper' && (n.powered || n.Powered)) add('charged_creeper', 'entity/creeper/creeper_armor', dilateEntityModel(model, 2), { mode: 'swirl', offset: age => [age * 0.01 % 1, age * 0.01 % 1] })
  if (id === 'wither') {
    const invul = clamp(n.Invul, 0, 220)
    if (invul > 0) { texture = 'entity/wither/wither_invulnerable'; scale = 2 - invul / 220 * 0.5 }
    const maxHealthAttribute = (n.attributes || n.Attributes || []).find(a => ['max_health', 'generic.max_health'].includes(short(a.id ?? a.Name)))
    const maxHealth = Number(maxHealthAttribute?.base ?? maxHealthAttribute?.Base) || 300
    if (Number(n.Health) <= maxHealth / 2) add('wither_armor', 'entity/wither/wither_armor', dilateEntityModel(model, 0.5), { mode: 'swirl', offset: age => [Math.cos(age * 0.02) * 3 % 1, age * 0.01 % 1] })
  }
  if (id === 'breeze') {
    add('breeze_wind', 'entity/breeze/breeze_wind', EXTRA_MODELS.BreezeWindEntityModel, { mode: 'wind', offset: age => [age * 0.02 % 1, 0] })
    add('eyes', 'entity/breeze/breeze_eyes', selectEntityParts(model, ['head']), { mode: 'emissive' })
  }
  const eyes = { spider: 'spider/spider_eyes', cave_spider: 'spider/spider_eyes', enderman: 'enderman/enderman_eyes', phantom: 'phantom/phantom_eyes', ender_dragon: 'enderdragon/dragon_eyes' }[id]
  if (eyes) add('eyes', 'entity/' + eyes, model, { mode: 'eyes' })
  if (id === 'creaking' && (n.active || n.Active)) add('eyes', 'entity/creaking/creaking_eyes', selectEntityParts(model, ['head']), { mode: 'eyes' })
  if (id === 'warden') {
    add('bioluminescence', 'entity/warden/warden_bioluminescent_layer', selectEntityParts(model, ['head', 'left_arm', 'right_arm', 'left_leg', 'right_leg']), { mode: 'emissive' })
    for (let i = 0; i < 2; i++) add('pulsating_spots_' + (i + 1), `entity/warden/warden_pulsating_spots_${i + 1}`, selectEntityParts(model, ['body', 'head', 'left_arm', 'right_arm', 'left_leg', 'right_leg']), { mode: 'emissive', opacity: age => Math.max(0, Math.cos(age * 0.045 + i * Math.PI) * 0.25) })
    // 原版安静状态每 40 tick 一次心跳，亮度在 10 tick 内衰减。
    add('heart', 'entity/warden/warden_heart', selectEntityParts(model, ['body']), { mode: 'emissive', opacity: age => Math.max(0, 1 - age % 40 / 10) })
  }
  if (id === 'sheep') {
    const color = clamp(n.Color, 0, 15), rainbow = customName(n) === 'jeb_'
    const options = { tint: woolColors[color], ...(rainbow ? { animatedTint: rainbowWool } : {}) }
    if (rainbow || color !== 0) add('undercoat', 'entity/sheep/sheep_wool_undercoat', model, options)
    if (!n.Sheared) add('wool', 'entity/sheep/sheep_wool', EXTRA_MODELS.SheepWoolEntityModel, options)
  }
  if (id === 'iron_golem' && Number.isFinite(n.Health)) {
    const maxAttribute = (n.attributes || n.Attributes || []).find(a => ['max_health', 'generic.max_health'].includes(short(a.id ?? a.Name)))
    const health = n.Health / (Number(maxAttribute?.base ?? maxAttribute?.Base) || 100)
    const cracks = health < 0.25 ? 'high' : health < 0.5 ? 'medium' : health < 0.75 ? 'low' : null
    if (cracks) add('cracks', 'entity/iron_golem/iron_golem_crackiness_' + cracks)
  }
  if (id === 'drowned') add('outer_layer', 'entity/zombie/drowned_outer_layer', dilateEntityModel(model, 0.25))
  if (id === 'stray' || id === 'bogged') {
    const outer = dilateEntityModel(getModel('Biped'), id === 'stray' ? 0.25 : 0.2)
    outer.w = 64; outer.h = 32
    add('outer_layer', `entity/skeleton/${id}_overlay`, outer)
    if (id === 'bogged' && n.sheared) model = transformEntityModel(model, (node, name) => { if (name.includes('mushroom')) node.cuboids = [] })
  }
  if (id === 'trader_llama' && !readEquipment(n).body) add('carpet', 'entity/equipment/llama_body/trader_llama')
  if (id === 'villager' || id === 'zombie_villager') {
    const villager = n.VillagerData || {}, type = choice(villager.type, ['plains', 'desert', 'jungle', 'savanna', 'snow', 'swamp', 'taiga'])
    add('biome_clothes', `entity/${id}/type/${type}`)
    const profession = choice(villager.profession, ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'])
    if (profession !== 'none' && !(Number(n.Age) < 0 || n.IsBaby)) {
      add('profession', `entity/${id}/profession/${profession}`)
      if (profession !== 'nitwit') add('profession_level', `entity/${id}/profession_level/${['stone', 'iron', 'gold', 'emerald', 'diamond'][clamp((Number(villager.level) || 1) - 1, 0, 4)]}`)
    }
  }
  // 默认遵循原版 setAngles 的可见性；图鉴趣味开关可让三种灾厄村民同时保留两套手臂。
  if (['pillager', 'vindicator', 'evoker', 'illusioner'].includes(id)) model = transformEntityModel(model, (node, name) => {
    // PillagerEntity.getState 返回 NEUTRAL / CROSSBOW_HOLD，永远不返回 CROSSED。
    // 其余灾厄村民的静止状态保留交叉手臂；不能把掠夺者的独立双臂一并删掉。
    if (id === 'pillager' && name === 'arms') { node.cuboids = []; node.children = {} }
    if ((id !== 'pillager' && !entity.renderOptions?.illagerExtraArms && ['right_arm', 'left_arm'].includes(name)) || (name === 'hat' && id !== 'illusioner')) node.cuboids = []
  })
  if (id === 'goat') model = transformEntityModel(model, (node, name) => {
    if ((name === 'left_horn' && n.HasLeftHorn != null && !n.HasLeftHorn) || (name === 'right_horn' && n.HasRightHorn != null && !n.HasRightHorn)) node.cuboids = []
  })
  if (id === 'armadillo' && state.rolledUp) model = transformEntityModel(model, (node, name) => { if (name === 'body') node.cuboids = [] })
  if (BABY_MOBS.has(id) && isBaby(n)) {
    const baby = babyModel(id)
    state.babyModel = !!baby
    const babyTexture = key => {
      if (id === 'sniffer') return key
      if (id === 'fox') key = key.replace('snow_fox', 'fox_snow')
      if (id === 'cat') key = key.replace('/all_black', '/cat_all_black')
      if (key.includes('/type/')) return key.replace('/type/', '/baby/')
      return key + '_baby'
    }
    texture = babyTexture(texture)
    if (baby) { model = structuredClone(baby); scale = baby.scale || 1 }
    if (id === 'happy_ghast') {
      model = structuredClone(model)
      model.parts.body.children.inner_body = { pivot: [0, 8, 0], rot: [0, 0, 0], children: {},
        cuboids: [{ u: 0, v: 32, x: -8, y: -16, z: -8, dx: 16, dy: 16, dz: 16, dil: [-.5, -.5, -.5] }] }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (layer.name === 'undercoat') { layers.splice(i, 1); continue }
      layer.texture = babyTexture(layer.texture)
      layer.model = layer.name === 'outer_layer' ? dilateEntityModel(model, .25) : model
      if (layer.name === 'wool') layer.model = dilateEntityModel(model, .01)
      if (layer.name === 'collar' && id === 'cat') layer.model = dilateEntityModel(model, .01)
    }
    if (id === 'llama' || id === 'trader_llama') model = transformEntityModel(model, (node, name) => { if (name.endsWith('_chest') && !n.ChestedHorse) node.cuboids = [] })
    if (id === 'armadillo') model = transformEntityModel(model, (node, name) => { if (name === (state.rolledUp ? 'body' : 'cube')) node.cuboids = [] })
    if (id === 'goat') model = transformEntityModel(model, (node, name) => { if ((name.includes('left_horn') && n.HasLeftHorn === 0) || (name.includes('right_horn') && n.HasRightHorn === 0)) node.cuboids = [] })
  }
  return { model, texture, scale, tint, layers, state }
}
