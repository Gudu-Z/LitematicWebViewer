import * as THREE from 'three'
import { GPUUpload } from '../src/gpuUpload.js'
import { CompactFaceData } from '../src/compactFaceData.js'
import { CompactFaceMesh } from '../src/compactFaceMesh.js'
import { enableSpatialFaces } from '../src/spatialFaces.js'

const assert = (test, label) => { if (!test) throw Error(label) }
const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
const until = async test => { for (let i = 0; i < 500; i++) { if (test()) return; await frame() }; throw Error('GPU test timeout') }
const pixels = (renderer, scene, camera) => {
  renderer.render(scene, camera)
  const gl = renderer.getContext(), bytes = new Uint8Array(96 * 96 * 4)
  gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
  assert(gl.getError() === gl.NO_ERROR, 'No GL error after complete render')
  return bytes
}
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])

window.__gpuUploadResult = (async () => {
  const createRenderer = () => { const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true }); renderer.setSize(96, 96); document.body.append(renderer.domElement); return renderer }
  const renderer = createRenderer(), exported = createRenderer(), gl = renderer.getContext()
  renderer.resetState()
  const probe = gl.createBuffer()
  gl.bindBuffer(gl.COPY_WRITE_BUFFER, probe); gl.bufferData(gl.COPY_WRITE_BUFFER, 128, gl.STATIC_DRAW)
  gl.bufferSubData(gl.COPY_WRITE_BUFFER, 0, new Uint16Array([0, 1, 2]))
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, probe)
  assert(gl.getError() === gl.INVALID_OPERATION, 'COPY_WRITE first binding cannot be used for indices; the uploader must label element buffers separately')
  gl.deleteBuffer(probe); renderer.resetState()

  let frameId = 0, abortOnFrame = null, ready = 0
  const frameBytes = new Map(), allocationSizes = [], originalSub = gl.bufferSubData.bind(gl), originalData = gl.bufferData.bind(gl)
  gl.bufferSubData = (target, offset, data, start = 0, count = data.length - start) => {
    frameBytes.set(frameId, (frameBytes.get(frameId) || 0) + count * data.BYTES_PER_ELEMENT)
    return originalSub(target, offset, data, start, count)
  }
  gl.bufferData = (target, data, usage) => { allocationSizes.push(typeof data === 'number' ? data : -data.byteLength); return originalData(target, data, usage) }
  const uploader = new GPUUpload(renderer, { onReady: () => ready++, onError: error => { throw error } })
  const yieldTask = uploader.yieldFrame
  uploader.yieldFrame = async () => { await yieldTask(); frameId++; const abort = abortOnFrame; abortOnFrame = null; abort?.() }
  const positions = new Float32Array(3 * 1024 * 1024)
  positions.set([-1, -1, 0, 1, -1, 0, 0, 1, 0])
  for (let offset = 0; offset < positions.length; offset += 65536) await uploader.uploadRange(positions, offset, Math.min(65536, positions.length - offset))
  assert([...frameBytes.values()].every(bytes => bytes <= 8 * 1024 ** 2), 'Across small streaming fields, at most 8 MiB uploads before yielding')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setIndex([0, 1, 2])
  const object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x83baff }))
  const scene = new THREE.Scene(); scene.add(object)
  const camera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, .1, 20); camera.position.z = 5
  await uploader.prepareObject(object)
  const beforeDraw = allocationSizes.length
  const staged = pixels(renderer, scene, camera), normal = pixels(exported, scene, camera)
  assert(equal(staged, normal), 'Staged upload and a second renderer sharing the CPU geometry have identical pixels')
  assert(staged.some((value, i) => i % 4 !== 3 && value > 0), 'Comparison contains a visible triangle')
  assert(allocationSizes.slice(beforeDraw).every(bytes => bytes > -1024), 'First draw does not upload the large CPU array again')
  assert(geometry.attributes.position.array === positions, 'Retain the exact CPU array')
  const cloned = geometry.clone()
  assert(!cloned.attributes.position.isGLBufferAttribute && cloned.attributes.position.array[0] === -1, 'Geometry clones remain ordinary CPU-backed attributes')
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1))
  assert(ray.intersectObject(object).length > 0, 'Exact CPU picking remains available')
  positions[0] = -.3; geometry.attributes.position.needsUpdate = true
  assert(uploader.pending, 'Dirty version pauses the complete scene')
  await until(() => !uploader.pending)
  assert(equal(pixels(renderer, scene, camera), pixels(exported, scene, camera)), 'Dirty CPU versions update the native VBO without switching to a broken normal cache')

  const data = new CompactFaceData(8193, { minX: 0, minY: 0, minZ: 0, width: 128, height: 1, depth: 128 })
  const quad = { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[0, 0], [1, 0], [0, 1], [1, 1]] }
  for (let i = 0; i < data.count; i++) data.write(quad, i % 128, 0, Math.floor(i / 128), i)
  data.finish()
  const compact = enableSpatialFaces(new CompactFaceMesh(data, new THREE.MeshBasicMaterial({ color: 0xffab65 })), { minFaces: 1, batchFaces: 4096 })
  const compactScene = new THREE.Scene(); compactScene.add(compact)
  const view = new THREE.OrthographicCamera(-90, 90, 90, -90, .1, 500); view.position.set(64, 80, 180); view.lookAt(64, 0, 32)
  await uploader.prepareObject(compact)
  for (const zoom of [1, 8, .8]) {
    view.zoom = zoom; view.updateProjectionMatrix()
    const actual = pixels(renderer, compactScene, view), expected = pixels(exported, compactScene, view)
    assert(actual.some((value, i) => i % 4 !== 3 && value > 0), 'Compact comparison contains visible faces')
    assert(equal(actual, expected), 'Compact/spatial integer attributes preserve pixels at zoom ' + zoom)
  }

  const lost = new Promise(resolve => renderer.domElement.addEventListener('webglcontextlost', resolve, { once: true }))
  const restored = new Promise(resolve => renderer.domElement.addEventListener('webglcontextrestored', resolve, { once: true }))
  renderer.forceContextLoss(); await lost
  assert(uploader.pending, 'Context loss blocks complete scene draws')
  setTimeout(() => renderer.forceContextRestore(), 100)
  await restored; await until(() => !uploader.pending)
  assert(equal(pixels(renderer, scene, camera), pixels(exported, scene, camera)), 'Context restoration reconstructs ordinary buffers from retained CPU arrays')
  assert(equal(pixels(renderer, compactScene, view), pixels(exported, compactScene, view)), 'Context restoration reconstructs shared spatial buffers')

  const controller = new AbortController(), cancelledArray = new Float32Array(3 * 1024 * 1024)
  abortOnFrame = () => controller.abort()
  let cancelled = false
  try { await uploader.uploadRange(cancelledArray, 0, cancelledArray.length, { signal: controller.signal }) } catch (error) { cancelled = error.name === 'AbortError' }
  assert(cancelled && !uploader.records.has(cancelledArray), 'Cancellation frees an unfinished VBO')
  assert(equal(pixels(renderer, scene, camera), pixels(exported, scene, camera)), 'Cancelling another layout leaves the complete scene intact')
  const stray = new Uint32Array(256); await uploader.uploadRange(stray, 0, stray.length)
  const strayBuffer = uploader.records.get(stray).buffer
  uploader.releaseUnused(); assert(!gl.isBuffer(strayBuffer), 'Unused layout buffers are released')
  const retained = uploader.records.get(positions).buffer
  geometry.dispose(); assert(!gl.isBuffer(retained), 'Geometry disposal releases its pre-uploaded buffer')
  compact.geometry.dispose(); uploader.clear(); uploader.dispose(); cloned.dispose()
  object.material.dispose(); compact.material[0].dispose(); renderer.dispose(); exported.dispose()
  return { pass: true, copyTargetIndex: true, exactPixels: true, compactSpatial: true, contextRestore: true, cpuPickingAndClone: true,
    maxUploadBytesPerYield: Math.max(...frameBytes.values()), readyNotifications: ready }
})()

window.runGPUUploadScheduling = async () => {
  const results = []
  for (const mode of ['raf-per-buffer', 'task-per-buffer', 'task-batch']) {
    const renderer = new THREE.WebGLRenderer({ antialias: false }), gl = renderer.getContext()
    document.body.append(renderer.domElement)
    let queries = 0, queryMs = 0, ticks = 0, stopped = false, previous = performance.now(), maxGap = 0
    const heartbeat = time => { ticks++; maxGap = Math.max(maxGap, time - previous); previous = time; if (!stopped) requestAnimationFrame(heartbeat) }
    requestAnimationFrame(heartbeat)
    const nativeError = gl.getError.bind(gl)
    gl.getError = () => { const began = performance.now(), result = nativeError(); queryMs += performance.now() - began; queries++; return result }
    const uploader = new GPUUpload(renderer, { yieldFrame: mode.startsWith('raf') ? frame : undefined })
    if (mode.endsWith('per-buffer')) {
      const allocate = uploader._allocate.bind(uploader)
      uploader._allocate = async (...args) => { await allocate(...args); assert(gl.getError() === 0, 'Legacy per-buffer query succeeds') }
    }
    const large = new Float32Array(16 * 1024 * 1024), start = performance.now()
    await uploader.uploadRange(large, 0, large.length); await uploader._validate()
    const bulkMs = performance.now() - start
    uploader.releaseUnused()
    const smallStart = performance.now()
    for (let i = 0; i < 2000; i++) {
      const array = new Float32Array(12)
      await uploader.uploadRange(array, 0, array.length)
    }
    await uploader._validate()
    const smallMs = performance.now() - smallStart
    assert(ticks > 0, 'Upload gives display-frame callbacks execution opportunities')
    results.push({ mode, bulkMiB: 64, bulkMs: +bulkMs.toFixed(1), smallBuffers: 2000, smallMs: +smallMs.toFixed(1),
      errorQueries: queries, errorQueryMs: +queryMs.toFixed(1), heartbeatTicks: ticks, maxHeartbeatGapMs: +maxGap.toFixed(1) })
    if (mode === 'task-batch') {
      // A background tab may stop RAF completely. Scheduling the upload must
      // neither invoke nor depend on it; timer-based cancellation still runs.
      stopped = true
      const savedRAF = window.requestAnimationFrame
      let rafCalls = 0
      window.requestAnimationFrame = () => { rafCalls++; return 0 }
      try {
        const background = new Float32Array(6 * 1024 * 1024)
        await uploader.uploadRange(background, 0, background.length); await uploader._validate()
        assert(rafCalls === 0, 'Background upload continues with display-frame callbacks suspended')
        const controller = new AbortController(), cancelled = new Float32Array(16 * 1024 * 1024)
        let timerRan = false, aborted = false
        setTimeout(() => { timerRan = true; controller.abort() }, 0)
        try { await uploader.uploadRange(cancelled, 0, cancelled.length, { signal: controller.signal }) } catch (error) { aborted = error.name === 'AbortError' }
        assert(timerRan && aborted, 'Input/timer tasks can cancel uploads while RAF is suspended')
      } finally { window.requestAnimationFrame = savedRAF }
    }
    stopped = true; uploader.releaseUnused(); uploader.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
  }
  return results
}
