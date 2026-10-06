import { BLOCK_IDS, ITEM_IDS, ZH_NAMES } from './inspection-data.js'
import { ALL_MOB_FIXTURES } from './entity-fixtures.mjs'
import { BLOCK_STATES } from './inspection-block-states.js'
import { EN_NAMES } from './inspection-english.js'
import { BABY_MOBS } from '../src/entityBabies.js'

export { BLOCK_IDS, ITEM_IDS }
export const CATEGORY_NAMES = { block: '方块', mob: '生物', entity: '实体' }
export let language = 'zh'
export function setLanguage(lang) { language = lang === 'en' ? 'en' : 'zh' }
export function officialName(id, kind = 'block', lang = language) {
  id = id.replace(/^minecraft:/, '')
  const alias = id.replace('_wall_banner', '_banner')
  const names = lang === 'en' ? EN_NAMES : ZH_NAMES
  return names[`${kind}.minecraft.${id}`] || names[`block.minecraft.${alias}`]
    || names[`item.minecraft.${id}`] || names[`entity.minecraft.${id}`] || (lang === 'en' ? id.replaceAll('_', ' ') : '未命名对象')
}
const entity = (id, nbt = {}) => ({ id: 'minecraft:' + id, pos: [0, 0, 0], rotation: [0, 0], nbt })
const candleCakes = BLOCK_IDS.filter(id => id === 'candle_cake' || id.endsWith('_candle_cake'))
export function blockFamily(id) {
  if (candleCakes.includes(id)) return 'cake'
  if (id.startsWith('potted_')) return 'flower_pot'
  if (id.endsWith('_cauldron')) return 'cauldron'
  const wall = id.replace('_wall_hanging_sign', '_hanging_sign').replace('_wall_sign', '_sign')
    .replace('_wall_banner', '_banner').replace('_wall_head', '_head').replace('_wall_skull', '_skull')
    .replace('_wall_torch', '_torch').replace(/^wall_torch$/, 'torch').replace('_wall_fan', '_fan')
  return BLOCK_IDS.includes(wall) ? wall : id
}
const families = new Map()
for (const id of BLOCK_IDS) { const family = blockFamily(id); if (!families.has(family)) families.set(family, []); families.get(family).push(id) }
export function blockVariants(id) {
  return [id, ...(families.get(id) || []).filter(v => v !== id)]
}
export function blockIdFor(entry, values = {}) {
  return entry.variants?.includes(values.block) ? values.block : entry.id
}
export function blockVariantLabel(id) {
  if (/(banner|sign|head|skull|torch|coral_fan)$/.test(id)) return id.includes('wall') ? '挂墙' : id.endsWith('hanging_sign') ? '悬挂' : '立地'
  return officialName(id)
}
export const CATALOG = [
  ...BLOCK_IDS.filter(id => blockFamily(id) === id).map(id => ({ key: 'block/' + id, id, kind: 'block', name: officialName(id), variants: blockVariants(id) })),
  ...ALL_MOB_FIXTURES.map(fixture => ({ key: 'mob/' + fixture.id.slice(10), id: fixture.id.slice(10), kind: 'mob', name: officialName(fixture.id, 'entity'), fixture })),
  { key: 'entity/boat', id: 'boat', name: officialName('boat', 'entity'), kind: 'entity', fixture: entity('oak_boat') },
  { key: 'entity/minecart', id: 'minecart', name: officialName('minecart', 'entity'), kind: 'entity', fixture: entity('minecart') },
  { key: 'entity/item_frame', id: 'item_frame', name: officialName('item_frame', 'entity'), kind: 'entity', fixture: entity('item_frame', { Facing: 3 }) },
  { key: 'entity/armor_stand', id: 'armor_stand', name: officialName('armor_stand', 'entity'), kind: 'entity', fixture: entity('armor_stand', { ShowArms: 0 }) },
]
export const ITEM_OPTIONS = ITEM_IDS.map(id => ({ value: id, label: officialName(id, 'item') }))
const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const dyeOptions = DYES.map((id, value) => [value, officialName(id + '_dye', 'item').replace(/染料$/, '')])
const field = (path, label, values) => ({ path, label, options: values.map(([value, label]) => ({ value, label })) })
const state = (key, label, values) => field('nbt.' + key, label, values)
const bool = (key, label, off = '否', on = '是') => state(key, label, [[0, off], [1, on]])
const list = (key, label, ids, labels) => state(key, label, ids.map((v, i) => [v, labels[i]]))
const range = (key, label, values) => state(key, label, values.map(v => [v, String(v)]))
const colors = (key = 'Color', label = '颜色') => state(key, label, dyeOptions)
const climate = () => list('variant', '变种', ['temperate', 'warm', 'cold'], ['温带', '暖地', '寒带'])
const sitting = () => bool('Sitting', '姿态', '站立', '坐下')
const environment = () => bool('OnGround', '环境', '水中 / 滞空', '地面')
const owner = () => state('Owner', '驯服', [[null, '未驯服'], [[1, 2, 3, 4], '已驯服']])

export function entityFields(entry) {
  const id = entry.id, f = []
  if (entry.kind === 'entity') {
    if (id === 'boat') {
      const wood = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo']
      f.push(field('id', '材质与类型', wood.flatMap(w => ['', 'chest_'].map(chest => {
        const type = w + '_' + chest + (w === 'bamboo' ? 'raft' : 'boat')
        return ['minecraft:' + type, officialName(type, 'item')]
      }))))
    }
    if (id === 'minecart') f.push(field('id', '类型', ['minecart', 'chest_minecart', 'furnace_minecart', 'hopper_minecart', 'tnt_minecart', 'command_block_minecart', 'spawner_minecart'].map(type => ['minecraft:' + type, officialName(type, 'entity')])))
    if (id === 'item_frame') f.push(
      field('id', '类型', ['item_frame', 'glow_item_frame'].map(type => ['minecraft:' + type, officialName(type, 'entity')])),
      state('Facing', '朝向', [[3, '南'], [2, '北'], [4, '西'], [5, '东'], [1, '上'], [0, '下']]),
      state('ItemRotation', '物品旋转', Array.from({ length: 8 }, (_, i) => [i, i * 45 + '°'])),
    )
    if (id === 'armor_stand') f.push(bool('ShowArms', '手臂', '隐藏', '显示'), bool('Small', '体型', '正常', '小型'), bool('NoBasePlate', '底座', '显示', '隐藏'))
    return f
  }
  if (BABY_MOBS.has(id)) f.push(state('Age', '年龄', [[0, '成年'], [-24000, '幼年']]))
  if (['pig', 'cow', 'chicken', 'frog'].includes(id)) f.push(climate())
  if (['cod', 'salmon', 'tropical_fish', 'pufferfish', 'axolotl', 'frog', 'chicken', 'bee', 'parrot'].includes(id)) f.push(environment())
  if (['cat', 'wolf', 'parrot'].includes(id)) f.push(sitting())
  if (['cat', 'wolf'].includes(id)) f.push(owner(), colors('CollarColor', '项圈颜色'))
  if (id === 'creeper') f.push(bool('powered', '状态', '普通苦力怕', '闪电苦力怕'))
  if (id === 'pillager') f.push(state('HandItems', '手臂姿态', [[[], '空手'], [[{ id: 'minecraft:crossbow', count: 1 }], '持弩']]))
  if (id === 'wither') f.push(state('Health', '护甲', [[300, '正常'], [140, '半血护甲']]), state('Invul', '生成状态', [[0, '正常'], [200, '无敌阶段']]))
  if (id === 'bat') f.push(state('BatFlags', '姿态', [[0, '飞行'], [1, '倒挂']]))
  if (id === 'sheep') f.push(colors(), bool('Sheared', '羊毛', '未剪毛', '已剪毛'), state('CustomName', '特殊名称', [['', '普通'], ['jeb_', '彩虹羊毛（jeb_）']]))
  if (id === 'pufferfish') f.push(state('PuffState', '膨胀', [[0, '未膨胀'], [1, '半膨胀'], [2, '完全膨胀']]))
  if (id === 'slime' || id === 'magma_cube') f.push(state('Size', '体型', [[0, '小'], [1, '中'], [3, '大']]))
  if (id === 'phantom') f.push(range('Size', '大小', [0, 1, 2, 4, 8]))
  if (id === 'salmon') f.push(list('type', '体型', ['medium', 'small', 'large'], ['中', '小', '大']))
  if (id === 'mooshroom') f.push(list('Type', '变种', ['red', 'brown'], ['红色', '棕色']))
  if (id === 'axolotl') f.push(list('Variant', '变种', ['wild', 'lucy', 'gold', 'cyan', 'blue'], ['棕色', '粉红色', '金色', '青色', '蓝色']))
  if (id === 'cat') f.push(list('variant', '毛色', ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black'], ['虎斑', '黑白', '红色', '暹罗', '英国短毛', '三花', '波斯', '布偶', '白色', 'Jellie', '黑色']))
  if (id === 'wolf') f.push(list('variant', '毛色', ['pale', 'spotted', 'snowy', 'black', 'ashen', 'rusty', 'woods', 'chestnut', 'striped'], ['苍白', '斑点', '雪地', '黑色', '灰烬', '锈色', '森林', '栗色', '条纹']), state('AngerTime', '情绪', [[0, '平静'], [200, '愤怒']]))
  if (id === 'parrot') f.push(list('Variant', '羽色', [0, 1, 2, 3, 4], ['红蓝', '蓝色', '绿色', '黄蓝', '灰色']))
  if (id === 'fox') f.push(list('Type', '变种', ['red', 'snow'], ['红狐', '雪狐']), bool('Sleeping', '姿态', '清醒', '睡眠'), sitting())
  if (id === 'rabbit') f.push(list('RabbitType', '毛色', [0, 1, 2, 3, 4, 5, 99], ['棕色', '白色', '黑色', '黑白花色', '金色', '椒盐色', '杀手兔']), state('CustomName', '特殊名称', [['', '普通'], ['Toast', 'Toast']]))
  if (id === 'panda') for (const key of ['MainGene', 'HiddenGene']) f.push(list(key, key === 'MainGene' ? '显性基因' : '隐性基因', ['normal', 'lazy', 'worried', 'playful', 'brown', 'weak', 'aggressive'], ['普通', '懒惰', '忧郁', '顽皮', '棕色', '虚弱', '好斗']))
  if (id === 'horse') {
    const coats = ['白色', '奶油色', '栗色', '棕色', '黑色', '灰色', '深棕色'], markings = ['无花纹', '白袜', '白色斑块', '白色斑点', '黑色斑点']
    f.push(state('Variant', '毛色与花纹', coats.flatMap((c, i) => markings.map((m, j) => [i | j << 8, c + ' · ' + m]))))
  }
  if (['llama', 'trader_llama'].includes(id)) f.push(list('Variant', '毛色', [0, 1, 2, 3], ['奶油色', '白色', '棕色', '灰色']))
  if (['donkey', 'mule', 'llama', 'trader_llama'].includes(id)) f.push(bool('ChestedHorse', '箱子', '无', '有'))
  if (id === 'bee') f.push(state('AngerTime', '情绪', [[0, '平静'], [200, '愤怒']]), bool('HasNectar', '花蜜', '无', '有'), bool('HasStung', '尾刺', '有', '已使用'))
  if (id === 'strider') f.push(bool('shivering', '温度', '温暖', '寒冷'))
  if (id === 'copper_golem') f.push(list('weather_state', '氧化程度', ['unaffected', 'exposed', 'weathered', 'oxidized'], ['未氧化', '斑驳', '锈蚀', '氧化']))
  if (id === 'shulker') f.push(state('Color', '颜色', [[16, '原色'], ...dyeOptions]), state('Peek', '开合', [[0, '关闭'], [50, '半开'], [100, '全开']]), state('AttachFace', '吸附面', [[0, '地面'], [1, '顶面'], [2, '北墙'], [3, '南墙'], [4, '西墙'], [5, '东墙']]))
  if (id === 'creaking') f.push(bool('active', '状态', '未激活', '激活'))
  if (id === 'iron_golem') f.push(state('Health', '裂纹', [[100, '无'], [70, '轻度'], [40, '中度'], [15, '重度']]))
  if (id === 'bogged') f.push(bool('sheared', '蘑菇', '保留', '已剪除'))
  if (id === 'snow_golem') f.push(bool('Pumpkin', '南瓜', '无', '有'))
  if (id === 'camel') f.push(state('LastPoseTick', '姿态', [[0, '站立'], [-500, '坐下']]))
  if (id === 'armadillo') f.push(list('state', '姿态', ['idle', 'scared'], ['伸展', '蜷缩']))
  if (id === 'goat') f.push(bool('HasLeftHorn', '左角', '无', '有'), bool('HasRightHorn', '右角', '无', '有'))
  if (id === 'turtle') f.push(bool('HasEgg', '状态', '普通', '携带海龟蛋'))
  if (['villager', 'zombie_villager'].includes(id)) f.push(
    list('VillagerData.type', '地区服装', ['plains', 'desert', 'jungle', 'savanna', 'snow', 'swamp', 'taiga'], ['平原', '沙漠', '丛林', '热带草原', '雪地', '沼泽', '针叶林']),
    state('VillagerData.profession', '职业', ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'].map(p => [p, ZH_NAMES['entity.minecraft.villager.' + p]])),
    list('VillagerData.level', '职业等级', [1, 2, 3, 4, 5], ['新手', '学徒', '老手', '专家', '大师']),
  )
  if (id === 'tropical_fish') f.push(
    field('fish.shape', '体型', [[0, '小型'], [1, '大型']]), field('fish.pattern', '花纹', Array.from({ length: 6 }, (_, i) => [i, '花纹 ' + (i + 1)])),
    field('fish.body', '身体颜色', dyeOptions), field('fish.color', '花纹颜色', dyeOptions),
  )
  return f
}

export function getPath(object, path) { return path.split('.').reduce((value, key) => value?.[key], object) }
export function setPath(object, path, value) {
  const keys = path.split('.'), last = keys.pop()
  const target = keys.reduce((obj, key) => obj[key] ||= {}, object)
  target[last] = structuredClone(value)
}
export function createFixture(entry, values = {}, item = '') {
  const fixture = structuredClone(entry.fixture)
  for (const [path, value] of Object.entries(values)) setPath(fixture, path, value)
  if (fixture.fish) {
    const { shape = 0, pattern = 0, body = 0, color = 0 } = fixture.fish
    fixture.nbt.Variant = shape | pattern << 8 | body << 16 | color << 24
    delete fixture.fish
  }
  if (entry.id === 'item_frame' && item) fixture.nbt.Item = { id: 'minecraft:' + item, count: 1 }
  return fixture
}

const PROP_LABELS = { attachment: '安装方式', facing: '朝向', axis: '轴向', half: '半部', type: '类型', shape: '形状', open: '开启', powered: '供能', lit: '点亮', waterlogged: '含水', age: '生长阶段', level: '液面等级', power: '红石信号', rotation: '旋转', north: '北侧', south: '南侧', east: '东侧', west: '西侧', up: '上方连接', down: '下方连接', layers: '层数', bites: '食用次数', part: '部件', hinge: '门轴', face: '附着面', attached: '附着', persistent: '持续存在', distance: '距离', enabled: '启用', conditional: '条件制约', mode: '模式', candles: '蜡烛数量', honey_level: '蜂蜜等级', in_wall: '墙内', occupied: '占用', unstable: '不稳定', triggered: '触发', charges: '充能', eggs: '蛋数量', hatch: '孵化阶段', moisture: '湿润度', snowy: '覆雪', stage: '生长阶段', flower_amount: '花朵数量', orientation: '朝向组合', tilt: '倾斜', drag: '向下流动', hanging: '悬挂', vertical_direction: '垂直朝向', thickness: '粗细', sculk_sensor_phase: '感测阶段', shrieking: '尖啸', can_summon: '允许召唤', bloom: '绽放', berries: '浆果', bottom: '底部', delay: '延迟', locked: '锁定', inverted: '反相', note: '音高', instrument: '乐器', extended: '伸出', short: '缩短', has_book: '有书', has_record: '有唱片', has_bottle_0: '左侧药水', has_bottle_1: '中间药水', has_bottle_2: '右侧药水' }
const VALUE_LABELS = { single_wall: '单墙', double_wall: '双墙', true: '是', false: '否', north: '北', south: '南', west: '西', east: '东', up: '上', down: '下', top: '上', bottom: '下', upper: '上半部', lower: '下半部', double: '双层', single: '单个', left: '左', right: '右', none: '无', low: '低', tall: '高', side: '侧面', straight: '直形', inner_left: '内左', inner_right: '内右', outer_left: '外左', outer_right: '外右', head: '头部', foot: '尾部', floor: '地面', wall: '墙面', ceiling: '顶面', x: '东西', y: '上下', z: '南北', compare: '比较', subtract: '减法', active: '激活', inactive: '静止', cooldown: '冷却' }
const blockRegistry = id => BLOCK_STATES[id] || (id === 'chain' ? BLOCK_STATES.iron_chain : null)
export function blockFields(blockstate, id) {
  const props = new Map()
  const add = (key, value) => {
    if (!props.has(key)) props.set(key, new Set())
    String(value).split('|').forEach(v => props.get(key).add(v))
  }
  for (const variant of Object.keys(blockstate?.variants || {})) for (const pair of variant.split(',')) {
    const [key, value] = pair.split('='); if (value !== undefined) add(key, value)
  }
  const visit = when => {
    for (const [key, value] of Object.entries(when || {})) {
      if (key === 'AND' || key === 'OR') value.forEach(visit)
      else { (Array.isArray(value) ? value : [value]).forEach(v => add(key, v)); if (['true', 'false'].includes(String(value))) add(key, String(value) === 'true' ? 'false' : 'true') }
    }
  }
  for (const part of blockstate?.multipart || []) visit(part.when)
  // 游戏状态报告包含不影响模型选择的属性，尤其是 waterlogged 和墙连接的 none。
  // 保留资源包额外声明的属性，同时用原版报告补全取值集合。
  const registry = blockRegistry(id)
  for (const [key, values] of Object.entries(registry?.[0] || {})) for (const value of values) add(key, value)
  if (['water', 'lava'].includes(id)) for (let i = 0; i < 16; i++) add('level', i)
  const preferred = { facing: 'south', half: 'lower', type: 'single', axis: 'y', shape: 'straight', up: id === 'fire' ? 'false' : 'true', part: 'foot' }
  return [...props].map(([key, set]) => {
    if (key === 'half' && set.has('upper') && set.has('lower')) return field(key, '显示部分', [['all', '全部'], ['upper', '上半'], ['lower', '下半']])
    if (key === 'part' && set.has('head') && set.has('foot')) return field(key, '显示部分', [['all', '全部'], ['head', '床头'], ['foot', '床尾']])
    const values = [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const first = [preferred[key], registry?.[1]?.[key], 'false', 'none', 'bottom', '0'].find(v => set.has(v))
    if (first) values.splice(values.indexOf(first), 1), values.unshift(first)
    return field(key, PROP_LABELS[key] || key, values.map(v => [v, v === 'none' && ['north', 'south', 'west', 'east'].includes(key) ? '不显示' : VALUE_LABELS[v] || v]))
  })
}

export function filterCatalog(scope = 'all', query = '') {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = text => terms.every(term => text.toLowerCase().includes(term))
  const names = (id, kind) => officialName(id, kind, 'zh') + ' ' + officialName(id, kind, 'en')
  const blockText = id => names(id, 'block') + ' ' + blockVariantLabel(id) + ' ' + id
    + (id.includes('wall') ? ' 墙上' : '')
    + (blockRegistry(id)?.[0]?.waterlogged?.includes('true') ? ' 含水 waterlogged' : '')
  const matchingItems = terms.length ? ITEM_OPTIONS.filter(item => matches(names(item.value, 'item') + ' ' + item.value)) : []
  return CATALOG.filter(entry => scope === 'all' || entry.kind === scope).filter(entry => {
    const variantNames = entry.kind === 'block' ? entry.variants.map(blockText).join(' ') : entityFields(entry).flatMap(f => f.options.map(o => o.label + ' ' + o.value)).join(' ')
    return matches(names(entry.id, entry.kind === 'block' ? 'block' : 'entity') + ' ' + entry.id + ' ' + variantNames) || (entry.key === 'entity/item_frame' && matchingItems.length > 0)
  }).map(entry => ({ entry,
    matchedBlock: terms.length && entry.kind === 'block' ? entry.variants.find(id => matches(blockText(id))) : undefined,
    matchedItem: terms.length && entry.key === 'entity/item_frame' ? matchingItems[0]?.value : undefined,
  }))
}
