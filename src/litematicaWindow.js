import { readNBTStream } from './nbtStream.js'

export const MAX_WINDOW_VOLUME = 1_048_576
export const MAX_LOADED_BLOCKS = 2_000_000
export const MAX_WINDOW_FACES = 1_000_000
const MAX_ENTITIES = 4_096
const SKIP = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])
const regionRoots = new Set(['Regions', 'SubRegions'])
const vector = v => Array.isArray(v) ? { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) } : { x: Number(v?.x), y: Number(v?.y), z: Number(v?.z) }
export function loadError(code) { return Object.assign(new Error(code), { code }) }

function dimensions(b) {
  return { ...b, width: b.maxX - b.minX + 1, height: b.maxY - b.minY + 1, depth: b.maxZ - b.minZ + 1 }
}
function regionBounds(region) {
  const pos = vector(region.Position), size = vector(region.Size), b = {}
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isSafeInteger(pos[axis]) || !Number.isSafeInteger(size[axis])) throw loadError('invalidSchematicBounds')
    if (!size[axis]) return null
    const a = axis.toUpperCase()
    b['min' + a] = Math.min(pos[axis], pos[axis] + size[axis] + 1)
    b['max' + a] = b['min' + a] + Math.abs(size[axis]) - 1
  }
  return dimensions(b)
}
export function intersectBounds(a, b) {
  const out = {}
  for (const axis of ['X', 'Y', 'Z']) {
    out['min' + axis] = Math.max(a['min' + axis], b['min' + axis])
    out['max' + axis] = Math.min(a['max' + axis], b['max' + axis])
    if (out['min' + axis] > out['max' + axis]) return null
  }
  return dimensions(out)
}
export function validateWindow(selection, source) {
  for (const axis of ['X', 'Y', 'Z']) {
    const min = selection?.['min' + axis], max = selection?.['max' + axis]
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || min < source['min' + axis] || max > source['max' + axis]) throw loadError('invalidWindow')
  }
  const b = dimensions(selection)
  if (b.width * b.height * b.depth > MAX_WINDOW_VOLUME) throw loadError('windowTooLarge')
  return b
}
export function defaultWindow(bounds) {
  const out = {}
  for (const axis of ['X', 'Y', 'Z']) {
    const size = Math.min(96, bounds['max' + axis] - bounds['min' + axis] + 1)
    out['min' + axis] = Math.floor((bounds['min' + axis] + bounds['max' + axis] - size + 1) / 2)
    out['max' + axis] = out['min' + axis] + size - 1
  }
  return dimensions(out)
}

// Inspection deliberately skips block arrays and entity lists. Region descriptors
// are available before the second pass regardless of the NBT field ordering.
export async function inspectLitematica(file, options = {}) {
  const { root, bytes } = await readNBTStream(file, { ...options, visit: async (r, type, path) => {
    if (path.length === 1 && !['Metadata', 'Version', 'MinecraftDataVersion', 'Regions', 'SubRegions'].includes(path[0])) {
      await r.payload(type, path, false); return {}
    }
    if (regionRoots.has(path[0]) && path.length === 3 && !['Position', 'Size', 'BlockStatePalette'].includes(path[2])) {
      if (path[2] === 'BlockStates' && type === 12) {
        const words = await r.length(), start = r.position, samples = []
        // A few word pairs locate a useful initial window even when the geometric
        // center is empty. Keep raw samples until Size/Palette have been read.
        if (words > 1_000_000) {
          const step = Math.max(2, Math.ceil(words / 4096))
          for (let word = 0; word + 1 < words; word += step) {
            await r.skip(start + word * 8 - r.position)
            samples.push({ word, bytes: (await r.bytes(16)).slice() })
          }
        }
        await r.skip(start + words * 8 - r.position); return { value: { words, samples } }
      }
      await r.payload(type, path, false); return {}
    }
  } })
  const regions = [], source = root.Regions || root.SubRegions
  if (!source || typeof source !== 'object') throw loadError('invalidSchematicBounds')
  let bounds = null, volume = 0
  for (const [name, region] of Object.entries(source)) {
    const b = regionBounds(region)
    if (!b) continue
    const size = b.width * b.height * b.depth, palette = region.BlockStatePalette
    if (!Number.isSafeInteger(size) || !Array.isArray(palette) || !palette.length || palette.length > 65536) throw loadError('invalidSchematicBounds')
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
    if (region.BlockStates?.words < Math.ceil(size * bits / 64) || !Number.isSafeInteger(region.BlockStates?.words)) throw loadError('invalidBlockStates')
    regions.push({ name, ...b, position: vector(region.Position), palette, bits, words: region.BlockStates.words, samples: region.BlockStates.samples })
    volume += size
    if (!bounds) bounds = { ...b }
    else for (const axis of ['X', 'Y', 'Z']) {
      bounds['min' + axis] = Math.min(bounds['min' + axis], b['min' + axis])
      bounds['max' + axis] = Math.max(bounds['max' + axis], b['max' + axis])
    }
  }
  if (!bounds || !Number.isSafeInteger(volume)) throw loadError('invalidSchematicBounds')
  bounds = dimensions(bounds)
  if (!Number.isSafeInteger(bounds.width * bounds.height * bounds.depth)) throw loadError('invalidSchematicBounds')
  let closest, distance = Infinity
  for (const region of regions) {
    for (const sample of region.samples) {
      const index = Math.ceil(sample.word * 64 / region.bits)
      const [value] = decodePackedSpan(sample.bytes, region.bits, index * region.bits - sample.word * 64, 1)
      const name = region.palette[value]?.Name
      if (!name || SKIP.has(name.replace(/^minecraft:/, ''))) continue
      const p = { X: region.minX + index % region.width, Y: region.minY + Math.floor(index / (region.width * region.depth)), Z: region.minZ + Math.floor(index / region.width) % region.depth }
      const d = ['X', 'Y', 'Z'].reduce((sum, a) => sum + ((p[a] - (bounds['min' + a] + bounds['max' + a]) / 2) / (bounds['max' + a] - bounds['min' + a] + 1)) ** 2, 0)
      if (d < distance) { distance = d; closest = p }
    }
    delete region.samples
  }
  const suggestedWindow = defaultWindow(bounds)
  if (closest) for (const a of ['X', 'Y', 'Z']) {
    const width = suggestedWindow['max' + a] - suggestedWindow['min' + a] + 1
    suggestedWindow['min' + a] = Math.max(bounds['min' + a], Math.min(bounds['max' + a] - width + 1, closest[a] - Math.floor(width / 2)))
    suggestedWindow['max' + a] = suggestedWindow['min' + a] + width - 1
  }
  const m = root.Metadata || {}
  const metadata = { name: m.Name ?? '', author: m.Author ?? '', description: m.Description ?? '', regionCount: regions.length,
    totalBlocks: Number(m.TotalBlocks ?? 0), totalVolume: Number(m.TotalVolume ?? volume), enclosingSize: vector(m.EnclosingSize || { x: bounds.width, y: bounds.height, z: bounds.depth }),
    minecraftDataVersion: root.MinecraftDataVersion ?? 0, version: root.Version ?? 0 }
  return { metadata, bounds, regions, suggestedWindow, decompressedBytes: bytes,
    requiresWindow: metadata.totalBlocks > MAX_LOADED_BLOCKS || volume > 16_000_000 || bytes > 128 * 1024 * 1024 }
}

// Packed words are big-endian on disk; palette indices occupy the low bits first.
// startBit is relative to the supplied span, so indices above 2^32 remain exact.
export function decodePackedSpan(bytes, bits, startBit, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), mask = (1 << bits) - 1
  const out = new Uint32Array(count)
  for (let i = 0, bit = startBit; i < count; i++, bit += bits) {
    const word = Math.floor(bit / 64) * 8, offset = bit % 64
    const lo = view.getUint32(word + 4), hi = view.getUint32(word)
    let value
    if (offset < 32) value = offset + bits <= 32 ? lo >>> offset : (lo >>> offset) | (hi << (32 - offset))
    else value = offset + bits <= 64 ? hi >>> (offset - 32) : (hi >>> (offset - 32)) | (view.getUint32(word + 12) << (64 - offset))
    out[i] = value & mask
  }
  return out
}

export async function readLitematicaWindow(file, info, selection, options = {}) {
  if (info.requiresWindow && !selection) throw loadError('windowRequired')
  const bounds = selection ? validateWindow(selection, info.bounds) : info.bounds
  const palette = [], byKey = new Map(), blocks = new Map(), entities = [], tileEntities = []
  const plans = new Map(info.regions.map(region => [region.name, { region, clip: intersectBounds(region, bounds), local: new Map() }]))
  const inside = (x, y, z) => !selection || (x >= bounds.minX && x < bounds.maxX + 1 && y >= bounds.minY && y < bounds.maxY + 1 && z >= bounds.minZ && z < bounds.maxZ + 1)
  function globalIndex(plan, local) {
    if (plan.local.has(local)) return plan.local.get(local)
    const value = plan.region.palette[local]
    if (!value || typeof value.Name !== 'string') throw loadError('invalidBlockStates')
    if (SKIP.has(value.Name.replace(/^minecraft:/, ''))) { plan.local.set(local, -1); return -1 }
    const properties = value.Properties || {}, keys = Object.keys(properties).sort()
    const key = value.Name + (keys.length ? '[' + keys.map(k => k + '=' + properties[k]).join(',') + ']' : '')
    if (!byKey.has(key)) { byKey.set(key, palette.length); palette.push({ name: value.Name, properties, key }) }
    const index = byKey.get(key); plan.local.set(local, index); return index
  }
  async function readBlocks(r, plan) {
    const words = await r.length(), { region, clip } = plan
    if (words !== region.words) throw loadError('invalidBlockStates')
    const start = r.position
    if (clip) {
      let tailWord = -1, tail
      for (let y = clip.minY; y <= clip.maxY; y++) for (let z = clip.minZ; z <= clip.maxZ; z++) for (let x0 = clip.minX; x0 <= clip.maxX; x0 += 65536) {
        const columns = Math.min(65536, clip.maxX - x0 + 1)
        const cell = (y - region.minY) * region.width * region.depth + (z - region.minZ) * region.width + x0 - region.minX
        const first = Math.floor(cell * region.bits / 64), end = Math.ceil((cell + columns) * region.bits / 64)
        let span
        if (first === tailWord) {
          span = new Uint8Array((end - first) * 8); span.set(tail)
          span.set(await r.bytes((end - first - 1) * 8), 8)
        } else {
          await r.skip(start + first * 8 - r.position)
          span = await r.bytes((end - first) * 8)
        }
        tailWord = end - 1; tail = span.slice(-8)
        const decoded = decodePackedSpan(span, region.bits, cell * region.bits - first * 64, columns)
        const row = (y - bounds.minY) * bounds.width * bounds.depth + (z - bounds.minZ) * bounds.width + x0 - bounds.minX
        for (let x = 0; x < decoded.length; x++) {
          const gi = globalIndex(plan, decoded[x])
          if (gi < 0) continue
          blocks.set(row + x, gi)
          if (blocks.size > MAX_LOADED_BLOCKS) throw loadError('windowTooLarge')
        }
      }
    }
    await r.skip(start + words * 8 - r.position)
  }
  const seen = new Set()
  await readNBTStream(file, { ...options, visit: async (r, type, path) => {
    if (!path.length || (path.length === 1 && regionRoots.has(path[0])) || (path.length === 2 && regionRoots.has(path[0]))) return
    if (path.length === 3 && regionRoots.has(path[0])) {
      const plan = plans.get(path[1])
      if (path[2] === 'BlockStates' && plan && type === 12) {
        await readBlocks(r, plan); seen.add(path[1]); return {}
      }
      if ((path[2] === 'Entities' || path[2] === 'TileEntities') && plan && type === 9) {
        const sub = await r.number(1), count = await r.length()
        if (count && sub !== 10) throw loadError('invalidBlockStates')
        for (let i = 0; i < count; i++) {
          // Read one entity at a time; never retain the entire source list.
          const nbt = await r.payload(sub, [], true, 4, false), g = plan.region
          if (path[2] === 'TileEntities') {
            const x = Number(nbt.x) + g.minX, y = Number(nbt.y) + g.minY, z = Number(nbt.z) + g.minZ
            if (inside(x, y, z)) tileEntities.push({ id: nbt.id, x, y, z, nbt, region: g.name })
          } else {
            const p = Array.isArray(nbt.Pos) ? nbt.Pos : [0, 0, 0]
            const pos = [Number(p[0]) + g.position.x, Number(p[1]) + g.position.y, Number(p[2]) + g.position.z]
            if (inside(...pos)) entities.push({ id: nbt.id, pos, rotation: [Number(nbt.Rotation?.[0]) || 0, Number(nbt.Rotation?.[1]) || 0], nbt, region: g.name })
          }
          if (entities.length + tileEntities.length > MAX_ENTITIES) throw loadError('windowTooComplex')
        }
        return {}
      }
    }
    await r.payload(type, path, false); return {}
  } })
  if (seen.size !== plans.size) throw loadError('invalidBlockStates')
  // Animated block overlays and per-block textures are separate from face groups.
  // Bound these too, including schematics that omitted their block-entity NBT.
  if (selection) {
    const special = palette.map(p => /:(bell|enchanting_table|conduit|lectern|decorated_pot|player_head|player_wall_head)$|_banner$|copper_golem_statue$/.test(p.name))
    let count = 0
    for (const gi of blocks.values()) if (special[gi] && ++count > 2048) throw loadError('windowTooComplex')
  }
  return { metadata: info.metadata, palette, blocks, bounds, entities, tileEntities,
    regions: [...plans.values()].filter(p => p.clip).map(p => ({ name: p.region.name, ...p.clip })),
    sourceBounds: info.bounds, selection: selection ? bounds : null, maxFaces: MAX_WINDOW_FACES }
}
