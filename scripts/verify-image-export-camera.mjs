import assert from 'node:assert/strict'
import * as THREE from 'three'
import { exportFilename, fitImageCamera, validImageSize, viewDirection } from '../src/imageExportCamera.js'

let cases = 0
for (const perspective of [false, true]) for (const aspect of [1, 16 / 9, 9 / 16, 8, 1 / 8]) {
  for (const size of [[6, 4, 6], [500, 2, 1], [1, 200, 1], [2, 2, 400]]) for (const [yaw, pitch] of [[45, 35.2643897], [0, 0], [90, 0], [0, 90], [225, -60]]) {
    const box = new THREE.Box3(new THREE.Vector3(-32, 11, 7), new THREE.Vector3(-32 + size[0], 11 + size[1], 7 + size[2]))
    const camera = perspective ? new THREE.PerspectiveCamera(45) : new THREE.OrthographicCamera()
    const padding = .12
    const result = fitImageCamera(camera, box, aspect, viewDirection(yaw, pitch), padding)
    assert.ok(result.target.distanceTo(box.getCenter(new THREE.Vector3())) < 1e-9)
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(camera)
      assert.ok(Math.abs(p.x) <= 1 - 2 * padding + 1e-8 && Math.abs(p.y) <= 1 - 2 * padding + 1e-8 && Math.abs(p.z) < 1, `Clipped corner: ${perspective}, ${aspect}, ${size}, ${yaw}, ${pitch}`)
    }
    cases++
  }
}
assert.ok(validImageSize(4096, 4096))
assert.ok(validImageSize(8192, 2048))
for (const size of [[8192, 4096], [9000, 100], [63, 100], [64.5, 100], [NaN, 500], [0, 1024]]) assert.equal(validImageSize(...size), false)
assert.equal(validImageSize(4096, 512, 2048), false, 'hardware limit applies')
assert.equal(exportFilename('建筑.litematic'), '建筑.png')
assert.equal(exportFilename('a/b:*?"<>|.png'), 'a_b_______.png')
assert.equal(exportFilename('...'), 'schematic.png')
console.log(`Passed ${cases} orthographic/perspective export framing cases, size limits and safe PNG filenames.`)
