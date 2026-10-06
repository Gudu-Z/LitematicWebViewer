import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'

let cases = 0
for (const [width, height, inset] of [[1440, 928, { left: 316, right: 316, top: 20, bottom: 20 }], [390, 780, { top: 16, bottom: 76 }], [1024, 600, { left: 316, right: 316 }], [1920, 1080, {}]]) {
  for (const [w, h, d] of [[6, 4, 6], [500, 5, 1], [1, 200, 1], [2, 2, 400], [1, 1, 1]]) {
    const bounds = { minX: -50, minY: 10, minZ: 27, maxX: -50 + w - 1, maxY: 10 + h - 1, maxZ: 27 + d - 1, width: w, height: h, depth: d }
    const camera = new THREE.PerspectiveCamera(60, width / height, .1, 1000)
    const target = new THREE.Vector3()
    const subject = {
      camera, container: { clientWidth: width, clientHeight: height }, getViewportInsets: () => inset,
      controls: { target, update() { camera.lookAt(target); camera.updateMatrixWorld(true) } },
    }
    Renderer.prototype.fitToBounds.call(subject, bounds)
    assert.deepEqual(target.toArray(), [-50 + w / 2, 10 + h / 2, 27 + d / 2])
    const maxX = 1 - 2 * Math.max(inset.left || 0, inset.right || 0) / width
    const maxY = 1 - 2 * Math.max(inset.top || 0, inset.bottom || 0) / height
    for (const x of [bounds.minX, bounds.maxX + 1]) for (const y of [bounds.minY, bounds.maxY + 1]) for (const z of [bounds.minZ, bounds.maxZ + 1]) {
      const p = new THREE.Vector3(x, y, z).project(camera)
      assert.ok(Math.abs(p.x) <= maxX && Math.abs(p.y) <= maxY && Math.abs(p.z) <= 1, 'building corner clipped by viewport/panels')
    }
    cases++
  }
}
console.log(`Passed ${cases} camera framing cases: desktop panels, portrait, narrow windows, tall/wide/deep bounds and block-center alignment`)
