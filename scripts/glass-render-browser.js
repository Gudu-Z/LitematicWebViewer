import * as THREE from 'three'
import JSZip from 'jszip'
import { AssetProvider } from '../src/assets.js'
import { BlockModelResolver } from '../src/blocks.js'
import { buildFaceGroups } from '../src/geometry.js'
import { Renderer } from '../src/renderer.js'
import { buildItemPreview, buildGuiItem } from '../src/entities.js'

export async function verifyGlassRender(renderer) {
  const check = (value, message) => { if (!value) throw Error(message) }
  const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
  const names = ['glass', 'tinted_glass', ...colors.map(c => c + '_stained_glass'), 'glass_pane', ...colors.map(c => c + '_stained_glass_pane')]
  const assets = new AssetProvider(); assets.baseUrl = '/assets/minecraft/'
  const dispose = root => { const g = new Set(), m = new Set(); root.traverse(o => { if (o.geometry) g.add(o.geometry); if (o.material) m.add(o.material) }); g.forEach(v => v.dispose()); m.forEach(v => v.dispose()) }
  const sceneFor = object => { const scene = new THREE.Scene(); scene.add(object, new THREE.AmbientLight(0xffffff, 2.2)); const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(3, 8, -4); scene.add(sun); return scene }
  const pixels = () => { const gl = renderer.getContext(), out = new Uint8Array(192 * 192 * 4); gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, out); check(!gl.getError(), 'Glass WebGL error'); return out }
  let cases = 0, maxError = 0, atlasCases = 0
  window.__glassShots = {}
  try {
    for (const pack of [false, true]) {
      if (pack) assets.addPack(await JSZip.loadAsync(await (await fetch('/resourcepacks/XK redstone display 26.3.0.zip')).arrayBuffer()), 'XK')
      const resolver = new BlockModelResolver(assets)
      const palette = await Promise.all(names.map(async name => {
        const properties = { north: 'true', south: 'true', west: 'false', east: 'false', waterlogged: 'false' }
        return { name, properties, baked: await resolver.resolve(name, properties) }
      }))
      const layouts = [
        ['layers', [[0, 16], [24, 13], [48, 7]]],
        ['same', [[0, 16], [1, 16]]],
        ['colours', Array.from({ length: 18 }, (_, i) => [i % 6 * 2 + Math.floor(i / 6) * 12 * 2, i])],
        ['panes', Array.from({ length: 17 }, (_, i) => [i % 6 * 2 + Math.floor(i / 6) * 12 * 2, i + 18])],
      ]
      for (const [name, entries] of layouts) {
        const bounds = { minX: 0, minY: 0, minZ: 0, width: 12, height: 3, depth: 8 }
        const data = { palette, bounds, blocks: new Map(entries) }
        const object = await Renderer.buildBlockPreview(data, assets), scene = sceneFor(object), reference = new THREE.Group()
        const { groups } = await buildFaceGroups(palette, data.blocks, bounds)
        // Independent per-face draw oracle: original sprite alpha, backface
        // culling, depth writes and far-to-near alpha blending, without our shader.
        for (const [key, group] of groups) {
          const map = await assets.getTexture(key.split('|')[0])
          for (let face = 0; face < group.positions.length / 12; face++) {
            const geo = new THREE.BufferGeometry()
            geo.setAttribute('position', new THREE.BufferAttribute(group.positions.slice(face * 12, face * 12 + 12), 3))
            geo.setAttribute('uv', new THREE.BufferAttribute(group.uvs.slice(face * 8, face * 8 + 8), 2))
            geo.setIndex([0, 1, 2, 2, 1, 3]); geo.computeBoundingSphere()
            reference.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, transparent: true, opacity: 1, alphaTest: .1, side: THREE.FrontSide, depthWrite: true, flatShading: true })))
          }
        }
        const refScene = sceneFor(reference), wide = name === 'colours' || name === 'panes', size = wide ? 7 : 3
        const center = new THREE.Vector3(wide ? 5.5 : .5, .5, wide || name === 'layers' ? 2.5 : .5)
        const camera = new THREE.OrthographicCamera(-size, size, size, -size, .1, 100)
        for (const [i, angle] of [[wide ? 8 : 2, wide ? 6 : 1, 12], [-8, 6, 12], [8, 4, -12], [-8, -6, -12]].entries()) {
          assets.updateAnimations(i * 30)
          camera.position.copy(center).add(new THREE.Vector3(...angle)); camera.lookAt(center); camera.updateMatrixWorld()
          reference.children.map((mesh, id) => ({ mesh, id, distance: mesh.geometry.boundingSphere.center.distanceToSquared(camera.position) }))
            .sort((a, b) => b.distance - a.distance || a.id - b.id).forEach((row, index) => { row.mesh.renderOrder = index })
          renderer.render(scene, camera); const actual = pixels()
          check(renderer.info.render.calls === 1, 'Glass colours must share a sorted draw: ' + name)
          if (wide) atlasCases++
          let material
          object.traverse(o => { if (o.material?.translucentMaps) material = o.material })
          const version = material.map.version
          renderer.render(scene, camera)
          check(material.map.version === version, 'Unchanged atlas does not upload again')
          if (i === 0 && (name === 'colours' || name === 'layers')) window.__glassShots[(pack ? 'xk-' : 'vanilla-') + name] = renderer.domElement.toDataURL()
          renderer.render(refScene, camera); const expected = pixels()
          let fractional = 0
          for (let p = 0; p < actual.length; p++) {
            const error = Math.abs(actual[p] - expected[p]); maxError = Math.max(maxError, error)
            check(error <= 2, `Glass pixel mismatch ${error}: ${pack}/${name}/${i}, channel ${p}`)
            if (p % 4 === 3 && actual[p] > 0 && actual[p] < 255) fractional++
          }
          check(fractional > 100, 'Visible glass must retain partial alpha: ' + name)
          cases++
        }
        if (wide) {
          let material
          object.traverse(o => { if (o.material?.translucentMaps) material = o.material })
          const map = material.translucentMaps[0], original = map.image
          const canvas = document.createElement('canvas'); canvas.width = original.width; canvas.height = original.height
          const context = canvas.getContext('2d'); context.fillStyle = 'rgba(224, 40, 140, .6)'; context.fillRect(0, 0, canvas.width, canvas.height)
          map.image = canvas; map.needsUpdate = true
          const version = material.map.version
          renderer.render(scene, camera); const actual = pixels()
          check(material.map.version === version + 1, 'Changed source frame refreshes the atlas once')
          renderer.render(refScene, camera); const expected = pixels()
          check(actual.every((v, p) => Math.abs(v - expected[p]) <= 2), 'Animated/replaced source keeps exact atlas pixels')
          map.image = original; map.needsUpdate = true
          let disposed = 0
          material.map.addEventListener('dispose', () => disposed++)
          dispose(object)
          check(disposed === 1, 'Private atlas released with its material')
        } else dispose(object)
        dispose(reference)
      }
      for (const id of ['red_stained_glass', 'red_stained_glass_pane']) {
        for (const make of [buildItemPreview, buildGuiItem]) {
          const item = await make({ id: 'minecraft:' + id, count: 1 }, assets), scene = sceneFor(item)
          const camera = new THREE.PerspectiveCamera(40, 1, .01, 100); camera.position.set(1, 1, 3); camera.lookAt(0, 0, 0)
          renderer.render(scene, camera)
          check(pixels().some((v, i) => i % 4 === 3 && v > 0 && v < 255), 'Glass/pane item has translucent pixels')
          dispose(item)
        }
      }
    }
    return { cases, atlasCases, maxError }
  } finally { assets.clearCaches() }
}
