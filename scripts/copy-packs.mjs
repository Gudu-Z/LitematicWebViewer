// 把 resourcepacks/ 目录里的资源包（.zip）复制到 public/resourcepacks/，
// 并生成 manifest.json 供前端列出可用资源包。
// 用法：npm run packs   （新增/删除资源包后重新运行一次即可）

import { readdirSync, copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const srcDir = join(root, 'resourcepacks')
const outDir = join(root, 'public', 'resourcepacks')

if (!existsSync(srcDir)) {
  console.log('[copy-packs] 没有 resourcepacks 目录，跳过')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const packs = []
for (const f of readdirSync(srcDir)) {
  if (!f.toLowerCase().endsWith('.zip')) continue
  copyFileSync(join(srcDir, f), join(outDir, f))
  packs.push({ name: f.replace(/\.zip$/i, ''), file: f })
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(packs, null, 2))
console.log(`[copy-packs] 已复制 ${packs.length} 个资源包到 public/resourcepacks/`)
for (const p of packs) console.log(`  - ${p.name}`)
