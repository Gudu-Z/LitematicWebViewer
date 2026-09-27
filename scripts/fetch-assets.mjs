// 从 Mojang 官方下载指定 Minecraft 版本的默认资源
// （贴图 textures/block、方块模型 models/block、方块状态 blockstates）
// 到 public/assets/minecraft/ 目录，供预览器默认渲染使用。
//
// 这些资源打包在 client.jar 内，脚本会下载 client.jar 并用 JSZip 解压所需文件。
//
// 用法：
//   npm run setup                 # 下载默认版本（26.3，最新正式版）
//   node scripts/fetch-assets.mjs 1.21.1   # 指定其他版本
//
// 首次运行需要联网，下载完成后可离线使用。

import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const version = process.argv[2] || '26.3'
const outDir = join(root, 'public', 'assets', 'minecraft')

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const PREFIXES = [
  'assets/minecraft/textures/block/',
  'assets/minecraft/blockstates/',
  'assets/minecraft/models/block/',
  'assets/minecraft/textures/entity/', // 实体贴图（矿车等）
  'assets/minecraft/textures/item/', // 物品贴图（物品展示框内容）
]
// 额外单独下载的粒子贴图（气泡柱的气泡）
const EXTRA_FILES = [
  'assets/minecraft/textures/particle/bubble.png',
]

async function main() {
  console.log(`[fetch-assets] 目标版本：${version}`)

  const manifest = await (await fetch(VERSION_MANIFEST)).json()
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) {
    const recent = manifest.versions.slice(-8).map((v) => v.id).join(', ')
    throw new Error(`找不到版本 ${version}。可用的近期版本：${recent}`)
  }

  const vj = await (await fetch(entry.url)).json()
  const jarUrl = vj.downloads?.client?.url
  if (!jarUrl) throw new Error('找不到 client.jar 下载地址')

  console.log('[fetch-assets] 正在下载 client.jar …')
  const jarBuf = await (await fetch(jarUrl)).arrayBuffer()
  console.log(`[fetch-assets] client.jar 大小 ${(jarBuf.byteLength / 1024 / 1024).toFixed(1)} MB`)

  const zip = await JSZip.loadAsync(jarBuf)
  const entries = []
  zip.forEach((rel, file) => {
    if (file.dir) return
    if (PREFIXES.some((p) => rel.startsWith(p)) || EXTRA_FILES.includes(rel)) entries.push({ rel, file })
  })

  console.log(`[fetch-assets] 找到 ${entries.length} 个资源文件，正在解压 …`)

  let done = 0
  for (const { rel, file } of entries) {
    const destRel = rel.slice('assets/minecraft/'.length)
    const dest = join(outDir, ...destRel.split('/'))
    const buf = await file.async('nodebuffer')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    done++
    if (done % 300 === 0 || done === entries.length) {
      console.log(`  进度 ${done}/${entries.length}`)
    }
  }

  console.log(`[fetch-assets] 完成，共 ${done} 个文件 -> public/assets/minecraft/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
