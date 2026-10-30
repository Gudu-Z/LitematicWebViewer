import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GPUUpload } from '../src/gpuUpload.js'

// CPU-only comparison of the previous fixed-vertex RAF policy with the actual
// work-time budget. A 16 ms wait models a 60 Hz frame; this is not a GPU test.
async function previous(geometry, yieldFrame) {
  const position = geometry.attributes.position, box = new THREE.Box3(), point = new THREE.Vector3(), center = new THREE.Vector3()
  let sinceYield = 0
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i); box.expandByPoint(point)
    if ((++sinceYield & 262143) === 0) await yieldFrame()
  }
  box.getCenter(center)
  let radiusSq = 0
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i); radiusSq = Math.max(radiusSq, center.distanceToSquared(point))
    if ((++sinceYield & 262143) === 0) await yieldFrame()
  }
  geometry.boundingBox = box; geometry.boundingSphere = new THREE.Sphere(center, Math.sqrt(radiusSq))
}
const array = new Float32Array(3 * 4 * 1024 * 1024)
for (let i = 0; i < array.length; i++) array[i] = ((i * 17) % 99991 - 50000) / 7
const geometry = () => new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(array, 3))
const canvas = new EventTarget(), renderer = { domElement: canvas, getContext: () => ({ isContextLost: () => false }), render() {} }
const upload = new GPUUpload(renderer)
// Warm both loops before measuring so interpreter/JIT startup is not the result.
await previous(geometry(), async () => {})
upload.yieldFrame = async () => {}; await upload._bounds(geometry()); upload._boundsCPU = 0
const results = [], outputs = []
for (const name of ['fixedVertexRAF', 'cpuBudgetRAF']) {
  const item = geometry(); let yields = 0, waited = 0
  const yieldFrame = async () => { yields++; const start = performance.now(); await delay(16); waited += performance.now() - start }
  upload.yieldFrame = yieldFrame
  const start = performance.now()
  if (name === 'fixedVertexRAF') await previous(item, yieldFrame)
  else await upload._bounds(item)
  const elapsed = performance.now() - start
  results.push({ name, vertices: array.length / 3, positionMiB: array.byteLength / 1024 ** 2,
    elapsedMs: Number(elapsed.toFixed(1)), frameWaitMs: Number(waited.toFixed(1)), cpuMs: Number((elapsed - waited).toFixed(1)), yields })
  outputs.push(item)
}
assert.deepEqual(outputs[0].boundingBox, outputs[1].boundingBox)
assert.deepEqual(outputs[0].boundingSphere, outputs[1].boundingSphere)
upload.dispose()
await mkdir('scripts/_ref', { recursive: true })
await writeFile('scripts/_ref/gpu-bounds-benchmark.json', JSON.stringify({ exactBounds: true, results }, null, 2) + '\n')
console.log(JSON.stringify({ exactBounds: true, results }))
