import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as THREE from 'three'

// Node 20 (used by CI) supports async loader registration, but not registerHooks.
register(new URL('./image-export-test-loader.mjs', import.meta.url))
const { ImageExport } = await import('../src/imageExport.js')

const original = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'].map(key => [key, globalThis[key]]))
globalThis.requestAnimationFrame = callback => { queueMicrotask(callback); return 1 }
globalThis.cancelAnimationFrame = () => {}
globalThis.setTimeout = callback => { callback(); return 1 }
globalThis.document = { createElement: () => ({ click() {}, remove() {} }) }

function studio() {
  const exporter = Object.create(ImageExport.prototype)
  exporter.dialog = { open: true, querySelectorAll: () => [], setAttribute() {}, append() {} }
  exporter.el = { Save: { disabled: false }, Filename: { value: 'fixture' } }
  exporter.messages = []
  exporter.message = (...args) => exporter.messages.push(args)
  exporter.validate = () => {}
  exporter.resize = () => {}
  return exporter
}

try {
  // Three's setPixelRatio resizes immediately. Track every intermediate buffer,
  // including cleanup after a PNG encoder failure, without allocating huge images.
  for (const ratio of [1, 1.5, 2]) for (const [width, height] of [[512, 320], [4096, 4096]]) for (const succeeds of [true, false]) {
    const exporter = studio(), history = [], captures = [], preview = { x: 480, y: 320 }
    Object.assign(exporter.el, { Width: { value: width }, Height: { value: height } })
    let currentRatio = ratio, size = { ...preview }
    const canvas = { width: preview.x * ratio, height: preview.y * ratio, toBlob(callback, format) {
      assert.equal(format, 'image/png')
      captures.push([this.width, this.height])
      callback(succeeds ? new Blob(['encoded PNG'], { type: format }) : null)
    } }
    exporter.gl = {
      domElement: canvas,
      getSize: value => value.set(size.x, size.y),
      getPixelRatio: () => currentRatio,
      setSize(x, y) {
        size = { x, y }; canvas.width = Math.floor(x * currentRatio); canvas.height = Math.floor(y * currentRatio)
        history.push([canvas.width, canvas.height])
      },
      setPixelRatio(value) { currentRatio = value; this.setSize(size.x, size.y) },
      getContext: () => ({ isContextLost: () => false }),
    }
    exporter.draw = () => assert.deepEqual([canvas.width, canvas.height], [width, height], 'The renderer receives the requested PNG dimensions')
    const log = console.error
    console.error = (...args) => { if (succeeds) log(...args) }
    try { await exporter.save() } finally { console.error = log }
    assert.deepEqual(captures, [[width, height]], 'Device scale must not change exported pixels')
    assert.deepEqual(size, preview)
    assert.equal(currentRatio, ratio)
    assert.deepEqual(history.at(-1), [preview.x * ratio, preview.y * ratio])
    const budget = Math.max(width * height, preview.x * preview.y * ratio * ratio)
    assert.ok(history.every(([w, h]) => w * h <= budget), `Restore must not allocate a DPR-scaled export buffer: ${JSON.stringify(history)}`)
    assert.equal(exporter.exporting, false)
    assert.equal(exporter.messages.at(-1)[0], succeeds ? 'saved' : 'failed')
  }

  {
    const exporter = studio(), texture = new THREE.Texture(), geometry = new THREE.BoxGeometry()
    const material = new THREE.MeshBasicMaterial({ map: texture }), oldObject = new THREE.Mesh(geometry, material)
    oldObject.userData.updateAnimation = () => {}
    const scene = new THREE.Scene(); scene.add(oldObject)
    const counts = { scene: 0, context: 0, controls: 0, observer: 0, resume: 0 }
    for (const resource of [texture, geometry, material]) resource.addEventListener('dispose', () => counts.scene++)
    exporter.source = { scene, setActive(active) { assert.equal(active, true); counts.resume++ } }
    exporter.wasActive = true
    exporter.modelData = { blocks: new Map([[1, 1]]) }; exporter.animated = [oldObject]
    exporter.gl = { dispose() { counts.context++ }, forceContextLoss() {}, domElement: { remove() {} } }
    exporter.controls = { dispose() { counts.controls++ } }
    exporter.observer = { disconnect() { counts.observer++ } }
    exporter.camera = new THREE.PerspectiveCamera()
    exporter.release(); exporter.release()
    assert.equal(exporter.modelData, null, 'Closed export must release its previous schematic data')
    assert.deepEqual(exporter.animated, [], 'Closed export must release previous entity references')
    assert.equal(exporter.camera, null)
    assert.equal(exporter.observer, null)
    assert.deepEqual(counts, { scene: 0, context: 1, controls: 1, observer: 1, resume: 1 }, 'Closing is idempotent and never disposes shared scene resources')
    assert.equal(oldObject.parent, scene)

    scene.remove(oldObject)
    const newObject = new THREE.Group(); newObject.userData.updateAnimation = () => {}; scene.add(newObject)
    const nextData = { blocks: new Map([[2, 2]]) }
    exporter.getData = () => nextData; exporter.getFileName = () => 'replacement.litematic'
    Object.assign(exporter.el, { Empty: {}, Frame: {}, SourceName: {} })
    exporter.preset = name => assert.equal(name, 'iso')
    exporter.syncModel(true) // The normal open() path always refreshes this snapshot.
    assert.equal(exporter.modelData, nextData, 'Reopening loads the current schematic')
    assert.deepEqual(exporter.animated, [newObject], 'Reopening rebuilds animation references from the current scene')
    assert.equal(exporter.el.Filename.value, 'replacement')
    assert.equal(counts.scene, 0)
  }

  {
    const exporter = studio(), scene = new THREE.Scene(), source = { scene }
    for (const key of ['group', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup', 'entitiesGroup']) {
      source[key] = new THREE.Group(); scene.add(source[key])
    }
    exporter.source = source; exporter.el.Entities = { checked: true }
    const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshBasicMaterial()
    const instances = new THREE.InstancedMesh(geometry, material, 2)
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-4, 0, 0))
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(8, 3, -2))
    instances.position.set(3, 0, 0)
    source.entitiesGroup.position.set(10, 5, 7); source.entitiesGroup.add(instances)
    source.entitiesGroup.visible = false
    let bounds = exporter.bounds()
    assert.deepEqual(bounds.min.toArray(), [8, 4, 4])
    assert.deepEqual(bounds.max.toArray(), [22, 9, 8], 'Export framing includes every instance and its parent transforms')
    assert.equal(source.entitiesGroup.visible, false, 'Export bounds must restore main-viewer visibility')

    const hidden = new THREE.Mesh(geometry, material); hidden.position.set(1000, 1000, 1000); hidden.visible = false
    const hitbox = new THREE.Mesh(geometry, material); hitbox.position.set(-1000, -1000, -1000); hitbox.userData.isEntityHitbox = true
    const empty = new THREE.InstancedMesh(geometry, material, 0); empty.position.set(2000, 2000, 2000)
    source.entitiesGroup.add(hidden, hitbox, empty)
    assert.ok(exporter.bounds().equals(bounds), 'Hidden objects, hitbox overlays and empty instance batches must not change framing')

    exporter.el.Entities.checked = false
    const regular = new THREE.Mesh(geometry, material); regular.position.set(2, 3, 4); source.group.add(regular)
    bounds = exporter.bounds()
    assert.deepEqual(bounds.min.toArray(), [1, 2, 3])
    assert.deepEqual(bounds.max.toArray(), [3, 4, 5], 'Ordinary geometry and the export entity toggle retain their existing framing')
    source.group.remove(regular)
    exporter.modelData = { bounds: { minX: -2, minY: 4, minZ: -8, maxX: 3, maxY: 9, maxZ: 2 } }
    bounds = exporter.bounds()
    assert.deepEqual(bounds.min.toArray(), [-2, 4, -8])
    assert.deepEqual(bounds.max.toArray(), [4, 10, 3], 'An empty selection uses the schematic bounds')
    exporter.modelData = null
    bounds = exporter.bounds()
    assert.deepEqual(bounds.min.toArray(), [0, 0, 0]); assert.deepEqual(bounds.max.toArray(), [1, 1, 1])
    geometry.dispose(); material.dispose()
  }
  console.log('PASS image export lifecycle: exact dimensions and bounded temporary buffers at DPR 1/1.5/2, encoder failure recovery, released snapshots, reopen, shared-scene ownership and instanced/hidden/empty framing')
} finally {
  for (const [key, value] of Object.entries(original)) globalThis[key] = value
}
