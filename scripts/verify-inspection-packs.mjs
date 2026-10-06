import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { readInspectionPack } from './inspection-packs.js'
import { AssetProvider } from '../src/assets.js'

async function pack(value, prefix = '') {
  const zip = new JSZip()
  zip.file(prefix + 'pack.mcmeta', '\uFEFF' + JSON.stringify({ pack: { description: 'Test', pack_format: 85 } }))
  zip.file(prefix + 'assets/minecraft/models/block/stone.json', JSON.stringify({ value }))
  return zip.generateAsync({ type: 'uint8array' })
}
const a = await readInspectionPack(await pack('A'))
const b = await readInspectionPack(await pack('B', 'wrapped/'))
assert.ok((await readInspectionPack(await readFile('public/resourcepacks/XK redstone display 26.3.0.zip'))).file('pack.mcmeta'), 'built-in XK metadata with UTF-8 BOM')
const assets = new AssetProvider()
assets.addPack(a, 'A'); assets.addPack(b, 'B')
const value = async () => (await assets.getJSON('models/block/stone.json')).value
assert.equal(await value(), 'A')
assets.movePack('B', -1); assert.equal(await value(), 'B')
assets.removePack('B'); assert.equal(await value(), 'A')
assets.addPack(b, 'A'); assert.equal(await value(), 'B', 'same-name replacement invalidates cache')
assets.clearPacks()
// The vanilla fallback uses the same fetch path as the browser.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => new Response(JSON.stringify({ value: 'vanilla' }), { headers: { 'content-type': 'application/json' } })
try { assert.equal(await value(), 'vanilla') } finally { globalThis.fetch = originalFetch }
await assert.rejects(readInspectionPack(new Uint8Array([1, 2, 3])), /ZIP/)
const missing = new JSZip(); missing.file('readme.txt', 'Not a pack')
await assert.rejects(readInspectionPack(await missing.generateAsync({ type: 'uint8array' })), /pack.mcmeta/)
missing.file('pack.mcmeta', '{}')
await assert.rejects(readInspectionPack(await missing.generateAsync({ type: 'uint8array' })), /格式/)
missing.file('pack.mcmeta', '{"pack":{}}')
await assert.rejects(readInspectionPack(await missing.generateAsync({ type: 'uint8array' })), /资源/)
console.log('Passed ZIP validation, wrapped pack folders, override priority, reordering, unloading, replacement and vanilla fallback')
