// 从 Minecraft client.jar 提取并展开 BlockTags.BLOCKS_FLUID_FLOW 标签，
// 生成 src/fluidFlowBlocks.js（一个静态 Set，运行时直接 import，无需联网/解析标签）。
//
// 这个标签用于水流朝向：getFlow 里遇到「空流体邻居」时，若该邻居方块属于
// BLOCKS_FLUID_FLOW（= blocks_motion + all_signs，即各种实心/非流体方块），
// 就把它当作「阻挡流动」直接跳过；只有空气、植物、火把等不在标签里的方块，
// 才会继续往下查看是否有可流下的水。
//
// 用法：
//   node scripts/gen-fluid-flow-blocks.mjs            # 下载默认版本 26.3 并生成
//   node scripts/gen-fluid-flow-blocks.mjs 1.21.1     # 指定版本
//   node scripts/gen-fluid-flow-blocks.mjs --jar <path>  # 使用本地 client.jar

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outPath = join(root, 'src', 'fluidFlowBlocks.js')

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const TAG_PREFIX = 'data/minecraft/tags/block/'

async function loadJarByVersion(version) {
  const manifest = await (await fetch(VERSION_MANIFEST)).json()
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) {
    const recent = manifest.versions.slice(-8).map((v) => v.id).join(', ')
    throw new Error(`找不到版本 ${version}。可用的近期版本：${recent}`)
  }
  const vj = await (await fetch(entry.url)).json()
  const jarUrl = vj.downloads?.client?.url
  if (!jarUrl) throw new Error('找不到 client.jar 下载地址')
  console.log(`[gen-fluid-flow-blocks] 下载 client.jar …`)
  const buf = await (await fetch(jarUrl)).arrayBuffer()
  return JSZip.loadAsync(buf)
}

// 递归展开一个标签为「短名」集合（去掉 minecraft: 前缀）。tagName 形如 "blocks_fluid_flow"。
async function expandTag(zip, tagName, cache) {
  if (cache.has(tagName)) return cache.get(tagName)
  const rel = TAG_PREFIX + tagName + '.json'
  const file = zip.file(rel)
  if (!file) throw new Error(`缺少标签文件 ${rel}`)
  const json = JSON.parse(await file.async('string'))
  const out = new Set()
  for (const v of json.values || []) {
    if (v.startsWith('#')) {
      const sub = await expandTag(zip, v.slice('#minecraft:'.length), cache)
      for (const s of sub) out.add(s)
    } else {
      // 显式方块 id（minecraft:stone 等）→ 短名
      out.add(v.replace(/^minecraft:/, ''))
    }
  }
  cache.set(tagName, out)
  return out
}

async function main() {
  const args = process.argv.slice(2)
  let zip
  if (args[0] === '--jar') {
    const jarPath = args[1]
    if (!jarPath) throw new Error('--jar 需要给出 client.jar 路径')
    console.log(`[gen-fluid-flow-blocks] 读取本地 client.jar：${jarPath}`)
    zip = await JSZip.loadAsync(await readFile(jarPath))
  } else {
    const version = args[0] || '26.3'
    zip = await loadJarByVersion(version)
  }

  const set = await expandTag(zip, 'blocks_fluid_flow', new Map())
  const list = [...set].sort()

  const body = `// 由 scripts/gen-fluid-flow-blocks.mjs 自动生成，请勿手改。
// BlockTags.BLOCKS_FLUID_FLOW（= blocks_motion + all_signs）展开后的全部方块短名。
// 用于水流朝向：空流体邻居若属于这些方块，则视为「阻挡流动」，不再向下查看。
export const FLUID_FLOW_BLOCKS = new Set(${JSON.stringify(list)})
`
  await writeFile(outPath, body, 'utf8')
  console.log(`[gen-fluid-flow-blocks] 生成 ${list.length} 个方块 -> src/fluidFlowBlocks.js`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
