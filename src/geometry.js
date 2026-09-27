// 纯数据逻辑：把「世界坐标方块映射 + 调色板」转成按贴图分组的几何数据。
// 不依赖 three / DOM，可在 Node 中单独测试。
//
// 每个调色板条目带有 baked = { quads, fullCube }（由 modelBaker 烘焙）：
//   - quads：一组面（含局部坐标顶点、UV、法线、朝向）
//   - fullCube：是否为完整立方体（用于遮挡剔除）
// 隐藏面剔除：某个面只有当邻居不是「不透明的完整方块」时才生成。
//
// blocks 是 Map<整数key -> paletteIndex>，key = lx + lz*W + ly*(W*D)。
// 邻居查找用整数算术（lx±1 等），但整数 key 在边界处会「回绕」（x+1 到最大 x 时
// 绕到下一行 z 的 x=0），因此查找前必须先做边界检查，否则会误删边界处的可见面。

const SKIP_BLOCKS = new Set([
  'air', 'cave_air', 'void_air',
  'structure_void', 'barrier', 'light',
])

function shortName(name) {
  return (name || '').replace(/^minecraft:/, '')
}

export function isSkipBlock(name) {
  return SKIP_BLOCKS.has(shortName(name))
}

// 透明方块：不遮挡邻居，但仍以 alphaTest 方式渲染出边框/树叶。
export function isTransparent(name) {
  const n = shortName(name)
  return n.endsWith('_leaves') || n.includes('glass') || n === 'ice' || n === 'water' || n === 'lava'
}

// 红石粉的线/点贴图需要按信号强度分别染色
function isRedstoneDustTex(texKey) {
  return /(redstone_dust_dot|redstone_dust_line0|redstone_dust_line1)$/.test(texKey)
}

// 流体（水/岩浆）高度（0-1）：level 0=满，1-7 逐级下降，8+ 下落近似薄层
function fluidHeight(level) {
  const l = Number(level) || 0
  return l <= 0 ? 1 : l < 8 ? 1 - l / 8 : 0.125
}

function isFluidName(name) {
  const n = shortName(name)
  return n === 'water' || n === 'lava'
}

// 让出主线程一小段时间（超大投影分块处理时保持界面响应）
function yieldThread() {
  return new Promise((r) => setTimeout(r, 0))
}

// 一个非流体方块的面是否应被剔除：模型声明了 cullface 且邻居为不透明完整方块
// 或同类方块（如玻璃-玻璃、树叶-树叶）时，该面不可见。邻居越界视为空气（不剔除）。
function faceCulled(blocks, occludes, q, lx, lz, ly, gi, grid) {
  if (!q.cullface) return false
  const cf = q.cullface
  const nx = lx + cf[0]
  const ny = ly + cf[1]
  const nz = lz + cf[2]
  if (nx < 0 || nx >= grid.W || ny < 0 || ny >= grid.H || nz < 0 || nz >= grid.D) return false
  const ngi = blocks.get(nx + nz * grid.W + ny * grid.strideY)
  return ngi !== undefined && (occludes[ngi] || ngi === gi)
}

// 非流体方块的贴图组 key：红石粉按信号强度细分，便于渲染时按强度上色。
function faceKey(palette, gi, q) {
  if (isRedstoneDustTex(q.texKey)) {
    return q.texKey + '|p' + (Number(palette[gi].properties?.power) || 0)
  }
  return q.texKey
}

// 收集一个流体方块应生成的面，逐个交给 record(texKey, pos, uvs)。
// lx/lz/ly 是局部坐标（用于邻居查找与越界判断），x/y/z 是世界坐标（用于顶点）。
function emitFluidFaces(palette, blocks, lx, lz, ly, x, y, z, gi, grid, record) {
  const name = shortName(palette[gi].name)
  const isLava = name === 'lava'
  const level = Number(palette[gi].properties?.level) || 0
  const self = fluidHeight(level)
  const stillTex = isLava ? 'block/lava_still' : 'block/water_still'
  const flowTex = isLava ? 'block/lava_flow' : 'block/water_flow'

  // 相邻流体高度（非流体邻居用自身高度，避免水面边缘塌陷）
  const nbh = (dx, dz) => {
    const nx = lx + dx
    const nz = lz + dz
    if (nx < 0 || nx >= grid.W || nz < 0 || nz >= grid.D) return self
    const ngi = blocks.get(nx + nz * grid.W + ly * grid.strideY)
    if (ngi === undefined || !isFluidName(palette[ngi].name)) return self
    return fluidHeight(Number(palette[ngi].properties?.level) || 0)
  }
  // 角高度 = (自身 + 相邻两方向) / 3，邻居更低时用自身（水被托住不下坠）
  const corner = (dx, dz) => {
    const a = Math.max(self, nbh(dx, 0))
    const b = Math.max(self, nbh(0, dz))
    return (self + a + b) / 3
  }
  const h00 = corner(-1, -1) // 西北 x=0,z=0
  const h10 = corner(1, -1) // 东北 x=16,z=0
  const h01 = corner(-1, 1) // 西南 x=0,z=16
  const h11 = corner(1, 1) // 东南 x=16,z=16

  const fluidAt = (dx, dz) => {
    const nx = lx + dx
    const nz = lz + dz
    if (nx < 0 || nx >= grid.W || nz < 0 || nz >= grid.D) return false
    const ngi = blocks.get(nx + nz * grid.W + ly * grid.strideY)
    return ngi !== undefined && isFluidName(palette[ngi].name)
  }
  // 上方/下方被流体或不透明方块遮挡
  const occluded = (dy) => {
    const ny = ly + dy
    if (ny < 0 || ny >= grid.H) return false
    const ngi = blocks.get(lx + lz * grid.W + ny * grid.strideY)
    if (ngi === undefined) return false
    if (isFluidName(palette[ngi].name)) return true
    return !!(palette[ngi].baked && palette[ngi].baked.fullCube && !isTransparent(palette[ngi].name))
  }

  let count = 0
  // 顶面（平滑，四角不同高度）
  if (!occluded(1)) {
    record(stillTex, [[x, y + h01, z + 1], [x + 1, y + h11, z + 1], [x, y + h00, z], [x + 1, y + h10, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
    count++
  }
  // 底面
  if (!occluded(-1)) {
    record(stillTex, [[x + 1, y, z + 1], [x, y, z + 1], [x + 1, y, z], [x, y, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
    count++
  }
  // 侧面（邻居是流体时剔除，避免内部面）
  if (!fluidAt(0, -1)) {
    record(flowTex, [[x + 1, y, z], [x, y, z], [x + 1, y + h10, z], [x, y + h00, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
    count++
  }
  if (!fluidAt(0, 1)) {
    record(flowTex, [[x, y, z + 1], [x + 1, y, z + 1], [x, y + h01, z + 1], [x + 1, y + h11, z + 1]], [[0, 1], [1, 1], [0, 0], [1, 0]])
    count++
  }
  if (!fluidAt(-1, 0)) {
    record(flowTex, [[x, y + h00, z], [x, y, z], [x, y + h01, z + 1], [x, y, z + 1]], [[0, 0], [0, 1], [1, 0], [1, 1]])
    count++
  }
  if (!fluidAt(1, 0)) {
    record(flowTex, [[x + 1, y + h11, z + 1], [x + 1, y, z + 1], [x + 1, y + h10, z], [x + 1, y, z]], [[0, 0], [0, 1], [1, 0], [1, 1]])
    count++
  }
  return count
}

// 把一个面写入已预分配好的 typed arrays。
// verts：4 个顶点 [x,y,z]（局部坐标，需加 ox/oy/oz 偏移）；uvs：4 个 [u,v]。
function writeFace(g, verts, uvs, ox, oy, oz) {
  const v = g.v
  const p = g.positions
  const u = g.uvs
  const ix = g.indices
  const f = g.f
  for (let k = 0; k < 4; k++) {
    // 顶点 k 的分量起点是 (v+k)*3，不是 v+k*3（v 是顶点游标，每面 +4）
    p[(v + k) * 3] = ox + verts[k][0]
    p[(v + k) * 3 + 1] = oy + verts[k][1]
    p[(v + k) * 3 + 2] = oz + verts[k][2]
    u[(v + k) * 2] = uvs[k][0]
    u[(v + k) * 2 + 1] = uvs[k][1]
  }
  ix[f] = v
  ix[f + 1] = v + 1
  ix[f + 2] = v + 2
  ix[f + 3] = v + 2
  ix[f + 4] = v + 1
  ix[f + 5] = v + 3
  g.v = v + 4
  g.f = f + 6
}

// palette: [{name, baked}]，baked 为 {quads, fullCube} 或 null
// blocks: Map<整数key -> paletteIndex>
// bounds: {minX,minY,minZ,width,height,depth}（用于把整数 key 还原为世界坐标）
// onProgress(fraction) 每处理约 6.5 万方块回调一次进度，并让出主线程。
//
// 采用「两遍扫描」：第一遍统计每个贴图组的精确面数，据此分配精确大小的
// Float32/Uint32 数组，第二遍填充。相比普通 JS 数组（每个数 8 字节 + push 扩容），
// 内存减半且无扩容峰值，超大投影（上千万面）也不会撑爆内存。
// 法线不存（每个面的 4 个顶点本就同法线，渲染用 flatShading 即可得到相同光照）。
// 返回 { groups: Map<texKey, {positions,uvs,indices}>, emitted: 面数 }
export async function buildFaceGroups(palette, blocks, bounds, onProgress) {
  const grid = {
    W: bounds.width,
    D: bounds.depth,
    H: bounds.height,
    strideY: bounds.width * bounds.depth,
  }
  const minX = bounds.minX
  const minY = bounds.minY
  const minZ = bounds.minZ

  const renderable = new Uint8Array(palette.length)
  const occludes = new Uint8Array(palette.length)
  const quadsByPalette = new Array(palette.length)
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i].name
    const baked = palette[i].baked
    if (baked && baked.quads && baked.quads.length && !isSkipBlock(name)) {
      renderable[i] = 1
      occludes[i] = baked.fullCube && !isTransparent(name) ? 1 : 0
      quadsByPalette[i] = baked.quads
    } else {
      quadsByPalette[i] = null
    }
  }

  const total = blocks.size
  const counts = new Map() // gKey -> 面数
  let emitted = 0

  // —— 第一遍：统计每个贴图组的精确面数 ——
  let n = 0
  for (const [key, gi] of blocks) {
    if ((++n & 0xffff) === 0) {
      onProgress?.(total ? (0.5 * n) / total : 0)
      await yieldThread()
    }
    if (!renderable[gi]) continue
    const lx = key % grid.W
    const lz = Math.floor(key / grid.W) % grid.D
    const ly = Math.floor(key / grid.strideY)
    const x = lx + minX
    const y = ly + minY
    const z = lz + minZ
    if (isFluidName(palette[gi].name)) {
      emitted += emitFluidFaces(palette, blocks, lx, lz, ly, x, y, z, gi, grid, (texKey) => {
        counts.set(texKey, (counts.get(texKey) || 0) + 1)
      })
      continue
    }
    for (const q of quadsByPalette[gi]) {
      if (faceCulled(blocks, occludes, q, lx, lz, ly, gi, grid)) continue
      const gKey = faceKey(palette, gi, q)
      counts.set(gKey, (counts.get(gKey) || 0) + 1)
      emitted++
    }
  }

  // 分配精确大小的 typed arrays
  const groups = new Map()
  for (const [gKey, count] of counts) {
    groups.set(gKey, {
      positions: new Float32Array(count * 12),
      uvs: new Float32Array(count * 8),
      indices: new Uint32Array(count * 6),
      v: 0,
      f: 0,
    })
  }

  // —— 第二遍：填充几何数据 ——
  n = 0
  for (const [key, gi] of blocks) {
    if ((++n & 0xffff) === 0) {
      onProgress?.(total ? 0.5 + (0.5 * n) / total : 0)
      await yieldThread()
    }
    if (!renderable[gi]) continue
    const lx = key % grid.W
    const lz = Math.floor(key / grid.W) % grid.D
    const ly = Math.floor(key / grid.strideY)
    const x = lx + minX
    const y = ly + minY
    const z = lz + minZ
    if (isFluidName(palette[gi].name)) {
      emitFluidFaces(palette, blocks, lx, lz, ly, x, y, z, gi, grid, (texKey, pos, uvs) => {
        writeFace(groups.get(texKey), pos, uvs, 0, 0, 0)
      })
      continue
    }
    for (const q of quadsByPalette[gi]) {
      if (faceCulled(blocks, occludes, q, lx, lz, ly, gi, grid)) continue
      const gKey = faceKey(palette, gi, q)
      writeFace(groups.get(gKey), q.verts, q.uvs, x, y, z)
    }
  }

  return { groups, emitted }
}
