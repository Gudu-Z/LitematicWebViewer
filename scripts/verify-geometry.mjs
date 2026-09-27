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
function isFluidName(n) { const s = shortName(n); return s === 'water' || s === 'lava' }
function isRedstoneDustTex(t) { return /(redstone_dust_dot|redstone_dust_line0|redstone_dust_line1)$/.test(t) }
function fluidHeight(l) { const v = Number(l) || 0; return v <= 0 ? 1 : v < 8 ? 1 - v / 8 : 0.125 }

// 参考实现：字符串 key、世界坐标查找、普通数组（改动前的原版逻辑）
function buildReference(palette, strBlocks) {
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
    } else quadsByPalette[i] = null
  }

  const groups = new Map() // gKey -> 面签名数组
  let emitted = 0
  for (const [key, gi] of strBlocks) {
    if (!renderable[gi]) continue
    const parts = key.split(',')
    const x = +parts[0], y = +parts[1], z = +parts[2]
    if (isFluidName(palette[gi].name)) {
      // 流体参考：字符串查找版（复刻 emitFluidFaces 的旧实现）
      const isLava = shortName(palette[gi].name) === 'lava'
      const self = fluidHeight(palette[gi].properties?.level)
      const still = isLava ? 'block/lava_still' : 'block/water_still'
      const flow = isLava ? 'block/lava_flow' : 'block/water_flow'
      const nbh = (dx, dz) => {
        const ngi = strBlocks.get((x + dx) + ',' + y + ',' + (z + dz))
        if (ngi === undefined || !isFluidName(palette[ngi].name)) return self
        return fluidHeight(palette[ngi].properties?.level)
      }
      const corner = (dx, dz) => {
        const a = Math.max(self, nbh(dx, 0)), b = Math.max(self, nbh(0, dz))
        return (self + a + b) / 3
      }
      const h00 = corner(-1, -1), h10 = corner(1, -1), h01 = corner(-1, 1), h11 = corner(1, 1)
      const fluidAt = (dx, dz) => {
        const ngi = strBlocks.get((x + dx) + ',' + y + ',' + (z + dz))
        return ngi !== undefined && isFluidName(palette[ngi].name)
      }
      const occluded = (dy) => {
        const ngi = strBlocks.get(x + ',' + (y + dy) + ',' + z)
        if (ngi === undefined) return false
        if (isFluidName(palette[ngi].name)) return true
        return !!(palette[ngi].baked && palette[ngi].baked.fullCube && !isTransparent(palette[ngi].name))
      }
      const push = (tex, pos, uv) => {
        let g = groups.get(tex)
        if (!g) { g = []; groups.set(tex, g) }
        // Math.fround：参考值也量化到 Float32 精度（与 typed array 存储一致）
        let sig = ''
        for (let k = 0; k < 4; k++) sig += Math.fround(pos[k][0]) + ',' + Math.fround(pos[k][1]) + ',' + Math.fround(pos[k][2]) + ',' + Math.fround(uv[k][0]) + ',' + Math.fround(uv[k][1]) + ';'
        g.push(sig)
        emitted++
      }
      if (!occluded(1)) push(still, [[x, y + h01, z + 1], [x + 1, y + h11, z + 1], [x, y + h00, z], [x + 1, y + h10, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!occluded(-1)) push(still, [[x + 1, y, z + 1], [x, y, z + 1], [x + 1, y, z], [x, y, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!fluidAt(0, -1)) push(flow, [[x + 1, y, z], [x, y, z], [x + 1, y + h10, z], [x, y + h00, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!fluidAt(0, 1)) push(flow, [[x, y, z + 1], [x + 1, y, z + 1], [x, y + h01, z + 1], [x + 1, y + h11, z + 1]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!fluidAt(-1, 0)) push(flow, [[x, y + h00, z], [x, y, z], [x, y + h01, z + 1], [x, y, z + 1]], [[0, 0], [0, 1], [1, 0], [1, 1]])
      if (!fluidAt(1, 0)) push(flow, [[x + 1, y + h11, z + 1], [x + 1, y, z + 1], [x + 1, y + h10, z], [x + 1, y, z]], [[0, 0], [0, 1], [1, 0], [1, 1]])
      continue
    }
    for (const q of quadsByPalette[gi]) {
      if (q.cullface) {
        const ngi = strBlocks.get((x + q.cullface[0]) + ',' + (y + q.cullface[1]) + ',' + (z + q.cullface[2]))
        if (ngi !== undefined && (occludes[ngi] || ngi === gi)) continue
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
