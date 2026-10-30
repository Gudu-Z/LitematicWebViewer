import * as THREE from 'three'
import * as compact from '/src/compactFaceMesh.js'
import { enableSpatialFaces } from '/src/spatialFaces.js'
import { spatialFixture } from './spatial-face-fixture.js'

// Both paths consume exactly the same face data; the baseline retains one draw.
const makeMesh = (data, material, spatial) => {
  const mesh = new compact.CompactFaceMesh(data, material)
  if (spatial) enableSpatialFaces(mesh, { batchFaces: 4096, minFaces: 8192 })
  return mesh
}
const width = 640, height = 480
function texture() {
  const pixels = new Uint8Array([
    255, 40, 70, 255, 20, 240, 40, 0,
    30, 80, 255, 255, 250, 220, 30, 255,
  ])
  const map = new THREE.DataTexture(pixels, 2, 2)
  map.magFilter = map.minFilter = THREE.NearestFilter; map.generateMipmaps = false; map.needsUpdate = true
  return map
}
function createView(data, spatial, transparent, transform) {
  const scene = new THREE.Scene(), parent = new THREE.Group(), map = texture()
  scene.background = new THREE.Color('#132333'); scene.add(parent)
  parent.position.set(...transform.position); parent.rotation.y = transform.rotation
  parent.scale.set(...transform.scale)
  const material = new THREE.MeshBasicMaterial({ map, alphaTest: .5, transparent, opacity: transparent ? .6 : 1,
    side: THREE.DoubleSide, forceSinglePass: !transparent })
  const mesh = makeMesh(data, material, spatial)
  parent.add(mesh)
  // A separate transparent object challenges source-vs-other-object ordering.
  const bounds = data.worldBounds
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(bounds[3] - bounds[0] + 2, bounds[4] - bounds[1] + 2),
    new THREE.MeshBasicMaterial({ color: '#e040c0', transparent: true, opacity: .17, side: THREE.DoubleSide }))
  overlay.position.set((bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2)
  parent.add(overlay); scene.updateMatrixWorld(true)
  return { scene, parent, mesh, dispose() {
    scene.traverse(object => object.geometry?.dispose()); material.dispose(); overlay.material.dispose(); map.dispose()
  } }
}
function imageData(pixels) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d'), image = context.createImageData(width, height)
  for (let y = 0; y < height; y++) image.data.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4)
  context.putImageData(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1]
}

window.runSpatialFaces = async () => {
  const powerPreference = new URLSearchParams(location.search).get('powerPreference') || 'default'
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference })
  renderer.setSize(width, height); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.append(renderer.domElement)
  const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info')
  let uploadedBytes = 0
  const bufferData = gl.bufferData.bind(gl), bufferSubData = gl.bufferSubData.bind(gl)
  gl.bufferData = (...args) => { uploadedBytes += typeof args[1] === 'number' ? args[1] : args[1]?.byteLength || 0; return bufferData(...args) }
  gl.bufferSubData = (...args) => { uploadedBytes += args[2]?.byteLength || 0; return bufferSubData(...args) }
  const gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  const results = [], failures = []
  let changedPixels = 0, pixelSamples = 0, reduced = 0
  const capture = (view, camera, activeRenderer = renderer) => {
    const beforeUpload = uploadedBytes
    activeRenderer.render(view.scene, camera)
    const context = activeRenderer.getContext(), pixels = new Uint8Array(width * height * 4)
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels)
    if (context.getError() !== context.NO_ERROR) throw Error('WebGL error during spatial comparison')
    return { pixels, render: { ...activeRenderer.info.render }, uploadBytes: uploadedBytes - beforeUpload }
  }
  try {
    for (const wide of [false, true]) for (const transparent of [false, true]) {
      // The transparent fallback exercises separated layers and both side passes.
      // Large opaque fixtures retain deliberate coplanar/overlapping stress cases.
      const fixture = spatialFixture({ repetitions: transparent ? 8 : 8192, wide, layered: transparent }), { data, clusters } = fixture
      for (const transform of [
        { position: [0, 0, 0], rotation: 0, scale: [1, 1, 1] },
        { position: [5, 7, -9], rotation: .13, scale: [1.2, .9, 1.1] },
      ]) {
        const views = [createView(data, false, transparent, transform), createView(data, true, transparent, transform)]
        try {
          const center = new THREE.Vector3().fromArray(data.worldBounds).add(new THREE.Vector3().fromArray(data.worldBounds, 3)).multiplyScalar(.5)
          const poses = [['whole', center, Math.max(fixture.bounds.width, fixture.bounds.depth) * 1.5],
            ...clusters.map((point, index) => ['near-' + index, new THREE.Vector3(...point), 30])]
          for (let index = 0; index < poses.length; index++) {
            const [name, localTarget, halfWidth] = poses[index], target = localTarget.clone().applyMatrix4(views[0].parent.matrixWorld)
            const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfWidth * height / width, -halfWidth * height / width, .01, 40000)
            camera.position.copy(target).add(new THREE.Vector3(0, 0, name === 'whole' ? 16000 : 60)); camera.lookAt(target); camera.updateMatrixWorld(true)
            if (name !== 'whole') { camera.far = 120; camera.updateProjectionMatrix() }
            const shots = views.map(view => capture(view, camera))
            let changed = 0, colored = 0
            for (let i = 0; i < shots[0].pixels.length; i += 4) {
              if ([0, 1, 2, 3].some(c => shots[0].pixels[i + c] !== shots[1].pixels[i + c])) changed++
              if ([0, 1, 2].some(c => shots[0].pixels[i + c] !== shots[0].pixels[c])) colored++
            }
            if (!colored) throw Error('Empty spatial comparison scene')
            if (name === 'whole' && shots[0].render.triangles !== shots[1].render.triangles) throw Error('Overview omitted or duplicated faces')
            if (name === 'whole' && shots[1].uploadBytes > shots[0].uploadBytes) throw Error('Spatial batches duplicate GPU buffers')
            if (name !== 'whole' && shots[1].uploadBytes) throw Error('Camera changes reupload immutable face buffers')
            if (!transparent && name !== 'whole' && shots[1].render.triangles < shots[0].render.triangles * .6) reduced++
            if (changed) {
              const repeatChanges = views.map((view, j) => {
                const again = capture(view, camera); let count = 0
                for (let i = 0; i < again.pixels.length; i += 4) if ([0,1,2,3].some(c => again.pixels[i+c] !== shots[j].pixels[i+c])) count++
                return count
              })
              const diff = new Uint8Array(shots[0].pixels.length)
              for (let i = 0; i < diff.length; i += 4) { diff[i + 3] = 255; if ([0,1,2,3].some(c => shots[0].pixels[i+c] !== shots[1].pixels[i+c])) diff[i] = 255 }
              failures.push({ pack: 'synthetic', scenario: (wide ? 'wide' : 'normal') + (transparent ? '-blend' : '-cutout'), layer: transform.rotation ? 'transformed' : 'identity', index,
                repeatChanges,
                images: { baseline: imageData(shots[0].pixels), spatial: imageData(shots[1].pixels), diff: imageData(diff) } })
            }
            changedPixels += changed; pixelSamples += width * height
            results.push({ wide, transparent, transformed: !!transform.rotation, name, changed, colored,
              uploadBytes: shots.map(shot => shot.uploadBytes), baseline: shots[0].render, spatial: shots[1].render })
            console.log('STAGE', JSON.stringify(results.at(-1)))
          }
          if (!wide && !transparent && !transform.rotation) {
            // Export uses a separate WebGLRenderer and a new perspective camera.
            const exporter = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference })
            exporter.setSize(width, height); exporter.setPixelRatio(1); exporter.outputColorSpace = THREE.SRGBColorSpace
            try {
              const camera = new THREE.PerspectiveCamera(60, width / height, .01, 120)
              const target = new THREE.Vector3(...clusters[0])
              camera.position.copy(target).add(new THREE.Vector3(0, 0, 45)); camera.lookAt(target); camera.updateMatrixWorld(true)
              const shots = views.map(view => capture(view, camera, exporter))
              let changed = 0
              for (let i = 0; i < shots[0].pixels.length; i += 4) if ([0,1,2,3].some(c => shots[0].pixels[i+c] !== shots[1].pixels[i+c])) changed++
              if (changed) failures.push({ pack: 'synthetic', scenario: 'separate-export', layer: 'identity', index: 0,
                images: { baseline: imageData(shots[0].pixels), spatial: imageData(shots[1].pixels) } })
              changedPixels += changed; pixelSamples += width * height
              results.push({ name: 'separate-export-renderer', changed, baseline: shots[0].render, spatial: shots[1].render })
            } finally { exporter.dispose(); exporter.forceContextLoss() }
          }
        } finally { views.forEach(view => view.dispose()) }
      }
    }
    if (reduced < 6) throw Error('Spatial path did not remove offscreen drawing')
    if (renderer.info.memory.geometries || renderer.info.memory.textures) throw Error('Spatial geometry or template textures leaked after scene disposal')
    return { gpu, changedPixels, pixelSamples, results, failures, reduced }
  } finally { renderer.dispose() }
}
