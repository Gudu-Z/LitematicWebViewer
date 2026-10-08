import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURL, validFile, validCamera, fetchSchematic, MAX_FILE_BYTES } from '../src/embedProtocol.js'
import { normalizeOptions, themeValues } from '../src/previewOptions.js'

const base = 'https://viewer.example/subdir/'
for (const options of [
  { background: 'url(https://other.example/tracker)' }, { background: '#ffffff80' },
  { style: { accent: 'red; display:none' } }, { style: { fontFamily: 'serif; color:red' } },
  { controls: { pan: true } }, { controls: { open: 'false' } },
  { camera: { projection: 'invalid' } }, { camera: { zoom: Infinity } },
  { camera: { position: [1, 2, 3] } }, { camera: { position: [1,2,3], target: [1,2,3] } },
  { viewer: { panelOpacity: 0 } }, { viewer: { layout: 'sidebar' } }, { viewer: { panels: { controls: 'false' } } },
  { viewer: { brand: { logo: 'javascript:alert(1)' } } }, { viewer: { brand: { returnUrl: 'https://u:p@archive.example/' } } },
  { viewer: { brand: { logo: '/logo.svg' } } }, { viewer: { tools: { typo: true } } }, { viewer: [] },
]) assert.throws(() => normalizeOptions(options), TypeError)
const initialOptions = normalizeOptions({ theme:'auto', controls:{hint:false}, style:{accent:'#123456'}, camera:{projection:'orthographic'} })
const mergedOptions = normalizeOptions({ controls:{open:false}, labels:{reset:'<img onerror=alert(1)>'} }, initialOptions)
assert.equal(mergedOptions.controls.hint,false)
assert.equal(mergedOptions.controls.open,false)
assert.equal(initialOptions.controls.open,true,'configuration merging never mutates existing state')
assert.equal(themeValues(initialOptions,true).theme,'dark')
assert.equal(themeValues(initialOptions,false).theme,'light')
assert.equal(themeValues(normalizeOptions({background:'transparent'})).background,'transparent')
assert.equal(themeValues(normalizeOptions({style:{accent:null}},initialOptions)).accent,'#1268bf','null clears a color override')
assert.equal(normalizeOptions({controls:null},initialOptions).controls.hint,true,'null resets an option group')
const branded = normalizeOptions({ viewer: { panels: { file: false }, expanded: { materials: false }, brand: { name: '<b>Archive</b>', returnUrl: 'https://archive.example/build/42' } } })
const adjusted = normalizeOptions({ viewer: { panels: { metadata: false } } }, branded)
assert.equal(adjusted.viewer.panels.file, false)
assert.equal(adjusted.viewer.panels.metadata, false)
assert.equal(branded.viewer.panels.metadata, true)
assert.equal(adjusted.viewer.brand.name, '<b>Archive</b>')
assert.equal(normalizeOptions({ viewer: { panels: null } }, adjusted).viewer.panels.file, true)
assert.equal(normalizeOptions({ viewer: null }, adjusted).viewer.expanded.materials, true)
assert.equal(fileURL('demo.litematic', base), base + 'demo.litematic')
for (const value of ['javascript:alert(1)', 'data:application/octet-stream,abc', 'file:///etc/passwd', 'https://user:password@archive.example/a', 'http://archive.example/a']) assert.throws(() => fileURL(value, base))
assert.equal(fileURL('http://localhost:3000/a', 'http://localhost:5173/'), 'http://localhost:3000/a')
assert.equal(validFile(new File([], 'empty.litematic')), false)
assert.equal(validFile({ size: 528 }), false)
assert.equal(validCamera({ position: [NaN, 1, 1], target: [0, 0, 0] }), false)
assert.equal(validCamera({ position: [1, 1, 1], target: [1, 1, 1] }), false)
assert.equal(validCamera({ position: [1, 2, 3], target: [-4, 0, 2] }), true)
const sample = await readFile('public/demo.litematic')
const originalFetch = globalThis.fetch
try {
  let requestOptions
  globalThis.fetch = async (_, options) => { requestOptions = options; return new Response(sample) }
  const result = await fetchSchematic('https://archive.example/%E6%8A%95%E5%BD%B1.litematic', base)
  assert.equal(result.name, '投影.litematic')
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), sample)
  assert.equal(requestOptions.credentials, 'omit')
  assert.equal(requestOptions.referrerPolicy, 'no-referrer')
  globalThis.fetch = async () => new Response('', { status: 403 })
  await assert.rejects(fetchSchematic('/file', base), /HTTP 403/)
  globalThis.fetch = async () => new Response('<html>Login page</html>', { headers: { 'Content-Type': 'text/html' } })
  await assert.rejects(fetchSchematic('/file', base), /notSchematic/)
  globalThis.fetch = async () => new Response(sample, { headers: { 'Content-Length': String(MAX_FILE_BYTES + 1) } })
  await assert.rejects(fetchSchematic('/file', base), /fileLimit/)
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_BYTES)); controller.enqueue(new Uint8Array(1)) },
    cancel() { cancelled = true },
  }))
  await assert.rejects(fetchSchematic('/file', base), /fileLimit/)
  assert.equal(cancelled, true, 'oversized chunked download stops reading')
} finally { globalThis.fetch = originalFetch }
console.log('Passed URL schemes/credentials/mixed content, file and camera validation, filename decoding, credential-free downloads, HTTP/HTML errors and bounded streaming without Content-Length.')
