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
//
// 性能说明：超大投影（上亿方块）解码是最耗时的环节。若每个方块做 BigInt 运算
// （BigInt 比 Number 慢约一个数量级），全量解码要数十秒。这里把每个 64 位 long
// 拆成两个 32 位半区，用纯 Number 位运算逐位提取，速度快 5 倍以上。
export function decodeBlockStates(longs, bits, total, startIdx = 0) {
  const out = new Uint32Array(total)
  const mask = (1 << bits) - 1 // bits 恒 ≤ 32，mask 落在 32 位整数范围内
  let bit = startIdx * bits // 起始位偏移（可能位于某个 long 的中间）
  let word = -1
  let lo = 0
  let hi = 0
  for (let j = 0; j < total; j++) {
    // 不能用 bit >> 6 / bit & 63（32 位溢出）；bit/64 在 <2^53 内是精确的整数，
    // 且 word 值 <2^31，| 0 截断安全。off = bit & 63 取低 6 位，溢出也正确。
    const w = (bit / 64) | 0
    const off = bit & 63
    if (w !== word) {
      word = w
      const b = BigInt.asUintN(64, longs[w])
      lo = Number(b & 0xffffffffn)
      hi = Number(b >> 32n)
    }
    let v
    if (off + bits <= 32) {
      v = (lo >>> off) & mask
    } else if (off >= 32 && off + bits <= 64) {
      v = (hi >>> (off - 32)) & mask
    } else if (off >= 32) {
      // 跨 64 位 word 边界：高位部分在当前 word 高半区，剩余低位在下一 word 低半区
      const take = 64 - off
      const next = BigInt.asUintN(64, longs[w + 1])
      const nextLo = Number(next & 0xffffffffn)
      v = ((hi >>> (off - 32)) | (nextLo << take)) & mask
    } else {
      // 跨 32 位半区边界，但仍在同一 word 内
      const lowBits = 32 - off
      v = ((lo >>> off) | ((hi & ((1 << (bits - lowBits)) - 1)) << lowBits)) & mask
    }
    out[j] = v
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

    // 按「层」分块解码并即时存入 Map：避免一次性分配超大数组，
    // 且每解码一层让出一次主线程，防止超大投影（上亿方块）卡死界面。
    for (let y = 0; y < dy; y++) {
      const decoded = decodeBlockStates(region.BlockStates, bits, rowSize, y * rowSize)
      const yKey = (ly0 + y) * strideY
      let rowIdx = 0
      for (let z = 0; z < dz; z++) {
        const rowBase = yKey + (lz0 + z) * W + lx0
        for (let x = 0; x < dx; x++) {
          const li = decoded[rowIdx++]
          if (isSkip[li]) continue // 空气类方块不入 Map
          blocks.set(rowBase + x, localToGlobal[li] ?? 0)
        }
      }
      doneBlocks += rowSize
      onProgress?.(totalBlocks ? doneBlocks / totalBlocks : 0)
      await new Promise((r) => setTimeout(r, 0)) // 让出主线程，保持界面响应
    }
    region.BlockStates = null // 该区域已解码完，释放大数组（超大投影可达数百 MB），降低峰值内存
  }

  const bounds = {
    minX, minY, minZ, maxX, maxY, maxZ,
    width: W,
    height: maxY - minY + 1,
    depth: D,
  }

  return { metadata, palette, blocks, bounds, tileEntities, entities, regions: regionList }
}

export async function parseLitematica(buffer, onProgress) {
  const raw = await decompressNBT(new Uint8Array(buffer))
  return parseLitematicaRaw(raw, onProgress)
}
