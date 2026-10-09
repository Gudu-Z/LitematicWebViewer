// A bounded surface mesh for large schematics. The original palette and resource
// pack still determine the colours; only distant geometry is simplified.
import * as THREE from 'three'

const CHUNK = 16
const FACES = [
  { delta: [1, 0, 0], shade: 0.78, corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]] },
  { delta: [-1, 0, 0], shade: 0.78, corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]] },
  { delta: [0, 1, 0], shade: 1, corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]] },
  { delta: [0, -1, 0], shade: 0.5, corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]] },
  { delta: [0, 0, 1], shade: 0.88, corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] },
  { delta: [0, 0, -1], shade: 0.88, corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]] },
]
const delay = () => new Promise(resolve => setTimeout(resolve, 0))
const cache = new WeakMap()

function within(x, y, z, b) {
  return x >= b.minX && x < b.maxX + 1 && y >= b.minY && y < b.maxY + 1 && z >= b.minZ && z < b.maxZ + 1
}

function textureTint(texture) {
  const name = texture.replace(/^.*\//, '')
  if (name.startsWith('water_')) return 0x3f76e4
  if (name === 'spruce_leaves') return 0x619961
  if (name === 'birch_leaves') return 0x80a755
  if (/^(oak|jungle|acacia|dark_oak|mangrove)_leaves$/.test(name) || name === 'vine') return 0x48b518
  if (/^(grass_block_top|grass_block_side_overlay|short_grass|tall_grass_.*|fern|large_fern_.*|potted_fern)$/.test(name)) return 0x7cbd6b
  return 0xffffff
}

// Canvas sampling respects the selected pack, transparent pixels, and animated
// texture frames. Readbacks are cached per Texture, never per block instance.
function averageTexture(texture) {
  if (cache.has(texture)) return cache.get(texture)
  let result = null
  try {
    const source = texture.image
    let pixels
    if (source?.data && source.width && source.height) pixels = source.data
    else if (source && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context) {
        context.drawImage(source, 0, 0, source.width, Math.min(source.width, source.height), 0, 0, 16, 16)
        pixels = context.getImageData(0, 0, 16, 16).data
      }
    }
    if (pixels) {
      let r = 0, g = 0, b = 0, weight = 0
      const colour = new THREE.Color()
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255
        if (!alpha) continue
        colour.setRGB(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, THREE.SRGBColorSpace)
        r += colour.r * alpha; g += colour.g * alpha; b += colour.b * alpha; weight += alpha
      }
      if (weight) result = [r / weight, g / weight, b / weight]
    }
  } catch { /* A missing or unreadable pack texture retains the neutral fallback. */ }
  cache.set(texture, result)
  return result
}

async function paletteColours(data, assets, resolver) {
  const colours = new Float32Array((data.palette.length + 1) * 18)
  const used = [...new Set(data.overview.states)].filter(state => state > 0 && state <= data.palette.length)
  const textures = new Set()
  const textureColours = new Map()
  const loadColour = key => {
    if (!textureColours.has(key)) textureColours.set(key, (async () => {
      const texture = await assets?.getTexture(key)
      if (!texture) return null
      textures.add(key)
      const rgb = averageTexture(texture)
      if (!rgb) return null
      const tint = new THREE.Color(textureTint(key))
      return [rgb[0] * tint.r, rgb[1] * tint.g, rgb[2] * tint.b]
    })())
    return textureColours.get(key)
  }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, used.length) }, async () => {
    for (;;) {
      const state = used[cursor++]
      if (state === undefined) break
      const entry = data.palette[state - 1]
      const baked = entry.baked ?? await resolver?.resolve(entry.name, entry.properties)
      const quads = baked?.quads || []
      const fallbackKey = quads[0]?.texKey || 'block/' + entry.name.replace(/^minecraft:/, '')
      for (let face = 0; face < FACES.length; face++) {
        const direction = FACES[face].delta
        const quad = quads.find(q => q.normal && q.normal[0] * direction[0] + q.normal[1] * direction[1] + q.normal[2] * direction[2] > 0.9)
        const rgb = await loadColour(quad?.texKey || fallbackKey) || [0.38, 0.38, 0.38]
        const offset = state * 18 + face * 3
        colours.set(rgb, offset)
      }
    }
  }))
  return { colours, textures: textures.size }
}

function materialFor(data) {
  const { step, width, depth } = data.overview
  const material = new THREE.MeshBasicMaterial({ vertexColors: true })
  const uniforms = {
    overviewDetailActive: { value: false },
    overviewDetailMin: { value: new THREE.Vector3() },
    overviewDetailMax: { value: new THREE.Vector3() },
    overviewOrigin: { value: new THREE.Vector3(data.bounds.minX, data.bounds.minY, data.bounds.minZ) },
    overviewMax: { value: new THREE.Vector3(data.bounds.maxX + 1, data.bounds.maxY + 1, data.bounds.maxZ + 1) },
    overviewGrid: { value: new THREE.Vector3(width, depth, step) },
  }
  material.userData.overviewUniforms = uniforms
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = `attribute float overviewCell;\nuniform vec3 overviewOrigin;\nuniform vec3 overviewMax;\nuniform vec3 overviewGrid;\nvarying vec3 vOverviewCell;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float cx = mod(overviewCell, overviewGrid.x);
        float cz = mod(floor(overviewCell / overviewGrid.x), overviewGrid.y);
        float cy = floor(overviewCell / (overviewGrid.x * overviewGrid.y));
        vec3 cellMin = overviewOrigin + vec3(cx, cy, cz) * overviewGrid.z;
        vOverviewCell = 0.5 * (cellMin + min(cellMin + overviewGrid.z, overviewMax));`)
    shader.fragmentShader = `uniform bool overviewDetailActive;\nuniform vec3 overviewDetailMin;\nuniform vec3 overviewDetailMax;\nvarying vec3 vOverviewCell;\n${shader.fragmentShader}`
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (overviewDetailActive && all(greaterThanEqual(vOverviewCell, overviewDetailMin))
          && all(lessThan(vOverviewCell, overviewDetailMax))) discard;`)
  }
  material.customProgramCacheKey = () => 'litematica-overview-v1'
  return material
}

function filteredGrid(data, filter) {
  const { states, width, height, depth, step } = data.overview
  if (!filter) return { states, minY: data.bounds.minY, maxY: data.bounds.maxY + 1 }
  const active = new Uint32Array(states.length)
  const layer = Number(filter.layerY)
  let minY = data.bounds.minY, maxY = data.bounds.maxY + 1
  if (Number.isFinite(layer)) {
    if (filter.mode === 'single' || filter.mode === 'above') minY = Math.max(minY, layer)
    if (filter.mode === 'single' || filter.mode === 'below') maxY = Math.min(maxY, layer + 1)
  }
  const hidden = filter.hiddenRegions || []
  for (let y = 0; y < height; y++) {
    const bottom = data.bounds.minY + y * step, top = Math.min(bottom + step, data.bounds.maxY + 1)
    if (bottom >= maxY || top <= minY) continue
    const wy = (Math.max(bottom, minY) + Math.min(top, maxY)) / 2
    for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
      const index = x + z * width + y * width * depth
      if (!states[index]) continue
      const wx = Math.min(data.bounds.minX + (x + 0.5) * step, data.bounds.maxX + 0.5)
      const wz = Math.min(data.bounds.minZ + (z + 0.5) * step, data.bounds.maxZ + 0.5)
      if (typeof filter === 'function' && !filter(wx, wy, wz, wy - data.bounds.minY)) continue
      if (hidden.some(b => within(wx, wy, wz, b))) continue
      active[index] = states[index]
    }
  }
  return { states: active, minY, maxY }
}

async function buildMeshes(group, filter) {
  const internals = group.userData.overview
  const revision = ++internals.revision
  const { data, colours, material } = internals
  const { width, height, depth, step } = data.overview
  const { states, minY, maxY } = filteredGrid(data, filter)
  const stride = width * depth
  const next = [], offsets = [1, -1, stride, -stride, width, -width]
  let faces = 0
  const exposed = (index, x, y, z, face) => {
    const d = FACES[face].delta, nx = x + d[0], ny = y + d[1], nz = z + d[2]
    return nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth || !states[index + offsets[face]]
  }
  try {
    for (let y0 = 0; y0 < height; y0 += CHUNK) for (let z0 = 0; z0 < depth; z0 += CHUNK) for (let x0 = 0; x0 < width; x0 += CHUNK) {
      const x1 = Math.min(width, x0 + CHUNK), y1 = Math.min(height, y0 + CHUNK), z1 = Math.min(depth, z0 + CHUNK)
      let count = 0
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const index = x + z * width + y * stride
        if (states[index]) for (let face = 0; face < 6; face++) if (exposed(index, x, y, z, face)) count++
      }
      if (!count) continue
      const positions = new Float32Array(count * 12), rgb = new Uint8Array(count * 12), cell = new Float32Array(count * 4)
      const indices = count * 4 <= 65536 ? new Uint16Array(count * 6) : new Uint32Array(count * 6)
      let cursor = 0
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const index = x + z * width + y * stride, state = states[index]
        if (!state) continue
        const low = [data.bounds.minX + x * step, Math.max(data.bounds.minY + y * step, minY), data.bounds.minZ + z * step]
        const high = [Math.min(low[0] + step, data.bounds.maxX + 1), Math.min(data.bounds.minY + (y + 1) * step, maxY), Math.min(low[2] + step, data.bounds.maxZ + 1)]
        for (let face = 0; face < 6; face++) {
          if (!exposed(index, x, y, z, face)) continue
          const definition = FACES[face], colourOffset = state * 18 + face * 3
          for (let vertex = 0; vertex < 4; vertex++) {
            const out = cursor * 12 + vertex * 3, corner = definition.corners[vertex]
            for (let axis = 0; axis < 3; axis++) {
              positions[out + axis] = corner[axis] ? high[axis] : low[axis]
              rgb[out + axis] = Math.min(255, Math.round(colours[colourOffset + axis] * definition.shade * 255))
            }
            cell[cursor * 4 + vertex] = index
          }
          const base = cursor * 4
          indices.set([base, base + 1, base + 2, base + 2, base + 1, base + 3], cursor * 6)
          cursor++
        }
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3, true))
      geometry.setAttribute('overviewCell', new THREE.BufferAttribute(cell, 1))
      geometry.setIndex(new THREE.BufferAttribute(indices, 1))
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData.isOverview = true
      mesh.raycast = function (raycaster, hits) {
        const found = []
        THREE.Mesh.prototype.raycast.call(this, raycaster, found)
        const detail = internals.detail
        for (const hit of found) {
          const id = cell[indices[hit.faceIndex * 3]]
          const cellX = data.bounds.minX + (id % width) * step
          const cellY = data.bounds.minY + Math.floor(id / stride) * step
          const cellZ = data.bounds.minZ + (Math.floor(id / width) % depth) * step
          const wx = (cellX + Math.min(cellX + step, data.bounds.maxX + 1)) / 2
          const wy = (cellY + Math.min(cellY + step, data.bounds.maxY + 1)) / 2
          const wz = (cellZ + Math.min(cellZ + step, data.bounds.maxZ + 1)) / 2
          if (!detail || !within(wx, wy, wz, detail)) hits.push(hit)
        }
      }
      next.push(mesh)
      faces += count
      if ((next.length & 7) === 0) {
        await delay()
        if (revision !== internals.revision || internals.disposed) return
      }
    }
    if (revision !== internals.revision || internals.disposed) return
    for (const mesh of [...group.children]) { group.remove(mesh); mesh.geometry?.dispose() }
    if (next.length) group.add(...next)
    group.userData.stats.faces = faces
    next.length = 0
  } finally {
    for (const mesh of next) mesh.geometry.dispose()
  }
}

/** Build once for the complete schematic. Grid state 0 is air, n is palette[n-1]. */
export async function createOverview(data, assets, resolver) {
  const { colours, textures } = await paletteColours(data, assets, resolver)
  const group = new THREE.Group()
  group.name = 'schematic-overview'
  group.userData.isOverview = true
  group.userData.stats = { faces: 0, textures }
  group.userData.overview = { data, colours, material: materialFor(data), detail: null, revision: 0, disposed: false }
  try { await buildMeshes(group, null) } catch (error) { disposeOverview(group); throw error }
  return group
}

/** Inclusive world bounds; call only after the replacement detail is visible. */
export function setOverviewDetail(group, bounds) {
  const internal = group?.userData.overview
  if (!internal || internal.disposed) return
  internal.detail = bounds ? { ...bounds } : null
  const uniforms = internal.material.userData.overviewUniforms
  uniforms.overviewDetailActive.value = !!bounds
  if (bounds) {
    uniforms.overviewDetailMin.value.set(bounds.minX, bounds.minY, bounds.minZ)
    uniforms.overviewDetailMax.value.set(bounds.maxX + 1, bounds.maxY + 1, bounds.maxZ + 1)
  }
}

/** Filter modes all/single/below/above; hiddenRegions are inclusive world boxes. */
export async function setOverviewFilter(group, filter) {
  if (!group?.userData.overview || group.userData.overview.disposed) return
  await buildMeshes(group, filter)
}

export function disposeOverview(group) {
  const internal = group?.userData.overview
  if (!internal || internal.disposed) return
  internal.disposed = true
  internal.revision++
  for (const mesh of [...group.children]) { group.remove(mesh); mesh.geometry?.dispose() }
  internal.material.dispose()
  group.removeFromParent()
}
