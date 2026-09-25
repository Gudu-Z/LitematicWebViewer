// 生成一个结构合法的小 .litematic 样例文件（samples/demo.litematic），
// 并做一次「编码 -> 解压 -> NBT 解析 -> 位解码」的回环验证。
//
// 用途：
//   - 给用户一个立即可拖进预览器测试的文件；
//   - 验证 src/nbt.js 与 src/litematica.js 的解码逻辑没有崩溃、字段对得上。
//
// 用法：node scripts/gen-test.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNBT } from '../src/nbt.js'
import { decodeBlockStates } from '../src/litematica.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ---------- 极简 NBT 写出器（大端序） ----------
const chunks = []
function u8(v) { chunks.push(Buffer.from([v & 0xff])) }
function i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); chunks.push(b) }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); chunks.push(b) }
function i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v))); chunks.push(b) }
function str(s) { const b = Buffer.from(s, 'utf8'); i16(b.length); chunks.push(b) }

// 写一个命名标签头
function tag(type, name) { u8(type); str(name) }

// List<Int> 的负载（元素类型 Int=3 + 长度 + 元素）
function intList(arr) { u8(3); i32(arr.length); for (const v of arr) i32(v) }

// 写一个 {x,y,z} compound 的负载（Litematica 的 Position/Size/EnclosingSize 用这个结构）
function vecCompound(x, y, z) {
  u8(3); str('x'); i32(x)
  u8(3); str('y'); i32(y)
  u8(3); str('z'); i32(z)
}

// 调色板：list of compound {Name: string, Properties?: compound}
function paletteList(palette) {
  u8(10) // 元素类型 compound
  i32(palette.length)
  for (const p of palette) {
    u8(8); str('Name'); str(p.name)
    if (p.properties && Object.keys(p.properties).length) {
      tag(10, 'Properties')
      for (const k of Object.keys(p.properties)) { u8(8); str(k); str(p.properties[k]) }
      u8(0) // end Properties
    }
    u8(0) // end entry
  }
}

// 位打包（小端序，与 Litematica / BitStorage 一致）
function pack(values, bits) {
  const longCount = Math.ceil((values.length * bits) / 64)
  const longs = new Array(longCount).fill(0n)
  for (let i = 0; i < values.length; i++) {
    const v = BigInt(values[i])
    const start = i * bits
    const word = Math.floor(start / 64)
    const off = start % 64
    longs[word] |= v << BigInt(off)
    if (off + bits > 64) longs[word + 1] |= v >> BigInt(64 - off)
  }
  return longs
}

// LongArray 的负载（无元素类型字节：长度 + 若干 64 位）
function longArrayTag(longs) {
  i32(longs.length); for (const l of longs) i64(l)
}

// ---------- 构造一个 6x4x6 的小房子 ----------
const SX = 6, SY = 4, SZ = 6
const NAMES = ['minecraft:air', 'minecraft:oak_planks', 'minecraft:stone', 'minecraft:grass_block', 'minecraft:oak_sign']
const palette = NAMES.map((name) =>
  name === 'minecraft:oak_sign'
    ? { name, properties: { rotation: '0', waterlogged: 'false' } }
    : { name }
)

function blockAt(x, y, z) {
  if (x === 1 && y === 1 && z === 1) return 'minecraft:oak_sign' // 告示牌
  if (y === 0) return 'minecraft:oak_planks' // 地板
  const edge = x === 0 || x === SX - 1 || z === 0 || z === SZ - 1
  if (edge) return 'minecraft:stone' // 墙
  if (y === SY - 1) return 'minecraft:grass_block' // 屋顶（草）
  return 'minecraft:air'
}

const values = [] // 按 idx = y*(SX*SZ) + z*SX + x 顺序
for (let y = 0; y < SY; y++) {
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      values.push(NAMES.indexOf(blockAt(x, y, z)))
    }
  }
}
const total = values.length
const nonAir = values.filter((v) => v !== 0).length
const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))

// ---------- 组装 NBT ----------
tag(10, '') // 根 compound
u8(3); str('Version'); i32(5)
u8(3); str('SubVersion'); i32(1)
u8(3); str('MinecraftDataVersion'); i32(3465) // 1.20.4

tag(10, 'Metadata')
u8(8); str('Name'); str('demo')
u8(8); str('Author'); str('LitematicViewer')
u8(8); str('Description'); str('generated test structure')
u8(3); str('RegionCount'); i32(1)
u8(3); str('TotalVolume'); i32(total)
u8(3); str('TotalBlocks'); i32(nonAir)
tag(10, 'EnclosingSize'); vecCompound(SX, SY, SZ); u8(0)
u8(4); str('TimeCreated'); i64(0)
u8(4); str('TimeModified'); i64(0)
u8(0)

tag(10, 'Regions')
tag(10, 'demo')
tag(10, 'Position'); vecCompound(0, 0, 0); u8(0)
tag(10, 'Size'); vecCompound(SX, SY, SZ); u8(0)
tag(9, 'BlockStatePalette'); paletteList(palette)
tag(12, 'BlockStates'); longArrayTag(pack(values, bits))

// 方块实体：一个告示牌
tag(9, 'TileEntities')
u8(10); i32(1) // list of compound，长度 1
u8(8); str('id'); str('minecraft:sign')
u8(3); str('x'); i32(1)
u8(3); str('y'); i32(1)
u8(3); str('z'); i32(1)
tag(10, 'front_text')
u8(9); str('messages')
u8(8); i32(4)
str('{"text":"测试告示牌"}')
str('{"text":"第二行"}')
str('{"text":"line 3"}')
str('{"text":"line 4"}')
u8(0) // end front_text
u8(0) // end sign entry

u8(0) // end region
u8(0) // end Regions

u8(0) // end root

const nbtBuffer = Buffer.concat(chunks)
const gz = gzipSync(nbtBuffer)
const outDir = join(root, 'samples')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'demo.litematic')
writeFileSync(outPath, gz)
console.log(`[gen-test] 已生成样例：${outPath}（${gz.length} 字节）`)

// ---------- 回环验证 ----------
const raw = gunzipSync(gz)
const root2 = parseNBT(raw)
const region = root2.Regions.demo
const pos = region.Position
const size = region.Size
const plist = region.BlockStatePalette
const decodedBits = Math.max(2, Math.ceil(Math.log2(plist.length)))
const decoded = decodeBlockStates(region.BlockStates, decodedBits, total)

let ok = true
for (let i = 0; i < total; i++) {
  if (decoded[i] !== values[i]) {
    ok = false
    console.error(`  不一致 @${i}: 期望 ${values[i]} 得到 ${decoded[i]}`)
    break
  }
}
console.log(`[gen-test] 回环验证：${ok ? '通过 ✔' : '失败 ✘'}（${total} 个方块，${plist.length} 种方块，位宽 ${decodedBits}）`)
console.log(`[gen-test] Metadata.Name = ${root2.Metadata.Name}，尺寸 = ${size.x}×${size.y}×${size.z}`)

if (!ok) process.exit(1)
