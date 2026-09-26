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
