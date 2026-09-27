// Three.js 渲染器：把解析出的方块数据渲染成合并的几何体。
// 隐藏面剔除、按贴图分组等纯逻辑在 geometry.js 中，这里只负责 WebGL 部分。
// 同时负责：相机（轨道 + WASD 移动）、坐标轴与尺寸标注。

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildFaceGroups } from './geometry.js'
import { buildEntityMesh } from './entities.js'

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']

// 红石粉按信号强度染色（复刻原版 RedstoneWireBlock 的渐变：越高越亮，越低越深）
function redstoneTint(power) {
  const f = Math.min(15, Math.max(0, power)) / 15
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3)
  const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5))
  const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7))
  return [r, g, b]
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

    this.entitiesGroup = new THREE.Group() // 实体（矿车、物品展示框等）
    this.scene.add(this.entitiesGroup)

    this.overlay = new THREE.Group() // 坐标轴 + 尺寸标注
    this.scene.add(this.overlay)

    // WASD 移动
    this.keys = new Set()
    this._lastTime = performance.now()
    this._onKeyDown = (e) => this._key(e, true)
    this._onKeyUp = (e) => this._key(e, false)
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)

    this._onResize = () => this._resize()
    window.addEventListener('resize', this._onResize)
    this._resize()
    this._animate()
  }

  _key(e, down) {
    if (MOVE_KEYS.includes(e.code)) {
      e.preventDefault()
      if (down) this.keys.add(e.code)
      else this.keys.delete(e.code)
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
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  _applyMovement(dt) {
    if (this.keys.size === 0) return
    const cam = this.camera.position
    const target = this.controls.target
    const dist = cam.distanceTo(target)
    const step = dist * 1.0 * dt // 每秒移动约一个视距

    const forward = new THREE.Vector3().subVectors(target, cam)
    forward.y = 0
    if (forward.lengthSq() < 1e-8) return
    forward.normalize()
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

  clear() {
    while (this.group.children.length) {
      const child = this.group.children.pop()
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m) => m?.dispose())
    }
    this.clearSigns()
    this.clearEntities()
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

  // 渲染实体（矿车、物品展示框等）
  async renderEntities(entities, assets) {
    this.clearEntities()
    if (!entities || !entities.length) return
    const meshes = await Promise.all(entities.map((e) => buildEntityMesh(e, assets).catch(() => null)))
    for (const m of meshes) if (m) this.entitiesGroup.add(m)
  }

  // 动态设置背景色
  setBackgroundColor(color) {
    this.scene.background = new THREE.Color(color)
  }

  // 渲染告示牌（方块实体）：木柱 + 面板 + 面板正面文字
  // signs: [{x, y, z, rotation, lines: [4 行文字]}]
  async renderSigns(signs, assets) {
    this.clearSigns()
    if (!signs.length) return

    const plankTex = await assets.getTexture('block/oak_planks')
    const plankMat = new THREE.MeshLambertMaterial({ map: plankTex || null })

    for (const sign of signs) {
      const rotation = Number(sign.rotation) || 0
      // 朝向：rotation 0 = 南(+z)，每 +1 顺时针转 22.5°
      const angle = (-rotation * 22.5 * Math.PI) / 180
      const front = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), front)

      const px = sign.x + 0.5
      const pz = sign.z + 0.5

      // 木柱
      const post = new THREE.Mesh(new THREE.BoxGeometry(2 / 16, 11 / 16, 2 / 16), plankMat)
      post.position.set(px, sign.y + 11 / 32, pz)
      this.signsGroup.add(post)

      // 面板（宽 14/16、高 4/16、厚 2/16，中心在 y=13/16）
      const boardCenter = new THREE.Vector3(px, sign.y + 13 / 16, pz)
      const board = new THREE.Mesh(new THREE.BoxGeometry(14 / 16, 4 / 16, 2 / 16), plankMat)
      board.position.copy(boardCenter)
      board.setRotationFromQuaternion(quat)
      this.signsGroup.add(board)

      // 文字平面（面板正面，略向前偏移避免与面板重叠闪烁）
      const textMat = new THREE.MeshBasicMaterial({ map: this._makeSignTexture(sign.lines) })
      const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(13 / 16, 3 / 16), textMat)
      textPlane.position.copy(boardCenter).addScaledVector(front, 1 / 16 + 0.006)
      textPlane.setRotationFromQuaternion(quat)
      this.signsGroup.add(textPlane)
    }
  }

  _makeSignTexture(lines) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#5a3a1e' // 深棕色木板
    ctx.fillRect(0, 0, 512, 128)
    ctx.strokeStyle = '#38220f'
    ctx.lineWidth = 4
    ctx.strokeRect(2, 2, 508, 124) // 边框
    ctx.fillStyle = '#ffffff'
    ctx.font = '24px "PixelFont", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < 4; i++) {
      ctx.fillText(String(lines[i] || ''), 256, 18 + i * 31)
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    return tex
  }

  // data: { palette: [{name, faces}], blocks: Map<"x,y,z" -> paletteIndex>, bounds }
  // 返回 { faces, textures }
  async render(data, assets, onProgress) {
    this.clear()
    const { palette, blocks, bounds } = data

    const { groups, emitted } = await buildFaceGroups(palette, blocks, bounds, (f) => onProgress?.(f * 0.45))
    if (emitted === 0) {
      throw new Error('没有生成任何可显示的面（方块可能全是空气或贴图解析失败）')
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
        // 气泡柱内的气泡：原版气泡粒子贴图（particle/bubble.png，8×8 白色气泡），
        // 在侧面上重复平铺，半透明地叠在水流内部。
        const isBubble = texKey === 'particle/bubble'
        const texture = await assets.getTexture(texKey)
        if (texture) {
          if (isBubble) {
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.RepeatWrapping
            texture.repeat.set(4, 4)
          }
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
              ? new THREE.MeshLambertMaterial({ map: texture, transparent: true, opacity: 0.8, depthWrite: false, flatShading: true })
              : new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, flatShading: true })
          // 红石粉线/点是灰度贴图，按强度染色（强度数字层 pXX 不染色）
          if (power !== null) {
            const c = redstoneTint(power)
            mat.color.setRGB(c[0], c[1], c[2])
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

    this._fit(bounds)
    this._updateOverlay(bounds)
    onProgress?.(1)
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
    const dist = radius * 2.6
    this.camera.position.set(cx + dist * 0.8, cy + dist * 0.55, cz + dist * 0.8)
    this.camera.near = Math.max(0.05, radius / 2000)
    this.camera.far = Math.max(200, radius * 200)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  // 坐标轴 + 长宽高标注：三条轴长度分别等于投影长/宽/高，标签贴在轴端点旁
  _updateOverlay(bounds) {
    while (this.overlay.children.length) {
      const c = this.overlay.children.pop()
      c.geometry?.dispose()
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      mats.forEach((m) => {
        m.map?.dispose()
        m.dispose()
      })
    }

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
