// .litematica 文件解析：NBT -> 元数据 + 全局调色板 + 世界坐标方块映射。
// 关键格式事实（已核实）：
//   - 根字段：Metadata / Version / MinecraftDataVersion / Regions
//   - 每个区域：Position / Size（可能为负）/ BlockStatePalette / BlockStates（位压缩 LongArray）
//   - 位宽 bits = max(2, ceil(log2(paletteSize)))
//   - 索引顺序 idx = y * (dx*dz) + z * dx + x（x 最快）
//   - 位序：小端序（第 0 个方块在第 0 个 long 的低位）
//   - 世界最小角 world = min(origin, origin + size + 1)

import { parseNBT, decompressNBT } from './nbt.js'

// 解码位压缩的 BlockStates（小端序），返回每个位置的调色板索引。
export function decodeBlockStates(longs, bits, total) {
  const out = new Uint32Array(total)
  const mask = (1n << BigInt(bits)) - 1n
  for (let i = 0; i < total; i++) {
    const start = i * bits
    const word = start >> 6
    const off = start & 63
    let v
    if (off + bits <= 64) {
      v = (BigInt.asUintN(64, longs[word]) >> BigInt(off)) & mask
    } else {
      const low = BigInt.asUintN(64, longs[word]) >> BigInt(off)
      const hiBits = off + bits - 64
      const hi = BigInt.asUintN(64, longs[word + 1]) & ((1n << BigInt(hiBits)) - 1n)
      v = low | (hi << BigInt(64 - off))
    }
    out[i] = Number(v)
  }
  return out
}

// Litematica 中 Position/Size/EnclosingSize 是 compound {x,y,z}；
// 这里同时兼容 compound 和 list 两种写法。
function vec(v) {
  if (!v) return { x: 0, y: 0, z: 0 }
  if (Array.isArray(v)) return { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) }
  return { x: Number(v.x), y: Number(v.y), z: Number(v.z) }
}

// 解析 .litematica 的 ArrayBuffer，返回：
// { metadata, palette: [{name, properties, key}], blocks: Map<"x,y,z" -> paletteIndex>, bounds }
export function parseLitematicaRaw(rawBytes) {
  const root = parseNBT(rawBytes)

  const meta = root.Metadata || {}
  const metadata = {
    name: meta.Name ?? '',
    author: meta.Author ?? '',
    description: meta.Description ?? '',
    regionCount: meta.RegionCount ?? 0,
    totalBlocks: meta.TotalBlocks ?? 0,
    totalVolume: meta.TotalVolume ?? 0,
    enclosingSize: vec(meta.EnclosingSize),
    minecraftDataVersion: root.MinecraftDataVersion ?? 0,
    version: root.Version ?? 0,
  }

  const regions = root.Regions || root.SubRegions
  if (!regions || typeof regions !== 'object') {
    throw new Error('文件中没有 Regions 数据')
  }

  const palette = []
  const paletteIndexByKey = new Map()
  const getGlobalIndex = (name, properties) => {
    const props = properties || {}
    const keys = Object.keys(props).sort()
    const key = name + (keys.length ? '[' + keys.map((k) => k + '=' + props[k]).join(',') + ']' : '')
    let idx = paletteIndexByKey.get(key)
    if (idx === undefined) {
      idx = palette.length
      palette.push({ name, properties: props, key })
      paletteIndexByKey.set(key, idx)
    }
    return idx
  }

  const blocks = new Map()
  const tileEntities = [] // 方块实体（如告示牌）
  const entities = [] // 实体（如矿车、物品展示框）
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const region of Object.values(regions)) {
    const pos = vec(region.Position)
    const size = vec(region.Size)

    const dx = Math.abs(size.x)
    const dy = Math.abs(size.y)
    const dz = Math.abs(size.z)
    if (dx === 0 || dy === 0 || dz === 0) continue

    const wx0 = Math.min(pos.x, pos.x + size.x + 1)
    const wy0 = Math.min(pos.y, pos.y + size.y + 1)
    const wz0 = Math.min(pos.z, pos.z + size.z + 1)

    const paletteList = region.BlockStatePalette || []
    const localToGlobal = new Array(paletteList.length)
    for (let i = 0; i < paletteList.length; i++) {
      localToGlobal[i] = getGlobalIndex(paletteList[i].Name, paletteList[i].Properties)
    }

    if (Array.isArray(region.TileEntities)) {
      for (const te of region.TileEntities) {
        tileEntities.push({ id: te.id, x: te.x, y: te.y, z: te.z, nbt: te })
      }
    }

    // 实体：Pos 是 double 列表、Rotation 是 [yaw, pitch]，与方块实体不同。
    // 注意：实体坐标是相对区域原点的，需要加上区域 Position 偏移。
    if (Array.isArray(region.Entities)) {
      for (const e of region.Entities) {
        const epos = Array.isArray(e.Pos) ? e.Pos : [0, 0, 0]
        const rot = Array.isArray(e.Rotation) ? e.Rotation : [0, 0]
        entities.push({
          id: e.id,
          pos: [Number(epos[0]) + pos.x, Number(epos[1]) + pos.y, Number(epos[2]) + pos.z],
          rotation: [Number(rot[0]) || 0, Number(rot[1]) || 0],
          nbt: e,
        })
      }
    }

    const bits = Math.max(2, Math.ceil(Math.log2(paletteList.length)))
    const total = dx * dy * dz
    const decoded = decodeBlockStates(region.BlockStates, bits, total)

    let idx = 0
    for (let y = 0; y < dy; y++) {
      for (let z = 0; z < dz; z++) {
        for (let x = 0; x < dx; x++) {
          const gi = localToGlobal[decoded[idx++]] ?? 0
          const wx = wx0 + x
          const wy = wy0 + y
          const wz = wz0 + z
          blocks.set(wx + ',' + wy + ',' + wz, gi)
          if (wx < minX) minX = wx
          if (wx > maxX) maxX = wx
          if (wy < minY) minY = wy
          if (wy > maxY) maxY = wy
          if (wz < minZ) minZ = wz
          if (wz > maxZ) maxZ = wz
        }
      }
    }
  }

  const bounds = {
    minX, minY, minZ, maxX, maxY, maxZ,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    depth: maxZ - minZ + 1,
  }

  return { metadata, palette, blocks, bounds, tileEntities, entities }
}

export async function parseLitematica(buffer) {
  const raw = await decompressNBT(new Uint8Array(buffer))
  return parseLitematicaRaw(raw)
}
