// 校验 buildFaceGroups 生成的几何数据：与「字符串 key + 世界坐标查找」的参考实现
// 逐面比对顶点位置与 UV（顺序无关）。
// 用法：node scripts/verify-geometry.mjs <文件>
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseLitematicaRaw } from '../src/litematica.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups, isSkipBlock, isTransparent } from '../src/geometry.js'

const fakeAssets = {
  async getJSON(path) {
    const p = 'public/assets/minecraft/' + path
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  },
}

function shortName(n) { return (n || '').replace(/^minecraft:/, '') }
// 纯流体（水/岩浆/气泡柱）不参与此处的逐面比对：其几何由 geometry.js 的 emitFluidFaces
// 按原版 FluidRenderer 生成（含水面高度、流向旋转等），有独立的校验逻辑。
// 含水方块（waterlogged）在这里只比对其「方块自身」的面，内部水体不在参考中复现。
function isPureFluid(p) {
  const n = shortName(p.name)
  return n === 'water' || n === 'lava' || n === 'bubble_column'
}
// 流体贴图组（新实现会生成、参考实现不生成，比对时跳过）
function isFluidTexKey(k) {
  return k === 'block/water_still' || k === 'block/water_flow' || k === 'block/lava_still' || k === 'block/lava_flow' || k === 'particle/bubble'
}
function isRedstoneDustTex(t) { return /(redstone_dust_dot|redstone_dust_line0|redstone_dust_line1)$/.test(t) }

// 参考实现：字符串 key、世界坐标查找、普通数组（改动前的原版逻辑）
function buildReference(palette, strBlocks) {
  const renderable = new Uint8Array(palette.length)
  const occludes = new Uint8Array(palette.length)
  const hideSame = new Uint8Array(palette.length)
  const quadsByPalette = new Array(palette.length)
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i].name
    const baked = palette[i].baked
    if (baked && baked.quads && baked.quads.length && !isSkipBlock(name)) {
      renderable[i] = 1
      occludes[i] = baked.fullCube && !isTransparent(name) ? 1 : 0
      quadsByPalette[i] = baked.quads
    } else quadsByPalette[i] = null
    const sn = shortName(name)
    hideSame[i] = sn.includes('glass') || sn.endsWith('_leaves') ? 1 : 0
  }

  const groups = new Map() // gKey -> 面签名数组
  let emitted = 0
  for (const [key, gi] of strBlocks) {
    if (!renderable[gi]) continue
    const parts = key.split(',')
    const x = +parts[0], y = +parts[1], z = +parts[2]
    if (isPureFluid(palette[gi])) continue
    for (const q of quadsByPalette[gi]) {
      if (q.cullface) {
        const ngi = strBlocks.get((x + q.cullface[0]) + ',' + (y + q.cullface[1]) + ',' + (z + q.cullface[2]))
        if (ngi !== undefined && (occludes[ngi] || (ngi === gi && hideSame[ngi]))) continue
      }
      let gKey = q.texKey
      if (isRedstoneDustTex(q.texKey)) gKey = q.texKey + '|p' + (Number(palette[gi].properties?.power) || 0)
      let g = groups.get(gKey)
      if (!g) { g = []; groups.set(gKey, g) }
      let sig = ''
      for (let k = 0; k < 4; k++) {
        sig += Math.fround(x + q.verts[k][0]) + ',' + Math.fround(y + q.verts[k][1]) + ',' + Math.fround(z + q.verts[k][2]) + ',' + Math.fround(q.uvs[k][0]) + ',' + Math.fround(q.uvs[k][1]) + ';'
      }
      g.push(sig)
      emitted++
    }
  }
  return { groups, emitted }
}

const file = process.argv[2]
const buf = readFileSync(file)
const raw = new Uint8Array(gunzipSync(buf))
const data = await parseLitematicaRaw(raw)
const resolver = new BlockModelResolver(fakeAssets)
for (const p of data.palette) p.baked = await resolver.resolve(p.name, p.properties)

// 把整数 key 还原成字符串 key 的世界坐标 Map（参考实现用）
const b = data.bounds
const W = b.width, D = b.depth, strideY = W * D
const strBlocks = new Map()
for (const [key, gi] of data.blocks) {
  const lx = key % W
  const lz = Math.floor(key / W) % D
  const ly = Math.floor(key / strideY)
  strBlocks.set((lx + b.minX) + ',' + (ly + b.minY) + ',' + (lz + b.minZ), gi)
}

const { groups, emitted } = await buildFaceGroups(data.palette, data.blocks, data.bounds)
const ref = buildReference(data.palette, strBlocks)

console.log(`新实现: ${emitted} 面, ${groups.size} 组；参考实现: ${ref.emitted} 面, ${ref.groups.size} 组`)

let totalDiff = 0
const allKeys = new Set([...groups.keys(), ...ref.groups.keys()])
for (const gKey of allKeys) {
  if (isFluidTexKey(gKey)) continue // 流体面（水面/流向）不在此比对
  const newSigs = []
  const g = groups.get(gKey)
  if (g) {
    const p = g.positions, u = g.uvs
    const nFaces = g.positions.length / 12
    for (let f = 0; f < nFaces; f++) {
      let sig = ''
      for (let k = 0; k < 4; k++) {
        const vi = f * 4 + k
        sig += p[vi * 3] + ',' + p[vi * 3 + 1] + ',' + p[vi * 3 + 2] + ',' + u[vi * 2] + ',' + u[vi * 2 + 1] + ';'
      }
      newSigs.push(sig)
    }
  }
  const refSigs = (ref.groups.get(gKey) || []).slice()
  newSigs.sort()
  refSigs.sort()
  let diff = 0
  const n = Math.max(newSigs.length, refSigs.length)
  for (let i = 0; i < n; i++) {
    if (newSigs[i] !== refSigs[i]) {
      diff++
      if (diff <= 3) console.log(`  [${gKey}] 面 ${i} 不同:\n    新: ${newSigs[i]}\n    参: ${refSigs[i]}`)
    }
  }
  if (diff) console.log(`❌ 组 ${gKey}: ${diff} 个面不一致`)
  else console.log(`✅ 组 ${gKey}: ${newSigs.length} 面一致`)
  totalDiff += diff
}
console.log(totalDiff === 0 ? '✅ 全部一致' : `❌ 共 ${totalDiff} 个面不一致`)
process.exit(totalDiff ? 1 : 0)
