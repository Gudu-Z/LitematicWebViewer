import * as THREE from 'three'
import { installSignDrawBatches } from '../src/signDrawBatches.js'
import { markBlockObject, selectionSource } from '../src/selectionSources.js'

export function verifySignDrawBatches(renderer) {
  const check = (ok, message) => { if (!ok) throw Error(message) }
  const scene = new THREE.Scene(), root = new THREE.Group(), signs = new THREE.Group()
  scene.background = new THREE.Color(0x193247); scene.add(root); root.add(signs)
  const originalBefore = scene.onBeforeRender, originalSort = renderer.renderLists.get(scene, 0).sort, sortObjects = renderer.sortObjects
  const width = 192, height = 144, gl = renderer.getContext(), owned = new Set()
  const keep = item => { owned.add(item); return item }
  const plane = keep(new THREE.PlaneGeometry(.85, .4)), materials = []
  const pageSize = Math.min(32, renderer.capabilities.maxTextures - 1)
  for (let i = 0; i < pageSize + 7; i++) {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 16
    const ctx = canvas.getContext('2d'), color = `${(37 * i + 17) % 256},${(83 * i + 97) % 256},${(137 * i + 41) % 256}`
    ctx.fillStyle = `rgba(${color},.43)`; ctx.fillRect(1, 1, 61, 14)
    ctx.fillStyle = `rgb(${color})`; ctx.fillRect(i % 13 + 3, 4, 14, 6)
    ctx.clearRect(36 + i % 11, 3, 7, 9)
    const map = keep(new THREE.CanvasTexture(canvas)); map.colorSpace = THREE.SRGBColorSpace; map.magFilter = map.minFilter = THREE.NearestFilter
    materials.push(keep(new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, forceSinglePass: true })))
  }
  const objects = []
  function obstacle(color, opacity, x, y, z, w, h) {
    const mesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), keep(new THREE.MeshBasicMaterial({ color, opacity,
      transparent: opacity < 1, depthWrite: opacity === 1, side: THREE.DoubleSide, forceSinglePass: true })))
    mesh.position.set(x, y, z); mesh.layers.enableAll(); root.add(mesh)
  }
  for (let i = 0; i < 384; i++) {
    const mesh = new THREE.Mesh(plane, materials[i % materials.length])
    mesh.position.set((i % 24 - 11.5) * .48, (Math.floor(i / 24) - 7.5) * .22, (i % 5 - 2) * .042)
    mesh.rotation.y = (i % 7 - 3) * .08
    if (i % 17 === 1) { mesh.position.copy(objects[i - 1].position); mesh.quaternion.copy(objects[i - 1].quaternion) } // Coplanar labels with different maps.
    if (i % 4 === 0) mesh.layers.enable(1)
    markBlockObject(mesh, i, i % 3, 0); signs.add(mesh); objects.push(mesh)
    // Non-label transparent objects also interrupt the original sorted list.
    if (i === 150) obstacle(0x20de81, .49, -.6, .1, 0, 5.7, 2.2)
    if (i === 255) obstacle(0xe12a93, .36, .8, -.35, -.045, 4.5, 2.9)
  }
  obstacle(0xcda263, 1, .25, 0, .24, .6, 4.3) // Opaque foreground occlusion.
  // A customized source must interrupt the batch just like any other draw.
  let beforeCalls, afterCalls, materialCalls
  objects[0].onBeforeRender = () => { beforeCalls++ }
  objects[0].onAfterRender = () => { afterCalls++ }
  materials[2].onBeforeRender = () => { materialCalls++ }
  materials[1].onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.r *= .5;')
  }
  let prematureDisposals = 0, uninstall
  const disposed = () => prematureDisposals++
  for (const resource of owned) resource.addEventListener('dispose', disposed)
  const cases = [
    { label: 'perspective/front' }, { label: 'perspective/orbit', eye: [3.6, 1.2, 12] },
    { label: 'perspective/pan', eye: [-1.9, -.65, 13], target: [-1.9, -.65, 0] },
    { label: 'orthographic/back', ortho: true, eye: [-.8, .5, -14] },
    { label: 'far coordinates', eye: [2.5, 1.1, 13.7], offset: [30000000, -81, -30000000] },
    { label: 'hidden and layer-filtered', hidden: true, layer: 1, ortho: true },
    { label: 'hidden group', groupHidden: true }, { label: 'unsorted fallback', noSort: true },
  ]
  function draw(test) {
    root.position.fromArray(test.offset || [0, 0, 0]); signs.visible = !test.groupHidden
    for (let i = 0; i < objects.length; i++) objects[i].visible = !test.hidden || i % 3 !== 1
    renderer.sortObjects = !test.noSort
    const camera = test.ortho ? new THREE.OrthographicCamera(-7.2, 7.2, 5.4, -5.4, .1, 100) : new THREE.PerspectiveCamera(45, width / height, .1, 100)
    camera.layers.set(test.layer || 0)
    camera.position.fromArray(test.eye || [0, 0, 14]).add(root.position)
    camera.lookAt(new THREE.Vector3(...(test.target || [0, 0, 0])).add(root.position)); camera.updateMatrixWorld(true)
    beforeCalls = afterCalls = materialCalls = 0
    renderer.info.reset(); renderer.render(scene, camera)
    const rgba = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    check(gl.getError() === gl.NO_ERROR && !gl.isContextLost(), test.label + ': WebGL error')
    return { rgba, calls: renderer.info.render.calls, beforeCalls, afterCalls, materialCalls }
  }
  function equalRGBA(actual, expected, label) {
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw Error(`${label}: RGBA byte ${i}, expected ${expected[i]}, got ${actual[i]}`)
  }
  const results = []
  try {
    renderer.setSize(width, height)
    const baseline = cases.map(draw), visible = baseline[0].rgba, hidden = baseline.find((_, i) => cases[i].groupHidden).rgba
    check(visible.some((byte, i) => byte !== hidden[i]), 'Labels contribute visible pixels to the reference')
    uninstall = installSignDrawBatches(scene, signs, renderer)
    check(typeof uninstall === 'function', 'The real WebGL renderer accepted the multi-page fixture')
    for (let i = 0; i < cases.length; i++) {
      const test = cases[i], result = draw(test)
      equalRGBA(result.rgba, baseline[i].rgba, test.label)
      for (const key of ['beforeCalls', 'afterCalls', 'materialCalls']) check(result[key] === baseline[i][key], test.label + ': source callback ' + key)
      if (test.groupHidden || test.noSort) check(result.calls === baseline[i].calls, test.label + ': ordinary draw path')
      else check(result.calls < baseline[i].calls, test.label + ': fewer actual WebGL draws')
      results.push({ case: test.label, original: baseline[i].calls, batched: result.calls })
      check(renderer.renderLists.get(scene, 0).sort === originalSort, 'Restore the original render list sort after every pass')
    }
    check(results[0].original > 300 && results[0].batched < results[0].original / 2, 'Reduce draws in a fully visible multi-texture scene')
    uninstall(); uninstall = null
    check(scene.onBeforeRender === originalBefore && !prematureDisposals, 'Uninstall restores the hook and keeps all source resources alive')
    check(signs.children.every((object, i) => object === objects[i] && object.geometry === plane && object.material === materials[i % materials.length]
      && selectionSource(object)?.position[0] === i), 'Original meshes, materials and picking sources remain intact')
    const restored = draw(cases[0]); equalRGBA(restored.rgba, baseline[0].rgba, 'after uninstall')
    check(restored.calls === baseline[0].calls, 'Uninstall restores every ordinary draw')
    return { maps: materials.length, pageSize, pixelsCompared: width * height * (cases.length + 1), results }
  } finally {
    uninstall?.(); renderer.sortObjects = sortObjects
    for (const resource of owned) { resource.removeEventListener('dispose', disposed); resource.dispose() }
  }
}
