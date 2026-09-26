// 纯数据逻辑：把「世界坐标方块映射 + 调色板」转成按贴图分组的几何数据。
// 不依赖 three / DOM，可在 Node 中单独测试。
//
// 每个调色板条目带有 baked = { quads, fullCube }（由 modelBaker 烘焙）：
//   - quads：一组面（含局部坐标顶点、UV、法线、朝向）
//   - fullCube：是否为完整立方体（用于遮挡剔除）
// 隐藏面剔除：某个面只有当邻居不是「不透明的完整方块」时才生成。

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

// 推入一个自定义 quad（世界坐标顶点 + 归一化 UV + 法线）
function pushFluidQuad(groups, texKey, pos, uvs, normal) {
  let g = groups.get(texKey)
  if (!g) {
    g = { positions: [], normals: [], uvs: [], indices: [] }
    groups.set(texKey, g)
  }
  const base = g.positions.length / 3
  for (let i = 0; i < 4; i++) {
    g.positions.push(pos[i][0], pos[i][1], pos[i][2])
    g.normals.push(normal[0], normal[1], normal[2])
    g.uvs.push(uvs[i][0], uvs[i][1])
  }
  g.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
}

// 渲染一个流体方块：顶面按四角高度平均（平滑），侧面/底面与相邻流体之间剔除
// 返回生成的面数
function emitFluid(groups, palette, blocks, x, y, z, gi) {
  const name = shortName(palette[gi].name)
  const isLava = name === 'lava'
  const level = Number(palette[gi].properties?.level) || 0
  const self = fluidHeight(level)
  const stillTex = isLava ? 'block/lava_still' : 'block/water_still'
  const flowTex = isLava ? 'block/lava_flow' : 'block/water_flow'

  // 相邻流体高度（非流体邻居用自身高度，避免水面边缘塌陷）
  const nbh = (dx, dz) => {
    const ngi = blocks.get((x + dx) + ',' + y + ',' + (z + dz))
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
    const ngi = blocks.get((x + dx) + ',' + y + ',' + (z + dz))
    return ngi !== undefined && isFluidName(palette[ngi].name)
  }
  // 上方/下方被流体或不透明方块遮挡
  const occluded = (dy) => {
    const ngi = blocks.get(x + ',' + (y + dy) + ',' + z)
    if (ngi === undefined) return false
    if (isFluidName(palette[ngi].name)) return true
    return !!(palette[ngi].baked && palette[ngi].baked.fullCube && !isTransparent(palette[ngi].name))
  }

  let count = 0
  // 顶面（平滑，四角不同高度）
  if (!occluded(1)) {
    pushFluidQuad(groups, stillTex,
      [[x, y + h01, z + 1], [x + 1, y + h11, z + 1], [x, y + h00, z], [x + 1, y + h10, z]],
      [[0, 1], [1, 1], [0, 0], [1, 0]], [0, 1, 0])
    count++
  }
  // 底面
  if (!occluded(-1)) {
    pushFluidQuad(groups, stillTex,
      [[x + 1, y, z + 1], [x, y, z + 1], [x + 1, y, z], [x, y, z]],
      [[0, 1], [1, 1], [0, 0], [1, 0]], [0, -1, 0])
    count++
  }
  // 侧面（邻居是流体时剔除，避免内部面）
  if (!fluidAt(0, -1)) {
    pushFluidQuad(groups, flowTex,
      [[x + 1, y, z], [x, y, z], [x + 1, y + h10, z], [x, y + h00, z]],
      [[0, 1], [1, 1], [0, 0], [1, 0]], [0, 0, -1])
    count++
  }
  if (!fluidAt(0, 1)) {
    pushFluidQuad(groups, flowTex,
      [[x, y, z + 1], [x + 1, y, z + 1], [x, y + h01, z + 1], [x + 1, y + h11, z + 1]],
      [[0, 1], [1, 1], [0, 0], [1, 0]], [0, 0, 1])
    count++
  }
  if (!fluidAt(-1, 0)) {
    pushFluidQuad(groups, flowTex,
      [[x, y + h00, z], [x, y, z], [x, y + h01, z + 1], [x, y, z + 1]],
      [[0, 0], [0, 1], [1, 0], [1, 1]], [-1, 0, 0])
    count++
  }
  if (!fluidAt(1, 0)) {
    pushFluidQuad(groups, flowTex,
      [[x + 1, y + h11, z + 1], [x + 1, y, z + 1], [x + 1, y + h10, z], [x + 1, y, z]],
      [[0, 0], [0, 1], [1, 0], [1, 1]], [1, 0, 0])
    count++
  }
  return count
}

// palette: [{name, baked}]，baked 为 {quads, fullCube} 或 null
// blocks: Map<"x,y,z" -> paletteIndex>
// 返回 { groups: Map<texKey, {positions,normals,uvs,indices}>, emitted: 面数 }
export function buildFaceGroups(palette, blocks) {
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

  const groups = new Map()
  let emitted = 0
  for (const [key, gi] of blocks) {
    if (!renderable[gi]) continue
    const parts = key.split(',')
    const x = +parts[0]
    const y = +parts[1]
    const z = +parts[2]
    // 流体单独处理（平滑顶面 + 面剔除）
    if (isFluidName(palette[gi].name)) {
      emitted += emitFluid(groups, palette, blocks, x, y, z, gi)
      continue
    }
    for (const q of quadsByPalette[gi]) {
      // 只在模型声明了 cullface 时裁剪；邻居为不透明完整方块则裁剪该面
      if (q.cullface) {
        const ngi = blocks.get((x + q.cullface[0]) + ',' + (y + q.cullface[1]) + ',' + (z + q.cullface[2]))
        // 邻居为不透明完整方块，或为同类方块（如玻璃-玻璃、树叶-树叶）时裁剪该面
        if (ngi !== undefined && (occludes[ngi] || ngi === gi)) continue
      }
      // 红石粉按「贴图 + 信号强度」分组，便于渲染时按强度上色
      let gKey = q.texKey
      if (isRedstoneDustTex(q.texKey)) {
        gKey = q.texKey + '|p' + (Number(palette[gi].properties?.power) || 0)
      }
      let g = groups.get(gKey)
      if (!g) {
        g = { positions: [], normals: [], uvs: [], indices: [] }
        groups.set(gKey, g)
      }
      emitQuad(g, q, x, y, z)
      emitted++
    }
  }
  return { groups, emitted }
}

function emitQuad(g, q, x, y, z) {
  const base = g.positions.length / 3
  for (let i = 0; i < 4; i++) {
    g.positions.push(x + q.verts[i][0], y + q.verts[i][1], z + q.verts[i][2])
    g.normals.push(q.normal[0], q.normal[1], q.normal[2])
    g.uvs.push(q.uvs[i][0], q.uvs[i][1])
  }
  // 三角形顺序与 prismarine-viewer 一致（保证正面朝外）
  g.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
}
