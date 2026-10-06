import assert from 'node:assert/strict'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Renderer } from '../src/renderer.js'

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} != ${b}`)
const sameVector = (a, b, message) => close(a.distanceTo(b), 0, message)
const sameRotation = (a, b, message) => close(1 - Math.abs(a.dot(b)), 0, message)
const subject = Object.create(Renderer.prototype)
subject.container = { clientWidth: 1440, clientHeight: 900 }
subject.renderer = { setSize(w, h) { assert.equal(w, subject.container.clientWidth); assert.equal(h, subject.container.clientHeight) } }
subject.camera = new THREE.PerspectiveCamera(60, 1.6, .1, 1000)
subject.camera.rotation.order = 'YXZ'
subject.camera.position.set(20, 16, 20)
subject.controls = new OrbitControls(subject.camera)
subject.controls.target.set(3, 2, -4)
subject.controls.update()
subject.moveMode = 'orbit'
const startPosition = subject.camera.position.clone()
const startTarget = subject.controls.target.clone()
const startRotation = subject.camera.quaternion.clone()
const projected = point => { subject.camera.updateMatrixWorld(true); return point.clone().project(subject.camera) }
// A segment in the target plane should keep its screen size when switching projections.
const right = new THREE.Vector3(1, 0, 0).applyQuaternion(startRotation)
const segment = startTarget.clone().addScaledVector(right, 2)
const originalScreen = projected(segment)
assert.equal(subject.getProjectionMode(), 'perspective')
subject.setProjectionMode('orthographic')
assert.ok(subject.camera.isOrthographicCamera)
assert.equal(subject.controls.object, subject.camera)
sameVector(subject.camera.position, startPosition, 'switch preserves position')
sameVector(subject.controls.target, startTarget, 'switch preserves target')
sameRotation(subject.camera.quaternion, startRotation, 'switch preserves orientation')
close(projected(segment).x, originalScreen.x, 'target-plane screen width preserved')
close(projected(segment).y, originalScreen.y, 'target-plane screen height preserved')
// Orthographic objects keep the same size regardless of depth.
const forward = subject.camera.getWorldDirection(new THREE.Vector3())
close(projected(segment.clone().addScaledVector(forward, 10)).x, originalScreen.x, 'no perspective foreshortening')
subject.setProjectionMode('perspective')
sameVector(subject.camera.position, startPosition, 'round trip preserves position')
close(projected(segment).x, originalScreen.x, 'round trip preserves screen width')

subject.setProjectionMode('orthographic')
subject.controls.dollyIn(.5)
close(projected(segment).x, originalScreen.x * 2, 'OrbitControls zoom affects orthographic camera')
const zoomed = projected(segment)
subject.setProjectionMode('perspective')
close(projected(segment).x, zoomed.x, 'orthographic zoom retained on switch to perspective')
subject.setProjectionMode('orthographic')
close(projected(segment).x, zoomed.x, 'zoom retained on second round trip')
subject.controls.rotateLeft(.3)
subject.controls.rotateUp(.2)
assert.ok(subject.camera.quaternion.angleTo(startRotation) > .1, 'orbit rotation still operates on replacement camera')
subject.controls.domElement = { clientWidth: 1440, clientHeight: 900 }
subject.controls.pan(30, 15)
assert.ok(subject.controls.target.distanceTo(startTarget) > 0, 'orbit pan still works')
subject.controls.domElement = null

const visibleHeight = (subject.camera.top - subject.camera.bottom) / subject.camera.zoom
subject.container.clientWidth = 390
subject.container.clientHeight = 780
subject._resize()
close((subject.camera.right - subject.camera.left) / (subject.camera.top - subject.camera.bottom), .5, 'portrait frustum aspect')
close((subject.camera.top - subject.camera.bottom) / subject.camera.zoom, visibleHeight, 'resize preserves vertical framing and zoom')
subject.controls.dollyOut(.001)
subject.setProjectionMode('perspective')
assert.ok(Math.abs(projected(subject.controls.target).z) < 1, 'large orthographic zoom-out is not clipped after switching')
subject._resize()
close(subject.camera.aspect, .5, 'perspective resize')

const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 3, maxZ: 5, width: 6, height: 4, depth: 6 }
subject.fitToBounds(bounds)
subject.moveMode = 'fly'
subject._yaw = .3
subject._pitch = -.2
subject._applyFlyRotation()
const flyRotation = subject.camera.quaternion.clone()
const flyPosition = subject.camera.position.clone()
for (const mode of ['orthographic', 'perspective']) {
  subject.setProjectionMode(mode)
  sameRotation(subject.camera.quaternion, flyRotation, 'flight direction preserved')
  sameVector(subject.camera.position, flyPosition, 'unzoomed flight position preserved')
  subject._applyFlyRotation()
  sameRotation(subject.camera.quaternion, flyRotation, 'next pointer movement keeps flight direction')
}
for (const mode of ['orthographic', 'perspective']) {
  subject.setProjectionMode(mode)
  subject.fitToBounds(bounds)
  const fittedRotation = subject.camera.quaternion.clone()
  subject._applyFlyRotation()
  sameRotation(subject.camera.quaternion, fittedRotation, 'fit updates flight look angles')
}
const unchanged = subject.camera
subject.setProjectionMode('invalid')
subject.setProjectionMode('perspective')
assert.equal(subject.camera, unchanged, 'invalid or unchanged mode does not replace the camera')
console.log('Passed projection switching, target-plane scale, orthographic depth, zoom round trips, orbit rotation/pan, portrait resize, far clipping and flight orientation checks')
