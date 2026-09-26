// 采样纹理指定区域的平均 RGBA 颜色，用于判断贴图布局。
// 用法：node scripts/probe-texture.mjs <png> <x0> <y0> <x1> <y1> [更多区域...]
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function load(path) {
  const b = readFileSync(path)
  let pos = 8, w = 0, h = 0, ct = 0, idat = [], palette = null
  while (pos < b.length) {
    const len = b.readUInt32BE(pos)
    const type = b.toString('ascii', pos + 4, pos + 8)
    const d = b.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9] }
    else if (type === 'PLTE') palette = d
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = { 3: 1, 6: 4 }[ct]
  const stride = w * bpp
  const lines = []
  let off = 0
  for (let y = 0; y < h; y++) {
    const fl = raw[off]
    const cur = raw.subarray(off + 1, off + 1 + stride)
    const prev = y > 0 ? lines[y - 1] : Buffer.alloc(stride)
    const line = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const bb = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = cur[i]
      if (fl === 1) v = (v + a) & 0xff
      else if (fl === 2) v = (v + bb) & 0xff
      else if (fl === 3) v = (v + ((a + bb) >> 1)) & 0xff
      else if (fl === 4) {
        const q = a + bb - c
        const pa = Math.abs(q - a), pb = Math.abs(q - bb), pc = Math.abs(q - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? bb : c
        v = (v + pr) & 0xff
      }
      line[i] = v
    }
    lines.push(line)
    off += 1 + stride
  }
  return { w, h, ct, bpp, lines, palette }
}

function avg(tex, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, a = 0, n = 0
  for (let y = Math.max(0, y0); y < Math.min(tex.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(tex.w, x1); x++) {
      const line = tex.lines[y]
      const i = x * tex.bpp
      if (tex.ct === 6) { r += line[i]; g += line[i + 1]; b += line[i + 2]; a += line[i + 3] }
      else { const pi = line[i] * 3; r += tex.palette[pi]; g += tex.palette[pi + 1]; b += tex.palette[pi + 2]; a += 255 }
      n++
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)]
}

const path = process.argv[2]
const tex = load(path)
console.log(`### ${path} (${tex.w}x${tex.h}, colortype ${tex.ct})`)
const args = process.argv.slice(3)
for (let i = 0; i + 4 <= args.length; i += 5) {
  const [x0, y0, x1, y1] = args.slice(i, i + 4).map(Number)
  const label = args[i + 4]
  console.log(`  ${label}: [${x0},${y0}]-[${x1},${y1}] =`, avg(tex, x0, y0, x1, y1).join(','))
}
