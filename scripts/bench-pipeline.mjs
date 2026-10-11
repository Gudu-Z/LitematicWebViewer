// 分阶段计时：解压 -> 解析 -> 烘焙 -> 生成几何体，定位耗时瓶颈。
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLitematicaRaw } from '../src/litematica.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups } from '../src/geometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const file = process.argv[2]

// Match AssetProvider's JSON cache; repeated synchronous disk reads otherwise
// dominate this benchmark and misrepresent model baking in the browser.
const jsonCache = new Map()
const fakeAssets = {
  async getJSON(path) {
    if (jsonCache.has(path)) return jsonCache.get(path)
    const p = join(root, 'public', 'assets', 'minecraft', path)
    const value = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    jsonCache.set(path, value)
    return value
  },
}

let t = Date.now()
const buf = readFileSync(file)
const raw = new Uint8Array(gunzipSync(buf))
console.log(`1. 解压: ${Date.now() - t} ms (${buf.length} -> ${raw.length} 字节)`)

t = Date.now()
const data = await parseLitematicaRaw(raw)
console.log(`2. NBT解析+解码+建Map: ${Date.now() - t} ms (${data.blocks.size} 方块, ${data.palette.length} 调色板)`)

const resolver = new BlockModelResolver(fakeAssets)
t = Date.now()
await Promise.all(data.palette.map(async p => { p.baked = await resolver.resolve(p.name, p.properties) }))
console.log(`3. 烘焙模型: ${Date.now() - t} ms`)

t = Date.now()
const { groups, emitted } = await buildFaceGroups(data.palette, data.blocks, data.bounds)
console.log(`4. 生成几何体: ${Date.now() - t} ms (${emitted} 面, ${groups.size} 组)`)
const bytes = [...groups.values()].reduce((n, g) => n + g.positions.byteLength + (g.uvs?.byteLength || 0) + (g.indices?.byteLength || 0), 0)
console.log(`几何体缓冲区: ${(bytes / 1024 / 1024).toFixed(2)} MiB`)
