// 方块模型烘焙：把解析好的模型 JSON（elements + 合并后的 textures）
// 转成一组 quad（面）。每个 quad 含 4 个顶点（局部坐标 0..1）、UV、法线。
//
// 参考 Minecraft 方块模型格式与 prismarine-viewer 的实现：
//   - FACE_CORNERS：每个面 4 个角的 [选max标志x/y/z, uv选择u/v]
//   - UV 旋转：绕 (0.5,0.5) 旋转 face.rotation 度
//   - 元素旋转 origin/axis/angle（Minecraft 顺时针 = 右手系负角）

const FACE_CORNERS = {
  up:    [[0, 1, 1, 0, 1], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 0, 1, 0]],
  down:  [[1, 0, 1, 0, 1], [0, 0, 1, 1, 1], [1, 0, 0, 0, 0], [0, 0, 0, 1, 0]],
  east:  [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]],
  west:  [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]],
  north: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]],
  south: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]],
}

const FACE_DIRS = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1],
  south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
}

// 烘焙模型。variant 为 blockstate 里的 {x, y} 旋转角。
// 返回 { quads, fullCube }
export function bakeModel(model, variant) {
  const elements = model.elements
  const textures = model.textures || {}
  const variantX = variant?.x || 0
  const variantY = variant?.y || 0
  const quads = []

  // 判断是否整方块（用于遮挡剔除）
  const fullCube = isFullCube(elements)

  if (!elements) return { quads, fullCube }

  for (const element of elements) {
    const from = element.from
    const to = element.to
    if (!element.faces) continue
    const elRotation = element.rotation

    for (const dir of Object.keys(element.faces)) {
      const face = element.faces[dir]
      const corners = FACE_CORNERS[dir]
      if (!corners) continue
      const texKey = resolveTexture(face.texture, textures)
      if (!texKey) continue
      // 红石粉的强度点层与主线在同一高度共面，跳过以避免重叠闪烁（强度由资源包的数字层显示）
      if (texKey.endsWith('redstone_dust_overlay')) continue

      const uv = face.uv || autoUV(dir, from, to)
      const rot = ((face.rotation || 0) * Math.PI) / 180
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)

      const verts = [] // 局部坐标（1/16 单位）
      const uvs = []
      for (const c of corners) {
        let v = [c[0] ? to[0] : from[0], c[1] ? to[1] : from[1], c[2] ? to[2] : from[2]]
        if (elRotation) v = rotateAround(v, elRotation.axis, elRotation.angle, elRotation.origin)
        verts.push(v)

        const bu = c[3]
        const bv = c[4]
        const baseu = (bu - 0.5) * cos + (bv - 0.5) * sin + 0.5
        let basev = -(bu - 0.5) * sin + (bv - 0.5) * cos + 0.5
        // 底面贴图相对顶面需垂直翻转（Minecraft 底面“从下方观察”的镜像约定）
        if (dir === 'down') basev = 1 - basev
        uvs.push([(uv[0] + baseu * (uv[2] - uv[0])) / 16, (uv[1] + basev * (uv[3] - uv[1])) / 16])
      }

      let finalVerts = verts
      if (variantX || variantY) finalVerts = applyVariantRotation(verts, variantX, variantY)

      // 裁剪面：只按模型声明的 cullface 方向裁剪（无 cullface 的面永不裁剪）
      let cullface = null
      if (face.cullface && FACE_DIRS[face.cullface]) {
        cullface = variantX || variantY
          ? rotateDir(FACE_DIRS[face.cullface], variantX, variantY)
          : FACE_DIRS[face.cullface]
      }

      quads.push({
        texKey,
        cullface,
        normal: computeNormal(finalVerts),
        verts: finalVerts.map((v) => [v[0] / 16, v[1] / 16, v[2] / 16]),
        uvs,
      })
    }
  }

  return { quads, fullCube }
}

function isFullCube(elements) {
  if (!elements || elements.length !== 1) return false
  const el = elements[0]
  if (el.rotation) return false
  return (
    el.from[0] === 0 && el.from[1] === 0 && el.from[2] === 0 &&
    el.to[0] === 16 && el.to[1] === 16 && el.to[2] === 16 &&
    el.faces && Object.keys(el.faces).length === 6
  )
}

function resolveTexture(ref, textures) {
  let v = ref
  let guard = 0
  while (guard++ < 16) {
    if (typeof v === 'string' && v.startsWith('#')) {
      v = textures[v.slice(1)]
    } else if (v && typeof v === 'object' && typeof v.sprite === 'string') {
      // 26.x 起纹理引用可以是对象 { sprite, force_translucent, ambientocclusion }
      v = v.sprite
    } else {
      break
    }
  }
  if (typeof v !== 'string' || v.startsWith('#')) return null
  let s = v
  if (s.includes(':')) s = s.split(':').slice(-1)[0]
  s = s.replace(/^textures\//, '')
  return s
}

function autoUV(dir, from, to) {
  switch (dir) {
    case 'down':
    case 'up':
      return [from[0], from[2], to[0], to[2]]
    case 'north':
    case 'south':
      return [from[0], 16 - to[1], to[0], 16 - from[1]]
    case 'west':
    case 'east':
      return [from[2], 16 - to[1], to[2], 16 - from[1]]
    default:
      return [0, 0, 16, 16]
  }
}

// 绕指定轴旋转（标准右手系正角）。Minecraft 的“变体旋转”是顺时针，
// 故在 applyVariantRotation / rotateDir 里取负角还原；元素旋转则直接使用模型给的角。
function rotateAround([x, y, z], axis, angleDeg, origin) {
  const a = (angleDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const px = x - origin[0]
  const py = y - origin[1]
  const pz = z - origin[2]
  let rx, ry, rz
  if (axis === 'x') {
    rx = px
    ry = py * c - pz * s
    rz = py * s + pz * c
  } else if (axis === 'y') {
    rx = px * c + pz * s
    ry = py
    rz = -px * s + pz * c
  } else {
    rx = px * c - py * s
    ry = px * s + py * c
    rz = pz
  }
  return [rx + origin[0], ry + origin[1], rz + origin[2]]
}

// 旋转一个方向向量（无平移，绕原点），用于 cullface
function rotateDir(dir, x, y) {
  let d = dir
  if (x) d = rotateAround(d, 'x', -x, [0, 0, 0])
  if (y) d = rotateAround(d, 'y', -y, [0, 0, 0])
  return d.map((v) => Math.round(v))
}

function applyVariantRotation(verts, x, y) {
  const center = [8, 8, 8]
  return verts.map((v) => {
    let p = v
    if (x) p = rotateAround(p, 'x', -x, center)
    if (y) p = rotateAround(p, 'y', -y, center)
    return p
  })
}

function computeNormal(verts) {
  const e1 = [verts[1][0] - verts[0][0], verts[1][1] - verts[0][1], verts[1][2] - verts[0][2]]
  const e2 = [verts[2][0] - verts[0][0], verts[2][1] - verts[0][1], verts[2][2] - verts[0][2]]
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ]
  const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
  if (len < 1e-9) return [0, 1, 0]
  return [n[0] / len, n[1] / len, n[2] / len]
}
