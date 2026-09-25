// 解码 PNG 并用 ASCII 打印纹理，用于判断贴图的方向性特征（哪边是上）。
// 用法：node scripts/inspect-texture.mjs public/assets/minecraft/textures/block/piston_side.png
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (!file) { console.error('用法: node scripts/inspect-texture.mjs <png>'); process.exit(1) }

const buf = readFileSync(file)
if (buf.readUInt32BE(0) !== 0x89504e47) { console.error('不是 PNG'); process.exit(1) }

let pos = 8
let width = 0, height = 0, bitDepth = 0, colorType = 0
const idat = []
let palette = null

while (pos < buf.length) {
  const len = buf.readUInt32BE(pos)
  const type = buf.toString('ascii', pos + 4, pos + 8)
  const data = buf.subarray(pos + 8, pos + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
  } else if (type === 'PLTE') {
    palette = data
  } else if (type === 'IDAT') {
    idat.push(data)
  } else if (type === 'IEND') {
    break
  }
  pos += 12 + len
}

const raw = inflateSync(Buffer.concat(idat))
const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
if (!bpp) { console.error('不支持的颜色类型 ' + colorType); process.exit(1) }
const stride = width * bpp

function pixel(x, y) {
  const line = scanlines[y]
  const i = x * bpp
  if (colorType === 6) return [line[i], line[i + 1], line[i + 2], line[i + 3]]
  if (colorType === 2) return [line[i], line[i + 1], line[i + 2], 255]
  if (colorType === 3) { const pi = line[i] * 3; return [palette[pi], palette[pi + 1], palette[pi + 2], 255] }
  if (colorType === 4) return [line[i], line[i], line[i], line[i + 1]]
  return [line[i], line[i], line[i], 255]
}

// 逐行重建（应用 PNG 行过滤器）
const scanlines = []
let p = 0
for (let y = 0; y < height; y++) {
  const filter = raw[p]
  const line = Buffer.alloc(stride)
  const cur = raw.subarray(p + 1, p + 1 + stride)
  const prev = y > 0 ? scanlines[y - 1] : Buffer.alloc(stride)
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prev[i]
    const c = i >= bpp ? prev[i - bpp] : 0
    let v = cur[i]
    if (filter === 1) v = (v + a) & 0xff
    else if (filter === 2) v = (v + b) & 0xff
    else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
    else if (filter === 4) {
      const q = a + b - c
      const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c)
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      v = (v + pr) & 0xff
    }
    line[i] = v
  }
  scanlines.push(line)
  p += 1 + stride
}

console.log(`尺寸 ${width}x${height} 色型 ${colorType}`)
console.log('图例: 上 = 图像顶部(y=0)。每格一个字符。')
const ramp = ' .:-=+*#%@'
for (let y = 0; y < height; y++) {
  let row = String(y).padStart(2, '0') + ' |'
  for (let x = 0; x < width; x++) {
    const [r, g, b, a] = pixel(x, y)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const idx = a < 128 ? 1 : Math.min(ramp.length - 1, Math.max(0, Math.floor(lum * (ramp.length - 1))))
    row += ramp[idx]
  }
  row += '|'
  console.log(row)
}
