// 从 Mojang 官方资源下载 zh_cn.json，提取方块译名生成 src/blockNames.js。
// 用法：node scripts/gen-block-names.mjs [版本]（默认 26.3，与 fetch-assets 一致）
import { writeFile } from 'node:fs/promises'

const version = process.argv[2] || '26.3'

const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
const entry = manifest.versions.find((v) => v.id === version)
if (!entry) throw new Error(`找不到版本 ${version}`)
const vj = await (await fetch(entry.url)).json()
const assetIndex = await (await fetch(vj.assetIndex.url)).json()
const langObj = assetIndex.objects['minecraft/lang/zh_cn.json']
if (!langObj) throw new Error('资源索引里找不到 zh_cn.json')
const lang = await (await fetch(`https://resources.download.minecraft.net/${langObj.hash.slice(0, 2)}/${langObj.hash}`)).json()

const blocks = {}
for (const [k, v] of Object.entries(lang)) {
  if (k.startsWith('block.minecraft.')) blocks[k.slice('block.minecraft.'.length)] = v
}

const out =
  '// 由 scripts/gen-block-names.mjs 从官方 zh_cn.json 生成，勿手改。\n' +
  '// 方块英文 ID -> 中文译名（仅 block.minecraft.*）。\n' +
  'export const BLOCK_NAMES = ' +
  JSON.stringify(blocks) +
  '\n'
await writeFile(new URL('../src/blockNames.js', import.meta.url), out)
console.log(`生成 src/blockNames.js：${Object.keys(blocks).length} 个方块译名`)
