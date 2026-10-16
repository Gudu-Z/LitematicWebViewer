import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Renderer } from '../src/renderer.js'
import { AssetProvider } from '../src/assets.js'
import { collectSceneResources } from '../src/sceneResources.js'

const original = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'performance'].map(key => [key, globalThis[key]]))
const frames = new Map(), timers = new Map()
let handle = 0, now = 1000, draws = 0
globalThis.document = { hidden: false }
globalThis.performance = { now: () => now }
globalThis.requestAnimationFrame = callback => { frames.set(++handle, callback); return handle }
globalThis.cancelAnimationFrame = id => frames.delete(id)
globalThis.setTimeout = callback => { timers.set(++handle, callback); return handle }
globalThis.clearTimeout = id => timers.delete(id)
const flush = () => {
  const ready = [...frames.values()]; frames.clear()
  for (const callback of ready) callback(now)
}
const tick = () => {
  now += 50
  const ready = [...timers.values()]; timers.clear()
  for (const callback of ready) callback()
  flush()
}

try {
  const assets = new AssetProvider()
  let uploads = 0
  const animated = await assets._cachedTexture('animated', () => {
    const texture = new THREE.Texture()
    let previous = -1
    texture.userData.updateAnimation = age => {
      const frame = Math.floor(age / 2) % 2
      if (previous === frame) return
      previous = frame; texture.needsUpdate = true; uploads++
    }
    return texture
  })
  const staticTexture = await assets._cachedTexture('static', () => new THREE.Texture())
  const viewer = Object.create(Renderer.prototype)
  Object.assign(viewer, {
    _active: true, _lastTime: now, _assets: assets,
    scene: new THREE.Scene(), keys: new Set(), _joy: { x: 0, z: 0 }, _touchVertical: 0,
    controls: { update: () => false }, moveMode: 'orbit',
    renderer: { render: () => draws++, setClearAlpha() {} },
    _applyMovement() {},
  })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: staticTexture }))
  viewer.scene.add(mesh)
  viewer.requestRender(true); viewer.requestRender(true); viewer.requestRender()
  assert.equal(frames.size, 1, 'Coalesce scene changes into one scheduled draw')
  flush()
  assert.equal(draws, 1)
  assert.equal(frames.size + timers.size, 0, 'A static scene must leave no recurring work')
  assert.equal(uploads, 0, 'A cached but unused animated atlas must not upload')

  // Shader uniforms and hidden objects both retain resources, but only visible
  // materials animate. This also covers frame batches and portal shaders.
  const shader = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ uniforms: { sky: { value: animated } } }))
  const hidden = new THREE.Group(); hidden.visible = false; hidden.add(shader); viewer.scene.add(hidden)
  let resources = collectSceneResources(viewer.scene)
  assert.ok(resources.retained.has(animated))
  assert.ok(!resources.active.has(animated))
  viewer.requestRender(true); flush()
  assert.equal(timers.size, 0)
  hidden.visible = true; viewer.requestRender(true); flush()
  assert.equal(uploads, 1)
  assert.equal(timers.size, 1)
  const beforeTick = draws
  tick()
  assert.equal(draws, beforeTick, 'An unchanged animation frame must not redraw')
  tick()
  assert.equal(draws, beforeTick + 1, 'The next animation frame must draw')
  assert.equal(uploads, 2)

  shader.material.visible = false; viewer.requestRender(true); flush()
  assert.equal(frames.size + timers.size, 0, 'Hiding the last animation stops the clock')
  resources = collectSceneResources(viewer.scene)
  assert.ok(resources.retained.has(animated))
  assert.ok(!resources.active.has(animated))

  mesh.userData.updateAnimation = () => {}
  viewer.requestRender(true); flush()
  assert.equal(frames.size, 1, 'Visible model animations retain frame-rate updates')
  mesh.visible = false; viewer.requestRender(true); flush()
  assert.equal(frames.size, 0)
  delete mesh.userData.updateAnimation

  viewer.controls.autoRotate = true; viewer.requestRender(); flush()
  assert.equal(frames.size, 1)
  viewer.controls.autoRotate = false; flush()
  assert.equal(frames.size, 0)
  viewer.keys.add('KeyW'); viewer.requestRender(); flush()
  assert.equal(frames.size, 1, 'Held movement keys must keep the camera updating')
  viewer.keys.clear(); flush()
  assert.equal(frames.size, 0)
  viewer.setBackgroundColor('#123456'); flush()
  assert.equal(viewer.scene.background.getHexString(), '123456')
  assert.equal(frames.size, 0)

  viewer.requestRender(); viewer.setActive(false)
  assert.equal(frames.size + timers.size, 0)
  const beforeResume = draws
  viewer.requestRender(true)
  assert.equal(frames.size, 0, 'A paused main viewer stays paused while exporting')
  viewer.setActive(true); flush()
  assert.equal(draws, beforeResume + 1, 'Resume paints changes made while inactive')
  document.hidden = true; viewer.requestRender()
  assert.equal(frames.size, 0)
  document.hidden = false; viewer.requestRender(); flush()

  // Real async renderer entry points must cancel draws while awaiting assets,
  // including nested builders and failures, without changing export visibility.
  let releaseBuild
  viewer._buildBlockMeshes = async data => {
    if (data === 'outer') return viewer.renderBlocks('inner', assets)
    await new Promise(resolve => { releaseBuild = resolve })
    if (data === 'failure') throw new Error('Injected build failure')
    return data
  }
  viewer.requestRender(true)
  const building = viewer.renderBlocks('outer', assets)
  assert.equal(viewer._sceneBuildDepth, 2)
  assert.equal(frames.size + timers.size, 0, 'Build cancels existing animation work')
  viewer.requestRender(true); tick()
  assert.equal(frames.size + timers.size, 0, 'Async yields do not draw a partial scene')
  const beforeBuildDraw = draws
  releaseBuild(); assert.equal(await building, 'inner')
  assert.equal(viewer._sceneBuildDepth, 0)
  assert.equal(frames.size, 1, 'Nested builders coalesce into one completed-scene draw')
  flush(); assert.equal(draws, beforeBuildDraw + 1)

  const failed = viewer.renderBlocks('failure', assets)
  releaseBuild(); await assert.rejects(failed, /Injected build failure/)
  assert.equal(viewer._sceneBuildDepth, 0, 'Failure cannot leave rendering suspended')
  assert.equal(frames.size, 1); flush()
  viewer.setActive(false)
  const inactiveBuild = viewer.renderBlocks('inner', assets)
  releaseBuild(); await inactiveBuild
  assert.equal(viewer._active, false, 'Completing a build must not wake a paused export source')
  assert.equal(frames.size + timers.size, 0)
  viewer.setActive(true); flush()
  const endUpdate = viewer.beginSceneUpdate()
  viewer.requestRender(true)
  assert.equal(frames.size, 0, 'The file-level transaction also holds parsing and metadata updates')
  endUpdate(); endUpdate()
  assert.equal(viewer._sceneBuildDepth, 0, 'Releasing the same transaction twice is harmless')
  assert.equal(frames.size, 1); flush()
  console.log('PASS async scene builds defer partial draws, preserve nesting, recover after failures and respect inactive viewers')

  assets.releaseTextureUsage(viewer)
  assets.clearCaches()
  console.log('PASS scene scheduling: idle work stops, changes coalesce, visible shader atlases tick only when pixels change, hidden resources stay pinned, model animation/movement/auto-rotate and export resume wake correctly')
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
}
