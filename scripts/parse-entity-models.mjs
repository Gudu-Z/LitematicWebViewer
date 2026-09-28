// 从 vanilla 反编译源码（scripts/_ref/*.java）解析实体模型，生成 src/entityModelData.js。
// 复刻 net.minecraft.client.model.ModelPart.Cuboid 的 UV 布局与 ModelPart 的变换约定。
// 用法：node scripts/parse-entity-models.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REF = join(__dirname, '_ref')
const OUT = join(__dirname, '..', 'src', 'entityModelData.js')

const PI = Math.PI

// ---------------------------------------------------------------- 工具函数

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

// 提取 static final float/int 常量（数值可求值的）
function extractConstants(src) {
  const map = {}
  const re = /(?:private|protected|public)?\s*static\s+final\s+(?:float|int)\s+(\w+)\s*=\s*([^;]+);/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    const val = evalExpr(m[2], map)
    if (val !== null && Number.isFinite(val)) map[name] = val
  }
  return map
}

// 求值一个数值表达式（float 字面量、Math.PI、四则运算、括号、常量）
function evalExpr(expr, consts = {}) {
  if (expr == null) return null
  let s = String(expr).trim()
  if (!s) return null
  // 去掉 (float) / (double) 强制转换
  s = s.replace(/\(float\)\s*/g, '').replace(/\(double\)\s*/g, '')
  s = s.replace(/Math\.PI/g, PI.toString())
  // 数字后缀 F/f/L/d
  s = s.replace(/(\d+\.?\d*)[fF]/g, '$1')
  s = s.replace(/(\d+)[lL]\b/g, '$1')
  // 常量替换
  for (const k of Object.keys(consts)) {
    if (typeof consts[k] === 'number') s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), consts[k].toString())
  }
  // 只允许数字、运算符、括号、空白、点、负号
  if (/[^0-9+\-*/().\s]/.test(s)) return null
  try {
    // eslint-disable-next-line no-new-func
    return Function('return (' + s + ');')()
  } catch {
    return null
  }
}

// 顶层逗号切分（不拆分括号内的逗号）
function splitArgs(argStr) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of argStr) {
    if (ch === '(') { depth++; cur += ch }
    else if (ch === ')') { depth--; cur += ch }
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// 匹配平衡括号：从 openIndex（指向 '(' 的位置）返回匹配闭括号的下标
function matchParen(s, openIndex) {
  let depth = 0
  for (let i = openIndex; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

// 匹配平衡花括号：openIndex 指向 '{' 的位置，返回匹配的 '}' 下标
function matchBrace(s, openIndex) {
  let depth = 0
  for (let i = openIndex; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

// ---------------------------------------------------------------- 基础模型（硬编码，来自 vanilla getModelData）

function part(pivot, rot, cuboids) {
  return { pivot, rot, cuboids, children: {} }
}
function cub(u, v, x, y, z, dx, dy, dz, extra) {
  const c = { u, v, x, y, z, dx, dy, dz, mirror: false }
  if (extra) Object.assign(c, extra)
  return c
}

const BASE = {
  // QuadrupedEntityModel.getModelData(stanceWidth, leftMirrored, rightMirrored, dilation)
  quadruped(sw, leftM, rightM) {
    const leg = (mirror) => ({ u: 0, v: 16, x: -2, y: 0, z: -2, dx: 4, dy: sw, dz: 4, mirror })
    return {
      head: part([0, 18 - sw, -6], [0, 0, 0], [cub(0, 0, -4, -4, -8, 8, 8, 8)]),
      body: part([0, 17 - sw, 2], [PI / 2, 0, 0], [cub(28, 8, -5, -10, -7, 10, 16, 8)]),
      right_hind_leg: part([-3, 24 - sw, 7], [0, 0, 0], [leg(rightM)]),
      left_hind_leg: part([3, 24 - sw, 7], [0, 0, 0], [leg(leftM)]),
      right_front_leg: part([-3, 24 - sw, -5], [0, 0, 0], [leg(rightM)]),
      left_front_leg: part([3, 24 - sw, -5], [0, 0, 0], [leg(leftM)]),
    }
  },
  // BipedEntityModel.getModelData(dilation, pivotOffsetY)
  biped(offY = 0) {
    const head = part([0, offY, 0], [0, 0, 0], [cub(0, 0, -4, -8, -4, 8, 8, 8)])
    head.children.hat = part([0, 0, 0], [0, 0, 0], [cub(32, 0, -4, -8, -4, 8, 8, 8, { dil: [0.5, 0.5, 0.5] })])
    return {
      head,
      body: part([0, offY, 0], [0, 0, 0], [cub(16, 16, -4, 0, -2, 8, 12, 4)]),
      right_arm: part([-5, 2 + offY, 0], [0, 0, 0], [cub(40, 16, -3, -2, -2, 4, 12, 4)]),
      left_arm: part([5, 2 + offY, 0], [0, 0, 0], [cub(40, 16, -1, -2, -2, 4, 12, 4, { mirror: true })]),
      right_leg: part([-1.9, 12 + offY, 0], [0, 0, 0], [cub(0, 16, -2, 0, -2, 4, 12, 4)]),
      left_leg: part([1.9, 12 + offY, 0], [0, 0, 0], [cub(0, 16, -2, 0, -2, 4, 12, 4, { mirror: true })]),
    }
  },
  // SkeletonEntityModel.addLimbs —— 细肢
  skeletonLimbs() {
    return {
      right_arm: part([-5, 2, 0], [0, 0, 0], [cub(40, 16, -1, -2, -1, 2, 12, 2)]),
      left_arm: part([5, 2, 0], [0, 0, 0], [cub(40, 16, -1, -2, -1, 2, 12, 2, { mirror: true })]),
      right_leg: part([-2, 12, 0], [0, 0, 0], [cub(0, 16, -1, 0, -1, 2, 12, 2)]),
      left_leg: part([2, 12, 0], [0, 0, 0], [cub(0, 16, -1, 0, -1, 2, 12, 2, { mirror: true })]),
    }
  },
}

// ---------------------------------------------------------------- addChild 解析

// 提取 ModelPartBuilder <var> = ModelPartBuilder.create()...; 的变量赋值
function extractBuilderVars(code) {
  const vars = {}
  const re = /ModelPartBuilder\s+(\w+)\s*=\s*(ModelPartBuilder\.create\(\)[\s\S]*?);/g
  let m
  while ((m = re.exec(code))) {
    vars[m[1]] = m[2]
  }
  return vars
}

// 解析一个 ModelPartBuilder.create()... 链，返回 cuboid 列表
function parseBuilder(builderExpr, consts, builderVars) {
  // 若 builder 是变量引用（如 modelPartBuilder），递归解析其赋值
  let expr = builderExpr.trim()
  if (builderVars && /^\w+$/.test(expr) && builderVars[expr]) expr = builderVars[expr]
  const cuboids = []
  let curU = 0
  let curV = 0
  let curMirror = false
  // 逐个匹配 .uv(u,v) / .mirrored(...) / .cuboid(...)
  const re = /\.(uv|mirrored|cuboid)\s*\(/g
  let m
  while ((m = re.exec(expr))) {
    const open = m.index + m[0].length - 1 // '(' 位置
    const close = matchParen(expr, open)
    if (close < 0) break
    const inner = expr.slice(open + 1, close)
    const args = splitArgs(inner)
    if (m[1] === 'uv') {
      const u = evalExpr(args[0], consts)
      const v = evalExpr(args[1], consts)
      if (u != null && v != null) { curU = u; curV = v }
    } else if (m[1] === 'mirrored') {
      curMirror = args.length === 0 || args[0] === 'true'
    } else if (m[1] === 'cuboid') {
      let a = args
      // 首个参数若为字符串字面量则是 cuboid 名称，跳过
      if (a[0] && /^"/.test(a[0])) a = a.slice(1)
      const nums = a.map((s) => evalExpr(s, consts))
      const x = nums[0], y = nums[1], z = nums[2], dx = nums[3], dy = nums[4], dz = nums[5]
      if (x == null || y == null || z == null || dx == null || dy == null || dz == null) continue
      let u = curU
      let v = curV
      let dil = [0, 0, 0]
      const hasDilation = a.length >= 7
      if (hasDilation) dil = parseDilation(a[6])
      // 命名 cuboid 的尾部 (textureX, textureY) 会覆盖 uv
      if (a.length >= 8) {
        const texX = evalExpr(a[7], consts)
        const texY = evalExpr(a[8], consts)
        if (texX != null && texY != null) { u = texX; v = texY }
      }
      cuboids.push({ u, v, x, y, z, dx, dy, dz, mirror: curMirror, dil })
    }
  }
  return cuboids
}

// 解析 dilation 表达式为 [rx, ry, rz]（基础渲染 dilation = NONE → 0）
function parseDilation(expr) {
  const s = String(expr).trim()
  if (!s || s === 'dilation' || s === 'Dilation.NONE') return [0, 0, 0]
  let mm = s.match(/new\s+Dilation\s*\(([^)]*)\)/)
  if (mm) {
    const a = splitArgs(mm[1]).map((e) => evalExpr(e, {}))
    if (a.length === 1 && a[0] != null) return [a[0], a[0], a[0]]
    if (a.length === 3 && a.every((v) => v != null)) return a
    return [0, 0, 0]
  }
  mm = s.match(/\.add\s*\(([^)]*)\)/)
  if (mm) {
    const a = splitArgs(mm[1]).map((e) => evalExpr(e, {}))
    if (a.length === 1 && a[0] != null) return [a[0], a[0], a[0]]
    if (a.length === 3 && a.every((v) => v != null)) return a
    return [0, 0, 0]
  }
  return [0, 0, 0]
}

// 解析 ModelTransform.origin/of/NONE（rotation 参数可能含嵌套括号，如 (float)(Math.PI/2)）
function parseTransform(expr, consts) {
  const s = String(expr).trim()
  for (const kind of ['origin', 'of', 'rotation']) {
    const idx = s.indexOf('ModelTransform.' + kind + '(')
    if (idx >= 0) {
      const open = idx + ('ModelTransform.' + kind).length
      const close = matchParen(s, open)
      if (close >= 0) {
        const a = splitArgs(s.slice(open + 1, close)).map((e) => evalExpr(e, consts))
        if (kind === 'origin' && a.length >= 3 && a.slice(0, 3).every((v) => v != null)) return { pivot: a.slice(0, 3), rot: [0, 0, 0] }
        if (kind === 'of' && a.length >= 6 && a.slice(0, 6).every((v) => v != null)) return { pivot: a.slice(0, 3), rot: a.slice(3, 6) }
        if (kind === 'rotation' && a.length >= 3 && a.slice(0, 3).every((v) => v != null)) return { pivot: [0, 0, 0], rot: a.slice(0, 3) }
      }
    }
  }
  if (/ModelTransform\.NONE/.test(s)) return { pivot: [0, 0, 0], rot: [0, 0, 0] }
  return null
}

// 解析一段“模型构建代码”里所有的 addChild 调用，返回部件树 { name: part }
function parseAddChilds(code, consts) {
  const parts = {}
  const builderVars = extractBuilderVars(code)
  const varPath = {} // ModelPartData 变量名 -> 部件路径（如 "head" 或 "head/hat"）
  let lastPath = null // 最近一次 addChild 的部件路径（用于链式调用）
  const re = /(\b\w+\s*=\s*)?([\w$.]+|\w+)\.addChild\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + m[0].length - 1)
    if (open < 0) continue
    const close = matchParen(code, open)
    if (close < 0) continue
    const inner = code.slice(open + 1, close)
    const args = splitArgs(inner)
    if (args.length < 3) continue
    const name = args[0].replace(/^"|"$/g, '')
    const cuboids = parseBuilder(args[1], consts, builderVars)
    const tf = parseTransform(args[2], consts)
    const p = { name, pivot: tf ? tf.pivot : [0, 0, 0], rot: tf ? tf.rot : [0, 0, 0], cuboids, children: {} }
    const receiver = (m[2] || '').trim()
    let parentPath = null
    if (receiver === 'modelPartData' || receiver === 'root' || /getRoot/.test(receiver)) {
      parentPath = null
    } else if (receiver in varPath) {
      parentPath = varPath[receiver]
    } else if (lastPath) {
      parentPath = lastPath
    }
    const myPath = parentPath ? parentPath + '/' + name : name
    attachPath(parts, myPath, p)
    if (m[1]) varPath[m[1].trim().replace(/\s*=\s*$/, '')] = myPath
    lastPath = myPath
  }
  return parts
}

// 按路径 "a/b/c" 把 part 挂到 parts 树
function attachPath(parts, path, part) {
  const seg = path.split('/')
  let node = parts
  for (let i = 0; i < seg.length - 1; i++) {
    const s = seg[i]
    if (!node[s]) node[s] = { name: s, pivot: [0, 0, 0], rot: [0, 0, 0], cuboids: [], children: {} }
    node = node[s].children
  }
  node[seg[seg.length - 1]] = part
}

// ---------------------------------------------------------------- 循环生成的部件

function injectLoopParts(models) {
  const rod = () => ({ u: 0, v: 16, x: 0, y: 0, z: 0, dx: 2, dy: 8, dz: 2, mirror: false, dil: [0, 0, 0] })

  // 烈焰人：12 根火棒（rod0..rod11）
  const blaze = models.BlazeEntityModel
  if (blaze) {
    const pivots = [
      [9, -1, 0], [4.86, -1.12, 7.57], [-3.75, -1.46, 8.18], [-8.91, -1.93, 1.27],
      [4.95, 1.58, 4.95], [-1.49, 1.2, 6.84], [-6.56, 1.01, 2.44], [-5.6, 1.06, -4.2],
      [4.46, 11.96, 2.27], [0.5, 11.89, 4.98], [-3.92, 11.35, 3.11], [-4.73, 10.61, -1.62],
    ]
    delete blaze.parts['getRodName(i)']
    pivots.forEach((p, i) => {
      blaze.parts['rod' + i] = part(p, [0, 0, 0], [rod()])
    })
  }

  // 恶魂：9 根触手（tentacle0..8）
  const ghast = models.GhastEntityModel
  if (ghast) {
    delete ghast.parts['EntityModelPartNames.getTentacleName(i)']
    const tents = [[-3.75, -5, 8], [1.25, -5, 13], [6.25, -5, 9], [-6.25, 0, 11], [-1.25, 0, 11], [3.75, 0, 10], [-3.75, 5, 12], [1.25, 5, 9], [6.25, 5, 12]]
    tents.forEach((t, i) => {
      ghast.parts['tentacle' + i] = part([t[0], 24.6, t[1]], [0, 0, 0], [{ u: 0, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: t[2], dz: 2, mirror: false, dil: [0, 0, 0] }])
    })
  }

  // 鱿鱼：8 根触手
  const squid = models.SquidEntityModel
  if (squid) {
    delete squid.parts['getTentacleName(k)']
    const pivots = [[5, 15, 0], [3.54, 15, 3.54], [0, 15, 5], [-3.54, 15, 3.54], [-5, 15, 0], [-3.54, 15, -3.54], [0, 15, -5], [3.54, 15, -3.54]]
    const yaws = [Math.PI / 2, Math.PI / 4, 0, -Math.PI / 4, -Math.PI / 2, -Math.PI * 3 / 4, -Math.PI, -Math.PI * 5 / 4]
    pivots.forEach((p, i) => {
      squid.parts['tentacle' + i] = part(p, [0, yaws[i], 0], [{ u: 48, v: 0, x: -1, y: 0, z: -1, dx: 2, dy: 18, dz: 2, mirror: false, dil: [0, 0, 0] }])
    })
  }

  // 银鱼：7 节段 + 3 层
  const silverfish = models.SilverfishEntityModel
  if (silverfish) {
    delete silverfish.parts['getSegmentName(i)']
    delete silverfish.parts['getLayerName(0)']
    delete silverfish.parts['getLayerName(1)']
    delete silverfish.parts['getLayerName(2)']
    const locs = [[3, 2, 2], [4, 3, 2], [6, 4, 3], [3, 3, 3], [2, 2, 3], [2, 1, 2], [1, 1, 2]]
    const uvs = [[0, 0], [0, 4], [0, 9], [0, 16], [0, 22], [11, 0], [13, 4]]
    const fs = [-3.5, -1.5, 1, 4, 7, 9.5, 9.5]
    locs.forEach((L, i) => {
      silverfish.parts['segment' + i] = part([0, 24 - L[1], fs[i]], [0, 0, 0], [
        { u: uvs[i][0], v: uvs[i][1], x: L[0] * -0.5, y: 0, z: L[2] * -0.5, dx: L[0], dy: L[1], dz: L[2], mirror: false, dil: [0, 0, 0] },
      ])
    })
    silverfish.parts['layer0'] = part([0, 16, 1], [0, 0, 0], [{ u: 20, v: 0, x: -5, y: 0, z: -1.5, dx: 10, dy: 8, dz: 3, mirror: false, dil: [0, 0, 0] }])
    silverfish.parts['layer1'] = part([0, 20, 7], [0, 0, 0], [{ u: 20, v: 11, x: -3, y: 0, z: -1.5, dx: 6, dy: 4, dz: 3, mirror: false, dil: [0, 0, 0] }])
    silverfish.parts['layer2'] = part([0, 19, -1.5], [0, 0, 0], [{ u: 20, v: 18, x: -3, y: 0, z: -1, dx: 6, dy: 5, dz: 2, mirror: false, dil: [0, 0, 0] }])
  }

  // 蠹虫：4 节段
  const endermite = models.EndermiteEntityModel
  if (endermite) {
    delete endermite.parts['getSegmentName(i)']
    const dims = [[4, 3, 2], [6, 4, 5], [3, 3, 1], [1, 2, 1]]
    const uvs = [[0, 0], [0, 5], [0, 14], [0, 18]]
    const fs = [-3.5, 0, 3, 4]
    dims.forEach((D, i) => {
      endermite.parts['segment' + i] = part([0, 24 - D[1], fs[i]], [0, 0, 0], [
        { u: uvs[i][0], v: uvs[i][1], x: D[0] * -0.5, y: 0, z: D[2] * -0.5, dx: D[0], dy: D[1], dz: D[2], mirror: false, dil: [0, 0, 0] },
      ])
    })
  }

  // 守卫者：12 根尖刺 + 眼睛（挂到头下）
  const guardian = models.GuardianEntityModel
  if (guardian) {
    delete guardian.parts['getSpikeName(i)']
    const head = guardian.parts.head
    if (head) {
      const PX = [0, 0, 8, -8, -8, 8, 8, -8, 0, 0, 8, -8]
      const PY = [-8, -8, -8, -8, 0, 0, 0, 0, 8, 8, 8, 8]
      const PZ = [8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0]
      const PIT = [1.75, 0.25, 0, 0, 0.5, 0.5, 0.5, 0.5, 1.25, 0.75, 0, 0]
      const YAW = [0, 0, 0, 0, 0.25, 1.75, 1.25, 0.75, 0, 0, 0, 0]
      const ROL = [0, 0, 0.25, 1.75, 0, 0, 0, 0, 0, 0, 0.75, 1.25]
      for (let i = 0; i < 12; i++) {
        head.children['spike' + i] = part([PX[i], PY[i], PZ[i]], [PIT[i] * Math.PI, YAW[i] * Math.PI, ROL[i] * Math.PI], [
          { u: 0, v: 0, x: -1, y: -4.5, z: -1, dx: 2, dy: 9, dz: 2, mirror: false, dil: [0, 0, 0] },
        ])
      }
      head.children.eye = part([0, 0, -8.25], [0, 0, 0], [{ u: 8, v: 0, x: -1, y: 15, z: 0, dx: 2, dy: 2, dz: 1, mirror: false, dil: [0, 0, 0] }])
    }
  }
}

// ---------------------------------------------------------------- 模型方法定位

// 找到某个类里 getTexturedModelData / getModelData 等方法体（返回方法名 -> body 源码）
function findMethods(src, className) {
  const methods = {}
  const re = /(?:public|protected|private)?\s*static\s+(?:TexturedModelData|ModelData|ModelPartData|void)\s+(\w+)\s*\(/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    const open = src.indexOf('(', m.index + m[0].length - 1)
    const bodyOpen = src.indexOf('{', open)
    if (bodyOpen < 0) continue
    const bodyClose = matchBrace(src, bodyOpen)
    if (bodyClose < 0) continue
    methods[name] = src.slice(bodyOpen + 1, bodyClose)
  }
  return methods
}

// 从方法体里提取 TexturedModelData.of(..., W, H)
function findTexSize(body, consts) {
  const re = /TexturedModelData\s*\.\s*of\s*\([^,]+,\s*([^,]+),\s*([^)]+)\)/g
  let m
  while ((m = re.exec(body))) {
    const w = evalExpr(m[1], consts)
    const h = evalExpr(m[2], consts)
    if (w != null && h != null) return [w, h]
  }
  return null
}

// 提取 ModelTransformer.scaling(X) 的缩放
function findScale(body, consts) {
  const re = /ModelTransformer\s*\.\s*scaling\s*\(\s*([^)]+)\s*\)/g
  let m
  while ((m = re.exec(body))) {
    const s = evalExpr(m[1], consts)
    if (s != null) return s
  }
  return null
}

// 在方法体里找到对本类 getModelData / 基类 getModelData 的调用并展开
function findBaseCalls(body, consts) {
  const calls = []
  const re = /(\w+(?:EntityModel|ResemblingModel|EntityModel)?)\.getModelData\s*\(|(\w+)\.getTexturedModelData\s*\(/g
  let m
  while ((m = re.exec(body))) {
    const cls = m[1] || m[2]
    const open = body.indexOf('(', m.index + m[0].length - 1)
    const close = matchParen(body, open)
    if (close < 0) continue
    const args = splitArgs(body.slice(open + 1, close))
    calls.push({ cls, args })
  }
  return calls
}

// ---------------------------------------------------------------- 逐类解析

function parseClass(src) {
  const consts = extractConstants(src)
  const methods = findMethods(src)
  // 贴图尺寸：在任一方法体里找 TexturedModelData.of
  let tex = null
  for (const name of Object.keys(methods)) {
    const t = findTexSize(methods[name], consts)
    if (t) { tex = t; break }
  }
  // 按源码顺序处理构建方法（getTexturedModelData -> getModelData -> addLimbs）
  const order = []
  const methodDecl = /(?:public|protected|private)?\s*static\s+(?:TexturedModelData|ModelData|ModelPartData|void)\s+(\w+)\s*\(/g
  let md
  while ((md = methodDecl.exec(src))) {
    if (md[1] === 'getTexturedModelData' || md[1] === 'getModelData' || md[1] === 'addLimbs' || md[1] === 'addParts') order.push(md[1])
  }
  let parts = {}
  let scale = null
  for (const name of order) {
    const body = methods[name]
    if (!body) continue
    for (const call of findBaseCalls(body, consts)) {
      const b = expandBase(call.cls, call.args, consts, src, methods)
      if (b) Object.assign(parts, b)
    }
    Object.assign(parts, parseAddChilds(body, consts))
    const s = findScale(body, consts)
    if (s) scale = s
  }
  return { tex, parts, scale }
}

function expandBase(cls, args, consts, src, methods) {
  if (cls === 'QuadrupedEntityModel') {
    const sw = evalExpr(args[0], consts) ?? 6
    const leftM = args[1] === 'true'
    const rightM = args[2] === 'true'
    return BASE.quadruped(sw, leftM, rightM)
  }
  if (cls === 'BipedEntityModel') {
    const offY = evalExpr(args[1], consts) ?? 0
    return BASE.biped(offY)
  }
  if (cls === 'FelineEntityModel') return parseFeline(args, consts)
  if (cls === 'AbstractHorseEntityModel') return parseHorse(args, consts)
  if (cls === 'VillagerResemblingModel') return parseVillager(consts)
  if (cls === 'PiglinBaseEntityModel') return parsePiglin(consts)
  return null
}

// ---------------------------------------------------------------- 特殊基类（调用基类但需要解析其内部 getModelData）

// 这些基类的 getModelData 在各自文件中，直接用 parseAddChilds 解析它们的源码
const SPECIAL_BASE_FILES = {
  FelineEntityModel: 'FelineEntityModel',
  AbstractHorseEntityModel: 'AbstractHorseEntityModel',
  VillagerResemblingModel: 'VillagerResemblingModel',
}

function loadBaseSource(cls) {
  try {
    return readFileSync(join(REF, cls + '.java'), 'utf8')
  } catch {
    return null
  }
}
function parseFeline() {
  const src = loadBaseSource('FelineEntityModel')
  if (!src) return null
  const consts = extractConstants(src)
  const methods = findMethods(src)
  return methods.getModelData ? parseAddChilds(methods.getModelData, consts) : null
}
function parseHorse() {
  const src = loadBaseSource('AbstractHorseEntityModel')
  if (!src) return null
  const consts = extractConstants(src)
  const methods = findMethods(src)
  return methods.getModelData ? parseAddChilds(methods.getModelData, consts) : null
}
function parseVillager() {
  const src = loadBaseSource('VillagerResemblingModel')
  if (!src) return null
  const consts = extractConstants(src)
  const methods = findMethods(src)
  return methods.getModelData ? parseAddChilds(methods.getModelData, consts) : null
}
function parsePiglin() {
  // piglin ≈ biped 基础 + piglin 头/耳朵
  const parts = BASE.biped(0)
  parts.head = part([0, 0, 0], [0, 0, 0], [
    cub(0, 0, -5, -8, -4, 10, 8, 8),
    cub(31, 1, -2, -4, -5, 4, 4, 1),
    cub(2, 4, 2, -2, -5, 1, 2, 1),
    cub(2, 0, -3, -2, -5, 1, 2, 1),
  ])
  parts.head.children.left_ear = part([4.5, -6, 0], [0, 0, -PI / 6], [cub(51, 6, 0, 0, -2, 1, 5, 4)])
  parts.head.children.right_ear = part([-4.5, -6, 0], [0, 0, PI / 6], [cub(39, 6, -1, 0, -2, 1, 5, 4)])
  delete parts.head.children.hat // piglin 无 hat（reset）
  return parts
}

// ---------------------------------------------------------------- 入口

const files = readdirSync(REF).filter((f) => f.endsWith('.java'))

const models = {} // modelKey -> { w, h, parts }

// getTexturedModelData 返回 ModelData（无 TexturedModelData.of）的模型，贴图尺寸手动补
const TEX_OVERRIDES = { WolfEntityModel: [64, 32] }

for (const f of files) {
  const cls = f.replace(/\.java$/, '')
  const src = readFileSync(join(REF, f), 'utf8')
  const parsed = parseClass(src)
  const tex = parsed.tex || TEX_OVERRIDES[cls]
  if (parsed && tex && Object.keys(parsed.parts).length > 0) {
    const m = { w: tex[0], h: tex[1], parts: parsed.parts }
    if (parsed.scale) m.scale = parsed.scale
    models[cls] = m
  }
}

// 输出
// 注入循环生成的部件（blaze 火棒、ghast/鱿鱼触手、银鱼/蠹虫节段、守护者尖刺）
injectLoopParts(models)

// 附加基础模型（用于 thin subclass：zombie/cat/horse/piglin/villager 等）
models.Biped = { w: 64, h: 64, parts: BASE.biped(0) }
const feline = parseFeline(); if (feline) models.Feline = { w: 64, h: 32, parts: feline }
const horse = parseHorse(); if (horse) models.Horse = { w: 64, h: 64, parts: horse }
const piglin = parsePiglin(); if (piglin) models.Piglin = { w: 64, h: 64, parts: piglin }
const villager = parseVillager(); if (villager) models.Villager = { w: 64, h: 64, parts: villager }

const header = `// 由 scripts/parse-entity-models.mjs 从 vanilla 反编译源码自动生成，勿手改。\n// 每个模型的 parts 为一棵部件树：{ pivot:[x,y,z], rot:[pitch,yaw,roll], cuboids:[{u,v,x,y,z,dx,dy,dz,mirror,dil}], children:{...} }\n// 坐标单位为“模型像素”(1/16 方块)，Y 向下（模型空间），与 vanilla 一致。\n`
const body = `export const ENTITY_MODELS = ${JSON.stringify(models, null, 0)}\n`
writeFileSync(OUT, header + body, 'utf8')

console.log('解析到的模型数量：', Object.keys(models).length)
for (const k of Object.keys(models).sort()) {
  console.log(`  ${k}  ${models[k].w}x${models[k].h}  parts=${Object.keys(models[k].parts).join(',')}`)
}
