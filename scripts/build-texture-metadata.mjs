// One small lookup replaces a .png.mcmeta request (usually a 404) per texture.
// Generate from the installed assets so alternate Minecraft versions stay valid.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../public/assets/minecraft/', import.meta.url)
const animation = Object.create(null)
async function scan(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), relative = prefix + entry.name
    if (entry.isDirectory()) await scan(path, relative + '/')
    else if (relative.endsWith('.png.mcmeta')) {
      const data = JSON.parse(await readFile(path, 'utf8'))
      animation[relative.slice(0, -'.png.mcmeta'.length)] = data.animation || false
    }
  }
}
try {
  await scan(fileURLToPath(new URL('textures/', root)))
  await writeFile(new URL('texture-metadata.json', root), JSON.stringify({ version: 1, animation }))
  console.log(`[texture-metadata] Indexed ${Object.keys(animation).length} texture metadata files`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  console.warn('[texture-metadata] Minecraft assets missing; run npm run setup. Runtime will use individual metadata requests.')
}
