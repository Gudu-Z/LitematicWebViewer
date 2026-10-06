import { BlockModelResolver } from '../src/blocks.js'
import { buildEntityMesh } from '../src/entities.js'
import { Renderer } from '../src/renderer.js'
import { blockFields, blockIdFor, blockVariantLabel, createFixture } from './inspection-catalog.js'

export async function fieldsFor(entry, assets, values = {}) {
  const id = blockIdFor(entry, values)
  const fields = blockFields(await assets.getJSON('blockstates/' + id + '.json'), id)
  if (entry.variants?.length > 1) fields.unshift({ path: 'block', label: entry.id === 'cake' ? '种类' : '放置方式', options: entry.variants.map(value => ({ value, label: blockVariantLabel(value) })) })
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
  if (id.endsWith('_banner')) data.banners = [{ ...position, baseColor: id.replace(/_(wall_)?banner$/, ''), patterns: [] }]
  if (id === 'player_head' || id === 'player_wall_head') data.heads = [position]
  if (id === 'decorated_pot') data.pots = [{ ...position, sherds: {} }]
  if (id.endsWith('copper_golem_statue')) {
    const suffix = ['exposed', 'weathered', 'oxidized'].find(s => id.includes(s))
    data.statues = [{ ...position, texKey: 'entity/copper_golem/copper_golem' + (suffix ? '_' + suffix : '') }]
  }
  return data
}

export async function buildInspectionModel(entry, assets, values = {}, item = '') {
  if (entry.kind !== 'block') return buildEntityMesh(createFixture(entry, values, item), assets)
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
