import { BlockModelResolver } from '../src/blocks.js'
import { buildEntityMesh, buildItemPreview } from '../src/entities.js'
import { Renderer } from '../src/renderer.js'
import { applyRidingPreview } from './inspection-riding.js'
import { cushionColor } from '../src/cushion.js'
import { blockFields, blockIdFor, blockVariantLabel, blockFamily, createFixture, ITEM_IDS, officialName } from './inspection-catalog.js'

export async function fieldsFor(entry, assets, values = {}) {
  const id = blockIdFor(entry, values)
  const fields = blockFields(await assets.getJSON('blockstates/' + id + '.json'), id)
  if (entry.variants?.length > 1) fields.unshift({ path: 'block', label: ['cake', 'cauldron', 'flower_pot'].includes(entry.id) ? '内容' : '放置方式', options: entry.variants.map(value => ({ value, label: blockVariantLabel(value) })) })
  const field = (path, label, options) => fields.push({ path, label, options: options.map(([value, label]) => ({ value, label })) })
  if (['water', 'lava'].includes(id)) field('preview_flow', '流向', [['auto', '自动'], ['still', '静止'], ['north', '北'], ['south', '南'], ['east', '东'], ['west', '西'], ['northeast', '东北'], ['southeast', '东南'], ['southwest', '西南'], ['northwest', '西北']])
  if (id === 'bell') field('preview_ringing', '敲钟演示', [['false', '关闭'], ['true', '播放']])
  if (id === 'enchanting_table') field('preview_book', '书本', [['closed', '无人靠近'], ['open', '展开翻页']])
  if (id === 'moving_piston') {
    field('preview_moved_block', '移动方块', ['stone', 'oak_log', 'glass', 'piston_head', 'piston', 'sticky_piston'].map(id => [id, officialName(id)]))
    field('preview_progress', '移动进度', ['0.5', '0', '0.25', '0.75', '1'].map(n => [n, String(Number(n) * 100) + '%']))
    field('preview_extending', '运动方向', [['true', '伸出'], ['false', '收回']])
    field('preview_source', '活塞源', [['false', '否'], ['true', '是']])
  }
  if (id === 'conduit') {
    field('preview_active', '激活', [['false', '否'], ['true', '是']])
    field('preview_eye', '眼睛', [['false', '闭合'], ['true', '睁开']])
  }
  return fields
}

export async function createBlockSampleData(entry, assets, values = {}) {
  const id = blockIdFor(entry, values), fields = await fieldsFor(entry, assets, values)
  const properties = Object.fromEntries(fields.filter(f => f.path !== 'block').map(f => [f.path,
    f.options.some(o => o.value === values[f.path]) ? values[f.path] : f.options[0].value]))
  let cells = [{ x: 0, y: 0, z: 0, properties }]
  if (properties.half === 'all') {
    cells = [{ x: 0, y: 0, z: 0, properties: { ...properties, half: 'lower' } }]
    // 瓶子草作物到阶段 3 才占上下两格；幼苗的“全部”仍只有一格。
    if (id !== 'pitcher_crop' || Number(properties.age) >= 3) cells.push({ x: 0, y: 1, z: 0, properties: { ...properties, half: 'upper' } })
  } else if (properties.part === 'all') {
    const [dx, dz] = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[properties.facing] || [0, 1]
    cells = [{ x: 0, y: 0, z: 0, properties: { ...properties, part: 'foot' } },
      { x: dx, y: 0, z: dz, properties: { ...properties, part: 'head' } }]
  }
  const resolver = new BlockModelResolver(assets)
  const bounds = {}
  for (const axis of ['x', 'y', 'z']) {
    bounds['min' + axis.toUpperCase()] = Math.min(...cells.map(c => c[axis]))
    bounds['max' + axis.toUpperCase()] = Math.max(...cells.map(c => c[axis]))
  }
  Object.assign(bounds, { width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1, depth: bounds.maxZ - bounds.minZ + 1 })
  const palette = await Promise.all(cells.map(async c => ({ name: 'minecraft:' + id, properties: c.properties, baked: await resolver.resolve('minecraft:' + id, c.properties) })))
  const blocks = new Map(cells.map((c, i) => [(c.x - bounds.minX) + (c.z - bounds.minZ) * bounds.width + (c.y - bounds.minY) * bounds.width * bounds.depth, i]))
  const data = { palette, blocks, bounds }
  const position = { x: 0, y: 0, z: 0, ...properties }
  if (id === 'moving_piston') data.tileEntities = [{ id: 'minecraft:piston', x: 0, y: 0, z: 0, nbt: {
    blockState: { Name: 'minecraft:' + properties.preview_moved_block, Properties: { facing: properties.facing, type: properties.type, axis: 'y', extended: 'false', short: 'false' } },
    facing: ['down', 'up', 'north', 'south', 'west', 'east'].indexOf(properties.facing),
    progress: Number(properties.preview_progress), extending: properties.preview_extending === 'true', source: properties.preview_source === 'true',
  } }]
  if (id.endsWith('_banner')) data.banners = [{ ...position, baseColor: id.replace(/_(wall_)?banner$/, ''), patterns: [] }]
  if (id === 'player_head' || id === 'player_wall_head') data.heads = [position]
  if (id === 'decorated_pot') data.pots = [{ ...position, sherds: {} }]
  if (id.endsWith('copper_golem_statue')) {
    const suffix = ['exposed', 'weathered', 'oxidized'].find(s => id.includes(s))
    data.statues = [{ ...position, pose: properties.copper_golem_pose, texKey: 'entity/copper_golem/copper_golem' + (suffix ? '_' + suffix : '') }]
  }
  return data
}

export function inspectionItemId(entry, values = {}) {
  if (entry.key === 'entity/cushion') return cushionColor(createFixture(entry, values).nbt) + '_cushion'
  let id = entry.kind === 'block' ? blockIdFor(entry, values) : entry.kind === 'mob' ? entry.id + '_spawn_egg' : (values.id || entry.fixture.id).replace('minecraft:', '')
  if (id.startsWith('potted_')) id = 'flower_pot'
  else if (id.endsWith('_cauldron')) id = 'cauldron'
  else if (id.endsWith('candle_cake')) id = 'cake'
  else id = blockFamily(id)
  const aliases = { water: 'water_bucket', lava: 'lava_bucket', bubble_column: 'water_bucket', tripwire: 'string', redstone_wire: 'redstone', wall_torch: 'torch', farmland: 'dirt', dirt_path: 'dirt', wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', sweet_berry_bush: 'sweet_berries', cocoa: 'cocoa_beans', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds' }
  if (!ITEM_IDS.includes(id)) id = aliases[id] || id
  return id !== 'air' && ITEM_IDS.includes(id) ? id : null
}

export async function buildInspectionModel(entry, assets, values = {}, item = '', view = 'world', renderOptions = {}) {
  if (view !== 'world') {
    const id = inspectionItemId(entry, values)
    if (!id) return null
    if (view === 'frame') return buildEntityMesh({ id: 'minecraft:item_frame', pos: [0, 0, 0], rotation: [0, 0], nbt: { Facing: 3, Item: { id: 'minecraft:' + id, count: 1 } } }, assets)
    return buildItemPreview({ id: 'minecraft:' + id, count: 1 }, assets)
  }
  if (entry.kind !== 'block') return buildEntityMesh({ ...applyRidingPreview(createFixture(entry, values, item), entry), renderOptions }, assets)
  return Renderer.buildBlockPreview(await createBlockSampleData(entry, assets, values), assets)
}

// 基础贴图由 AssetProvider 缓存；卡片私有的滚动贴图和合成旗面在移除卡片时释放。
export function disposeInspectionModel(group, sharedTextures = new Set()) {
  const materials = new Set(), geometries = new Set()
  group?.traverse(o => {
    if (o.geometry) geometries.add(o.geometry)
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) materials.add(m)
  })
  geometries.forEach(g => g.dispose())
  materials.forEach(m => { if (m.map && !sharedTextures.has(m.map)) m.map.dispose(); m.dispose() })
}
