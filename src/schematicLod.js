import * as THREE from 'three'

const axes = ['X', 'Y', 'Z']
const keyOf = b => axes.map(a => `${b['min' + a]}:${b['max' + a]}`).join('/')
const abortError = () => new DOMException('Superseded', 'AbortError')

export function detailWindow(data, point, side = 96) {
  const { bounds: b, overview: { step } } = data, result = {}
  for (const a of axes) {
    const lo = b['min' + a], hi = b['max' + a], cells = Math.ceil((hi - lo + 1) / step)
    const span = Math.min(cells, Math.max(1, Math.floor(side / step)))
    const start = Math.max(0, Math.min(cells - span, Math.floor((point[a.toLowerCase()] - lo) / step) - Math.floor(span / 2)))
    result['min' + a] = lo + start * step
    result['max' + a] = Math.min(hi, lo + (start + span) * step - 1)
  }
  return result
}

// Traverse the coarse occupancy grid, rather than raycasting hundreds of thousands
// of triangles every time the camera moves. The result is a world-space focus.
export function overviewFocus(data, origin, direction, filter = {}) {
  const b = data.bounds, g = data.overview
  let lowY = b.minY, highY = b.maxY + 1
  if (filter.mode === 'single') { lowY = Math.max(lowY, filter.layerY); highY = Math.min(highY, filter.layerY + 1) }
  if (filter.mode === 'below') highY = Math.min(highY, filter.layerY + 1)
  if (filter.mode === 'above') lowY = Math.max(lowY, filter.layerY)
  if (lowY >= highY) return null
  const box = new THREE.Box3(new THREE.Vector3(b.minX, lowY, b.minZ), new THREE.Vector3(b.maxX + 1, highY, b.maxZ + 1))
  const ray = new THREE.Ray(origin, direction), entry = box.containsPoint(origin) ? origin.clone() : ray.intersectBox(box, new THREE.Vector3())
  if (!entry) return null
  entry.addScaledVector(direction, .0001)
  const coord = ['x', 'y', 'z'].map((a, i) => Math.floor((entry[a] - b['min' + axes[i]]) / g.step))
  const sizes = [g.width, g.height, g.depth], signs = ['x', 'y', 'z'].map(a => Math.sign(direction[a]))
  const deltas = ['x', 'y', 'z'].map(a => direction[a] === 0 ? Infinity : Math.abs(g.step / direction[a]))
  const next = ['x', 'y', 'z'].map((a, i) => direction[a] === 0 ? Infinity : (b['min' + axes[i]] + (coord[i] + (signs[i] > 0 ? 1 : 0)) * g.step - entry[a]) / direction[a])
  let distance = 0
  for (let n = 0; n < g.width + g.height + g.depth + 3; n++) {
    if (coord.some((v, i) => v < 0 || v >= sizes[i])) return null
    const point = entry.clone().addScaledVector(direction, distance)
    if (point.y < lowY || point.y >= highY) return null
    if (g.states[coord[0] + coord[2] * g.width + coord[1] * g.width * g.depth]) {
      // Use the same clipped cell centre as the overview's region filter.
      const x = Math.min(b.minX + (coord[0] + .5) * g.step, b.maxX + .5)
      const z = Math.min(b.minZ + (coord[2] + .5) * g.step, b.maxZ + .5)
      const y = (Math.max(b.minY + coord[1] * g.step, lowY) + Math.min(b.minY + (coord[1] + 1) * g.step, highY)) / 2
      const hidden = filter.hiddenRegions?.some(r => x >= r.minX && x < r.maxX + 1 && y >= r.minY && y < r.maxY + 1 && z >= r.minZ && z < r.maxZ + 1)
      if (!hidden) return point
    }
    const crossing = Math.min(...next)
    if (!Number.isFinite(crossing)) return null
    distance = crossing + .0001
    // Crossing an edge or corner enters a diagonal cell; never visit cells
    // that the ray merely touches at the same boundary.
    for (let axis = 0; axis < 3; axis++) if (Math.abs(next[axis] - crossing) < 1e-8) {
      next[axis] += deltas[axis]; coord[axis] += signs[axis]
    }
  }
  return null
}

export class SchematicLod {
  constructor({ renderer, data, session, assets, resolver, paused, filter, options, onState }) {
    Object.assign(this, { renderer, data, session, assets, resolver, paused, filter, options, onState })
    this.epoch = 0; this.lastCheck = 0; this.activeBounds = null
    this.frame = () => this.tick()
    renderer.onLodFrame = this.frame
  }
  state(kind, count = 0) {
    const signature = kind + ':' + count
    if (signature !== this.lastState && !this.disposed) { this.lastState = signature; this.onState?.({ kind, count }) }
  }
  suspend() {
    this.epoch++; this.controller?.abort(); clearTimeout(this.timer)
    this.wanted = null; this.suspended = true
  }
  reset() {
    this.suspend(); this.activeBounds = null; this.failedKey = null
    this.renderer.clearDetail(); this.state('overview')
  }
  dispose() {
    if (this.disposed) return
    this.suspend(); this.disposed = true
    if (this.renderer.onLodFrame === this.frame) this.renderer.onLodFrame = null
  }
  tick() {
    if (this.disposed) return
    if (this.paused?.()) { if (!this.suspended) this.suspend(); return }
    this.suspended = false
    const now = performance.now()
    if (now - this.lastCheck < 180) return
    this.lastCheck = now
    const { renderer: r, data } = this, camera = r.camera
    const direction = camera.getWorldDirection(new THREE.Vector3())
    const focus = overviewFocus(data, camera.position, direction, this.filter?.())
    const extent = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : Infinity
    const near = focus && (camera.position.distanceTo(focus) < 180 || extent < 200)
    if (!near) {
      if (this.wanted) this.suspend()
      if (this.activeBounds && (!focus || (camera.position.distanceTo(focus) > 300 && extent > 280))) {
        r.clearDetail(); this.activeBounds = null; this.state('overview')
      }
      this.state(this.activeBounds ? 'detail' : 'overview', r.detailData?.blocks.size || 0)
      return
    }
    const margin = data.overview.step * 1.5
    if (this.activeBounds && axes.every(a => {
      const v = focus[a.toLowerCase()], b = this.activeBounds
      return v >= b['min' + a] + (b['min' + a] > data.bounds['min' + a] ? margin : 0)
        && v <= b['max' + a] + 1 - (b['max' + a] < data.bounds['max' + a] ? margin : 0)
    })) {
      if (this.wanted) { this.epoch++; this.controller?.abort(); clearTimeout(this.timer); this.wanted = null }
      this.state('detail', r.detailData?.blocks.size || 0)
      return
    }
    const selection = detailWindow(data, focus), key = keyOf(selection)
    if (key === this.wanted?.key || key === this.failedKey) return
    this.epoch++; this.controller?.abort(); clearTimeout(this.timer)
    this.wanted = { key, focus, selection }
    this.schedule()
  }
  schedule() {
    if (this.running || !this.wanted || this.disposed || this.paused?.()) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.load(), 450)
  }
  async load() {
    if (!this.wanted || this.running || this.disposed || this.paused?.()) return
    const wanted = this.wanted, epoch = this.epoch, controller = new AbortController()
    this.controller = controller; this.running = true
    const current = () => !this.disposed && !this.paused?.() && this.epoch === epoch && !controller.signal.aborted
    this.state('loading')
    try {
      for (const side of [96, 64, 32]) {
        let stage
        try {
          const selection = detailWindow(this.data, wanted.focus, side)
          const data = await this.session.loadDetail(selection, { signal: controller.signal })
          if (!current()) throw abortError()
          // Limit asynchronous resource resolution too; a rapid camera move does
          // not enqueue thousands of model requests for a discarded window.
          const used = [...new Set(data.blocks.values())].map(i => data.palette[i])
          let next = 0
          await Promise.all(Array.from({ length: Math.min(8, used.length) }, async () => {
            while (next < used.length) {
              if (!current()) throw abortError()
              const p = used[next++]; p.baked = await this.resolver.resolve(p.name, p.properties)
            }
          }))
          if (!current()) throw abortError()
          stage = await this.renderer.prepareDetail(data, this.assets, { ...this.options?.(), isCurrent: current })
          if (!current()) throw abortError()
          this.renderer.installDetail(stage, data); stage = null
          this.activeBounds = data.bounds; this.wanted = null; this.failedKey = null
          this.state('detail', data.blocks.size)
          return
        } catch (error) {
          if (stage) this.renderer.disposeDetail(stage)
          if (error.name === 'AbortError' || !current()) throw abortError()
          if (!['windowTooLarge', 'windowTooComplex'].includes(error.code)) throw error
          if (side === 32) throw error
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError' && current()) {
        this.failedKey = wanted.key; this.wanted = null; this.state('limited')
        if (!['windowTooLarge', 'windowTooComplex'].includes(error.code)) console.warn('Detail loading failed', error)
      }
    } finally {
      this.running = false
      if (current() && this.wanted?.key === wanted.key) this.wanted = null
      this.schedule()
    }
  }
}
