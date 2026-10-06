// 从本地原版资源目录和 Mojang 官方中文语言文件生成检查页目录。
// node scripts/gen-inspection-data.mjs [版本]（先运行 npm run setup）
import { readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const version = process.argv[2] || '26.3'
async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  return response.json()
}
const manifest = await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
const entry = manifest.versions.find(v => v.id === version)
if (!entry) throw new Error('未知版本：' + version)
const metadata = await json(entry.url)
const index = await json(metadata.assetIndex.url)
const { hash } = index.objects['minecraft/lang/zh_cn.json']
const translations = await json(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`)
const names = Object.fromEntries(Object.entries(translations).filter(([key]) => /^(block|item|entity)\.minecraft\./.test(key)))
const ids = async dir => (await readdir(new URL('../public/assets/minecraft/' + dir, import.meta.url)))
  .filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
const blocks = await ids('blockstates/'), items = await ids('items/')
// blockstates 只记录影响模型的属性；含水、墙的 none 等须从游戏生成的注册报告补齐。
const reportUrl = `https://raw.githubusercontent.com/misode/mcmeta/${version}-summary/blocks/data.json`
const report = await json(reportUrl)
const states = Object.fromEntries(blocks.filter(id => report[id]).map(id => [id, report[id]]))
const hashStates = createHash('sha256').update(JSON.stringify(states)).digest('hex')
await writeFile(new URL('./inspection-block-states.js', import.meta.url),
  `// Minecraft ${version} 的游戏生成方块状态报告，经 mcmeta 归档：${reportUrl}\n`
  + `// gen-inspection-data.mjs 生成；内容 SHA-256：${hashStates}\n`
  + `export const BLOCK_STATES = ${JSON.stringify(states)}\n`)
const output = `// 由 gen-inspection-data.mjs 生成；Minecraft ${version}，官方 zh_cn 资源 SHA-1：${hash}。\n`
  + `export const BLOCK_IDS = ${JSON.stringify(blocks)}\nexport const ITEM_IDS = ${JSON.stringify(items)}\n`
  + `export const ZH_NAMES = ${JSON.stringify(names)}\n`
await writeFile(new URL('./inspection-data.js', import.meta.url), output)
console.log(`检查目录：${blocks.length} 个方块，${items.length} 个物品，${Object.keys(names).length} 条官方译名。`)
