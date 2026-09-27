// 校验新 decodeBlockStates 与旧 BigInt 逐块实现结果一致（覆盖跨 word / 跨半区 / 任意 startIdx）。
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseNBT } from '../src/nbt.js'
import { decodeBlockStates } from '../src/litematica.js'

const buf = readFileSync(process.argv[2])
const raw = new Uint8Array(gunzipSync(buf))
const root = parseNBT(raw)
const region = Object.values(root.Regions || {})[0]
const longs = region.BlockStates
const bits = Math.max(2, Math.ceil(Math.log2(region.BlockStatePalette.length)))

// 旧 BigInt 实现（参考基线）
function decodeOld(longs, bits, total, startIdx = 0) {
  const out = new Uint32Array(total)
  const mask = (1n << BigInt(bits)) - 1n
  for (let j = 0; j < total; j++) {
    const i = startIdx + j
    const start = i * bits
    const word = Math.floor(start / 64)
    const off = start % 64
    let v
    if (off + bits <= 64) {
      v = (BigInt.asUintN(64, longs[word]) >> BigInt(off)) & mask
    } else {
      const low = BigInt.asUintN(64, longs[word]) >> BigInt(off)
      const hi = BigInt.asUintN(64, longs[word + 1]) & ((1n << BigInt(off + bits - 64)) - 1n)
      v = (low | (hi << BigInt(64 - off))) & mask
    }
    out[j] = Number(v)
  }
  return out
}

function cmp(a, b, label) {
  let diff = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++
  console.log(`${label}: 长度 ${n}, 差异 ${diff}${diff ? '  ❌' : '  ✅'}`)
  return diff
}

let totalDiff = 0
// 1) 各种 startIdx（含跨 word 起始：offsets 覆盖 0、非整 word、跨 32 半区）
const starts = [0, 1, 7, 63, 64, 100, 1000, 123456, 1093070, 1093070 + 12345]
for (const s of starts) {
  const n = 10000
  totalDiff += cmp(decodeOld(longs, bits, n, s), decodeBlockStates(longs, bits, n, s), `startIdx=${s}`)
}
// 2) 全量对比（4.2 亿块，会分配 1.6GB 两个数组，需足够内存）
console.log('全量对比（较慢，请稍候）…')
const t = Date.now()
const a = decodeOld(longs, bits, Math.abs(region.Size.x) * Math.abs(region.Size.y) * Math.abs(region.Size.z))
const b = decodeBlockStates(longs, bits, a.length)
console.log(`全量解码 old ${Date.now() - t} ms`)
let diff = 0
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
console.log(`全量差异：${diff} / ${a.length} ${diff ? '❌' : '✅'}`)
totalDiff += diff
process.exit(totalDiff ? 1 : 0)
