import * as THREE from 'three'
import JSZip from 'jszip'
import { Renderer } from '/src/renderer.js'
import { AssetProvider } from '/src/assets.js'
import { BlockModelResolver } from '/src/blocks.js'
import { parseLitematica } from '/src/litematica.js'
import { buildFaceGroups } from '/src/geometry.js'
import { collectSceneResources } from '/src/sceneResources.js'

const differs = (a, b, i) => a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]
const imageHash = async pixels => [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
  .map(value => value.toString(16).padStart(2, '0')).join('')

function createView(compactFaces) {
  const view = Object.create(Renderer.prototype)
  view.scene = new THREE.Scene(); view.group = new THREE.Group(); view.scene.add(view.group)
  view.scene.background = new THREE.Color('#172332')
  view.scene.add(new THREE.AmbientLight(0xffffff, .85))
  const light = new THREE.DirectionalLight(0xffffff, .9)
  light.position.set(1, 2, 3); view.scene.add(light)
  view.materials = new Map(); view.compactFaces = compactFaces
  return view
}
function clearGeometry(view) {
  view.group.traverse(object => object.geometry?.dispose())
  view.group.clear()
}
async function build(view, data, assets, filter) {
  clearGeometry(view)
  const { groups } = await buildFaceGroups(data.palette, data.blocks, data.bounds, null, filter,
    { compactFaces: view.compactFaces, trackBlocks: true })
  await view._loadBlockMaterials(groups, assets, view.materials)
  await view._appendBlockMeshes(groups, view.materials, view.group)
  return groups
}
function largeSparseData(palette) {
  const bounds = { minX: -3000, minY: -128, minZ: -4000, width: 5120, height: 256, depth: 6656 }
  const blocks = new Map(), targets = []
  for (const [x, y, z] of [[3, 4, 5], [2000, 129, 3000], [5100, 250, 6630]]) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < palette.length; dx++) {
      blocks.set(x + dx * 2 + z * bounds.width + (y + dy) * bounds.width * bounds.depth, dx)
    }
    targets.push(new THREE.Vector3(x + bounds.minX + palette.length - .5, y + bounds.minY + 1, z + bounds.minZ + .5))
  }
  return { bounds, blocks, palette, targets }
}

function atlasRowsData() {
  // Original-order template 128 starts the second row. The even-Y rebuild on
  // the same material shrinks back to one row, then all templates return.
  const bounds = { minX: -256, minY: -9950, minZ: -400, width: 585, depth: 593, height: 11500 }
  const blocks = new Map(), palette = []
  for (let i = 0; i < 144; i++) {
    const x = 271 + i % 16, y = 10000 + Math.floor(i / 16), z = 432
    const right = 1 - i / 512, top = i >= 128 ? .875 : .625
    palette.push({ name: 'minecraft:stone', baked: { quads: [{ texKey: 'block/stone',
      verts: [[0,0,.5], [right,0,.5], [0,top,.5], [right,top,.5]], uvs: [[0,1], [1,1], [0,0], [1,0]],
    }] } })
    blocks.set(x + bounds.width * (z + y * bounds.depth), i)
  }
  // These cells exceed signed 32-bit indices, despite fitting the compact
  // single-uint format. The non-power-of-two extents require exact quotients.
  return { blocks, bounds, palette, targets: [new THREE.Vector3(23, 54, 32.5), new THREE.Vector3(23, 58, 32.5)] }
}

window.runCompactFaces = async () => {
  const powerPreference = new URLSearchParams(location.search).get('powerPreference') || 'default'
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference })
  renderer.setSize(960, 720); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.append(renderer.domElement)
  const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  // The default browser framebuffer can drift by a channel value on repeated
  // reads of overlapping transparent fluids. Use an explicit 8-bit sRGB
  // target with the same MSAA sample count for a repeatable, exact comparison.
  const pixelsTarget = new THREE.WebGLRenderTarget(960, 720, { samples: gl.getParameter(gl.SAMPLES) })
  pixelsTarget.texture.colorSpace = renderer.outputColorSpace
  const capture = (view, camera) => {
    // Readback binds the resolved attachment, which is not the multisampled
    // draw framebuffer. Set the actual draw target afresh on every capture.
    renderer.setRenderTarget(pixelsTarget)
    renderer.render(view.scene, camera)
    renderer.setRenderTarget(null)
    const pixels = new Uint8Array(960 * 720 * 4)
    renderer.readRenderTargetPixels(pixelsTarget, 0, 0, 960, 720, pixels)
    if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL error during pixel comparison')
    return pixels
  }
  const assets = new AssetProvider(); assets.baseUrl = '/assets/minecraft/'
  const bytes = await (await fetch('/schematics/投影预览测试.litematic')).arrayBuffer()
  const zip = await JSZip.loadAsync(await (await fetch('/resourcepacks/XK redstone display 26.3.0.zip')).arrayBuffer())
  const results = [], failures = []
  let changedPixels = 0, firstChangedPixels = 0, firstErrors = 0, pixelSamples = 0
  try {
    for (const pack of ['vanilla', 'xk']) {
      assets.packs = pack === 'xk' ? [{ name: 'XK', zip }] : []; assets.clearCaches()
      const resolver = new BlockModelResolver(assets)
      const fixture = await parseLitematica(bytes, null, { compactBlocks: false })
      await Promise.all(fixture.palette.map(async entry => { entry.baked = await resolver.resolve(entry.name, entry.properties) }))
      const palette = await Promise.all(['stone', 'oak_stairs', 'glass', 'redstone_wire'].map(async name => {
        const entry = { name: 'minecraft:' + name, properties: { facing: 'east', half: 'bottom', shape: 'outer_left', power: '15' } }
        entry.baked = await resolver.resolve(entry.name, entry.properties); return entry
      }))
      const sparse = largeSparseData(palette)
      for (const [scenario, data] of [['fixture', fixture], ['wide-address', sparse], ['atlas-rows', atlasRowsData()]]) {
        const views = [createView(false), createView(true)]
        const b = data.bounds
        const center = new THREE.Vector3(b.minX + b.width / 2, b.minY + b.height / 2, b.minZ + b.depth / 2)
        const radius = Math.max(b.width, b.depth, b.height)
        const poses = scenario === 'fixture'
          ? [[center, [radius, radius, radius]], [center, [-radius, radius, -radius]], [center, [radius * .4, radius * .4, radius * .4]]]
          : data.targets.map((target, i) => [target, [[10, 8, 10], [-8, 6, 10], [8, 4, -10]][i]])
        const camera = new THREE.PerspectiveCamera(60, 960 / 720, .01, 20000)
        const originalMaterials = views.map(() => new Map())
        try {
          for (const [layer, filter] of [['all', null], ['even-y', (_x, y) => y % 2 === 0], ['restored', null]]) {
            let preceding
            for (let i = 0; i < views.length; i++) {
              const groups = await build(views[i], data, assets, filter)
              if (scenario === 'wide-address' && i === 1 && ![...groups.values()].some(group => group.cellYs?.length)) throw Error('Wide address shader was not exercised')
              if (scenario === 'atlas-rows' && i === 1) {
                const g = groups.get('block/stone')
                if (g.cellYs || !g.cells.every(cell => cell > 0x7fffffff) || g.textureHeight !== (layer === 'all' || layer === 'restored' ? 2 : 1)) {
                  throw Error('The multi-row → single-row → multi-row address test did not exercise the requested cases')
                }
              }
              if (layer === 'all') originalMaterials[i] = new Map(views[i].materials)
              else for (const [key, material] of views[i].materials) if (material !== originalMaterials[i].get(key)) throw Error('Layer rebuild replaced material instead of testing cached shader')
            }
            for (let index = 0; index < poses.length; index++) {
              const [target, position] = poses[index]
              camera.position.copy(target).add(new THREE.Vector3(...position)); camera.lookAt(target); camera.updateMatrixWorld(true)
              assets.updateAnimations(0)
              for (const view of views) {
                view.scene.traverse(o => { if (o.userData.updateAnimation) { o.userData.animationAge = 0; o.userData.updateAnimation(0, camera) } })
                const resources = collectSceneResources(view.scene)
                assets.setTextureUsage(view, resources.retained, resources.active); assets.updateAnimations(0, view)
              }
              const frames = views.map(view => {
                // Both representations arrive at the target from the same
                // preceding camera, including when shaders/textures are cold.
                const [before, offset] = poses[(index + poses.length - 1) % poses.length]
                camera.position.copy(before).add(new THREE.Vector3(...offset)); camera.lookAt(before); camera.updateMatrixWorld(true)
                renderer.setRenderTarget(pixelsTarget); renderer.render(view.scene, camera); renderer.setRenderTarget(null)
                camera.position.copy(target).add(new THREE.Vector3(...position)); camera.lookAt(target); camera.updateMatrixWorld(true)
                // Use exactly the same two pose draws in both paths, including
                // the first one; the number of samples never depends on results.
                return [capture(view, camera), capture(view, camera)]
              })
              const snapshots = frames.map(pair => pair[1])
              if (preceding && !snapshots[0].some((value, i) => value !== preceding[i])) throw Error('Camera moved but readback returned the previous image')
              preceding = snapshots[0]
              if (!index && layer === 'all') {
                // A stale nonempty image could pass an ordinary zero-diff test.
                // Check the compact view itself can overwrite the resolved image.
                views[1].group.visible = false
                const cleared = capture(views[1], camera)
                views[1].group.visible = true
                if (cleared.some((value, i) => value !== cleared[i % 4])) throw Error('Hidden scene retained a previous draw')
              }
              let changed = 0, colored = 0, firstChanged = 0
              let firstCompactOnly = 0
              const settling = [0, 0], firstErrorSamples = []
              for (let i = 0; i < snapshots[0].length; i += 4) {
                if (differs(snapshots[0], snapshots[1], i)) changed++
                if (differs(frames[0][0], frames[1][0], i)) {
                  firstChanged++
                  // A mismatched first draw must also drift at this pixel in
                  // the expanded reference. Do not forgive a compact-only error.
                  if (!differs(frames[0][0], snapshots[0], i)) {
                    firstCompactOnly++
                    if (firstErrorSamples.length < 8) firstErrorSamples.push({ x: i / 4 % 960, y: Math.floor(i / 4 / 960),
                      reference: [...frames[0][0].subarray(i, i + 4)], compact: [...frames[1][0].subarray(i, i + 4)] })
                  }
                }
                for (let j = 0; j < 2; j++) if (differs(frames[j][0], snapshots[j], i)) settling[j]++
                if ([0, 1, 2].some(c => snapshots[0][i + c] !== snapshots[0][c])) colored++
              }
              if (colored < 100) throw Error(`Empty rendered view: ${pack}/${scenario}/${layer}/${index}`)
              // Normally both ordered pairs must match every byte. Report
              // reference-only drift separately iff both compact images are
              // identical to one *entire* observed reference image. Never
              // mix pixels/frames, discard a compact-only change, or tolerate
              // even a one-channel difference in an otherwise matching image.
              const identical = !firstChanged && !changed
              const referenceDrift = !identical && settling[0] > 0 && settling[1] === 0 && (!firstChanged || !changed)
              const outcome = identical ? 'identical' : referenceDrift ? 'reference-drift' : 'mismatch'
              if (outcome === 'mismatch') {
                const bad = changed ? snapshots : frames.map(pair => pair[0])
                const encode = pixels => {
                  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 720
                  const context = canvas.getContext('2d'), image = context.createImageData(960, 720)
                  for (let y = 0; y < 720; y++) image.data.set(pixels.subarray(y * 960 * 4, (y + 1) * 960 * 4), (719 - y) * 960 * 4)
                  context.putImageData(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1]
                }
                const diff = new Uint8Array(bad[0].length), samples = [], raycaster = new THREE.Raycaster()
                for (let i = 0; i < diff.length; i += 4) {
                  diff[i + 3] = 255
                  if (!differs(bad[0], bad[1], i)) continue
                  diff[i] = 255
                  if (samples.length >= 32) continue
                  const x = (i / 4) % 960, y = Math.floor(i / 4 / 960)
                  raycaster.setFromCamera(new THREE.Vector2((x + .5) / 960 * 2 - 1, (y + .5) / 720 * 2 - 1), camera)
                  samples.push({ x, y, old: [...bad[0].subarray(i, i + 4)], next: [...bad[1].subarray(i, i + 4)],
                    hits: views.map(view => raycaster.intersectObjects(view.group.children, true).slice(0, 5).map(hit => ({
                      material: [...view.materials].find(([, material]) => material === hit.object.material)?.[0], face: hit.faceIndex,
                      position: hit.point.toArray(), sphere: hit.object.geometry.boundingSphere?.center.toArray(),
                    }))) })
                }
                const repeatChanges = views.map((view, j) => {
                  const pixels = capture(view, camera)
                  let count = 0; for (let i = 0; i < pixels.length; i++) if (pixels[i] !== bad[j][i]) count++
                  return count
                })
                failures.push({ pack, scenario, layer, index, samples, repeatChanges, frame: changed ? 2 : 1,
                  images: { baseline: encode(bad[0]), compact: encode(bad[1]), diff: encode(diff) } })
              }
              changedPixels += changed; firstChangedPixels += firstChanged; firstErrors += firstCompactOnly; pixelSamples += 960 * 720
              const [reference, compact] = await Promise.all(frames.map(pair => Promise.all(pair.map(imageHash))))
              results.push({ pack, scenario, layer, index, outcome, changed, firstChanged, firstCompactOnly, firstErrorSamples, settling, colored,
                referenceMatch: referenceDrift ? (!firstChanged ? 1 : 2) : null, hashes: { reference, compact } })
              console.log('STAGE', JSON.stringify(results.at(-1)))
            }
          }
        } finally {
          for (const view of views) { assets.releaseTextureUsage(view); clearGeometry(view); for (const material of view.materials.values()) material.dispose() }
        }
      }
    }
    return { gpu, changedPixels, firstChangedPixels, firstErrors, pixelSamples, results, failures }
  } finally { renderer.setRenderTarget(null); pixelsTarget.dispose(); renderer.dispose(); assets.clearCaches() }
}
