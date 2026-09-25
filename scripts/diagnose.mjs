// 诊断脚本：在 Node 中跑通「解压 -> 解析 -> 解码 -> 模型烘焙 -> 面生成」全管线（不含 WebGL），
// 用于排查问题出在哪一层。
// 用法：node scripts/diagnose.mjs [文件路径]   （默认 samples/demo.litematic）

import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLitematicaRaw } from '../src/litematica.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups } from '../src/geometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fileArg = process.argv[2] || join(root, 'samples', 'demo.litematic')

// 模拟浏览器 DecompressionStream 的解压（Node 用 zlib 代替）
function decompress(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return new Uint8Array(gunzipSync(buf))
  if (buf.length >= 2 && buf[0] === 0x78) return new Uint8Array(inflateSync(buf))
  return buf
}

// 模拟浏览器 fetch('/assets/minecraft/...')：从本地 public/ 读文件
const fakeAssets = {
  async getJSON(path) {
    const p = join(root, 'public', 'assets', 'minecraft', path)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  },
}

const resolver = new BlockModelResolver(fakeAssets)

// 验证模型烘焙器：烘焙几个代表性模型并检查形状
async function testBaker() {
  console.log('[baker] === 模型烘焙验证 ===')
  const cases = [
    ['整方块 stone', 'minecraft:stone', {}],
    ['下半台阶 smooth_stone_slab', 'minecraft:smooth_stone_slab', { type: 'bottom', waterlogged: 'false' }],
    ['楼梯 oak_stairs', 'minecraft:oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' }],
    ['栅栏 oak_fence', 'minecraft:oak_fence', {}],
    ['玻璃 glass', 'minecraft:glass', {}],
    ['原木 oak_log', 'minecraft:oak_log', { axis: 'y' }],
    ['原木(横) oak_log axis=x', 'minecraft:oak_log', { axis: 'x' }],
  ]
  for (const [label, name, props] of cases) {
    const baked = await resolver.resolve(name, props)
    if (!baked || !baked.quads.length) {
      console.log(`[baker] ${label}: 解析失败`)
      continue
    }
    let minX = 2, minY = 2, minZ = 2, maxX = -1, maxY = -1, maxZ = -1
    for (const q of baked.quads) {
      for (const v of q.verts) {
        if (v[0] < minX) minX = v[0]
        if (v[0] > maxX) maxX = v[0]
        if (v[1] < minY) minY = v[1]
        if (v[1] > maxY) maxY = v[1]
        if (v[2] < minZ) minZ = v[2]
        if (v[2] > maxZ) maxZ = v[2]
      }
    }
    const texKeys = new Set(baked.quads.map((q) => q.texKey))
    console.log(
      `[baker] ${label}: ${baked.quads.length} 个面, fullCube=${baked.fullCube}, ` +
      `范围 x[${minX.toFixed(2)},${maxX.toFixed(2)}] y[${minY.toFixed(2)},${maxY.toFixed(2)}] z[${minZ.toFixed(2)},${maxZ.toFixed(2)}], ` +
      `贴图 [${[...texKeys].join(', ')}]`
    )
  }
}

async function main() {
  await testBaker()
  console.log('')

  const buf = readFileSync(fileArg)
  console.log(`[diagnose] 文件：${fileArg}（${buf.length} 字节）`)

  const raw = decompress(buf)
  console.log(`[diagnose] 解压后 ${raw.length} 字节`)

  const data = parseLitematicaRaw(raw)
  console.log(`[diagnose] 元数据：名称="${data.metadata.name}" 尺寸=${data.metadata.enclosingSize.x}×${data.metadata.enclosingSize.y}×${data.metadata.enclosingSize.z}`)
  console.log(`[diagnose] 调色板 ${data.palette.length} 种方块，方块映射 ${data.blocks.size} 个`)

  let resolvable = 0
  for (const p of data.palette) {
    p.baked = await resolver.resolve(p.name, p.properties)
    if (p.baked && p.baked.quads.length) resolvable++
  }
  console.log(`[diagnose] 可渲染的方块种类：${resolvable} / ${data.palette.length}`)

  const { groups, emitted } = buildFaceGroups(data.palette, data.blocks)
  console.log(`[diagnose] 生成的面数：${emitted}，分组（贴图）数：${groups.size}`)
  console.log(`[diagnose] 结论：${emitted > 0 ? '面生成正常' : '面生成为零，问题在面生成/烘焙环节'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
