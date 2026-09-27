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
      // 流体参考：字符串查找版（复刻新 emitFluidFaces 的原版 FluidRenderer 算法）
      const name = shortName(palette[gi].name)
      const isLava = name === 'lava'
      const still = isLava ? 'block/lava_still' : 'block/water_still'
      const flow = isLava ? 'block/lava_flow' : 'block/water_flow'
      const get = (dx, dy, dz) => strBlocks.get((x + dx) + ',' + (y + dy) + ',' + (z + dz))
      const giName = (gi2) => (gi2 === undefined ? '' : shortName(palette[gi2].name))
      const isFluid = (gi2) => giName(gi2) === name
      const isSolid = (gi2) => gi2 !== undefined && !!palette[gi2].baked && palette[gi2].baked.fullCube && !giName(gi2).endsWith('_leaves')
      const fluidH = (dx, dy, dz) => {
        const ngi = get(dx, dy, dz)
        if (ngi === undefined) return 0
        if (giName(ngi) === name) {
          if (isFluid(get(dx, dy + 1, dz))) return 1
          return fluidHeight(palette[ngi].properties?.level)
        }
        return isSolid(ngi) ? -1 : 0
      }
      const self = fluidH(0, 0, 0)
      const corner = (dx, dz) => {
        const a = fluidH(dx, 0, 0)
        const b = fluidH(0, 0, dz)
        if (a >= 1 || b >= 1) return 1
        let sum = 0, cnt = 0
        const add = (h) => {
          if (h >= 0.8) { sum += h * 10; cnt += 10 }
          else if (h >= 0) { sum += h; cnt += 1 }
        }
        if (a > 0 || b > 0) {
          const f = fluidH(dx, 0, dz)
          if (f >= 1) return 1
          add(f)
        }
        add(self); add(a); add(b)
        return sum / cnt
      }
      let h00, h10, h01, h11
      if (self >= 1) h00 = h10 = h01 = h11 = 1
      else {
        h00 = corner(-1, -1); h10 = corner(1, -1); h01 = corner(-1, 1); h11 = corner(1, 1)
      }
      const above = get(0, 1, 0)
      const below = get(0, -1, 0)
      const bottomShown = !isFluid(below) && !isSolid(below)
      const w = bottomShown ? 0.001 : 0
      const minCorner = Math.min(h00, h10, h01, h11)
      const topShown = !isFluid(above) && !(isSolid(above) && minCorner >= 1)
      const push = (tex, pos, uv) => {
        let g = groups.get(tex)
        if (!g) { g = []; groups.set(tex, g) }
        // Math.fround：参考值也量化到 Float32 精度（与 typed array 存储一致）
        let sig = ''
        for (let k = 0; k < 4; k++) sig += Math.fround(pos[k][0]) + ',' + Math.fround(pos[k][1]) + ',' + Math.fround(pos[k][2]) + ',' + Math.fround(uv[k][0]) + ',' + Math.fround(uv[k][1]) + ';'
        g.push(sig)
        emitted++
      }
      if (topShown) push(still, [[x, y + h01 - 0.001, z + 1], [x + 1, y + h11 - 0.001, z + 1], [x, y + h00 - 0.001, z], [x + 1, y + h10 - 0.001, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (bottomShown) push(still, [[x + 1, y + w, z + 1], [x, y + w, z + 1], [x + 1, y + w, z], [x, y + w, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!isFluid(get(0, 0, -1)) && !isSolid(get(0, 0, -1))) push(flow, [[x + 1, y + w, z], [x, y + w, z], [x + 1, y + h10, z], [x, y + h00, z]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!isFluid(get(0, 0, 1)) && !isSolid(get(0, 0, 1))) push(flow, [[x, y + w, z + 1], [x + 1, y + w, z + 1], [x, y + h01, z + 1], [x + 1, y + h11, z + 1]], [[0, 1], [1, 1], [0, 0], [1, 0]])
      if (!isFluid(get(-1, 0, 0)) && !isSolid(get(-1, 0, 0))) push(flow, [[x, y + h00, z], [x, y + w, z], [x, y + h01, z + 1], [x, y + w, z + 1]], [[0, 0], [0, 1], [1, 0], [1, 1]])
      if (!isFluid(get(1, 0, 0)) && !isSolid(get(1, 0, 0))) push(flow, [[x + 1, y + h11, z + 1], [x + 1, y + w, z + 1], [x + 1, y + h10, z], [x + 1, y + w, z]], [[0, 0], [0, 1], [1, 0], [1, 1]])
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
