import * as THREE from 'three'
import { FACE_BATCH_SIZE } from './compactFaceData.js'

const states = new WeakMap(), storages = new WeakMap()
const defaults = { batchFaces: 8192, minFaces: 262144, wholeRatio: .8 }

function range(start, count) {
  // Every range draws the same four template vertices. Only the instance
  // attribute offsets change. These descriptors must remain immutable: another
  // mesh sharing this geometry may be projected before this render list draws.
  return { start: 0, count: 6, materialIndex: 0, faceStart: start, faceCount: count }
}

function storageFor(mesh) {
  const geometry = mesh.geometry
  let storage = storages.get(geometry)
  if (storage) return storage
  const buffers = new Map(), views = new Map()
  for (const name of ['compactCell', 'compactTemplate', 'compactCellY']) {
    const attribute = geometry.getAttribute(name)
    if (!attribute) continue
    const buffer = new THREE.InstancedInterleavedBuffer(attribute.array, 1, 1)
    buffer.setUsage(attribute.usage)
    buffers.set(name, buffer)
  }
  storage = {
    geometry, whole: range(0, mesh.compactData.count), buffers, views,
    attributes(start) {
      let result = views.get(start)
      if (!result) {
        result = []
        for (const [name, buffer] of buffers) {
          const attribute = new THREE.InterleavedBufferAttribute(buffer, 1, start)
          attribute.gpuType = THREE.IntType
          result.push([name, attribute])
        }
        views.set(start, result)
      }
      return result
    },
  }
  storage.wholeGroups = [storage.whole]
  // Install before the first upload. All ranges share these exact data objects;
  // Three uploads each buffer once and changes only vertexAttribIPointer offsets.
  for (const [name, attribute] of storage.attributes(0)) geometry.setAttribute(name, attribute)
  storages.set(geometry, storage)
  return storage
}

function applyRange(state, group) {
  const { geometry, storage } = state
  const selected = group?.faceStart === undefined ? storage.whole : group
  for (const [name, attribute] of storage.attributes(selected.faceStart)) geometry.setAttribute(name, attribute)
  geometry.instanceCount = selected.faceCount
}

function whole(state) {
  state.geometry.groups = state.storage.wholeGroups
  state.stats.visibleFaces = state.data.count; state.stats.ranges = 1; state.stats.mode = 'whole'
}

function supportedMaterial(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material.length === 1 && mesh.material[0] : mesh.material
  // In particular, splitting a transparent DoubleSide draw would interleave
  // back/front passes. Keep every transparent material on its original path.
  return material && !material.transparent && !(material.transmission > 0)
}

function paddedWorldBox(state, min, max, target) {
  target.min.fromArray(min); target.max.fromArray(max)
  target.applyMatrix4(state.mesh.matrixWorld)
  const magnitude = Math.max(1, Math.abs(target.min.x), Math.abs(target.min.y), Math.abs(target.min.z),
    Math.abs(target.max.x), Math.abs(target.max.y), Math.abs(target.max.z))
  return target.expandByScalar(magnitude * 2 ** -22)
}

function containsBox(frustum, box) {
  if (!frustum.planes) return false // FrustumArray still supports intersectsBox.
  for (const plane of frustum.planes) {
    const n = plane.normal
    const distance = n.x * (n.x > 0 ? box.min.x : box.max.x)
      + n.y * (n.y > 0 ? box.min.y : box.max.y)
      + n.z * (n.z > 0 ? box.min.z : box.max.z) + plane.constant
    if (distance < 0) return false
  }
  return true
}

function updateWorldBoxes(state) {
  if (state.worldValid && state.worldMatrix.equals(state.mesh.matrixWorld)) return
  state.worldMatrix.copy(state.mesh.matrixWorld)
  paddedWorldBox(state, state.fullMin, state.fullMax, state.fullBox)
  for (const batch of state.batches) paddedWorldBox(state, batch.min, batch.max, batch.box)
  state.worldValid = true
}

function normalizeOptions(options) {
  const { batchFaces, minFaces, wholeRatio } = options
  if (!Number.isSafeInteger(batchFaces) || batchFaces < 1 || !Number.isSafeInteger(minFaces) || minFaces < 0
    || !Number.isFinite(wholeRatio) || wholeRatio <= 0 || wholeRatio > 1) throw new RangeError('Invalid spatial face options')
  return { batchFaces: Math.ceil(batchFaces / FACE_BATCH_SIZE) * FACE_BATCH_SIZE, minFaces, wholeRatio }
}

function configure(state, options) {
  const { data } = state, { batchFaces, minFaces } = options
  const batches = []
  if (data.count >= minFaces && data.count > batchFaces) {
    for (let start = 0; start < data.count; start += batchFaces) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
      const end = Math.min(start + batchFaces, data.count)
      for (let base = start / FACE_BATCH_SIZE; base < Math.ceil(end / FACE_BATCH_SIZE); base++) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], data.faceBounds[base * 6 + axis])
          max[axis] = Math.max(max[axis], data.faceBounds[base * 6 + axis + 3])
        }
      }
      batches.push({ start, count: end - start, min, max, box: new THREE.Box3() })
    }
  }
  state.options = options; state.batches = batches; state.worldValid = false
  state.stats.batches = batches.length
  whole(state); applyRange(state, state.storage.whole)
}

function intersects(state, frustum) {
  if (!state.enabled || !state.batches.length || !supportedMaterial(state.mesh)) {
    whole(state)
    const visible = state.originalIntersects.call(state.mesh, frustum)
    if (!visible) { state.stats.visibleFaces = state.stats.ranges = 0; state.stats.mode = 'culled' }
    return visible
  }
  if (!state.originalIntersects.call(state.mesh, frustum)) {
    state.geometry.groups = []
    state.stats.visibleFaces = state.stats.ranges = 0; state.stats.mode = 'culled'
    return false
  }
  const { data, batches } = state
  updateWorldBoxes(state)
  if (containsBox(frustum, state.fullBox)) { whole(state); return true }
  const groups = []
  let visibleFaces = 0, start = -1, count = 0
  for (const batch of batches) {
    if (frustum.intersectsBox(batch.box)) {
      visibleFaces += batch.count
      if (start < 0) start = batch.start
      count += batch.count
    } else if (start >= 0) {
      groups.push(range(start, count)); start = -1; count = 0
    }
  }
  if (start >= 0) groups.push(range(start, count))
  // Whole-scene views retain one draw. Merge adjacent visible ranges to avoid
  // one draw per small source page when only a few intervals are out of view.
  if (visibleFaces >= data.count * state.options.wholeRatio) { whole(state); return true }
  state.geometry.groups = groups
  state.stats.visibleFaces = visibleFaces; state.stats.ranges = groups.length; state.stats.mode = groups.length ? 'ranges' : 'culled'
  return groups.length > 0
}

/** Adds lossless view-frustum ranges to a newly created CompactFaceMesh. */
export function enableSpatialFaces(mesh, options = {}) {
  return install(mesh, options)
}

function install(mesh, options, force = false) {
  const existing = states.get(mesh)
  options = normalizeOptions({ ...defaults, ...existing?.options, ...options })
  if (existing) { configure(existing, options); return mesh }
  const data = mesh.compactData
  if (!data?.faceBounds || !force && (data.count < options.minFaces || data.count <= options.batchFaces || !supportedMaterial(mesh))) return mesh
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const state = {
    mesh, data, geometry: mesh.geometry, storage: storageFor(mesh), batches: [], enabled: true,
    fullBox: new THREE.Box3(), worldMatrix: new THREE.Matrix4(), worldValid: false,
    options, originalIntersects: mesh.intersectsFrustum,
    originalBefore: mesh.onBeforeRender, frustumCulled: mesh.frustumCulled,
    fullMin: data.worldBounds.subarray(0, 3), fullMax: data.worldBounds.subarray(3, 6),
    stats: { batches: 0, totalFaces: data.count, visibleFaces: data.count, ranges: 1, mode: 'whole' },
  }
  states.set(mesh, state)
  mesh.material = [material]
  mesh.spatialFaceStats = state.stats
  mesh.intersectsFrustum = frustum => intersects(state, frustum)
  mesh.onBeforeRender = function (renderer, scene, camera, geometry, drawnMaterial, group) {
    state.originalBefore.call(this, renderer, scene, camera, geometry, drawnMaterial, group)
    applyRange(state, group)
  }
  // WebGLRenderer skips intersectsFrustum altogether when this is false. Reset
  // groups on its read as well, since cloned meshes can share a geometry which
  // another camera has most recently narrowed to a different set of ranges.
  Object.defineProperty(mesh, 'frustumCulled', {
    configurable: true, enumerable: true,
    get() { if (!state.frustumCulled || !state.enabled) whole(state); return state.frustumCulled },
    set(value) { state.frustumCulled = value; if (!value) whole(state) },
  })
  configure(state, options)
  return mesh
}

/** Rebuilds only the small CPU bounds index, preserving buffers and enabled state. */
export function configureSpatialFaces(mesh, options = {}) { return install(mesh, options) }

/** Test/benchmark switch; the instance buffers and source face order stay intact. */
export function setSpatialFacesEnabled(mesh, enabled) {
  const state = states.get(mesh)
  if (state) { state.enabled = !!enabled; whole(state); applyRange(state, state.storage.whole) }
  return mesh
}

export function copySpatialFaces(target, source) {
  if (target === source) return target
  const previous = states.get(target)
  if (previous) {
    target.intersectsFrustum = previous.originalIntersects
    target.onBeforeRender = previous.originalBefore
    Object.defineProperty(target, 'frustumCulled', { configurable: true, enumerable: true, writable: true, value: previous.frustumCulled })
    states.delete(target); delete target.spatialFaceStats
  }
  const state = states.get(source)
  if (state) {
    install(target, state.options, true)
    setSpatialFacesEnabled(target, state.enabled)
  }
  return target
}
