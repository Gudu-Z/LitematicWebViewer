import { BlockModelResolver } from './blocks.js'
import { markBlockObject } from './selectionSources.js'
import { disposeBlockEffect } from './blockEffects.js'
import { throwIfAborted, withAbort } from './loadingTask.js'

const DIRECTIONS = ['down', 'up', 'north', 'south', 'west', 'east']
const OFFSETS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

// PistonMovingBlockEntity NBT + PistonHeadRenderer, using the saved animation frame.
// A moving_piston without its block entity has no visible model in vanilla.
export function movingPistonParts(nbt = {}) {
  const name = nbt.blockState?.Name
  if (typeof name !== 'string' || /^(minecraft:)?(air|cave_air|void_air|moving_piston)$/.test(name)) return []
  const properties = { ...nbt.blockState.Properties }
  const direction = Number.isInteger(nbt.facing) && OFFSETS[nbt.facing] ? nbt.facing : 0
  const progress = Number.isFinite(nbt.progress) ? Math.max(0, Math.min(1, nbt.progress)) : 0
  const extending = nbt.extending === true || nbt.extending === 1
  const source = nbt.source === true || nbt.source === 1
  const offset = OFFSETS[direction].map(v => v * (extending ? progress - 1 : 1 - progress))
  const id = name.replace(/^minecraft:/, '')
  if (id === 'piston_head') properties.short = String(progress <= .5)
  else if (source && !extending && (id === 'piston' || id === 'sticky_piston')) {
    return [
      { name: 'minecraft:piston_head', properties: { facing: properties.facing || DIRECTIONS[direction], type: id === 'sticky_piston' ? 'sticky' : 'normal', short: String(progress >= .5) }, offset },
      { name, properties: { ...properties, extended: 'true' }, offset: [0, 0, 0] },
    ]
  }
  return [{ name, properties, offset }]
}

export async function addMovingPistons(group, data, assets, visible, buildPreview, options = {}) {
  const { signal } = options
  throwIfAborted(signal)
  if (!data.tileEntities?.length) return
  const { bounds: b, palette, blocks } = data, resolver = new BlockModelResolver(assets)
  const created = []
  let scanned = 0, yieldAt = performance.now() + 8
  try {
    for (const te of data.tileEntities) {
      if ((++scanned & 4095) === 0 && performance.now() >= yieldAt) {
        await withAbort(new Promise(resolve => setTimeout(resolve, 0)), signal)
        throwIfAborted(signal); yieldAt = performance.now() + 8
      }
      if (te.id !== 'minecraft:piston') continue
      const x = te.x - b.minX, y = te.y - b.minY, z = te.z - b.minZ
      if (![x, y, z].every(Number.isInteger) || x < 0 || x >= b.width || y < 0 || y >= b.height || z < 0 || z >= b.depth) continue
      const entry = palette[blocks.get(x + z * b.width + y * b.width * b.depth)]
      if (entry?.name !== 'minecraft:moving_piston' || (visible && !visible(te.x, te.y, te.z, y))) continue
      for (const part of movingPistonParts(te.nbt)) {
        throwIfAborted(signal)
        const baked = await withAbort(resolver.resolve(part.name, part.properties), signal)
        throwIfAborted(signal)
        const pending = Promise.resolve(buildPreview({
          bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, width: 1, height: 1, depth: 1 },
          palette: [{ name: part.name, properties: part.properties, baked }], blocks: new Map([[0, 0]]),
        }, assets)).then(preview => {
          if (signal?.aborted) { disposeBlockEffect(preview); return null }
          return preview
        })
        const preview = await withAbort(pending, signal)
        if (signal?.aborted) { disposeBlockEffect(preview); throwIfAborted(signal) }
        preview.name = 'moving-piston-block'
        preview.position.set(te.x + part.offset[0], te.y + part.offset[1], te.z + part.offset[2])
        group.add(markBlockObject(preview, te.x, te.y, te.z))
        created.push(preview)
        if (performance.now() >= yieldAt) {
          await withAbort(new Promise(resolve => setTimeout(resolve, 0)), signal)
          throwIfAborted(signal); yieldAt = performance.now() + 8
        }
      }
    }
  } catch (error) { created.forEach(disposeBlockEffect); throw error }
}
