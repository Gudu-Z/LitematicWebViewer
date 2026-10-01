// 紧凑的方块存储：把「世界坐标方块 → 全局调色板索引」按固定大小的块存成 Uint16Array，
// 替代之前把所有非空气方块塞进一个 JS Map 的做法（Map 存一亿方块 ≈ 数 GB）。
//
// 每块 CHUNK×CHUNK×CHUNK，值 = paletteIndex + 1（0 表示空气/空），全空气的块不分配数组。
// 提供：
//   - set / get：解析时写入、随机访问（告示牌/头颅/旗帜/装饰罐的方块查找、雕像扫描、水下雾判断）
//   - forEachBlock：遍历所有非空气方块（材料统计、雕像扫描）
//   - decodeChunk：取「某块 + 1 格外壳」的方块，做成几何生成用的局部 Map 与 bounds
//   - chunkBounds / chunkKeyOf / chunkCoordsOf：供渲染端按视距加载/卸载块

export const CHUNK = 32

export class BlockStore {
  constructor(bounds) {
    this.minX = bounds.minX
    this.minY = bounds.minY
    this.minZ = bounds.minZ
    this.width = bounds.width
    this.height = bounds.height
    this.depth = bounds.depth
    this.cx = Math.ceil(bounds.width / CHUNK) // 每个维度上的块数
    this.cy = Math.ceil(bounds.height / CHUNK)
    this.cz = Math.ceil(bounds.depth / CHUNK)
    this.chunks = new Map() // 整数 chunkKey -> Uint16Array(CHUNK³)
    this.count = 0 // 非空气方块总数
  }

  chunkKeyOf(cx, cy, cz) {
    return cx + cy * this.cx + cz * (this.cx * this.cy)
  }

  chunkCoordsOf(key) {
    const cz = Math.floor(key / (this.cx * this.cy))
    const rem = key - cz * (this.cx * this.cy)
    const cy = Math.floor(rem / this.cx)
    const cx = rem - cy * this.cx
    return { cx, cy, cz }
  }

  // 世界坐标 → 块坐标 + 块内局部坐标
  _loc(wx, wy, wz) {
    const lx = wx - this.minX
    const ly = wy - this.minY
    const lz = wz - this.minZ
    const cx = Math.floor(lx / CHUNK)
    const cy = Math.floor(ly / CHUNK)
    const cz = Math.floor(lz / CHUNK)
    return { cx, cy, cz, bx: lx - cx * CHUNK, by: ly - cy * CHUNK, bz: lz - cz * CHUNK }
  }

  set(wx, wy, wz, paletteIndex) {
    const { cx, cy, cz, bx, by, bz } = this._loc(wx, wy, wz)
    const key = this.chunkKeyOf(cx, cy, cz)
    let arr = this.chunks.get(key)
    if (!arr) {
      arr = new Uint16Array(CHUNK * CHUNK * CHUNK)
      this.chunks.set(key, arr)
    }
    arr[bx + bz * CHUNK + by * (CHUNK * CHUNK)] = paletteIndex + 1
    this.count++
  }

  get(wx, wy, wz) {
    const { cx, cy, cz, bx, by, bz } = this._loc(wx, wy, wz)
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.cx || cy >= this.cy || cz >= this.cz) return undefined
    const arr = this.chunks.get(this.chunkKeyOf(cx, cy, cz))
    if (!arr) return undefined
    const v = arr[bx + bz * CHUNK + by * (CHUNK * CHUNK)]
    return v === 0 ? undefined : v - 1
  }

  // 遍历所有非空气方块：cb(wx, wy, wz, paletteIndex)
  forEachBlock(cb) {
    for (const [key, arr] of this.chunks) {
      const { cx, cy, cz } = this.chunkCoordsOf(key)
      const baseX = this.minX + cx * CHUNK
      const baseY = this.minY + cy * CHUNK
      const baseZ = this.minZ + cz * CHUNK
      const layer = CHUNK * CHUNK
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 0) continue
        const by = Math.floor(i / layer)
        const rem = i - by * layer
        const bz = Math.floor(rem / CHUNK)
        const bx = rem - bz * CHUNK
        cb(baseX + bx, baseY + by, baseZ + bz, arr[i] - 1)
      }
    }
  }

  // 某块的包围盒（世界坐标，含 min/max，clamp 到全局边界）
  chunkBounds(cx, cy, cz) {
    return {
      minX: this.minX + cx * CHUNK,
      minY: this.minY + cy * CHUNK,
      minZ: this.minZ + cz * CHUNK,
      maxX: Math.min(this.minX + (cx + 1) * CHUNK - 1, this.minX + this.width - 1),
      maxY: Math.min(this.minY + (cy + 1) * CHUNK - 1, this.minY + this.height - 1),
      maxZ: Math.min(this.minZ + (cz + 1) * CHUNK - 1, this.minZ + this.depth - 1),
    }
  }

  // 取「某块 + shell 圈外壳」的方块，做成几何生成用的局部 Map 与扩展 bounds。
  // 返回 { blocks: Map<局部整数key, paletteIndex>, bounds }，key = lx + lz*W + ly*(W*D)。
  // 外壳方块参与面剔除但不被生成（由 buildFaceGroups 的 emitBounds 参数控制）。
  decodeChunk(cx, cy, cz, shell = 1) {
    const eMinX = Math.max(this.minX + cx * CHUNK - shell, this.minX)
    const eMinY = Math.max(this.minY + cy * CHUNK - shell, this.minY)
    const eMinZ = Math.max(this.minZ + cz * CHUNK - shell, this.minZ)
    const eMaxX = Math.min(this.minX + (cx + 1) * CHUNK - 1 + shell, this.minX + this.width - 1)
    const eMaxY = Math.min(this.minY + (cy + 1) * CHUNK - 1 + shell, this.minY + this.height - 1)
    const eMaxZ = Math.min(this.minZ + (cz + 1) * CHUNK - 1 + shell, this.minZ + this.depth - 1)
    const W = eMaxX - eMinX + 1
    const D = eMaxZ - eMinZ + 1
    const H = eMaxY - eMinY + 1
    const strideY = W * D
    const blocks = new Map()
    for (let wz = eMinZ; wz <= eMaxZ; wz++) {
      for (let wy = eMinY; wy <= eMaxY; wy++) {
        for (let wx = eMinX; wx <= eMaxX; wx++) {
          const gi = this.get(wx, wy, wz)
          if (gi === undefined) continue
          const lx = wx - eMinX
          const ly = wy - eMinY
          const lz = wz - eMinZ
          blocks.set(lx + lz * W + ly * strideY, gi)
        }
      }
    }
    return {
      blocks,
      bounds: {
        minX: eMinX, minY: eMinY, minZ: eMinZ,
        maxX: eMaxX, maxY: eMaxY, maxZ: eMaxZ,
        width: W, height: H, depth: D,
      },
    }
  }
}
