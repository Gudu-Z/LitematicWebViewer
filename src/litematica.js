// .litematica 文件解析：NBT -> 元数据 + 全局调色板 + 世界坐标方块映射。
// 关键格式事实（已核实）：
//   - 根字段：Metadata / Version / MinecraftDataVersion / Regions
//   - 每个区域：Position / Size（可能为负）/ BlockStatePalette / BlockStates（位压缩 LongArray）
//   - 位宽 bits = max(2, ceil(log2(paletteSize)))
//   - 索引顺序 idx = y * (dx*dz) + z * dx + x（x 最快）
//   - 位序：小端序（第 0 个方块在第 0 个 long 的低位）
//   - 世界最小角 world = min(origin, origin + size + 1)

import { parseNBT, decompressNBT, LITTLE_ENDIAN } from './nbt.js'

// 空气类方块：解析时直接跳过、不存入 blocks Map，避免超大型投影占用过多内存。
const SKIP_NAMES = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'])

// 解码位压缩的 BlockStates（小端序），返回每个位置的调色板索引。
// startIdx 支持分块解码：只解码 [startIdx, startIdx+total) 这段，用于超大投影分块处理。
//
// 直接借用 LongArray 的底层 32 位视图，解码过程中不分配 BigInt 或复制输入。
// out 可复用，解析大型投影时只需一个固定大小的解码缓冲区。
export function decodeBlockStates(longs, bits, total, startIdx = 0, out = new Uint32Array(total)) {
  const packed = Array.isArray(longs) ? BigInt64Array.from(longs, v => BigInt.asIntN(64, v)) : longs
  if ((startIdx + total) * bits > packed.length * 64 || out.length < total) {
    throw new RangeError('BlockStates 数据或解码缓冲区长度不足')
  }
  const words = new Uint32Array(packed.buffer, packed.byteOffset, packed.length * 2)
  const swap = LITTLE_ENDIAN ? 0 : 1
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1
  let bit = startIdx * bits
  for (let j = 0; j < total; j++) {
    // 位偏移可能超过 32 位，除法不能替换成 bit >>> 5。
    const word = Math.floor(bit / 32)
    const offset = bit & 31
    let value = words[word ^ swap] >>> offset
    if (offset + bits > 32) value |= words[(word + 1) ^ swap] << (32 - offset)
    out[j] = value & mask
    bit += bits
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
// { metadata, palette: [{name, properties, key}], blocks: Map<整数key -> paletteIndex>, bounds }
//
// blocks 的 key 是把局部坐标编码成的整数：key = lx + lz*W + ly*(W*D)
// （lx = wx-minX，W=宽，D=深，strideY = W*D）。相比 "x,y,z" 字符串 key，
// 整数 key 的邻居查找是纯整数算术、速度快数倍，内存也更小，超大投影收益显著。
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

  // 方块数量过大时直接拒绝：后续要把所有非空气方块存入 Map 并合并成几何体，
  // 几十万方块的投影浏览器能承受，上千万方块会撑爆内存/几何体数组（本次报错的
  // 两个投影分别是 9449 万与 1.99 亿方块）。
  const MAX_BLOCKS = 20_000_000
  if (metadata.totalBlocks > MAX_BLOCKS) {
    const err = new Error(`方块数量过大（${metadata.totalBlocks.toLocaleString()}，上限 ${MAX_BLOCKS.toLocaleString()}）`)
    err.code = 'FILE_TOO_LARGE'
    throw err
  }

  // 第一遍：统计总方块数 + 全局边界 + 收集每个区域的名称与边界（区域名是 Regions 对象的键）
  let totalBlocks = 0
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const regionList = []
  for (const [name, region] of Object.entries(regions)) {
    const pos = vec(region.Position)
    const size = vec(region.Size)
    const dx = Math.abs(size.x)
    const dy = Math.abs(size.y)
    const dz = Math.abs(size.z)
    if (dx === 0 || dy === 0 || dz === 0) continue
    totalBlocks += dx * dy * dz
    const wx0 = Math.min(pos.x, pos.x + size.x + 1)
    const wy0 = Math.min(pos.y, pos.y + size.y + 1)
    const wz0 = Math.min(pos.z, pos.z + size.z + 1)
    minX = Math.min(minX, wx0)
    maxX = Math.max(maxX, wx0 + dx - 1)
    minY = Math.min(minY, wy0)
    maxY = Math.max(maxY, wy0 + dy - 1)
    minZ = Math.min(minZ, wz0)
    maxZ = Math.max(maxZ, wz0 + dz - 1)
    regionList.push({
      name,
      minX: wx0, minY: wy0, minZ: wz0,
      maxX: wx0 + dx - 1, maxY: wy0 + dy - 1, maxZ: wz0 + dz - 1,
      width: dx, height: dy, depth: dz,
    })
  }
  const W = maxX - minX + 1
  const D = maxZ - minZ + 1
  const strideY = W * D // 每升高一层（y+1）整数 key 增加的步长

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
  let doneBlocks = 0
  const decoded = new Uint32Array(65536)
  let lastYield = performance.now()

  // 第二遍：解码并建立整数 key 的方块映射
  for (const [name, region] of Object.entries(regions)) {
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
    const isSkip = new Uint8Array(paletteList.length)
    for (let i = 0; i < paletteList.length; i++) {
      localToGlobal[i] = getGlobalIndex(paletteList[i].Name, paletteList[i].Properties)
      isSkip[i] = SKIP_NAMES.has((paletteList[i].Name || '').replace(/^minecraft:/, '')) ? 1 : 0
    }

    // 方块实体（告示牌/旗帜等）：坐标与方块网格一致，都相对区域「最小角」wx0（Size 为负时
    // Position 是最大角，不能直接加 Position）。实体（Pos）才是相对 Position 的。
    if (Array.isArray(region.TileEntities)) {
      for (const te of region.TileEntities) {
        tileEntities.push({ id: te.id, x: te.x + wx0, y: te.y + wy0, z: te.z + wz0, nbt: te, region: name })
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
          region: name,
        })
      }
    }

    const bits = Math.max(2, Math.ceil(Math.log2(paletteList.length)))
    const rowSize = dz * dx // 每层（y 固定）的方块数
    const lx0 = wx0 - minX
    const lz0 = wz0 - minZ
    const ly0 = wy0 - minY

    // 固定大小分块，既不为宽阔的一层分配大数组，也不为每个小层等待定时器。
    const volume = rowSize * dy
    for (let start = 0; start < volume; start += decoded.length) {
      const count = Math.min(decoded.length, volume - start)
      decodeBlockStates(region.BlockStates, bits, count, start, decoded)
      let j = 0
      while (j < count) {
        const index = start + j
        const y = Math.floor(index / rowSize)
        const z = Math.floor(index / dx) % dz
        const x = index % dx
        const rowBase = (ly0 + y) * strideY + (lz0 + z) * W + lx0
        const end = Math.min(count, j + dx - x)
        let key = rowBase + x
        for (; j < end; j++, key++) {
          const li = decoded[j]
          if (isSkip[li]) continue // 空气类方块不入 Map
          blocks.set(key, localToGlobal[li] ?? 0)
        }
      }
      doneBlocks += count
      if (performance.now() - lastYield >= 12) {
        onProgress?.(totalBlocks ? doneBlocks / totalBlocks : 0)
        await new Promise((r) => setTimeout(r, 0))
        lastYield = performance.now()
      }
    }
    region.BlockStates = null // 该区域已解码完，释放大数组（超大投影可达数百 MB），降低峰值内存
  }

  const bounds = {
    minX, minY, minZ, maxX, maxY, maxZ,
    width: W,
    height: maxY - minY + 1,
    depth: D,
  }

  onProgress?.(1)
  return { metadata, palette, blocks, bounds, tileEntities, entities, regions: regionList }
}

export async function parseLitematica(buffer, onProgress) {
  const raw = await decompressNBT(new Uint8Array(buffer))
  return parseLitematicaRaw(raw, onProgress)
}
