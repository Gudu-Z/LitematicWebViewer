import assert from 'node:assert/strict'
import * as THREE from 'three'
import { GPUUpload } from '../src/gpuUpload.js'
import { WebGLAttributes } from '../node_modules/three/src/renderers/webgl/WebGLAttributes.js'
import { WebGLGeometries } from '../node_modules/three/src/renderers/webgl/WebGLGeometries.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async test => { for (let n = 0; n < 100; n++) { if (test()) return; await tick() }; assert.fail('GPU preparation did not settle') }
function context() {
  const buffers = new Set(), bound = new Map(), bytesByFrame = new Map()
  let frame = 0, lost = false, failure = 0, copyFailure = 0, calls = 0, draws = 0, allocations = 0, errorsRead = 0, vao = null
  const gl = { ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, COPY_WRITE_BUFFER: 36663, STATIC_DRAW: 35044,
    FLOAT: 5126, HALF_FLOAT: 5131, UNSIGNED_INT: 5125, INT: 5124, UNSIGNED_SHORT: 5123, SHORT: 5122, UNSIGNED_BYTE: 5121, BYTE: 5120,
    ALREADY_SIGNALED: 37146, CONDITION_SATISFIED: 37148, WAIT_FAILED: 37149, SYNC_GPU_COMMANDS_COMPLETE: 37143, CONTEXT_LOST_WEBGL: 37442,
    createBuffer: () => { const buffer = { bytes: null }; buffers.add(buffer); allocations++; return buffer },
    bindBuffer: (target, buffer) => {
      if (buffer) { buffer.kind ??= target === gl.ELEMENT_ARRAY_BUFFER ? 'index' : 'vertex'; if (target === gl.ELEMENT_ARRAY_BUFFER) assert.equal(buffer.kind, 'index') }
      bound.set(target, buffer)
    },
    VERTEX_ARRAY_BINDING: 34229, getParameter: () => vao, createVertexArray: () => ({}), bindVertexArray: value => { vao = value }, deleteVertexArray() {},
    bufferData: (target, data) => { bound.get(target).bytes = typeof data === 'number' ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() },
    bufferSubData: (target, offset, array, start = 0, count = array.length - start) => {
      assert.ok(buffers.has(bound.get(target)), 'Write only a live VBO')
      const bytes = new Uint8Array(array.buffer, array.byteOffset + start * array.BYTES_PER_ELEMENT, count * array.BYTES_PER_ELEMENT)
      bound.get(target).bytes.set(bytes, offset); calls++
      bytesByFrame.set(frame, (bytesByFrame.get(frame) || 0) + bytes.byteLength)
      if (copyFailure) { failure = copyFailure; copyFailure = 0 }
    },
    deleteBuffer: buffer => buffers.delete(buffer), isBuffer: buffer => buffers.has(buffer),
    getError: () => { errorsRead++; const result = failure; failure = 0; return result }, isContextLost: () => lost,
    fenceSync: () => ({}), clientWaitSync: () => gl.ALREADY_SIGNALED, deleteSync() {}, flush() {},
  }
  const canvas = new EventTarget(), info = { memory: { geometries: 0 } }
  let attributes, geometries
  const reset = () => { attributes = WebGLAttributes(gl); geometries = WebGLGeometries(gl, attributes, info, { releaseStatesOfGeometry() {} }) }
  reset(); canvas.addEventListener('webglcontextrestored', reset)
  const renderer = { domElement: canvas, getContext: () => gl, render(root) {
    draws++
    root.traverse(object => {
      if (!object.geometry) return
      geometries.get(object, object.geometry); geometries.update(object.geometry)
      if (object.geometry.index) attributes.update(object.geometry.index, gl.ELEMENT_ARRAY_BUFFER)
    })
  } }
  return { gl, renderer, buffers, bytesByFrame, get calls() { return calls }, get draws() { return draws }, get allocations() { return allocations }, get errorsRead() { return errorsRead },
    yieldFrame: async () => { frame++ }, gpu: attribute => attributes.get(attribute),
    lose: (dispatch = true) => { lost = true; buffers.clear(); if (dispatch) canvas.dispatchEvent(new Event('webglcontextlost')) },
    lostEvent: () => canvas.dispatchEvent(new Event('webglcontextlost')),
    restore: () => { lost = false; canvas.dispatchEvent(new Event('webglcontextrestored')) }, fail: () => { failure = 1285 },
    failCopy: () => { copyFailure = 1285 },
  }
}
const mesh = () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0), 3))
  geometry.setIndex(new THREE.BufferAttribute(Uint16Array.of(0, 1, 2), 1))
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

const first = context(), ready = [], pending = []
const upload = new GPUUpload(first.renderer, { frameBytes: 64, frameMilliseconds: Infinity, yieldFrame: first.yieldFrame,
  onReady: () => ready.push(true), onPending: () => pending.push(true) })
const array = Uint32Array.from({ length: 100 }, (_, i) => i)
for (let offset = 0; offset < array.length; offset += 5) await upload.uploadRange(array, offset, 5)
assert.ok([...first.bytesByFrame.values()].every(bytes => bytes <= 64), 'Budget spans many small uploadRange calls')
assert.equal(first.allocations, 1)
assert.deepEqual(upload.records.get(array).buffer.bytes, new Uint8Array(array.buffer))
assert.equal(ready.length, 0, 'Streaming fields do not trigger an onReady callback per field')
upload.releaseUnused(); assert.equal(first.buffers.size, 0)

const object = mesh(), geometry = object.geometry, originalArray = geometry.attributes.position.array
await upload.prepareObject(object)
assert.equal(geometry.attributes.position.array, originalArray)
assert.equal(geometry.attributes.position.isGLBufferAttribute, false, 'CPU operations use normal attributes')
const expectedBox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position)
assert.deepEqual(geometry.boundingBox, expectedBox)
const beforeRenderCalls = first.calls
first.renderer.render(object)
assert.equal(first.calls, beforeRenderCalls, 'First complete draw reuses the pre-uploaded GPU buffers')
assert.equal(first.gpu(geometry.attributes.position).buffer, upload.records.get(originalArray).buffer)
assert.equal(first.gpu(geometry.index).type, first.gl.UNSIGNED_SHORT)
const cloned = geometry.clone()
assert.notEqual(cloned.attributes.position.array, originalArray)
assert.equal(!!cloned.attributes.position.isGLBufferAttribute, false)
assert.deepEqual(cloned.attributes.position.array, originalArray)
const exported = context()
exported.renderer.render(object)
assert.notEqual(exported.gpu(geometry.attributes.position).buffer, first.gpu(geometry.attributes.position).buffer)
assert.deepEqual(exported.gpu(geometry.attributes.position).buffer.bytes, first.gpu(geometry.attributes.position).buffer.bytes)

geometry.attributes.position.setX(0, -.5); geometry.attributes.position.needsUpdate = true
assert.equal(upload.pending, true)
const draws = first.draws
first.renderer.render(object); assert.equal(first.draws, draws, 'Dirty data pauses the complete draw')
await until(() => !upload.pending)
first.renderer.render(object)
assert.equal(new Float32Array(first.gpu(geometry.attributes.position).buffer.bytes.buffer)[0], -.5)
assert.equal(pending.length, 1); assert.equal(ready.length, 1)

first.lose(false)
const restoring = upload.uploadRange(originalArray, 0, 1)
await tick(); assert.equal(upload.pending, true)
first.lostEvent(); first.restore()
await restoring; await until(() => !upload.pending)
first.renderer.render(object)
assert.ok(first.gl.isBuffer(first.gpu(geometry.attributes.position).buffer))
assert.deepEqual(first.gpu(geometry.attributes.position).buffer.bytes, new Uint8Array(originalArray.buffer))
assert.equal(geometry.attributes.position.array, originalArray)

// Spatial ranges share one underlying interleaved GPU store and retain CPU access.
const instanced = new THREE.InstancedInterleavedBuffer(Uint32Array.of(2, 4, 6, 8), 1, 1)
const spatial = mesh()
spatial.geometry.setAttribute('compactCell', new THREE.InterleavedBufferAttribute(instanced, 1, 0))
await upload.prepareObject(spatial)
first.renderer.render(spatial)
const initial = first.gpu(spatial.geometry.attributes.compactCell).buffer
spatial.geometry.setAttribute('compactCell', new THREE.InterleavedBufferAttribute(instanced, 1, 2))
first.renderer.render(spatial)
assert.equal(first.gpu(spatial.geometry.attributes.compactCell).buffer, initial)
assert.equal(spatial.geometry.attributes.compactCell.getX(0), 6)

// Dynamic translucent indices remain on Three's normal update path.
const translucent = mesh(); translucent.material.translucentMaps = []
await upload.prepareObject(translucent)
assert.equal(upload.records.has(translucent.geometry.index.array), false)
first.renderer.render(translucent)
translucent.geometry.index.array.reverse(); translucent.geometry.index.needsUpdate = true
assert.equal(upload.pending, false)
first.renderer.render(translucent)
assert.deepEqual(first.gpu(translucent.geometry.index).buffer.bytes, new Uint8Array(translucent.geometry.index.array.buffer))

// Cancelling an unattached layout frees every staged array for that load.
const controller = new AbortController(), gate = deferred(), spare = new Uint32Array(64)
const previousYield = upload.yieldFrame
upload.yieldFrame = () => gate.promise
const cancelled = upload.uploadRange(spare, 0, spare.length, { signal: controller.signal })
await tick(); controller.abort()
await assert.rejects(cancelled, { name: 'AbortError' })
assert.equal(upload.records.has(spare), false)
upload.yieldFrame = previousYield; gate.resolve()

// Abort can run in the microtask between a context check and GPU allocation.
const microAbort = new AbortController(), microArray = new Float32Array(4)
const originalContext = upload._context.bind(upload)
upload._context = async (...args) => { await originalContext(...args); if (upload.records.has(microArray)) queueMicrotask(() => microAbort.abort()) }
const bufferCount = first.buffers.size
await assert.rejects(upload.uploadRange(microArray, 0, microArray.length, { signal: microAbort.signal }), { name: 'AbortError' })
assert.equal(first.buffers.size, bufferCount, 'Microtask cancellation must not allocate an unreachable VBO')
upload._context = originalContext

// Context loss during async bounds happens before a geometry has any owners.
const second = context(), boundGate = deferred()
const boundsUpload = new GPUUpload(second.renderer, { yieldFrame: second.yieldFrame })
const big = mesh(); big.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(262144 * 3), 3))
await boundsUpload.uploadRange(big.geometry.attributes.position.array, 0, big.geometry.attributes.position.array.length)
await boundsUpload.uploadRange(big.geometry.index.array, 0, big.geometry.index.array.length, { index: true })
await boundsUpload._validate()
let clock = 0
boundsUpload.now = () => { clock += 9; return clock }
let entered = false
boundsUpload.yieldFrame = async () => { if (!entered) { entered = true; await boundGate.promise }; await second.yieldFrame() }
const preparing = boundsUpload.prepareObject(big)
await until(() => entered)
second.lose(); second.restore(); boundGate.resolve()
await preparing; await until(() => !boundsUpload.pending)
second.renderer.render(big)
assert.ok(second.gl.isBuffer(second.gpu(big.geometry.attributes.position).buffer))

// Fast scans do not wait for a frame merely because their vertex count is high.
const timing = context(); let boundsYields = 0
const timedUpload = new GPUUpload(timing.renderer, { now: () => 0, yieldFrame: async () => { boundsYields++ } })
const precise = new THREE.BufferGeometry(), coordinates = new Float32Array(3 * 1048576)
for (let i = 0; i < coordinates.length; i++) coordinates[i] = ((i * 17) % 99991 - 50000) / 7
precise.setAttribute('position', new THREE.BufferAttribute(coordinates, 3))
const expected = precise.clone(); expected.computeBoundingBox(); expected.computeBoundingSphere()
await timedUpload._bounds(precise)
assert.equal(boundsYields, 0, 'A fixed vertex quota never forces a RAF')
assert.deepEqual(precise.boundingBox, expected.boundingBox)
assert.deepEqual(precise.boundingSphere, expected.boundingSphere, 'Time slicing preserves Three bounds exactly')
const boundsAbort = new AbortController()
clock = 0; timedUpload.now = () => { clock += 9; return clock }
timedUpload.yieldFrame = async () => { boundsYields++; boundsAbort.abort() }
precise.boundingBox = null; precise.boundingSphere = null
await assert.rejects(timedUpload._bounds(precise, boundsAbort.signal), { name: 'AbortError' })
assert.equal(boundsYields, 1, 'An exhausted CPU budget still yields and honors cancellation')
timedUpload.dispose(); precise.dispose(); expected.dispose()

// The default scheduler yields a task, works without RAF, and cancels promptly.
const tasks = context(), taskUpload = new GPUUpload(tasks.renderer, { frameBytes: 64, frameMilliseconds: Infinity })
const taskAbort = new AbortController(), taskArray = new Uint8Array(1024 * 1024)
let timerRan = false
setTimeout(() => { timerRan = true; taskAbort.abort() }, 0)
await assert.rejects(taskUpload.uploadRange(taskArray, 0, taskArray.length, { signal: taskAbort.signal }), { name: 'AbortError' })
assert.equal(timerRan, true, 'Upload must yield to actual event-loop tasks')
assert.equal(taskUpload.records.size, 0)
assert.equal(tasks.buffers.size, 0)
taskUpload.dispose()

const queries = context(), batched = new GPUUpload(queries.renderer, { frameMilliseconds: Infinity, yieldFrame: queries.yieldFrame })
for (let i = 0; i < 32; i++) await batched.uploadRange(new Float32Array(12), 0, 12)
assert.equal(queries.errorsRead, 0, 'Small VBOs do not synchronously query the GPU one by one')
await batched.prepareObject(new THREE.Group())
assert.equal(queries.errorsRead, 1, 'Final preparation validates the whole completed batch')
batched.releaseUnused(); assert.equal(queries.buffers.size, 0); batched.dispose()

// Deferred allocation validation still rejects before any failed geometry is
// attached, and releasing unused records cleans every buffer from that load.
const allocation = context(), allocationUpload = new GPUUpload(allocation.renderer, { yieldFrame: allocation.yieldFrame })
allocation.fail()
await assert.rejects(allocationUpload.prepareObject(mesh()), /GPU buffer allocation failed/)
assert.equal(allocationUpload.geometries.size, 0)
allocationUpload.releaseUnused(); assert.equal(allocation.buffers.size, 0)
const recovered = mesh(); await allocationUpload.prepareObject(recovered)
allocation.renderer.render(recovered)
recovered.geometry.dispose(); allocationUpload.dispose()

// Errors from copies into an already allocated/validated VBO must also be
// checked. No new bufferData call can incidentally mark these tests pending.
const copy = context(), copyUpload = new GPUUpload(copy.renderer, { yieldFrame: copy.yieldFrame })
const copyArray = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0)
await copyUpload.uploadRange(copyArray, 0, copyArray.length); await copyUpload._validate()
const allocatedBeforeCopy = copy.allocations
copy.failCopy(); await copyUpload.uploadRange(copyArray, 0, copyArray.length)
const copyGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(copyArray, 3))
await assert.rejects(copyUpload.prepareObject(new THREE.Mesh(copyGeometry, new THREE.MeshBasicMaterial())), /GPU buffer allocation failed/)
assert.equal(copy.allocations, allocatedBeforeCopy, 'Prepare failure must come from copy-only GL work')
assert.equal(copyUpload.geometries.size, 0, 'A failed copy is never attached for drawing')
copyUpload.releaseUnused(); assert.equal(copy.buffers.size, 0)

const copiedObject = mesh(); await copyUpload.prepareObject(copiedObject); copy.renderer.render(copiedObject)
const copyDraws = copy.draws, automaticAllocations = copy.allocations
copy.failCopy(); copiedObject.geometry.attributes.position.array[0] = -.5
copiedObject.geometry.attributes.position.needsUpdate = true
await until(() => copyUpload._failed)
assert.equal(copy.allocations, automaticAllocations, 'Automatic failure must also be copy-only')
assert.equal(copyUpload.pending, true)
copy.renderer.render(copiedObject); assert.equal(copy.draws, copyDraws, 'Failed automatic copies never resume complete-scene drawing')
copiedObject.geometry.dispose(); copyUpload.dispose(); copyGeometry.dispose()

// A failed restore never resumes drawing a partially populated GPU scene.
first.lose(); first.fail(); first.restore()
await until(() => upload._failed)
assert.equal(upload.pending, true)
const failedDraws = first.draws; first.renderer.render(object); assert.equal(first.draws, failedDraws)

geometry.dispose(); spatial.geometry.dispose(); translucent.geometry.dispose()
upload.clear(); assert.equal(first.buffers.size, 0)
assert.equal(geometry.attributes.position.isGLBufferAttribute, undefined)
upload.dispose(); big.geometry.dispose(); boundsUpload.dispose(); cloned.dispose()
console.log('PASS GPU staging budget, CPU identity, Three cache/index types, second context, clones, dirty versions, spatial views, cancellation, restore races and failed-restore draw blocking')
