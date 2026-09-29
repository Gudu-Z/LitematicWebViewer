// 生成一个「展示框全物品测试」投影（.litematic）：
// 一面白墙 + 一排排朝南的展示框，每个框放一种物品，用于逐项核对展示框内渲染。
// 用法：node scripts/gen-itemframe-test.mjs
// 产物：schematics/投影预览测试-展示框全物品.litematic

import { readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const itemsDir = join(root, 'public', 'assets', 'minecraft', 'items')
const outPath = join(root, 'schematics', '投影预览测试-展示框全物品.litematic')

// —— 这些物品没有可见模型/是内部物品，不放进展示框 ——
const SKIP = new Set([
  'air', 'cave_air', 'void_air',
  'structure_void', 'barrier', 'light', 'debug_stick',
  'command_block', 'chain_command_block', 'repeating_command_block',
  'structure_block', 'jigsaw', 'petrified_oak_slab',
])

// ===== NBT 写入（Java 大端序）=====
function str(s) {
  const b = Buffer.from(s, 'utf8')
  const o = Buffer.alloc(2 + b.length)
  o.writeUInt16BE(b.length, 0)
  b.copy(o, 2)
  return o
}
function i8(v) { const b = Buffer.alloc(1); b.writeInt8(v, 0); return b }
function i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); return b }
function i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v), 0); return b }
function f32(v) { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); return b }
function f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v, 0); return b }
function arr(entries) {
  // entries: [{ name, type, payload }]，type 为 NBT 类型 id
  const parts = []
  for (const e of entries) {
    parts.push(Buffer.from([e.type]), str(e.name), e.payload)
  }
  parts.push(Buffer.from([0])) // TAG_End
  return Buffer.concat(parts)
}
function list(type, items) {
  const parts = [Buffer.from([type]), i32(items.length)]
  for (const it of items) parts.push(it)
  return Buffer.concat(parts)
}
function tag(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), str(name), payload])
}
function byteArr(bytes) {
  const b = Buffer.alloc(4 + bytes.length)
  b.writeInt32BE(bytes.length, 0)
  Buffer.from(bytes).copy(b, 4)
  return b
}
function intArr(vals) {
  const b = Buffer.alloc(4 + vals.length * 4)
  b.writeInt32BE(vals.length, 0)
  vals.forEach((v, i) => b.writeInt32BE(v, 4 + i * 4))
  return b
}
function longArr(vals) {
  const b = Buffer.alloc(4 + vals.length * 8)
  b.writeInt32BE(vals.length, 0)
  vals.forEach((v, i) => b.writeBigInt64BE(BigInt(v), 4 + i * 8))
  return b
}
function doubleList(vals) { return list(6, vals.map((v) => f64(v))) }
function floatList(vals) { return list(5, vals.map((v) => f32(v))) }

// ===== 方块状态编码 =====
// 位序：LSB 优先；块序：y（外层）→ z → x（内层）。
function encodeBlockStates(indices, bits) {
  const totalBits = indices.length * bits
  const count = Math.ceil(totalBits / 64)
  const longs = new Array(count).fill(0n)
  for (let i = 0; i < indices.length; i++) {
    const v = BigInt(indices[i])
    const bit = i * bits
    const w = Math.floor(bit / 64)
    const off = bit % 64
    longs[w] |= v << BigInt(off)
    if (off + bits > 64) longs[w + 1] |= v >> BigInt(64 - off)
  }
  return longs
}

// ===== 主体 =====
const names = readdirSync(itemsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((n) => !SKIP.has(n))
  .sort()

const N = names.length
const W = Math.ceil(Math.sqrt(N)) // 每排列数
const H = Math.ceil(N / W) // 排数
const wall = 'minecraft:white_concrete'

console.log(`物品数：${N}，网格 ${W} × ${H}`)

// 区域：x 0..W-1，y 0..H-1，z 0..1（z=0 墙，z=1 展示框所在空气格）
const DX = W, DY = H, DZ = 2

// 调色板：0 = air，1 = wall
const palette = [
  { Name: 'minecraft:air' },
  { Name: wall },
]
const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))

// 块索引（块序 y → z → x）
const indices = new Array(DX * DY * DZ).fill(0)
for (let y = 0; y < DY; y++) {
  for (let z = 0; z < DZ; z++) {
    for (let x = 0; x < DX; x++) {
      if (z === 0) indices[y * DZ * DX + z * DX + x] = 1 // 墙
      else indices[y * DZ * DX + z * DX + x] = 0 // 空气
    }
  }
}
const longs = encodeBlockStates(indices, bits)

// 展示框实体：每个物品一个框，朝南（Facing=3），挂在 z=1 空气格的北墙（z=0 墙的南面）
// Pos = Tile + 0.5 - facing * 15/32（facing=south=[0,0,1]），Tile=(x, y, 1)
const entities = []
for (let i = 0; i < N; i++) {
  const x = i % W
  const y = Math.floor(i / W)
  const tileX = x, tileY = y, tileZ = 1
  const px = tileX + 0.5
  const py = tileY + 0.5
  const pz = tileZ + 0.5 - 15 / 32 // = 1.03125
  entities.push(arr([
    { name: 'id', type: 8, payload: str('minecraft:item_frame') },
    { name: 'Pos', type: 9, payload: doubleList([px, py, pz]) },
    { name: 'Motion', type: 9, payload: doubleList([0, 0, 0]) },
    { name: 'Rotation', type: 9, payload: floatList([0, 0]) },
    { name: 'Facing', type: 1, payload: i8(3) },
    { name: 'ItemRotation', type: 1, payload: i8(0) },
    { name: 'TileX', type: 3, payload: i32(tileX) },
    { name: 'TileY', type: 3, payload: i32(tileY) },
    { name: 'TileZ', type: 3, payload: i32(tileZ) },
    { name: 'Fixed', type: 1, payload: i8(0) },
    { name: 'Invisible', type: 1, payload: i8(0) },
    { name: 'ItemDropChance', type: 5, payload: f32(1) },
    { name: 'OnGround', type: 1, payload: i8(0) },
    { name: 'Air', type: 2, payload: i16(300) },
    { name: 'Fire', type: 2, payload: i16(0) },
    { name: 'PortalCooldown', type: 3, payload: i32(0) },
    { name: 'fall_distance', type: 5, payload: f32(0) },
    { name: 'Item', type: 10, payload: arr([
      { name: 'id', type: 8, payload: str('minecraft:' + names[i]) },
      { name: 'count', type: 1, payload: i8(1) },
    ]) },
  ]))
}

// 根 NBT
const now = BigInt(Date.now())
const totalVolume = DX * DY * DZ
const rootNbt = arr([
  { name: 'MinecraftDataVersion', type: 3, payload: i32(4299) },
  { name: 'Version', type: 3, payload: i32(8) },
  { name: 'SubVersion', type: 3, payload: i32(1) },
  { name: 'Metadata', type: 10, payload: arr([
    { name: 'Name', type: 8, payload: str('展示框全物品测试') },
    { name: 'Author', type: 8, payload: str('test') },
    { name: 'Description', type: 8, payload: str('') },
    { name: 'TimeCreated', type: 4, payload: i64(now) },
    { name: 'TimeModified', type: 4, payload: i64(now) },
    { name: 'RegionCount', type: 3, payload: i32(1) },
    { name: 'TotalBlocks', type: 3, payload: i32(DX * DY) },
    { name: 'TotalVolume', type: 3, payload: i32(totalVolume) },
    { name: 'EnclosingSize', type: 10, payload: arr([
      { name: 'x', type: 3, payload: i32(DX) },
      { name: 'y', type: 3, payload: i32(DY) },
      { name: 'z', type: 3, payload: i32(DZ) },
    ]) },
  ]) },
  { name: 'Regions', type: 10, payload: arr([
    { name: 'itemframe_test', type: 10, payload: arr([
      { name: 'Position', type: 10, payload: arr([
        { name: 'x', type: 3, payload: i32(0) },
        { name: 'y', type: 3, payload: i32(0) },
        { name: 'z', type: 3, payload: i32(0) },
      ]) },
      { name: 'Size', type: 10, payload: arr([
        { name: 'x', type: 3, payload: i32(DX) },
        { name: 'y', type: 3, payload: i32(DY) },
        { name: 'z', type: 3, payload: i32(DZ) },
      ]) },
      { name: 'BlockStatePalette', type: 9, payload: list(10, palette.map((p) => arr([
        { name: 'Name', type: 8, payload: str(p.Name) },
      ]))) },
      { name: 'BlockStates', type: 12, payload: longArr(longs) },
      { name: 'Entities', type: 9, payload: list(10, entities) },
    ]) },
  ]) },
])

// gzip 压缩（根标签需要补上前导 type=10 + 空名）
const gz = gzipSync(Buffer.concat([Buffer.from([10]), str(''), rootNbt]))
writeFileSync(outPath, gz)
console.log(`已写出 ${outPath}（${(gz.length / 1024).toFixed(1)} KB）`)
