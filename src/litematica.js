// .litematica 文件解析：NBT -> 元数据 + 全局调色板 + 世界坐标方块映射。
// 关键格式事实（已核实）：
//   - 根字段：Metadata / Version / MinecraftDataVersion / Regions
//   - 每个区域：Position / Size（可能为负）/ BlockStatePalette / BlockStates（位压缩 LongArray）
//   - 位宽 bits = max(2, ceil(log2(paletteSize)))
//   - 索引顺序 idx = y * (dx*dz) + z * dx + x（x 最快）
//   - 位序：小端序（第 0 个方块在第 0 个 long 的低位）
//   - 世界最小角 world = min(origin, origin + size + 1)

import { parseNBT, decompressNBT } from './nbt.js'

// 空气类方块：解析时直接跳过、不存入 blocks Map，避免超大型投影占用过多内存。
const SKIP_NAMES = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])

// 解码位压缩的 BlockStates（小端序），返回每个位置的调色板索引。
// startIdx 支持分块解码：只解码 [startIdx, startIdx+total) 这段，用于超大投影分块处理。
export function decodeBlockStates(longs, bits, total, startIdx = 0) {
  const out = new Uint32Array(total)
  const mask = (1n << BigInt(bits)) - 1n
  for (let j = 0; j < total; j++) {
    const i = startIdx + j
    const start = i * bits
    // 注意：不能用 start >> 6 / start & 63，JS 位运算会截成 32 位，
    // 超大型投影（i*bits > 2^31）会溢出导致 word 为负、longs[word] 为 undefined。
    const word = Math.floor(start / 64)
    const off = start % 64
    let v
    if (off + bits <= 64) {
      v = (BigInt.asUintN(64, longs[word]) >> BigInt(off)) & mask
    } else {
      const low = BigInt.asUintN(64, longs[word]) >> BigInt(off)
      const hiBits = off + bits - 64
      const hi = BigInt.asUintN(64, longs[word + 1]) & ((1n << BigInt(hiBits)) - 1n)
      v = low | (hi << BigInt(64 - off))
    }
    out[j] = Number(v)
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
// onProgress(fraction) 在解析过程中回调进度（0~1），用于超大文件显示进度。
export async function parseLitematicaRaw(rawBytes, onProgress) {
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

  // 预先统计总方块数（用于进度显示）
  let totalBlocks = 0
  for (const region of Object.values(regions)) {
    const size = vec(region.Size)
    const dx = Math.abs(size.x)
    const dy = Math.abs(size.y)
    const dz = Math.abs(size.z)
    if (dx === 0 || dy === 0 || dz === 0) continue
    totalBlocks += dx * dy * dz
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
  let doneBlocks = 0

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

    // 边界由区域范围直接得出（含空气），无需遍历每个方块
    minX = Math.min(minX, wx0)
    maxX = Math.max(maxX, wx0 + dx - 1)
    minY = Math.min(minY, wy0)
    maxY = Math.max(maxY, wy0 + dy - 1)
    minZ = Math.min(minZ, wz0)
    maxZ = Math.max(maxZ, wz0 + dz - 1)

    const paletteList = region.BlockStatePalette || []
    const localToGlobal = new Array(paletteList.length)
    const isSkip = new Uint8Array(paletteList.length)
    for (let i = 0; i < paletteList.length; i++) {
      localToGlobal[i] = getGlobalIndex(paletteList[i].Name, paletteList[i].Properties)
      isSkip[i] = SKIP_NAMES.has((paletteList[i].Name || '').replace(/^minecraft:/, '')) ? 1 : 0
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
    const rowSize = dz * dx // 每层（y 固定）的方块数

    // 按「层」分块解码并即时存入 Map：避免一次性分配超大数组，
    // 且每解码一层让出一次主线程，防止超大投影（上亿方块）卡死界面。
    for (let y = 0; y < dy; y++) {
      const decoded = decodeBlockStates(region.BlockStates, bits, rowSize, y * rowSize)
      let rowIdx = 0
      for (let z = 0; z < dz; z++) {
        for (let x = 0; x < dx; x++) {
          const li = decoded[rowIdx++]
          if (isSkip[li]) continue // 空气类方块不入 Map
          const gi = localToGlobal[li] ?? 0
          const wx = wx0 + x
          const wy = wy0 + y
          const wz = wz0 + z
          blocks.set(wx + ',' + wy + ',' + wz, gi)
        }
      }
      doneBlocks += rowSize
      onProgress?.(totalBlocks ? doneBlocks / totalBlocks : 0)
      await new Promise((r) => setTimeout(r, 0)) // 让出主线程，保持界面响应
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

export async function parseLitematica(buffer, onProgress) {
  const raw = await decompressNBT(new Uint8Array(buffer))
  return parseLitematicaRaw(raw, onProgress)
}
