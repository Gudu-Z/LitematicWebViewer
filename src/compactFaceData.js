// One original quad template + one cell/template pair per visible face. Template
// variants are selected against the legacy Float32 world vertices, never rounded
// to a coarser grid. Face order and UV bit patterns remain unchanged.
export const FACE_BATCH_SIZE = 4096
const MAX_COMPACT_TEMPLATES = 1024 * 2048 / 8
const bits = new Uint32Array(1), floats = new Float32Array(bits.buffer)
function nextFloat(value, up) {
  if (value === 0) return up ? 2 ** -149 : -(2 ** -149)
  floats[0] = value; bits[0] += (value > 0) === up ? 1 : -1
  return floats[0]
}

export function canCompactFaces(bounds, key) {
  return !key.startsWith('special/') && !key.endsWith('|translucent') && key !== 'particle/bubble'
    && !/^block\/(water|lava)_(still|flow|overlay)$/.test(key)
    && bounds.width * bounds.depth <= 2 ** 32
    && [[bounds.minX, bounds.width], [bounds.minY, bounds.height], [bounds.minZ, bounds.depth]]
      .every(([min, size]) => Number.isInteger(min) && Number.isInteger(size) && Math.abs(min) <= 2 ** 24 && Math.abs(min + size) <= 2 ** 24)
}

export class CompactFaceData {
  constructor(count, bounds) {
    this.isCompactFaceData = true; this.count = count; this.bounds = bounds; this.cursor = 0
    this.cells = new Uint32Array(count); this.templateIds = new Uint32Array(count)
    // Large sparse schematics can span more than 2^32 cells while their XZ
    // plane still fits uint. Keep that plane and Y separate only when needed.
    this.cellYs = bounds.width * bounds.height * bounds.depth > 2 ** 32 ? new Uint32Array(count) : null
    this.templates = []; this.lookup = new Map(); this.quads = new WeakMap()
    this.cellBounds = new Float64Array(Math.ceil(count / FACE_BATCH_SIZE) * 6)
    this.faceBounds = new Float32Array(this.cellBounds.length)
    for (let i = 0; i < this.cellBounds.length; i += 6) this.cellBounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i)
    this.faceBounds.set(this.cellBounds)
    this.modelMin = [Infinity, Infinity, Infinity]; this.modelMax = [-Infinity, -Infinity, -Infinity]
    this.worldBounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    this.variants = 0; this.absolute = 0
    this.offset = new Float64Array(3)
  }

  intern(values) {
    const key = values.join(',')
    let id = this.lookup.get(key)
    if (id === undefined) {
      id = this.templates.length
      if (id >= MAX_COMPACT_TEMPLATES) throw Object.assign(new Error('Too many distinct compact face templates'), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
      this.lookup.set(key, id); this.templates.push(values)
    }
    return id
  }

  forQuad(quad) {
    let record = this.quads.get(quad)
    if (record) return record
    const values = new Float32Array(32)
    const quadBounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    for (let v = 0; v < 4; v++) {
      for (let a = 0; a < 3; a++) {
        const original = quad.verts[v][a], anchor = Math.round(original)
        values[v * 8 + a] = original - anchor; values[v * 8 + 4 + a] = anchor
        quadBounds[a] = Math.min(quadBounds[a], original); quadBounds[a + 3] = Math.max(quadBounds[a + 3], original)
      }
      values[v * 8 + 3] = quad.uvs[v][0]; values[v * 8 + 7] = quad.uvs[v][1]
    }
    for (let a = 0; a < 3; a++) {
      this.modelMin[a] = Math.min(this.modelMin[a], quadBounds[a])
      this.modelMax[a] = Math.max(this.modelMax[a], quadBounds[a + 3])
    }
    const b = this.bounds, minima = [b.minX, b.minY, b.minZ], sizes = [b.width, b.height, b.depth]
    const anchored = quad.verts.every(vertex => vertex.every((value, a) => Math.abs(Math.round(value)) < 2 ** 31 - 2 ** 24))
    const precise = anchored && quad.verts.every(vertex => vertex.every((value, a) => Math.fround(value) === value
      && Math.abs(minima[a] + Math.round(value)) <= 2 ** 24 && Math.abs(minima[a] + sizes[a] + Math.round(value)) <= 2 ** 24))
    record = { values, quadBounds, id: this.intern(values), precise, anchored }; this.quads.set(quad, record)
    return record
  }

  write(quad, x, y, z, key) {
    const record = this.forQuad(quad), offset = this.offset
    offset[0] = x; offset[1] = y; offset[2] = z
    let values = record.values, changed = false, absolute = !record.anchored
    for (let v = 0; v < 4 && !absolute && !record.precise; v++) for (let a = 0; a < 3; a++) {
      const i = v * 8 + a, world = offset[a] + values[i + 4]
      const expected = Math.fround(offset[a] + quad.verts[v][a])
      const actual = Math.fround(Math.fround(world) + values[i])
      if (actual === expected) continue
      const adjusted = nextFloat(values[i], expected > actual)
      if (Math.fround(Math.fround(world) + adjusted) !== expected) { absolute = true; break }
      if (!changed) { values = values.slice(); changed = true }
      values[i] = adjusted
    }
    let id = record.id
    if (absolute) {
      values = record.values.slice()
      for (let v = 0; v < 4; v++) for (let a = 0; a < 3; a++) {
        values[v * 8 + a] = offset[a] + quad.verts[v][a]; values[v * 8 + 4 + a] = 0
      }
      id = (this.intern(values) | 0x80000000) >>> 0; this.absolute++
    } else if (changed) { id = this.intern(values); this.variants++ }
    const cursor = this.cursor++, batch = Math.floor(cursor / FACE_BATCH_SIZE) * 6
    if (this.cellYs) {
      this.cells[cursor] = key % (this.bounds.width * this.bounds.depth)
      this.cellYs[cursor] = y - this.bounds.minY
    } else this.cells[cursor] = key
    this.templateIds[cursor] = id
    for (let a = 0; a < 3; a++) {
      this.cellBounds[batch + a] = Math.min(this.cellBounds[batch + a], offset[a])
      this.cellBounds[batch + 3 + a] = Math.max(this.cellBounds[batch + 3 + a], offset[a])
      // Float32 conversion is monotonic, so local extrema give exactly the
      // legacy vertex-array bounds without visiting or expanding all vertices.
      const min = Math.fround(offset[a] + record.quadBounds[a]), max = Math.fround(offset[a] + record.quadBounds[a + 3])
      this.worldBounds[a] = Math.min(this.worldBounds[a], min)
      this.worldBounds[a + 3] = Math.max(this.worldBounds[a + 3], max)
      this.faceBounds[batch + a] = Math.min(this.faceBounds[batch + a], min)
      this.faceBounds[batch + a + 3] = Math.max(this.faceBounds[batch + a + 3], max)
    }
  }

  finish() {
    if (this.cursor !== this.count) throw new Error('Compact face count mismatch')
    this.templateCount = this.templates.length
    const texels = this.templateCount * 8
    this.textureWidth = Math.min(1024, 2 ** Math.ceil(Math.log2(Math.max(8, texels))))
    this.textureHeight = Math.ceil(texels / this.textureWidth)
    if (this.textureHeight > 2048) throw Object.assign(new Error('Too many distinct compact face templates'), { code: 'FILE_TOO_LARGE', reason: 'geometry' })
    this.templateData = new Float32Array(this.textureWidth * this.textureHeight * 4)
    this.templates.forEach((values, i) => this.templateData.set(values, i * 32))
    this.templates = this.lookup = this.quads = null
    return this
  }
}

export function compactFaceKey(data, face) {
  return data.cells[face] + (data.cellYs ? data.cellYs[face] * data.bounds.width * data.bounds.depth : 0)
}

export function readCompactFace(data, face, positions, uvs) {
  const key = compactFaceKey(data, face), b = data.bounds, raw = data.templateIds[face], id = raw & 0x7fffffff
  const offset = raw & 0x80000000 ? [0, 0, 0] : [key % b.width + b.minX,
    Math.floor(key / (b.width * b.depth)) + b.minY, Math.floor(key / b.width) % b.depth + b.minZ]
  for (let v = 0; v < 4; v++) {
    const base = id * 32 + v * 8
    for (let a = 0; a < 3; a++) positions[v * 3 + a] = Math.fround(offset[a] + data.templateData[base + 4 + a]) + data.templateData[base + a]
    uvs[v * 2] = data.templateData[base + 3]; uvs[v * 2 + 1] = data.templateData[base + 7]
  }
}
