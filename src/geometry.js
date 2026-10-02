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

import { FLUID_FLOW_BLOCKS } from './fluidFlowBlocks.js'

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
// 格栅（铜格栅）、铁栏杆、锁链等是 TransparentBlock（cutout 纹理有洞），同样不遮挡。
// 红树根/泥泞红树根（_roots）是「满覆盖 cutout」方块：六个面都是满 16×16 但纹理有洞，
// 含水时水要透出来，不能被 fullFaceMask 当实心面整体剔除（否则含水红树根完全不显示水）。
export function isTransparent(name) {
  const n = shortName(name)
  return n.endsWith('_leaves') || n.includes('glass') || n === 'ice' || n === 'water' || n === 'lava' || n === 'bubble_column'
    || n.endsWith('_grate') || n.endsWith('_bars') || n === 'chain' || n.endsWith('_chain') || n === 'tripwire'
    || n.endsWith('_roots')
}

// 原版 FluidRenderer 在水面侧面贴着「半透明方块」（HalfTransparentBlock：玻璃/冰/黏液/蜂蜜）
// 或「树叶」（LeavesBlock）时，改用 overlay 贴图（water_overlay）而非 flow 贴图。
function isOverlayBlock(name) {
  const n = shortName(name)
  return n.endsWith('_leaves')
    || n === 'glass' || n.endsWith('_stained_glass') || n === 'tinted_glass'
    || n === 'ice' || n === 'frosted_ice'
    || n === 'slime_block' || n === 'honey_block'
}

// 红石粉的线/点贴图需要按信号强度分别染色
function isRedstoneDustTex(texKey) {
  return /(redstone_dust_dot|redstone_dust_line0|redstone_dust_line1)$/.test(texKey)
}

// 流体（水/岩浆）自身高度（0-1）：与原版 FluidState.getOwnHeight() = getAmount()/9 一致。
// 原版 getAmount()：水源(level 0) → 8；流动水 → 方块状态里的 level 值；下落(level 8) → 8。
// 故 source / falling → 8/9；flowing L → L/9。这里的 8/9 正是原版 FLUID_HEIGHT 常量。
export function fluidHeight(level) {
  const l = Number(level) || 0
  return (l <= 0 || l >= 8) ? 8 / 9 : l / 9
}

// 始终含水的水生植物：这些方块没有 waterlogged 属性（方块状态里永不含它），
// 原版它们的 getFluidState 无条件返回水源（Fluids.WATER.getSource(false)），
// 即这些植物方块内部永远被水充满。这里单独补上，否则植物方块内部不会渲染水。
const ALWAYS_WATERLOGGED = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])

// 方块所属流体：kind = 'water' | 'lava' | null；level 为方块状态 level 值。
// 含水方块（waterlogged）与气泡柱（bubble_column）都视作「water 源」（level 0），
// 这样相邻的水面高度、同流体剔除都会把它们当成同种水处理（原版它们的 FluidState 就是水）。
export function fluidOfEntry(paletteEntry) {
  const n = shortName(paletteEntry.name)
  const props = paletteEntry.properties || {}
  if (n === 'water') return { kind: 'water', level: Number(props.level) || 0, waterlogged: false }
  if (n === 'lava') return { kind: 'lava', level: Number(props.level) || 0, waterlogged: false }
  if (n === 'bubble_column') return { kind: 'water', level: 0, waterlogged: false, bubble: true }
  const wl = props.waterlogged
  if (wl === true || wl === 'true' || wl === 1 || wl === '1') return { kind: 'water', level: 0, waterlogged: true }
  if (ALWAYS_WATERLOGGED.has(n)) return { kind: 'water', level: 0, waterlogged: true }
  return null
}

// 让出主线程一小段时间（超大投影分块处理时保持界面响应）
function yieldThread() {
  return new Promise((r) => setTimeout(r, 0))
}

// 一个非流体方块的面是否应被剔除：模型声明了 cullface 且邻居为不透明完整方块时，
// 该面不可见。此外「同类互隐」（原版 isSideInvisible）只有玻璃、树叶这类方块才有：
// 楼梯等方块即使邻居状态相同也不能剔面，否则楼梯之间会出现错误的镂空面。
// 邻居越界视为空气（不剔除）。
function faceCulled(blocks, occludes, hideSame, q, lx, lz, ly, gi, grid, visible) {
  if (!q.cullface) return false
  const cf = q.cullface
  const nx = lx + cf[0]
  const ny = ly + cf[1]
  const nz = lz + cf[2]
  if (nx < 0 || nx >= grid.W || ny < 0 || ny >= grid.H || nz < 0 || nz >= grid.D) return false
  // 被层级/区域过滤掉的邻居按空气处理，不遮挡当前面（否则切片边界会错误剔面）
  if (visible && !visible(nx, ny, nz)) return false
  const ngi = blocks.get(nx + nz * grid.W + ny * grid.strideY)
  return ngi !== undefined && (occludes[ngi] || (ngi === gi && hideSame[ngi]))
}

// 非流体方块的贴图组 key：红石粉按信号强度细分，便于渲染时按强度上色。
function faceKey(palette, gi, q) {
  if (isRedstoneDustTex(q.texKey)) {
    return q.texKey + '|p' + (Number(palette[gi].properties?.power) || 0)
  }
  return q.texKey
}

// 计算一个方块「满覆盖」的面位掩码（含水方块内部的水体据此剔除被自身实体面遮挡的水面）。
// bit: up=1 down=2 north=4 south=8 west=16 east=32。
// 一个面「满覆盖」某方向 = 该面法线沿该方向、且贴在该方向的边界、且另两轴铺满 16×16。
const FULL_BIT = { '0,1,0': 1, '0,-1,0': 2, '0,0,-1': 4, '0,0,1': 8, '-1,0,0': 16, '1,0,0': 32 }
function fullFaceMask(quads) {
  if (!quads) return 0
  let mask = 0
  for (const q of quads) {
    const nk = q.normal.map((v) => Math.round(v)).join(',')
    const bit = FULL_BIT[nk]
    if (!bit) continue
    let ax, b1, b2
    if (nk === '1,0,0' || nk === '-1,0,0') { ax = 0; b1 = 1; b2 = 2 }
    else if (nk === '0,1,0' || nk === '0,-1,0') { ax = 1; b1 = 0; b2 = 2 }
    else { ax = 2; b1 = 0; b2 = 1 }
    // 法线轴坐标必须全部相等且贴边界（0 或 16）
    const av = Math.round(q.verts[0][ax] * 16)
    if (av !== 0 && av !== 16) continue
    let full = true
    for (const v of q.verts) if (Math.round(v[ax] * 16) !== av) { full = false; break }
    if (!full) continue
    // 另两轴必须铺满 0..16
    const b1min = Math.min(...q.verts.map((v) => v[b1]))
    const b1max = Math.max(...q.verts.map((v) => v[b1]))
    const b2min = Math.min(...q.verts.map((v) => v[b2]))
    const b2max = Math.max(...q.verts.map((v) => v[b2]))
    if (b1min > 0.001 || b1max < 0.999 || b2min > 0.001 || b2max < 0.999) continue
    mask |= bit
  }
  return mask
}

// 流体顶面的水平流向角度（弧度），仿原版 FlowingFluid.getFlow：向高度更低的
// 「同种流体」邻居（含「空气/非阻挡方块下方有水」的下一级流）求和方向向量。无水平流动返回 null
// （此时顶面用静止贴图）。因此：
//   - 流动水/岩浆：流向更低处；
//   - 水源方块：在「喂给旁边流动水」时也有流向，静止水体则无流向。
function flowAngle(palette, fluidOf, blocks, lx, lz, ly, gi, grid, kind, visible) {
  const selfH = fluidHeight(fluidOf[gi].level)
  let vx = 0
  let vz = 0
  const get = (dx, dy, dz) => {
    const nx = lx + dx
    const ny = ly + dy
    const nz = lz + dz
    if (nx < 0 || nx >= grid.W || ny < 0 || ny >= grid.H || nz < 0 || nz >= grid.D) return undefined
    if (visible && !visible(nx, ny, nz)) return undefined
    return blocks.get(nx + nz * grid.W + ny * grid.strideY)
  }
  // 复刻原版 FlowingFluid.getFlow：
  //   - 同种流体邻居：按高度差贡献流向；
  //   - 空气、或不在 BLOCKS_FLUID_FLOW 标签里的非流体方块（植物/火把/铁轨/红石线等）：
  //     若其下方有同种流体（高度 > 0），水往下一级流（diff = selfH - (belowH - 8/9)）；
  //   - 属于 BLOCKS_FLUID_FLOW 标签的方块（实心/台阶/栅栏/树叶/告示牌等）：阻挡流动，跳过；
  //   - 别的流体（岩浆）不影响。
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const ngi = get(dx, 0, dz)
    const nfo = ngi === undefined ? null : fluidOf[ngi]
    if (nfo && nfo.kind !== kind) continue // 别的流体不影响流向
    let diff = 0
    if (nfo) {
      // 同种流体邻居：按高度差
      if (fluidHeight(nfo.level) > 0) {
        diff = selfH - fluidHeight(nfo.level)
      }
    } else if (ngi === undefined || !FLUID_FLOW_BLOCKS.has(shortName(palette[ngi].name))) {
      // 空气 / 非阻挡方块：其下方有同种流体（且高度 > 0）→ 水往下一级流
      const bgi = get(dx, -1, dz)
      const bfo = bgi === undefined ? null : fluidOf[bgi]
      if (bfo && bfo.kind === kind && fluidHeight(bfo.level) > 0) {
        diff = selfH - (fluidHeight(bfo.level) - 8 / 9)
      }
    }
    // ngi !== undefined && 属于 BLOCKS_FLUID_FLOW → 阻挡流动：跳过（diff 保持 0）
    if (diff !== 0) {
      vx += dx * diff
      vz += dz * diff
    }
  }
  if (vx === 0 && vz === 0) return null
  return Math.atan2(vz, vx)
}

// 气泡柱内部气泡的散布位置（方块局部坐标 0..1）。
// 原版气泡是每 tick 在柱内随机位置生成的上升/下沉粒子（中心一枚 + 随机一枚），
// 这里用「按方块坐标的确定性伪随机」静态近似：中心区域散落几枚、每格位置不同，
// 看起来是柱体内零散的气泡流而不是整齐排列。
function bubbleScatter(lx, ly, lz) {
  let h = (lx * 374761393 + ly * 668265263 + lz * 1442695041) >>> 0
  const rnd = () => {
    h = (h * 1664525 + 1013904223) >>> 0
    return h / 4294967296
  }
  const out = []
  const n = 4 + (h % 3) // 每格 4~6 枚
  for (let i = 0; i < n; i++) {
    // 集中在中心区域（x/z 0.38~0.62），高度随机
    out.push([0.38 + rnd() * 0.24, 0.05 + rnd() * 0.9, 0.38 + rnd() * 0.24])
  }
  return out
}

// 收集一个流体方块应生成的面，逐个交给 record(texKey, pos, uvs)。
// lx/lz/ly 是局部坐标（用于邻居查找与越界判断），x/y/z 是世界坐标（用于顶点）。
//
// 表面高度算法按原版 FluidRenderer（1.21.11 反编译源码）移植：
//   - getFluidHeight：同种流体取 level/9（上方有同种流体视为满格 1）；
//     非同种方块：实心（原版 isSolid，树叶除外）为 -1，其余（空气等）为 0。
//   - calculateFluidHeight：角点 = 自身 + 两相邻 + 对角 的加权平均；
//     高度 ≥ 0.8 权重 ×10（让表面贴近高水位），< 0 的实心贡献不参与；
//     任一相邻高度 ≥ 1 时角点直接取 1。
//     相邻方块计算同一世界坐标角点时的数值集合相同，因此表面连续，不会出现台阶。
// selfMask：含水方块自身「满覆盖」面的位掩码，用于剔除被自身实体面挡住的水面。
function emitFluidFaces(palette, blocks, fluidOf, lx, lz, ly, x, y, z, gi, grid, selfMask, visible, record) {
  const info = fluidOf[gi]
  const kind = info.kind
  const isLava = kind === 'lava'
  const stillTex = isLava ? 'block/lava_still' : 'block/water_still'
  const flowTex = isLava ? 'block/lava_flow' : 'block/water_flow'

  // 越界安全的邻居读取（被层级/区域过滤掉的邻居按空气处理）
  const get = (dx, dy, dz) => {
    const nx = lx + dx
    const ny = ly + dy
    const nz = lz + dz
    if (nx < 0 || nx >= grid.W || ny < 0 || ny >= grid.H || nz < 0 || nz >= grid.D) return undefined
    if (visible && !visible(nx, ny, nz)) return undefined
    return blocks.get(nx + nz * grid.W + ny * grid.strideY)
  }
  const giName = (gi2) => (gi2 === undefined ? '' : shortName(palette[gi2].name))
  // 同种流体（水/岩浆分开；含水方块、气泡柱都算水）
  const isFluid = (gi2) => gi2 !== undefined && !!fluidOf[gi2] && fluidOf[gi2].kind === kind
  // 高度计算用的 isSolid：完整方块（含玻璃等透明完整方块，原版按 isSolid() 判定）→ -1 不参与平均。
  const isSolid = (gi2) =>
    gi2 !== undefined && !!palette[gi2].baked && palette[gi2].baked.fullCube && !fluidOf[gi2] && !giName(gi2).endsWith('_leaves')
  // 面剔除用的 isCullingSolid：只有「不透明」的完整方块才遮挡水面；
  // 玻璃/树叶/格栅等透明方块的 culling shape 为空（原版 TransparentBlock），水应透过它们显示。
  const isCullingSolid = (gi2) => isSolid(gi2) && !isTransparent(palette[gi2].name)

  // 原版 getFluidHeight
  const fluidH = (dx, dy, dz) => {
    const ngi = get(dx, dy, dz)
    if (ngi === undefined) return 0
    const nfo = fluidOf[ngi]
    if (nfo && nfo.kind === kind) {
      // 上方有同种流体 → 视为满格
      if (isFluid(get(dx, dy + 1, dz))) return 1
      return fluidHeight(nfo.level)
    }
    return isSolid(ngi) ? -1 : 0
  }

  // 当前方块自身高度（原版的 n）
  const self = fluidH(0, 0, 0)

  // 原版 calculateFluidHeight
  const corner = (dx, dz) => {
    const a = fluidH(dx, 0, 0)
    const b = fluidH(0, 0, dz)
    if (a >= 1 || b >= 1) return 1
    let sum = 0
    let cnt = 0
    const add = (h) => {
      if (h >= 0.8) {
        sum += h * 10
        cnt += 10
      } else if (h > 0) {
        sum += h
        cnt += 1
      }
      // h <= 0（空气/实心方块）不参与平均：水面不会被边缘的空气拖低，
      // 与游戏内实际显示一致（水面保持平齐，仅在水体内部有过渡）。
    }
    if (a > 0 || b > 0) {
      const f = fluidH(dx, 0, dz)
      if (f >= 1) return 1
      add(f)
    }
    add(self)
    add(a)
    add(b)
    return sum / cnt
  }

  let h00, h10, h01, h11
  if (self >= 1) {
    // 自身满格时表面平齐（原版 n >= 1 的特判）
    h00 = h10 = h01 = h11 = 1
  } else {
    h00 = corner(-1, -1) // 西北 x=0,z=0
    h10 = corner(1, -1) // 东北 x=16,z=0
    h01 = corner(-1, 1) // 西南 x=0,z=16
    h11 = corner(1, 1) // 东南 x=16,z=16
  }

  const above = get(0, 1, 0)
  const below = get(0, -1, 0)
  const aboveFluid = isFluid(above)
  const belowFluid = isFluid(below)
  // 底面：下方不是同种流体且不被不透明完整方块遮挡；含水方块自身满底面时也剔除
  const bottomShown = !belowFluid && !isCullingSolid(below) && !(selfMask & 2)
  const w = bottomShown ? 0.001 : 0 // 原版：底面存在时侧面底边抬高 0.001 防闪烁
  // 顶面：上方不是同种流体；上方为不透明完整方块时只有表面满格才遮挡；含水方块自身满顶面时也剔除
  const minCorner = Math.min(h00, h10, h01, h11)
  const topShown = !aboveFluid && !(isCullingSolid(above) && minCorner >= 1) && !(selfMask & 1)

  let count = 0
  if (topShown) {
    // 顶面：有水平流速时用 flow 贴图并按流向旋转（水源、流动水、岩浆都适用）；
    // 无流速（静止水体）用 still 贴图。原版正是按 getVelocity 的 x/z 分量是否为零来切换。
    const angle = flowAngle(palette, fluidOf, blocks, lx, lz, ly, gi, grid, kind, visible)
    let topTex = stillTex
    let topUVs = [[0, 1], [1, 1], [0, 0], [1, 0]]
    if (angle !== null) {
      topTex = flowTex
      const af = angle - Math.PI / 2
      const ag = Math.sin(af) * 0.25
      const ah = Math.cos(af) * 0.25
      topUVs = [
        [0.5 - ah + ag, 0.5 + ah + ag],
        [0.5 + ah + ag, 0.5 + ah - ag],
        [0.5 - ah - ag, 0.5 - ah + ag],
        [0.5 + ah - ag, 0.5 - ah - ag],
      ]
    }
    record(topTex,
      [[x, y + h01 - 0.001, z + 1], [x + 1, y + h11 - 0.001, z + 1], [x, y + h00 - 0.001, z], [x + 1, y + h10 - 0.001, z]],
      topUVs)
    count++
  }
  if (bottomShown) {
    record(stillTex, [[x + 1, y + w, z + 1], [x, y + w, z + 1], [x + 1, y + w, z], [x, y + w, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
    count++
  }
  // 侧面（邻居为同种流体或不透明完整方块、或含水方块自身满侧面时剔除）
  const side = (dx, dz) => get(dx, 0, dz)
  // 侧面贴着玻璃/树叶等半透明方块时用 overlay 贴图（原版 HalfTransparentBlock/LeavesBlock）
  const overlayTex = isLava ? null : 'block/water_overlay'
  const emitSide = (dx, dz, bit, pos, uv) => {
    const ngi = side(dx, dz)
    if (isFluid(ngi) || isCullingSolid(ngi) || (selfMask & bit)) return
    record(overlayTex && isOverlayBlock(giName(ngi)) ? overlayTex : flowTex, pos, uv)
    count++
  }
  emitSide(0, -1, 4, [[x + 1, y + w, z], [x, y + w, z], [x + 1, y + h10, z], [x, y + h00, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
  emitSide(0, 1, 8, [[x, y + w, z + 1], [x + 1, y + w, z + 1], [x, y + h01, z + 1], [x + 1, y + h11, z + 1]], [[0, 1], [1, 1], [0, 0], [1, 0]])
  emitSide(-1, 0, 16, [[x, y + h00, z], [x, y + w, z], [x, y + h01, z + 1], [x, y + w, z + 1]], [[0, 0], [0, 1], [1, 0], [1, 1]])
  emitSide(1, 0, 32, [[x + 1, y + h11, z + 1], [x + 1, y + w, z + 1], [x + 1, y + h10, z], [x + 1, y + w, z]], [[0, 0], [0, 1], [1, 0], [1, 1]])
  // 气泡柱内部的气泡：原版是柱内中心区域随机上升/下沉的粒子，这里在每个方块中心区域
  // 散落几枚气泡「点」（渲染端用 THREE.Points 点精灵，始终面向摄像头，任何角度可见）。
  if (info.bubble) {
    for (const [bx, by, bz] of bubbleScatter(lx, ly, lz)) {
      record('particle/bubble', [x + bx, y + by, z + bz])
      count++
    }
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
export async function buildFaceGroups(palette, blocks, bounds, onProgress, filter) {
  const grid = {
    W: bounds.width,
    D: bounds.depth,
    H: bounds.height,
    strideY: bounds.width * bounds.depth,
  }
  const minX = bounds.minX
  const minY = bounds.minY
  const minZ = bounds.minZ

  // 邻居可见性：被层级/区域过滤掉的方块按空气处理（用于剔面/流体判断）。
  // 传入的是局部坐标，转成世界坐标再交给 filter（filter 的签名是 (x,y,z,ly)）。
  const visible = filter ? (lx, ly, lz) => filter(lx + minX, ly + minY, lz + minZ, ly) : null

  const renderable = new Uint8Array(palette.length)
  const occludes = new Uint8Array(palette.length)
  const hideSame = new Uint8Array(palette.length)
  const quadsByPalette = new Array(palette.length)
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i].name
    const baked = palette[i].baked
    const sn = shortName(name)
    // 玩家头颅单独渲染（用玩家自己的皮肤），不在这里走方块渲染
    if (sn === 'player_head' || sn === 'player_wall_head') {
      quadsByPalette[i] = null
      hideSame[i] = 0
      continue
    }
    if (baked && baked.quads && baked.quads.length && !isSkipBlock(name)) {
      renderable[i] = 1
      occludes[i] = baked.fullCube && !isTransparent(name) ? 1 : 0
      quadsByPalette[i] = baked.quads
    } else {
      quadsByPalette[i] = null
    }
    // 原版 isSideInvisible：玻璃/树叶同类相邻时隐藏共享面
    hideSame[i] = sn.includes('glass') || sn.endsWith('_leaves') ? 1 : 0
  }

  // 每个调色板条目所属流体（含含水方块/气泡柱）与其「满覆盖」面掩码。
  // 只有含水方块需要 selfMask（其内部水体被自身实体面遮挡）；纯流体（水/岩浆/气泡柱）
  // 的 baked 是整块流体的占位立方体，若误当 selfMask 会把自己顶/底面全剔掉。
  // 透明方块（树叶/玻璃等）的「满覆盖」面是 cutout，不能遮挡内部水体，故也为 0。
  const fluidOf = palette.map(fluidOfEntry)
  const selfMasks = palette.map((p) => {
    const fo = fluidOfEntry(p)
    if (!fo || !fo.waterlogged || isTransparent(p.name)) return 0
    return fullFaceMask(p.baked ? p.baked.quads : null)
  })

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
    const lx = key % grid.W
    const lz = Math.floor(key / grid.W) % grid.D
    const ly = Math.floor(key / grid.strideY)
    const x = lx + minX
    const y = ly + minY
    const z = lz + minZ
    if (filter && !filter(x, y, z, ly)) continue
    const finfo = fluidOf[gi]
    if (finfo) {
      // 流体（水/岩浆/气泡柱/含水方块的内部水体）
      emitted += emitFluidFaces(palette, blocks, fluidOf, lx, lz, ly, x, y, z, gi, grid, selfMasks[gi], visible, (texKey) => {
        counts.set(texKey, (counts.get(texKey) || 0) + 1)
      })
      if (!finfo.waterlogged) continue // 纯流体：不再渲染方块自身
      // 含水方块：继续渲染方块自身的面（下面）
    }
    if (!renderable[gi]) continue
    for (const q of quadsByPalette[gi]) {
      if (faceCulled(blocks, occludes, hideSame, q, lx, lz, ly, gi, grid, visible)) continue
      const gKey = faceKey(palette, gi, q)
      counts.set(gKey, (counts.get(gKey) || 0) + 1)
      emitted++
    }
  }

  // 分配精确大小的 typed arrays。
  // 气泡组是「点」而非面：只存中心坐标（每点 3 个 float），渲染端用 THREE.Points。
  const groups = new Map()
  for (const [gKey, count] of counts) {
    groups.set(gKey, gKey === 'particle/bubble'
      ? { positions: new Float32Array(count * 3), v: 0 }
      : {
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
    const lx = key % grid.W
    const lz = Math.floor(key / grid.W) % grid.D
    const ly = Math.floor(key / grid.strideY)
    const x = lx + minX
    const y = ly + minY
    const z = lz + minZ
    if (filter && !filter(x, y, z, ly)) continue
    const finfo = fluidOf[gi]
    if (finfo) {
      emitFluidFaces(palette, blocks, fluidOf, lx, lz, ly, x, y, z, gi, grid, selfMasks[gi], visible, (texKey, pos, uvs) => {
        const g = groups.get(texKey)
        if (texKey === 'particle/bubble') {
          g.positions[g.v] = pos[0]
          g.positions[g.v + 1] = pos[1]
          g.positions[g.v + 2] = pos[2]
          g.v += 3
        } else {
          writeFace(g, pos, uvs, 0, 0, 0)
        }
      })
      if (!finfo.waterlogged) continue
    }
    if (!renderable[gi]) continue
    for (const q of quadsByPalette[gi]) {
      if (faceCulled(blocks, occludes, hideSame, q, lx, lz, ly, gi, grid, visible)) continue
      const gKey = faceKey(palette, gi, q)
      writeFace(groups.get(gKey), q.verts, q.uvs, x, y, z)
    }
  }

  return { groups, emitted }
}
