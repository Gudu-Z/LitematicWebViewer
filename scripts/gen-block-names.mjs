// 从 Mojang 官方资源下载 zh_cn.json / en_us.json，提取方块译名生成 src/blockNames.js。
// 用法：node scripts/gen-block-names.mjs [版本]（默认 26.3，与 fetch-assets 一致）
import { writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const version = process.argv[2] || '26.3'
const PREFIX = 'block.minecraft.'

const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
const entry = manifest.versions.find((v) => v.id === version)
if (!entry) throw new Error(`找不到版本 ${version}`)
const vj = await (await fetch(entry.url)).json()

// 中文：从资源索引按 hash 下载
const assetIndex = await (await fetch(vj.assetIndex.url)).json()
const zhObj = assetIndex.objects['minecraft/lang/zh_cn.json']
if (!zhObj) throw new Error('资源索引里找不到 zh_cn.json')
const zh = await (await fetch(`https://resources.download.minecraft.net/${zhObj.hash.slice(0, 2)}/${zhObj.hash}`)).json()

// 英文：en_us.json 随 client.jar 分发
const jarUrl = vj.downloads?.client?.url
if (!jarUrl) throw new Error('找不到 client.jar 下载地址')
const jarBuf = await (await fetch(jarUrl)).arrayBuffer()
const zip = await JSZip.loadAsync(jarBuf)
const enEntry = zip.file('assets/minecraft/lang/en_us.json')
if (!enEntry) throw new Error('client.jar 里找不到 en_us.json')
const en = JSON.parse(await enEntry.async('string'))

const blocks = { zh: {}, en: {} }
for (const [k, v] of Object.entries(zh)) if (k.startsWith(PREFIX)) blocks.zh[k.slice(PREFIX.length)] = v
for (const [k, v] of Object.entries(en)) if (k.startsWith(PREFIX)) blocks.en[k.slice(PREFIX.length)] = v

const out =
  '// 由 scripts/gen-block-names.mjs 从官方 zh_cn.json / en_us.json 生成，勿手改。\n' +
  '// 方块英文 ID -> 各语言译名（仅 block.minecraft.*）。\n' +
  'export const BLOCK_NAMES = ' +
  JSON.stringify(blocks) +
  '\n'
await writeFile(new URL('../src/blockNames.js', import.meta.url), out)
console.log(`生成 src/blockNames.js：zh ${Object.keys(blocks.zh).length} / en ${Object.keys(blocks.en).length} 个方块译名`)
