// Three.js 渲染器：把解析出的方块数据渲染成合并的几何体。
// 隐藏面剔除、按贴图分组等纯逻辑在 geometry.js 中，这里只负责 WebGL 部分。
// 同时负责：相机（轨道 + WASD 移动）、坐标轴与尺寸标注。

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildFaceGroups } from './geometry.js'
import { buildEntityMesh, buildCopperGolemStatueMesh } from './entities.js'
import { bakeModel } from './modelBaker.js'

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']

// 墙上告示牌的 facing -> 方向向量（文字朝向）
const SIGN_FACING = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }

// 染料颜色（DyeColor -> 十六进制）：告示牌文字、旗帜底色/图案共用
const DYE_COLORS = {
  white: '#ffffff', orange: '#ff681f', magenta: '#c74ebd', light_blue: '#3ab3da',
  yellow: '#fed83d', lime: '#80c71f', pink: '#f38baa', gray: '#474f52',
  light_gray: '#9d9d97', cyan: '#169c9c', purple: '#8932b8', blue: '#3c44aa',
  brown: '#835432', green: '#5e7c16', red: '#b02e26', black: '#000000',
}

// 墙上旗帜 facing -> 旗面朝向角（three.js 的 rotation.y，逆时针为正）
const BANNER_FACING_Y = { north: 180, south: 0, east: 90, west: -90 }

// 陶片物品 ID -> 陶片图案贴图。minecraft:skull_pottery_sherd -> entity/decorated_pot/skull_pottery_pattern；
// 无陶片（如 minecraft:brick，或空）返回 null，用空白侧贴图 decorated_pot_side。
function potPatternTexture(sherdId) {
  const id = (sherdId || '').replace(/^minecraft:/, '')
  if (!id.endsWith('_pottery_sherd')) return null
  return 'entity/decorated_pot/' + id.replace(/_pottery_sherd$/, '_pottery_pattern')
}

// 旗帜旗面几何，UV v=0 在上（MC 约定，配合 flipY=false 贴图）。
// 原版 BannerFlagModel 的旗面 cuboid 是 20×40×1、texOffs(0,0)、贴图 64×64，即只采样
// 贴图左上角 u=0..20、v=0..40 的旗面区域（贴图右侧 22px 是旗面侧边的阴影，不属于正面）。
// 尺寸上原版 BannerRenderer 有 MODEL_SCALE=(2/3,−2/3,−2/3)：20×40 模型单位 ×2/3 ÷16
// = 20/24 × 40/24 格 ≈ 0.833×1.667 格（不是 1.25×2.5）。
function bannerFlagGeometry() {
  const geo = new THREE.BufferGeometry()
  const hw = 5 / 12 // 20/24 的一半
  const hh = 5 / 6 // 40/24 的一半
  const U = 20 / 64
  const V = 40 / 64
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0,
  ]), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, U, 0, 0, V, U, V,
  ]), 2))
  geo.setIndex([0, 2, 1, 1, 2, 3]) // 法线 +z
  return geo
}
const BANNER_FLAG_GEO = bannerFlagGeometry()

// 装饰罐四个侧面（原版 DecoratedPotRenderer.createSidesLayer）。
// 罐体 14×16（x/z 1..15、y 0..16），四个面贴在罐体外侧；贴图 16×16，只采样 u=1..15 的
// 14px 内容（左右各留 1px 边框），图案正立（v=0 在上）。原版里这四个面由同一个「北面」
// 立方体 (0,0,0)-(14,16,0) 经不同 PartPose 旋转/平移得到，这里按推导出的世界坐标与 UV
// 直接构造，法线显式朝外（配合 side=DoubleSide 与 flatShading）。
const POT_SIDE_GEO = (() => {
  const hx = 7 / 16 // 半宽（14px / 2）
  const hy = 0.5 // 半高（16px / 2）
  const s = 1 / 16 // 1px（贴图内容 u 从 1px 到 15px）
  const mk = (corners, nx, ny, nz) => {
    // corners: 4 项 [x, y, z, u, v]，坐标为「以方块中心为原点」（x/z 中心 0、y 中心 0）
    const pos = new Float32Array(12)
    const uv = new Float32Array(8)
    const nrm = new Float32Array(12)
    for (let i = 0; i < 4; i++) {
      const c = corners[i]
      pos[i * 3] = c[0]; pos[i * 3 + 1] = c[1]; pos[i * 3 + 2] = c[2]
      uv[i * 2] = c[3]; uv[i * 2 + 1] = c[4]
      nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    return g
  }
  return [
    mk([[-hx, hy, hx, 1 * s, 0], [hx, hy, hx, 15 * s, 0], [-hx, -hy, hx, 1 * s, 1], [hx, -hy, hx, 15 * s, 1]], 0, 0, 1), // front（+z）
    mk([[hx, hy, -hx, 1 * s, 0], [-hx, hy, -hx, 15 * s, 0], [hx, -hy, -hx, 1 * s, 1], [-hx, -hy, -hx, 15 * s, 1]], 0, 0, -1), // back（-z）
    mk([[-hx, hy, hx, 15 * s, 0], [-hx, hy, -hx, 1 * s, 0], [-hx, -hy, hx, 15 * s, 1], [-hx, -hy, -hx, 1 * s, 1]], -1, 0, 0), // left（-x）
    mk([[hx, hy, -hx, 15 * s, 0], [hx, hy, hx, 1 * s, 0], [hx, -hy, -hx, 15 * s, 1], [hx, -hy, hx, 1 * s, 1]], 1, 0, 0), // right（+x）
  ]
})()

// 玩家头颅模型（皮肤 64×64 布局）。与 vanilla HeadModel 一致：底层头 + 帽子层
// （第二层，UV 在皮肤头部区域的第二列 +32，比底层稍大 0.25 像素）。帽子层透明处
// 由 alphaTest 裁掉，无帽子的皮肤自然只显示底层。
const HEAD_MODEL = {
  textures: { all: 'head' },
  elements: [
    { // 底层头
      from: [4, 4, 4], to: [12, 12, 12],
      faces: {
        up: { uv: [8, 0, 16, 8], texture: '#all' },
        down: { uv: [16, 0, 24, 8], texture: '#all' },
        east: { uv: [0, 8, 8, 16], texture: '#all' },
        south: { uv: [8, 8, 16, 16], texture: '#all' },
        west: { uv: [16, 8, 24, 16], texture: '#all' },
        north: { uv: [24, 8, 32, 16], texture: '#all' },
      },
    },
    { // 帽子层（第二层，稍大 0.25）
      from: [3.75, 3.75, 3.75], to: [12.25, 12.25, 12.25],
      faces: {
        up: { uv: [40, 0, 48, 8], texture: '#all' },
        down: { uv: [48, 0, 56, 8], texture: '#all' },
        east: { uv: [32, 8, 40, 16], texture: '#all' },
        south: { uv: [40, 8, 48, 16], texture: '#all' },
        west: { uv: [48, 8, 56, 16], texture: '#all' },
        north: { uv: [56, 8, 64, 16], texture: '#all' },
      },
    },
  ],
}
const HEAD_FACING_Y = { north: 180, south: 0, east: -90, west: 90 }

// 把 bakeModel 的一组 quad 转成单一材质 BufferGeometry
function quadsToHeadGeometry(quads) {
  const n = quads.length
  const positions = new Float32Array(n * 12)
  const uvs = new Float32Array(n * 8)
  const normals = new Float32Array(n * 12)
  const indices = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const q = quads[i]
    for (let k = 0; k < 4; k++) {
      positions[i * 12 + k * 3] = q.verts[k][0]
      positions[i * 12 + k * 3 + 1] = q.verts[k][1]
      positions[i * 12 + k * 3 + 2] = q.verts[k][2]
      uvs[i * 8 + k * 2] = q.uvs[k][0]
      uvs[i * 8 + k * 2 + 1] = q.uvs[k][1]
      normals[i * 12 + k * 3] = q.normal[0]
      normals[i * 12 + k * 3 + 1] = q.normal[1]
      normals[i * 12 + k * 3 + 2] = q.normal[2]
    }
    // 与方块渲染（geometry.js writeFace）相同三角化：0,1,2 + 2,1,3
    indices[i * 6] = i * 4
    indices[i * 6 + 1] = i * 4 + 1
    indices[i * 6 + 2] = i * 4 + 2
    indices[i * 6 + 3] = i * 4 + 2
    indices[i * 6 + 4] = i * 4 + 1
    indices[i * 6 + 5] = i * 4 + 3
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  return geo
}

// 红石粉按信号强度染色（复刻原版 RedstoneWireBlock 的渐变：越高越亮，越低越深）
function redstoneTint(power) {
  const f = Math.min(15, Math.max(0, power)) / 15
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3)
  const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5))
  const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7))
  return [r, g, b]
}

// 树叶染色（复刻原版 BlockColors / FoliageColor）：
// 树叶贴图是灰度图，颜色由 tintindex 触发、按树种染色。无生物群系信息时用
// 默认 foliage 绿；云杉/白桦用固定色（这两色从 1.x 起就没变过）。
// 只有用「leaves」父模型（含 tintindex:0）的树叶才染色；杜鹃/白杨等树叶
// 模型是 cube_all（无 tintindex、贴图自带颜色），不能染，否则会二次变色。
const TINTED_LEAVES = new Set([
  'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
  'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves',
])
function foliageTint(texKey) {
  const name = texKey.split('/').pop()
  if (!TINTED_LEAVES.has(name)) return null
  if (name === 'spruce_leaves') return 0x619961
  if (name === 'birch_leaves') return 0x80a755
  return 0x48b518
}

// 一条坐标轴线：从 origin 沿 (dx,dy,dz) 延伸
function makeAxisLine(origin, dx, dy, dz, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    origin,
    new THREE.Vector3(origin.x + dx, origin.y + dy, origin.z + dz),
  ])
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }))
}

export class Renderer {
  constructor(container) {
    this.container = container
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x2a2a2a) // 默认深灰背景

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    this.camera.position.set(20, 16, 20)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = false // 无惯性
    this.controls.screenSpacePanning = true

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(0.6, 1, 0.4)
    this.scene.add(dir)

    this.group = new THREE.Group() // 方块网格
    this.scene.add(this.group)

    this.signsGroup = new THREE.Group() // 告示牌（方块实体）
    this.scene.add(this.signsGroup)

    this.headsGroup = new THREE.Group() // 玩家头颅（用玩家皮肤）
    this.scene.add(this.headsGroup)

    this.bannersGroup = new THREE.Group() // 旗帜旗面（底色 + 图案，每个实例单独绘制）
    this.scene.add(this.bannersGroup)

    this.statuesGroup = new THREE.Group() // 铜傀儡雕像（BER 绘制）
    this.scene.add(this.statuesGroup)

    this.potsGroup = new THREE.Group() // 装饰罐侧面（陶片图案逐实例绘制）
    this.scene.add(this.potsGroup)

    this.entitiesGroup = new THREE.Group() // 实体（矿车、物品展示框等）
    this.scene.add(this.entitiesGroup)

    this.overlay = new THREE.Group() // 坐标轴 + 尺寸标注
    this.scene.add(this.overlay)

    this.regionGroup = new THREE.Group() // 区域线框
    this.scene.add(this.regionGroup)

    // 移动双模式：orbit（环绕结构中心）/ fly（第一人称飞行）
    this.moveMode = 'orbit'
    this.moveSpeed = 1.0
    this.lookSensitivity = 0.007 // 飞行模式转头灵敏度（rad/px）
    this._yaw = 0
    this._pitch = 0
    this.camera.rotation.order = 'YXZ'
    this.onMoveModeChange = null // 由 main.js 设置，用于同步左侧 UI
    this.onSpeedChange = null
    this.onSensitivityChange = null
    this.onFirstMoveKey = null // WASD 首次按下时回调，切到飞行模式

    // WASD 移动
    this.keys = new Set()
    this._lastTime = performance.now()
    this._onKeyDown = (e) => this._key(e, true)
    this._onKeyUp = (e) => this._key(e, false)
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)

    this._initFlyControls()

    this._onResize = () => this._resize()
    window.addEventListener('resize', this._onResize)
    this._resize()
    this._animate()
  }

  // 飞行模式的鼠标/滚轮控制（原地转头、右键平移、滚轮调速）
  _initFlyControls() {
    const el = this.renderer.domElement
    this._flyDragging = null // null | 'look' | 'pan'
    this._flyLast = { x: 0, y: 0 }

    el.addEventListener('pointerdown', (e) => {
      if (this.moveMode !== 'fly') return
      if (e.button === 0) this._flyDragging = 'look'
      else if (e.button === 2) this._flyDragging = 'pan'
      else return
      this._flyLast = { x: e.clientX, y: e.clientY }
      el.setPointerCapture(e.pointerId)
    })
    el.addEventListener('pointermove', (e) => {
      if (this.moveMode !== 'fly' || !this._flyDragging) return
      const dx = e.clientX - this._flyLast.x
      const dy = e.clientY - this._flyLast.y
      this._flyLast = { x: e.clientX, y: e.clientY }
      if (this._flyDragging === 'look') {
        this._yaw -= dx * this.lookSensitivity
        this._pitch -= dy * this.lookSensitivity
        const max = Math.PI / 2 - 0.001
        this._pitch = Math.max(-max, Math.min(max, this._pitch))
        this._applyFlyRotation()
      } else if (this._flyDragging === 'pan') {
        // 屏幕空间平移：相机与 target 同向平移
        const dist = this.camera.position.distanceTo(this.controls.target)
        const s = dist * 0.0016
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
        const offset = new THREE.Vector3().addScaledVector(right, -dx * s).addScaledVector(up, dy * s)
        this.camera.position.add(offset)
        this.controls.target.add(offset)
      }
    })
    const endDrag = () => { this._flyDragging = null }
    el.addEventListener('pointerup', endDrag)
    el.addEventListener('pointercancel', endDrag)

    el.addEventListener('wheel', (e) => {
      if (this.moveMode !== 'fly') return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      this.moveSpeed = Math.min(10, Math.max(0.1, this.moveSpeed * factor))
      this.onSpeedChange?.(this.moveSpeed)
    }, { passive: false })
  }

  _applyFlyRotation() {
    this.camera.rotation.set(this._pitch, this._yaw, 0)
  }

  _key(e, down) {
    if (MOVE_KEYS.includes(e.code)) {
      e.preventDefault()
      if (down) {
        this.keys.add(e.code)
        // 第一次按 WASD 时自动从环绕切到飞行模式（main.js 里更新左侧 UI）
        if (this.moveMode === 'orbit') this.onFirstMoveKey?.()
      } else {
        this.keys.delete(e.code)
      }
    }
  }

  _resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  _animate() {
    requestAnimationFrame(() => this._animate())
    const now = performance.now()
    const dt = Math.min((now - this._lastTime) / 1000, 0.1)
    this._lastTime = now
    this._applyMovement(dt)
    // 飞行模式下不跑 OrbitControls.update()——它会 lookAt(target) 覆盖掉原地转头的旋转
    if (this.moveMode === 'orbit') this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  _applyMovement(dt) {
    if (this.keys.size === 0) return
    const cam = this.camera.position
    const target = this.controls.target
    const dist = cam.distanceTo(target)

    // 飞行模式：沿视线方向移动（固定世界速度 × 倍率）；环绕模式：沿「相机→目标」方向移动（速度随距离）。
    let forward
    let step
    if (this.moveMode === 'fly') {
      forward = new THREE.Vector3()
      this.camera.getWorldDirection(forward)
      forward.y = 0
      if (forward.lengthSq() < 1e-8) return
      forward.normalize()
      step = 8 * this.moveSpeed * dt // 每秒约 8 格 × 倍率
    } else {
      forward = new THREE.Vector3().subVectors(target, cam)
      forward.y = 0
      if (forward.lengthSq() < 1e-8) return
      forward.normalize()
      step = dist * this.moveSpeed * dt
    }
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()

    const move = new THREE.Vector3()
    if (this.keys.has('KeyW')) move.add(forward)
    if (this.keys.has('KeyS')) move.sub(forward)
    if (this.keys.has('KeyD')) move.add(right)
    if (this.keys.has('KeyA')) move.sub(right)

    if (this.keys.has('Space')) {
      cam.y += step
      target.y += step
    }
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
      cam.y -= step
      target.y -= step
    }

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(step)
      cam.add(move)
      target.add(move)
    }
  }

  // disposeTextures=true 时连同方块贴图一起释放（资源包切换时贴图缓存已失效）。
  // 层级/区域切换等只重建方块网格的场景传 false，复用缓存里的贴图，避免反复上传。
  clear(disposeTextures = false) {
    this.clearBlocks(disposeTextures)
    this.clearSigns()
    this.clearHeads()
    this.clearBanners()
    this.clearStatues()
    this.clearPots()
    this.clearEntities()
    this.clearOverlay()
    this.clearRegionWireframes()
  }

  clearBlocks(disposeTextures = false) {
    while (this.group.children.length) {
      const child = this.group.children.pop()
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m) => {
        if (m) {
          if (disposeTextures) m.map?.dispose()
          m.dispose()
        }
      })
    }
  }

  clearHeads() {
    while (this.headsGroup.children.length) {
      const child = this.headsGroup.children.pop()
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m) => {
        m.map?.dispose()
        m.dispose()
      })
    }
  }

  clearSigns() {
    while (this.signsGroup.children.length) {
      const child = this.signsGroup.children.pop()
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m) => {
        m.map?.dispose()
        m.dispose()
      })
    }
  }

  clearBanners() {
    while (this.bannersGroup.children.length) {
      const child = this.bannersGroup.children.pop()
      child.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m) => {
          if (m) {
            m.map?.dispose()
            m.dispose()
          }
        })
      })
    }
  }

  clearStatues() {
    while (this.statuesGroup.children.length) {
      const child = this.statuesGroup.children.pop()
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m) => {
        if (m) {
          m.map?.dispose()
          m.dispose()
        }
      })
    }
  }

  clearPots() {
    while (this.potsGroup.children.length) {
      const child = this.potsGroup.children.pop()
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m) => {
          if (m) {
            m.map?.dispose()
            m.dispose()
          }
        })
      })
    }
  }

  clearEntities() {
    while (this.entitiesGroup.children.length) {
      const child = this.entitiesGroup.children.pop()
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m) => {
          if (m) {
            m.map?.dispose()
            m.dispose()
          }
        })
      })
    }
  }

  clearOverlay() {
    while (this.overlay.children.length) {
      const c = this.overlay.children.pop()
      c.geometry?.dispose()
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      mats.forEach((m) => {
        m?.map?.dispose()
        m?.dispose()
      })
    }
  }

  clearRegionWireframes() {
    while (this.regionGroup.children.length) {
      const c = this.regionGroup.children.pop()
      c.geometry?.dispose()
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      mats.forEach((m) => m?.dispose())
    }
  }

  // 渲染实体（矿车、物品展示框等）
  async renderEntities(entities, assets, data) {
    this.clearEntities()
    if (!entities || !entities.length) return
    // 分批次渲染，避免「全方块」这类上千个展示框一次性并发加载贴图/模型，
    // 超过浏览器并发上限导致部分贴图瞬时加载失败（进而整框报「实体渲染失败」）。
    const BATCH = 50
    const meshes = []
    for (let i = 0; i < entities.length; i += BATCH) {
      const chunk = entities.slice(i, i + BATCH)
      const results = await Promise.all(
        chunk.map((e) =>
          buildEntityMesh(e, assets, data).catch((err) => {
            console.error('实体渲染失败:', e.id, err)
            return null
          }),
        ),
      )
      meshes.push(...results)
    }
    for (const m of meshes) if (m) this.entitiesGroup.add(m)
  }

  // 渲染玩家头颅：加载对应玩家的皮肤，画成 8×8×8 头颅。heads: [{x, y, z, rotation?, facing?, skinUrl}]
  async renderPlayerHeads(heads, assets) {
    this.clearHeads()
    if (!heads || !heads.length) return
    for (const head of heads) {
      // 有皮肤 URL 就加载玩家皮肤，否则用默认 Steve 皮肤
      const skinTex = head.skinUrl
        ? await assets.getExternalTexture(head.skinUrl)
        : await assets.getTexture('entity/player/wide/steve')
      if (!skinTex) continue
      // 立地头颅用 rotation(0-15)，墙上头颅用 facing（与 blocks.js headVariant 一致）
      const yDeg = head.facing ? (HEAD_FACING_Y[head.facing] || 0) : (Number(head.rotation) || 0) * 22.5
      const quads = bakeModel(HEAD_MODEL, { y: yDeg }, [64, 64]).quads
      const mat = new THREE.MeshLambertMaterial({ map: skinTex, alphaTest: 0.5, flatShading: true })
      const mesh = new THREE.Mesh(quadsToHeadGeometry(quads), mat)
      mesh.position.set(head.x, head.y, head.z)
      this.headsGroup.add(mesh)
    }
  }

  // 渲染旗帜旗面（底色 + 图案，每个实例单独绘制）。
  // banners: [{x, y, z, rotation?, facing?, baseColor, patterns: [{pattern, color}]}]
  async renderBanners(banners, assets) {
    this.clearBanners()
    if (!banners || !banners.length) return
    for (const b of banners) {
      const tex = await this._makeBannerTexture(b.baseColor, b.patterns, assets)
      if (!tex) continue
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true })
      const mesh = new THREE.Mesh(BANNER_FLAG_GEO, mat)
      const group = new THREE.Group()
      group.add(mesh)
      if (b.facing) {
        // 墙上旗帜：旗面贴墙（距方块中心 0.375 格、即距墙面 0.125 格），朝向 facing（远离墙）。
        // 旗面（半高 5/6）竖直居中于方块（中心 y≈0.021=1/48）。
        mesh.position.z = -0.375
        group.position.set(b.x + 0.5, b.y + 1 / 48, b.z + 0.5)
        group.rotation.y = ((BANNER_FACING_Y[b.facing] ?? 0) * Math.PI) / 180
      } else {
        // 立地旗帜：旗面绕杆旋转（与告示牌同一条 rotation 公式，顺时针 22.5°/级）。
        // 旗面在杆前 0.0625 格；中心在 y=1（与原版 MODEL_SCALE 2/3 后的旗面 y 8/3..88/3 中心 16px 一致）。
        mesh.position.z = 0.0625
        const rot = Number(b.rotation) || 0
        const a = -22.5 * (rot % 4) - 90 * Math.floor(rot / 4)
        group.position.set(b.x + 0.5, b.y + 1.0, b.z + 0.5)
        group.rotation.y = (a * Math.PI) / 180
      }
      this.bannersGroup.add(group)
    }
  }

  // 渲染铜傀儡雕像（BER 绘制，无 JSON 模型）。statues: [{x, y, z, facing, texKey}]
  async renderStatues(statues, assets) {
    this.clearStatues()
    if (!statues || !statues.length) return
    for (const s of statues) {
      const tex = await assets.getTexture(s.texKey)
      if (!tex) continue
      const mesh = buildCopperGolemStatueMesh(tex)
      if (!mesh) continue
      mesh.position.set(s.x + 0.5, s.y + 0.05, s.z + 0.5)
      mesh.rotation.y = ((BANNER_FACING_Y[s.facing] ?? 0) * Math.PI) / 180
      this.statuesGroup.add(mesh)
    }
  }

  // 渲染装饰罐的四个侧面（每只罐子的陶片图案可能不同）。
  // pots: [{x, y, z, facing, sherds: {front, back, left, right}}]，sherds 各项为陶片物品 ID 或 null。
  async renderDecoratedPots(pots, assets) {
    this.clearPots()
    if (!pots || !pots.length) return
    const blankTex = await assets.getTexture('entity/decorated_pot/decorated_pot_side')
    if (!blankTex) return
    const SIDES = ['front', 'back', 'left', 'right']
    for (const pot of pots) {
      const group = new THREE.Group()
      for (let i = 0; i < 4; i++) {
        const pattern = potPatternTexture(pot.sherds && pot.sherds[SIDES[i]])
        const tex = pattern ? await assets.getTexture(pattern) : blankTex
        if (!tex) continue
        const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, flatShading: true })
        group.add(new THREE.Mesh(POT_SIDE_GEO[i], mat))
      }
      group.position.set(pot.x + 0.5, pot.y + 0.5, pot.z + 0.5)
      group.rotation.y = ((BANNER_FACING_Y[pot.facing] ?? 0) * Math.PI) / 180
      this.potsGroup.add(group)
    }
  }

  // 把旗帜底色 + 图案合成到一张 64×64 贴图（底色/图案都用 DyeColor 染色）
  async _makeBannerTexture(baseColor, patterns, assets) {
    const baseTex = await assets.getTexture('entity/banner/base')
    if (!baseTex || !baseTex.image) return null
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    const tint = document.createElement('canvas')
    tint.width = 64
    tint.height = 64
    const tctx = tint.getContext('2d')

    const drawTinted = (image, hex) => {
      tctx.clearRect(0, 0, 64, 64)
      tctx.drawImage(image, 0, 0, 64, 64)
      // 原版 BannerRenderer.submitPatternLayer：最终色 = 贴图 × DyeColor.getTextureDiffuseColor()。
      // 图案贴图是灰度（RGB=亮度）+ alpha（掩码）。canvas 的 multiply 会把透明区也填成染料色，
      // 所以乘完再用 destination-in 按原贴图的 alpha 把透明区盖回去（保留灰度明暗 + 掩码）。
      tctx.globalCompositeOperation = 'multiply'
      tctx.fillStyle = hex
      tctx.fillRect(0, 0, 64, 64)
      tctx.globalCompositeOperation = 'destination-in'
      tctx.drawImage(image, 0, 0, 64, 64)
      tctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(tint, 0, 0, 64, 64)
    }

    drawTinted(baseTex.image, DYE_COLORS[baseColor] || '#ffffff')
    for (const p of patterns || []) {
      const name = (p.pattern || '').replace(/^minecraft:/, '')
      const tex = await assets.getTexture('entity/banner/' + name)
      if (!tex || !tex.image) continue
      drawTinted(tex.image, DYE_COLORS[p.color] || '#ffffff')
    }

    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.flipY = false
    tex.needsUpdate = true
    return tex
  }

  // 动态设置背景色
  setBackgroundColor(color) {
    this.scene.background = new THREE.Color(color)
  }

  // —— 移动模式 ——
  setMoveMode(mode) {
    if (mode !== 'orbit' && mode !== 'fly') return
    this.moveMode = mode
    this.controls.enabled = mode === 'orbit'
    if (mode === 'fly') {
      // 进入飞行模式：从当前相机朝向初始化 yaw/pitch
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
      this._yaw = e.y
      this._pitch = e.x
    }
    this.onMoveModeChange?.(mode)
  }

  getMoveMode() {
    return this.moveMode
  }

  setMoveSpeed(speed) {
    this.moveSpeed = Math.min(10, Math.max(0.1, Number(speed) || 1))
    this.onSpeedChange?.(this.moveSpeed)
  }

  setLookSensitivity(v) {
    this.lookSensitivity = Math.min(0.05, Math.max(0.005, Number(v) || 0.007))
    this.onSensitivityChange?.(this.lookSensitivity)
  }

  // —— 显示开关 ——
  setEntitiesVisible(v) { this.entitiesGroup.visible = !!v }
  setWireframesVisible(v) { this.regionGroup.visible = !!v }
  setDimensionsVisible(v) { this.overlay.visible = !!v }

  // 渲染告示牌文字：告示牌本身（柱/板）已由方块模型渲染，这里只在板面上加文字。
  // signs: [{x, y, z, rotation?, facing?, lines: [4 行文字]}]
  //   - 立地告示牌用 rotation(0-15)，墙上告示牌用 facing(north/south/east/west)
  async renderSigns(signs, assets) {
    this.clearSigns()
    if (!signs.length) return

    for (const sign of signs) {
      let front, boardCenter
      if (sign.facing) {
        // 墙上告示牌：板贴在 facing 反方向的墙上，文字朝 facing
        const d = SIGN_FACING[sign.facing] || [0, 0, 1]
        front = new THREE.Vector3(d[0], 0, d[2])
        boardCenter = new THREE.Vector3(sign.x + 0.5 - d[0] * 0.44, sign.y + 0.52, sign.z + 0.5 - d[2] * 0.44)
      } else {
        // 立地告示牌：rotation 0=南(+z)，每 +1 顺时针 22.5°；
        // 面板正面法线在模型里是 +z，经 rot(0..-67.5°)+variant y(0/90/180/270) 旋转，
        // 与方块渲染同一条旋转公式，文字正好落在方块模型的面板正面。
        const rotation = Number(sign.rotation) || 0
        const a = ((-22.5 * (rotation % 4) - 90 * Math.floor(rotation / 4)) * Math.PI) / 180
        front = new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
        // 挂告示牌板在方块下方（y≈0.31），立告示牌板在上方（y≈0.83）
        boardCenter = new THREE.Vector3(sign.x + 0.5, sign.y + (sign.hanging ? 0.31 : 0.83), sign.z + 0.5)
      }

      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), front)
      const textMat = new THREE.MeshBasicMaterial({ map: this._makeSignTexture(sign.lines, sign.color), transparent: true, side: THREE.DoubleSide })
      const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.4), textMat)
      textPlane.position.copy(boardCenter).addScaledVector(front, 0.05)
      textPlane.setRotationFromQuaternion(quat)
      this.signsGroup.add(textPlane)
    }
  }

  _makeSignTexture(lines, color) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, 512, 128) // 透明背景，让木板透出来
    ctx.fillStyle = DYE_COLORS[color] || '#1a1a1a' // 默认近黑色；指定 dye 颜色时用对应色
    ctx.font = '30px "PixelFont", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < 4; i++) {
      ctx.fillText(String(lines[i] || ''), 256, 16 + i * 32)
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    return tex
  }

  // data: { palette: [{name, faces}], blocks: Map<"x,y,z" -> paletteIndex>, bounds }
  // fit=true 时把相机对准结构中心（首次载入）；fit=false 时保持相机不动（切换资源包重渲染）。
  // 返回 { faces, textures }
  async render(data, assets, onProgress, filter, fit = true) {
    this.clear()
    const { bounds } = data
    const stats = await this._buildBlockMeshes(data, assets, onProgress, filter)
    if (fit) this._fit(bounds)
    this._updateOverlay(bounds)
    this._updateRegionWireframes(data)
    onProgress?.(1)
    return stats
  }

  // 只重建方块网格（层级/区域变化时调用，不动相机、告示牌、头颅、实体）。
  async renderBlocks(data, assets, filter) {
    this.clearBlocks()
    return this._buildBlockMeshes(data, assets, null, filter)
  }

  async _buildBlockMeshes(data, assets, onProgress, filter) {
    const { palette, blocks, bounds } = data

    const { groups, emitted } = await buildFaceGroups(palette, blocks, bounds, (f) => onProgress?.(f * 0.45), filter)
    if (emitted === 0) {
      return { faces: 0, textures: 0 }
    }
    onProgress?.(0.45)

    const texKeys = Array.from(groups.keys())
    const materials = new Map()
    let loaded = 0
    await Promise.all(
      texKeys.map(async (gKey) => {
        // 组键可能带强度后缀（如 redstone_dust_dot|p15）
        const sep = gKey.indexOf('|p')
        const texKey = sep >= 0 ? gKey.slice(0, sep) : gKey
        const power = sep >= 0 ? Number(gKey.slice(sep + 2)) : null
        const isWater = texKey === 'block/water_still' || texKey === 'block/water_flow'
        const isLava = texKey === 'block/lava_still' || texKey === 'block/lava_flow'
        // 气泡柱内的气泡：原版气泡粒子贴图（particle/bubble.png，8×8 白色气泡）。
        // 用点精灵（THREE.Points）渲染，始终面向摄像头，任何角度都可见。
        const isBubble = texKey === 'particle/bubble'
        // 铁轨是零厚度平面（含斜坡）：用 Lambert 会让朝下的面被 cull 后露出暗面（斜坡朝南的一面发黑），
        // 改用无光照 + 双面，让铁轨从任何角度都保持同一亮度（原版铁轨本就不随朝向变暗）。
        const isRail = texKey.includes('rail')
        const texture = await assets.getTexture(texKey)
        if (texture) {
          // 水/岩浆用半透明材质，其余用 alphaTest 裁剪
          // 注意：水的贴图是灰度图（颜色由着色器染色），需用 color 染成蓝色
          // flatShading：方块每个面的 4 个顶点本就同法线，用几何导数算平直法线即可，
          // 省去法线数组（超大投影可省数百 MB 内存），光照效果一致。
          const mat = isWater || isLava
            ? new THREE.MeshLambertMaterial(
                isWater
                  ? { map: texture, color: 0x3f76e4, transparent: true, opacity: 0.75, flatShading: true }
                  : { map: texture, transparent: true, opacity: 0.9, flatShading: true },
              )
            : isBubble
              // 气泡直径 0.3 格（原交叉面半径 0.15×2），sizeAttenuation 按距离透视缩放
              ? new THREE.PointsMaterial({ map: texture, transparent: true, opacity: 0.85, depthWrite: false, size: 0.3, sizeAttenuation: true })
              : isRail
                ? new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide })
                : new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, flatShading: true })
          // 红石粉线/点是灰度贴图，按强度染色（强度数字层 pXX 不染色）
          if (power !== null) {
            const c = redstoneTint(power)
            mat.color.setRGB(c[0], c[1], c[2])
          }
          // 树叶染色：灰度树叶贴图 × 树种色（云杉/白桦固定色，其余默认 foliage 绿）
          if (power === null) {
            const fc = foliageTint(texKey)
            if (fc != null) mat.color.setHex(fc)
          }
          materials.set(gKey, mat)
        }
        loaded++
        onProgress?.(0.45 + 0.5 * (loaded / Math.max(1, texKeys.length)))
      })
    )

    if (materials.size === 0 && groups.size > 0) {
      throw new Error(`贴图加载失败：${texKeys.length} 张贴图都未能加载（请确认已运行 npm run setup）`)
    }

    let i = 0
    for (const [texKey, g] of groups) {
      const mat = materials.get(texKey)
      if (!mat) continue
      // 气泡组是点云：positions 只存中心坐标（每点 3 个 float）。
      // renderOrder = -1：强制气泡在所有透明物体之前绘制——水会写深度（默认 depthWrite），
      // 若气泡排在水后面，柱内的气泡会被水面深度全部挡住（只有个别角度可见）。
      // 气泡先画、只和实体方块做深度测试，水随后混合在其上（气泡带一点水的蓝色），
      // 与原版一致：水不遮挡其内部的气泡粒子。
      if (texKey === 'particle/bubble') {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
        const points = new THREE.Points(geo, mat)
        points.renderOrder = -1
        this.group.add(points)
        continue
      }
      const geo = new THREE.BufferGeometry()
      // 注意：这里必须用 BufferAttribute 直接包装类型数组（不复制）——
      // Float32BufferAttribute 会复制一份（超大投影多占一倍内存），
      // 且 setIndex 只自动转换普通数组，直接传 Uint32Array 会被当成裸数组导致渲染报错。
      geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
      geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2))
      geo.setIndex(new THREE.BufferAttribute(g.indices, 1))
      this.group.add(new THREE.Mesh(geo, mat))
      // 超大几何体上传 GPU 时也定期让出主线程，避免最后一段卡顿
      if ((++i & 3) === 0) await new Promise((r) => setTimeout(r, 0))
    }

    return { faces: emitted, textures: materials.size }
  }

  // 调试：读取当前画面像素，统计有多少种颜色（判断画面是否有内容）
  debugPixels() {
    this.renderer.render(this.scene, this.camera)
    const gl = this.renderer.getContext()
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const colors = new Set()
    for (let i = 0; i < px.length; i += 4) {
      colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])
    }
    return { width: w, height: h, distinctColors: colors.size }
  }

  // 调试：把画面采样成文字网格（每个格子的颜色 hex），用于排查渲染问题
  debugGrid(cols = 24, rows = 16) {
    this.renderer.render(this.scene, this.camera)
    const gl = this.renderer.getContext()
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const lines = []
    for (let r = rows - 1; r >= 0; r--) {
      const y = Math.floor(((r + 0.5) / rows) * h)
      let line = ''
      for (let c = 0; c < cols; c++) {
        const x = Math.floor(((c + 0.5) / cols) * w)
        const i = (y * w + x) * 4
        line += '#' + [px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('') + ' '
      }
      lines.push(line)
    }
    return lines.join('\n')
  }

  _fit(bounds) {
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    const cz = (bounds.minZ + bounds.maxZ) / 2
    const w = bounds.width
    const h = bounds.height
    const d = bounds.depth
    const radius = Math.max(1, Math.sqrt(w * w + h * h + d * d) / 2)
    this.controls.target.set(cx, cy, cz)
    const dist = radius * 1.3
    this.camera.position.set(cx + dist * 0.8, cy + dist * 0.55, cz + dist * 0.8)
    this.camera.near = Math.max(0.05, radius / 2000)
    this.camera.far = Math.max(200, radius * 200)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  // 坐标轴 + 长宽高标注：三条轴长度分别等于投影长/宽/高，标签贴在轴端点旁
  _updateOverlay(bounds) {
    this.clearOverlay()

    const { minX, minY, minZ, width, height, depth } = bounds
    const o = new THREE.Vector3(minX, minY, minZ)

    this.overlay.add(makeAxisLine(o, width, 0, 0, 0xff5555))
    this.overlay.add(makeAxisLine(o, 0, height, 0, 0x55ff55))
    this.overlay.add(makeAxisLine(o, 0, 0, depth, 0x5599ff))

    const scale = Math.max(width, height, depth, 1) * 0.15
    const pad = scale * 0.5
    this.overlay.add(this._textSprite(`X ${width}`, 0xff5555, o.x + width + pad, o.y, o.z, scale))
    this.overlay.add(this._textSprite(`Y ${height}`, 0x55ff55, o.x, o.y + height + pad, o.z, scale))
    this.overlay.add(this._textSprite(`Z ${depth}`, 0x5599ff, o.x, o.y, o.z + depth + pad, scale))
  }

  // 区域线框：每个区域画一个淡蓝色包围盒（含边界 [min, max] 即 [min, max+1) 的世界盒）
  _updateRegionWireframes(data) {
    this.clearRegionWireframes()
    const regions = data.regions || []
    for (const r of regions) {
      const box = new THREE.Box3(
        new THREE.Vector3(r.minX, r.minY, r.minZ),
        new THREE.Vector3(r.maxX + 1, r.maxY + 1, r.maxZ + 1),
      )
      this.regionGroup.add(new THREE.Box3Helper(box, 0x6fa8dc))
    }
  }

  _textSprite(text, color, x, y, z, scale) {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.font = '40px "PixelFont", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
    ctx.fillText(text, 128, 32)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true }) // 取消悬浮
    const sprite = new THREE.Sprite(mat)
    sprite.position.set(x, y, z)
    const aspect = 4 // 宽 4 高 1
    sprite.scale.set(scale * aspect, scale, 1)
    return sprite
  }
}
