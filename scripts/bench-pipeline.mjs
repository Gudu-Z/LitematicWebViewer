// 分阶段计时：解压 -> 解析 -> 烘焙 -> 生成几何体，定位耗时瓶颈。
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNBT } from '../src/nbt.js'
import { parseLitematicaRaw } from '../src/litematica.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups } from '../src/geometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const file = process.argv[2]

const fakeAssets = {
  async getJSON(path) {
    const p = join(root, 'public', 'assets', 'minecraft', path)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  },
}

let t = Date.now()
const buf = readFileSync(file)
const raw = new Uint8Array(gunzipSync(buf))
console.log(`1. 解压: ${Date.now() - t} ms (${buf.length} -> ${raw.length} 字节)`)

t = Date.now()
const rootNBT = parseNBT(raw)
console.log(`2. parseNBT: ${Date.now() - t} ms`)

t = Date.now()
const data = await parseLitematicaRaw(raw)
console.log(`3. 解析+解码+建Map: ${Date.now() - t} ms (${data.blocks.size} 方块, ${data.palette.length} 调色板)`)

const resolver = new BlockModelResolver(fakeAssets)
t = Date.now()
for (const p of data.palette) p.baked = await resolver.resolve(p.name, p.properties)
console.log(`4. 烘焙模型: ${Date.now() - t} ms`)

t = Date.now()
const { groups, emitted } = await buildFaceGroups(data.palette, data.blocks, data.bounds)
console.log(`5. 生成几何体: ${Date.now() - t} ms (${emitted} 面, ${groups.size} 组)`)
