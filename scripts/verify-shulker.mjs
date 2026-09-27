// 校验潜影盒方块模型的 12 个面 UV，与「原版 ShulkerEntityModel + ShulkerBoxBlockEntityRenderer
// 的 scale(1,-1,-1) 变换」逐面比对（面顺序无关、位置→UV 精确匹配）。
// 潜影盒的 UV 很容易因忘掉实体→方块的那次 180° 旋转而写反，故单独做回归校验。
// 用法：node scripts/verify-shulker.mjs
import { BlockModelResolver } from '../src/blocks.js'

const fakeAssets = { async getJSON() { return null } }
const resolver = new BlockModelResolver(fakeAssets)
const { quads } = await resolver.resolve('minecraft:shulker_box', { facing: 'up' })

const NORMAL = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1],
  south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
}
const normKey = (n) => n.map((v) => Math.round(v)).join(',')

// 期望值：face 方向(法线) + 立方体段(lid=箱盖 y4..16 / base=底座 y0..8)
// 每个面给 4 个「角的位置(像素) -> 像素 UV」。
// 角坐标取自该面所在平面：up/down 用 (x,z)，west/east 用 (y,z)，north/south 用 (x,y)。
const EXPECT = {
  'base:up': {
    face: [0, 1, 0], corners: [
      [[0, 16], [16, 44]], [[16, 16], [32, 44]], [[0, 0], [16, 28]], [[16, 0], [32, 28]],
    ],
  },
  'base:down': {
    face: [0, -1, 0], corners: [
      [[16, 16], [48, 44]], [[0, 16], [32, 44]], [[16, 0], [48, 28]], [[0, 0], [32, 28]],
    ],
  },
  'base:west': {
    face: [-1, 0, 0], corners: [
      [[8, 0], [0, 44]], [[0, 0], [0, 52]], [[8, 16], [16, 44]], [[0, 16], [16, 52]],
    ],
  },
  'base:north': {
    face: [0, 0, -1], corners: [
      [[16, 0], [48, 52]], [[0, 0], [64, 52]], [[16, 8], [48, 44]], [[0, 8], [64, 44]],
    ],
  },
  'base:east': {
    face: [1, 0, 0], corners: [
      [[8, 16], [32, 44]], [[0, 16], [32, 52]], [[8, 0], [48, 44]], [[0, 0], [48, 52]],
    ],
  },
  'base:south': {
    face: [0, 0, 1], corners: [
      [[0, 0], [16, 52]], [[16, 0], [32, 52]], [[0, 8], [16, 44]], [[16, 8], [32, 44]],
    ],
  },
  'lid:up': {
    face: [0, 1, 0], corners: [
      [[0, 16], [16, 16]], [[16, 16], [32, 16]], [[0, 0], [16, 0]], [[16, 0], [32, 0]],
    ],
  },
  'lid:down': {
    face: [0, -1, 0], corners: [
      [[16, 16], [48, 16]], [[0, 16], [32, 16]], [[16, 0], [48, 0]], [[0, 0], [32, 0]],
    ],
  },
  'lid:west': {
    face: [-1, 0, 0], corners: [
      [[16, 0], [0, 16]], [[4, 0], [0, 28]], [[16, 16], [16, 16]], [[4, 16], [16, 28]],
    ],
  },
  'lid:north': {
    face: [0, 0, -1], corners: [
      [[16, 4], [48, 28]], [[0, 4], [64, 28]], [[16, 16], [48, 16]], [[0, 16], [64, 16]],
    ],
  },
  'lid:east': {
    face: [1, 0, 0], corners: [
      [[16, 16], [32, 16]], [[4, 16], [32, 28]], [[16, 0], [48, 16]], [[4, 0], [48, 28]],
    ],
  },
  'lid:south': {
    face: [0, 0, 1], corners: [
      [[0, 4], [16, 28]], [[16, 4], [32, 28]], [[0, 16], [16, 16]], [[16, 16], [32, 16]],
    ],
  },
}

function pixelUV(uv) {
  return [Math.round(uv[0] * 64 * 100) / 100, Math.round(uv[1] * 64 * 100) / 100]
}

let errors = 0
const seen = new Set()
for (const quad of quads) {
  const face = normKey(quad.normal)
  const xs = quad.verts.map((v) => v[0] * 16)
  const ys = quad.verts.map((v) => v[1] * 16)
  const zs = quad.verts.map((v) => v[2] * 16)
  // base 的面最低点在 y=0（底/侧面）或 y=8（顶面）；lid 的面最低点在 y=4（内面/侧面）或 y=16（盖顶）
  const isBase = Math.round(Math.min(...ys)) === 0 || Math.round(Math.min(...ys)) === 8
  const seg = isBase ? 'base' : 'lid'
  const key = seg + ':' + ({ '0,1,0': 'up', '0,-1,0': 'down', '0,0,-1': 'north', '0,0,1': 'south', '1,0,0': 'east', '-1,0,0': 'west' })[face]
  seen.add(key)
  const exp = EXPECT[key]
  if (!exp) { console.log(`❌ 未识别的面: ${key}`); errors++; continue }

  // 为当前面建立「角位置 -> 实际 uv」映射
  const actual = new Map()
  for (let k = 0; k < 4; k++) {
    const corner = face === '0,1,0' || face === '0,-1,0'
      ? [xs[k], zs[k]] : face === '0,0,-1' || face === '0,0,1'
        ? [xs[k], ys[k]] : [ys[k], zs[k]]
    actual.set(corner.map((v) => Math.round(v)).join(','), pixelUV(quad.uvs[k]))
  }

  for (const [corner, wantUV] of exp.corners) {
    const got = actual.get(corner.join(','))
    const want = [Math.round(wantUV[0] * 100) / 100, Math.round(wantUV[1] * 100) / 100]
    if (!got || got[0] !== want[0] || got[1] !== want[1]) {
      errors++
      console.log(`❌ ${key} 角 ${corner}: 期望 uv ${want}, 实际 ${got}`)
    }
  }
}

for (const key of Object.keys(EXPECT)) {
  if (!seen.has(key)) { console.log(`❌ 缺少面: ${key}`); errors++ }
}

if (errors === 0) console.log('✅ 潜影盒 12 个面的 UV 全部与游戏内一致')
else console.log(`❌ 共 ${errors} 处不一致`)
process.exit(errors ? 1 : 0)
