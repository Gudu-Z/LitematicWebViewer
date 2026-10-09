import fs from 'node:fs'
import crypto from 'node:crypto'
import JSZip from 'jszip'
// node scripts/generate-entity-dimensions.mjs /path/to/26.3-client.jar
const bytes = fs.readFileSync(process.argv[2] || 'scripts/_ref/audit-26.3-client.jar')
const sha1 = 'e877b6a07acd633fb3bb475002175cec036e7b87'
if (crypto.createHash('sha1').update(bytes).digest('hex') !== sha1) throw Error('Expected the official Minecraft 26.3 client')
const jar = await JSZip.loadAsync(bytes)
function parse(buf) {
  let p = 8
  const u1 = () => buf[p++], u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v }, u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v }
  const cp = Array(u2())
  for (let i = 1; i < cp.length; i++) {
    const tag = u1()
    if (tag === 1) { const length = u2(); cp[i] = buf.toString('utf8', p, p + length); p += length }
    else if ([3, 4].includes(tag)) { cp[i] = tag === 3 ? buf.readInt32BE(p) : buf.readFloatBE(p); p += 4 }
    else if ([5, 6].includes(tag)) { cp[i] = tag === 5 ? String(buf.readBigInt64BE(p)) : buf.readDoubleBE(p); p += 8; i++ }
    else if ([7, 8, 16, 19, 20].includes(tag)) cp[i] = [u2()]
    else if ([9, 10, 11, 12, 17, 18].includes(tag)) cp[i] = [u2(), u2()]
    else if (tag === 15) cp[i] = [u1(), u2()]
    else throw Error('Unknown tag ' + tag)
  }
  const ref = i => Array.isArray(cp[i]) ? cp[i].map(ref).join(' ') : cp[i]
  p += 4; const superName = ref(u2()); const interfaces = u2(); p += interfaces * 2
  function attrs() {
    const result = {}
    for (let n = u2(); n; n--) { const name = cp[u2()], length = u4(); result[name] = buf.subarray(p, p + length); p += length }
    return result
  }
  function members() {
    const out = []
    for (let n = u2(); n; n--) { const flags = u2(), name = cp[u2()], type = cp[u2()]; out.push({ flags, name, type, ...attrs() }) }
    return out
  }
  const fields = members(), methods = members()
  return { fields, methods, ref, superName }
}
const opNames = { 0x63: 'dadd', 0x67: 'dsub', 0x90: 'd2f', 0x8d: 'f2d', 0xb4: 'getfield', 0xb5: 'putfield', 0xb6: 'invokevirtual', 0xb7: 'invokespecial', 0xb8: 'invokestatic' }
const smallConstants = { 2: -1, 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 0, 10: 1, 11: 0, 12: 1, 13: 2, 14: 0, 15: 1 }
function disasm(code, ref) {
  const buf = code.subarray(8, 8 + code.readUInt32BE(4)), lines = []
  for (let p = 0; p < buf.length;) {
    const start = p, op = buf[p++]; let arg = '', extra = 0
    if ([0x10, 0x12, 0xbc].includes(op) || op >= 0x15 && op <= 0x19 || op >= 0x36 && op <= 0x3a || op === 0xa9) extra = 1
    if ([0x11, 0x13, 0x14, 0x84, 0xc0, 0xc1, 0xc6, 0xc7, 0xbb, 0xbd].includes(op) || op >= 0x99 && op <= 0xa8 || op >= 0xb2 && op <= 0xb8) extra = 2
    if ([0xb9, 0xba, 0xc8, 0xc9].includes(op)) extra = 4
    if (op === 0xc5) extra = 3
    if (op >= 0xb2 && op <= 0xb9 || op === 0x13 || op === 0x14) arg = ref(buf.readUInt16BE(p))
    if (op === 0x12) arg = ref(buf[p])
    if (op >= 0x02 && op <= 0x0f) arg = smallConstants[op]
    if (op === 0x10) arg = buf.readInt8(p)
    if (op === 0x11) arg = buf.readInt16BE(p)
    if (op === 0xc1) arg = ref(buf.readUInt16BE(p))
    if (op === 0xaa || op === 0xab) {
      p = (p + 3) & ~3
      if (op === 0xaa) { const lo = buf.readInt32BE(p + 4), hi = buf.readInt32BE(p + 8); p += 12 + (hi - lo + 1) * 4 }
      else p += 8 + buf.readInt32BE(p + 4) * 8
    } else if (op === 0xc4) { p += buf[p] === 0x84 ? 5 : 3 }
    else p += extra
    if (arg !== '' || opNames[op]) lines.push(`${start}: ${opNames[op] || op.toString(16)} ${arg}`)
  }
  return lines.join('\n')
}

const cache = new Map()
async function readClass(name) {
  if (!cache.has(name)) cache.set(name, parse(await jar.file(name + '.class').async('nodebuffer')))
  return cache.get(name)
}
async function living(name) {
  if (name === 'net/minecraft/world/entity/LivingEntity') return true
  if (!name?.startsWith('net/minecraft/world/entity/')) return false
  return living((await readClass(name)).superName)
}
const registry = await readClass('net/minecraft/world/entity/EntityTypes')
const lines = disasm(registry.methods.find(m => m.name === '<clinit>').Code, registry.ref).split('\n')
const constant = line => {
  const value = Number(line?.match(/^\d+: (?:\w+) (-?[\d.e+]+)$/)?.[1])
  if (!Number.isFinite(value)) throw Error('Expected literal: ' + line)
  return value
}
const dimensions = {}, baby = {}
let id, size
for (let i = 0; i < lines.length; i++) {
  const line = lines[i], key = line.match(/b2 net\/minecraft\/world\/entity\/EntityTypeIds (\w+) /)
  if (key) { id = key[1]; size = null }
  if (/Builder sized /.test(line)) {
    const w = constant(lines[i - 2]), h = constant(lines[i - 1])
    size = [w, h, Math.fround(h * Math.fround(.85))]
  }
  if (/Builder eyeHeight /.test(line)) size[2] = constant(lines[i - 1])
  if (/b3 net\/minecraft\/world\/entity\/EntityTypes \w+ Lnet\/minecraft\/world\/entity\/EntityType;/.test(line)) {
    if (!size) throw Error('No dimensions: ' + id)
    const field = registry.fields.find(f => f.name === id)
    const type = registry.ref(field.Signature.readUInt16BE(0)).match(/<L([^;]+);>/)?.[1]
    dimensions[id.toLowerCase()] = [...size, await living(type) ? 1 : 0]
  }
}
if (Object.keys(dimensions).length !== 161) throw Error('Unexpected entity registry')

// Extract literal BABY_DIMENSIONS constructors and chained scale/eye-height calls.
// Attachments affect seats, not these three dimensions, and are deliberately ignored.
for (const path of Object.keys(jar.files).filter(n => n.startsWith('net/minecraft/world/entity/') && n.endsWith('.class') && !n.includes('$'))) {
  const cls = await readClass(path.slice(0, -6)), init = cls.methods.find(m => m.name === '<clinit>')
  if (!init?.Code) continue
  const code = disasm(init.Code, cls.ref).split('\n')
  let start = 0
  for (let i = 0; i < code.length; i++) {
    if (!/b3 /.test(code[i])) continue
    if (/ (BABY_DIMENSIONS|BABY_STANDING_DIMENSIONS) /.test(code[i])) {
      let result
      for (let j = start; j < i; j++) {
        if (/EntityType getDimensions /.test(code[j])) {
          const base = code[j - 1].match(/EntityTypes (\w+) /)?.[1]?.toLowerCase()
          if (!dimensions[base]) throw Error('Unknown base: ' + code[j - 1])
          result = dimensions[base].slice(0, 3)
        }
        if (/EntityDimensions scalable /.test(code[j])) {
          const w = constant(code[j - 2]), h = constant(code[j - 1])
          result = [w, h, Math.fround(h * Math.fround(.85))]
        }
        if (/EntityDimensions scale \(F\)/.test(code[j])) {
          const scale = constant(code[j - 1])
          result = result.map(n => Math.fround(n * scale))
        }
        if (/EntityDimensions withEyeHeight /.test(code[j])) result[2] = constant(code[j - 1])
      }
      let name = path.split('/').pop().replace('.class', '').replace(/[A-Z]/g, (s, i) => (i ? '_' : '') + s.toLowerCase())
      if (name === 'mushroom_cow') name = 'mooshroom'
      if (name !== 'abstract_cow') {
        if (!dimensions[name] || !result) throw Error('Unknown baby: ' + name)
        baby[name] = result
      }
    }
    start = i + 1
  }
}
for (const [id, parent] of Object.entries({ trader_llama: 'llama', glow_squid: 'squid', camel_husk: 'camel' })) baby[id] = baby[parent]
// Inherited age scale (LivingEntity / AbstractChestedHorse), without a static override.
for (const id of ['bee', 'donkey', 'mule', 'sniffer']) baby[id] = dimensions[id].slice(0, 3).map(n => Math.fround(n * .5))
const table = (name, entries) => `export const ${name} = {\n${Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `  ${id}: [${value.join(', ')}],`).join('\n')}\n}\n`
fs.writeFileSync('src/entityDimensionData.js', `// Generated by scripts/generate-entity-dimensions.mjs from the official Minecraft 26.3 client.\n// https://piston-data.mojang.com/v1/objects/${sha1}/client.jar\n// EntityTypes and entity BABY_DIMENSIONS; Java float values preserved.\n// Adult entries: [width, height, eyeHeight, living]; babies: [width, height, eyeHeight].\n${table('ENTITY_DIMENSIONS', dimensions)}\n${table('BABY_DIMENSIONS', baby)}`)
console.log(`Extracted ${Object.keys(dimensions).length} entity dimensions and ${Object.keys(baby).length} baby dimensions.`)
