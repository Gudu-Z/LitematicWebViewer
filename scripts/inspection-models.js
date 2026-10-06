import { BlockModelResolver } from '../src/blocks.js'
import { buildEntityMesh } from '../src/entities.js'
import { Renderer } from '../src/renderer.js'
import { blockFields, createFixture } from './inspection-catalog.js'

export async function fieldsFor(entry, assets) {
  return blockFields(await assets.getJSON('blockstates/' + entry.id + '.json'), entry.id)
}

export async function buildInspectionModel(entry, assets, values = {}, item = '') {
  if (entry.kind !== 'block') return buildEntityMesh(createFixture(entry, values, item), assets)
  const properties = { ...values }
  const resolver = new BlockModelResolver(assets)
  const baked = await resolver.resolve('minecraft:' + entry.id, properties)
  const data = {
    palette: [{ name: 'minecraft:' + entry.id, properties, baked }], blocks: new Map([[0, 0]]),
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, width: 1, height: 1, depth: 1 },
  }
  const position = { x: 0, y: 0, z: 0, ...properties }
  if (entry.id.endsWith('_banner')) data.banners = [{ ...position, baseColor: entry.id.replace(/_(wall_)?banner$/, ''), patterns: [] }]
  if (entry.id === 'player_head' || entry.id === 'player_wall_head') data.heads = [position]
  if (entry.id === 'decorated_pot') data.pots = [{ ...position, sherds: {} }]
  if (entry.id.endsWith('copper_golem_statue')) {
    const suffix = ['exposed', 'weathered', 'oxidized'].find(s => entry.id.includes(s))
    data.statues = [{ ...position, texKey: 'entity/copper_golem/copper_golem' + (suffix ? '_' + suffix : '') }]
  }
  return Renderer.buildBlockPreview(data, assets)
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
