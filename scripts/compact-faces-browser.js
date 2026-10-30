import * as THREE from 'three'
import JSZip from 'jszip'
import { Renderer } from '/src/renderer.js'
import { AssetProvider } from '/src/assets.js'
import { BlockModelResolver } from '/src/blocks.js'
import { parseLitematica } from '/src/litematica.js'
import { buildFaceGroups } from '/src/geometry.js'

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

window.runCompactFaces = async () => {
  const powerPreference = new URLSearchParams(location.search).get('powerPreference') || 'default'
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference })
  renderer.setSize(960, 720); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.append(renderer.domElement)
  const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  const assets = new AssetProvider(); assets.baseUrl = '/assets/minecraft/'
  const bytes = await (await fetch('/schematics/投影预览测试.litematic')).arrayBuffer()
  const zip = await JSZip.loadAsync(await (await fetch('/resourcepacks/XK redstone display 26.3.0.zip')).arrayBuffer())
  const results = [], failures = []
  let changedPixels = 0, pixelSamples = 0
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
      for (const [scenario, data] of [['fixture', fixture], ['wide-address', sparse]]) {
        const views = [createView(false), createView(true)]
        const b = data.bounds
        const center = new THREE.Vector3(b.minX + b.width / 2, b.minY + b.height / 2, b.minZ + b.depth / 2)
        const radius = Math.max(b.width, b.depth, b.height)
        const poses = scenario === 'fixture'
          ? [[center, [radius, radius, radius]], [center, [-radius, radius, -radius]], [center, [radius * .4, radius * .4, radius * .4]]]
          : data.targets.map(target => [target, [10, 8, 10]])
        const camera = new THREE.PerspectiveCamera(60, 960 / 720, .01, 20000)
        const originalMaterials = views.map(() => new Map())
        try {
          for (const [layer, filter] of [['all', null], ['even-y', (_x, y) => y % 2 === 0], ['restored', null]]) {
            for (let i = 0; i < views.length; i++) {
              const groups = await build(views[i], data, assets, filter)
              if (scenario === 'wide-address' && i === 1 && ![...groups.values()].some(group => group.cellYs?.length)) throw Error('Wide address shader was not exercised')
              if (layer === 'all') originalMaterials[i] = new Map(views[i].materials)
              else for (const [key, material] of views[i].materials) if (material !== originalMaterials[i].get(key)) throw Error('Layer rebuild replaced material instead of testing cached shader')
            }
            for (let index = 0; index < poses.length; index++) {
              const [target, position] = poses[index]
              camera.position.copy(target).add(new THREE.Vector3(...position)); camera.lookAt(target); camera.updateMatrixWorld(true)
              assets.updateAnimations(0)
              const snapshots = views.map(view => {
                renderer.render(view.scene, camera)
                const pixels = new Uint8Array(960 * 720 * 4)
                gl.readPixels(0, 0, 960, 720, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL error during pixel comparison')
                return pixels
              })
              let changed = 0, colored = 0
              for (let i = 0; i < snapshots[0].length; i += 4) {
                if ([0, 1, 2, 3].some(c => snapshots[0][i + c] !== snapshots[1][i + c])) changed++
                if ([0, 1, 2].some(c => snapshots[0][i + c] !== snapshots[0][c])) colored++
              }
              if (colored < 100) throw Error(`Empty rendered view: ${pack}/${scenario}/${layer}/${index}`)
              if (changed) {
                const encode = pixels => {
                  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 720
                  const context = canvas.getContext('2d'), image = context.createImageData(960, 720)
                  for (let y = 0; y < 720; y++) image.data.set(pixels.subarray(y * 960 * 4, (y + 1) * 960 * 4), (719 - y) * 960 * 4)
                  context.putImageData(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1]
                }
                const diff = new Uint8Array(snapshots[0].length), samples = [], raycaster = new THREE.Raycaster()
                for (let i = 0; i < diff.length; i += 4) {
                  diff[i + 3] = 255
                  if (![0, 1, 2, 3].some(c => snapshots[0][i + c] !== snapshots[1][i + c])) continue
                  diff[i] = 255
                  if (samples.length >= 32) continue
                  const x = (i / 4) % 960, y = Math.floor(i / 4 / 960)
                  raycaster.setFromCamera(new THREE.Vector2((x + .5) / 960 * 2 - 1, (y + .5) / 720 * 2 - 1), camera)
                  samples.push({ x, y, old: [...snapshots[0].subarray(i, i + 4)], next: [...snapshots[1].subarray(i, i + 4)],
                    hits: views.map(view => raycaster.intersectObjects(view.group.children, true).slice(0, 5).map(hit => ({
                      material: [...view.materials].find(([, material]) => material === hit.object.material)?.[0], face: hit.faceIndex,
                      position: hit.point.toArray(), sphere: hit.object.geometry.boundingSphere?.center.toArray(),
                    }))) })
                }
                const repeatChanges = views.map((view, j) => {
                  renderer.render(view.scene, camera); const pixels = new Uint8Array(diff.length)
                  gl.readPixels(0, 0, 960, 720, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                  let count = 0; for (let i = 0; i < pixels.length; i++) if (pixels[i] !== snapshots[j][i]) count++
                  return count
                })
                failures.push({ pack, scenario, layer, index, samples, repeatChanges,
                  images: { baseline: encode(snapshots[0]), compact: encode(snapshots[1]), diff: encode(diff) } })
              }
              changedPixels += changed; pixelSamples += 960 * 720
              results.push({ pack, scenario, layer, index, changed, colored })
              console.log('STAGE', JSON.stringify(results.at(-1)))
            }
          }
        } finally {
          for (const view of views) { clearGeometry(view); for (const material of view.materials.values()) material.dispose() }
        }
      }
    }
    return { gpu, changedPixels, pixelSamples, results, failures }
  } finally { renderer.dispose(); assets.clearCaches() }
}
