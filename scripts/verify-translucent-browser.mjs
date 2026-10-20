// Optional real WebGL check: node scripts/verify-translucent-browser.mjs
// CHROME_PATH can select a local Chromium executable. No remote requests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

async function verifyInBrowser() {
  const { THREE, JSZip } = await import('/__translucent-dependencies.js')
  const { AssetProvider } = await import('/src/assets.js')
  const { BlockModelResolver } = await import('/src/blocks.js')
  const { buildFaceGroups } = await import('/src/geometry.js')
  const { Renderer } = await import('/src/renderer.js')
  const { buildItemPreview, buildEntityMesh } = await import('/src/entities.js')
  const check = (ok, message) => { if (!ok) throw Error(message) }
  const dispose = root => {
    const gs = new Set(), ms = new Set()
    root.traverse(o => { if (o.geometry) gs.add(o.geometry); if (o.material) ms.add(o.material) })
    gs.forEach(g => g.dispose()); ms.forEach(m => m.dispose())
  }
  const sceneFor = root => {
    const scene = new THREE.Scene(); scene.add(root, new THREE.AmbientLight(0xffffff, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(3, 8, -4); scene.add(sun)
    return scene
  }
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true })
  renderer.setSize(192, 192)
  const assets = new AssetProvider(); assets.baseUrl = '/assets/minecraft/'
  let cases = 0, maxError = 0
  const pixels = () => {
    const gl = renderer.getContext(), out = new Uint8Array(192 * 192 * 4)
    gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, out)
    check(gl.getError() === 0, 'WebGL error'); return out
  }
  try {
    for (const pack of [false, true]) {
      if (pack) assets.addPack(await JSZip.loadAsync(await (await fetch('/resourcepacks/XK redstone display 26.3.0.zip')).arrayBuffer()), 'XK')
      const resolver = new BlockModelResolver(assets)
      const palette = await Promise.all(['slime_block', 'honey_block'].map(async id => ({ name: 'minecraft:' + id, baked: await resolver.resolve(id, {}) })))
      for (const entries of [[[0, 0]], [[0, 1]], [[0, 0], [1, 0]], [[0, 1], [1, 1]], [[0, 0], [1, 1], [4, 0], [5, 1]]]) {
        const data = { palette, blocks: new Map(entries), bounds: { minX: 0, minY: 0, minZ: 0, width: 2, height: 2, depth: 2 } }
        const object = await Renderer.buildBlockPreview(data, assets), scene = sceneFor(object), reference = new THREE.Group()
        const { groups } = await buildFaceGroups(palette, data.blocks, data.bounds)
        // Reference uses ordinary Three materials, one original model face per
        // draw, and an independent draw order. No production shader/sorter reuse.
        for (const [key, g] of groups) {
          const map = await assets.getTexture(key.split('|')[0])
          for (let i = 0; i < g.positions.length / 12; i++) {
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute('position', new THREE.BufferAttribute(g.positions.slice(i * 12, i * 12 + 12), 3))
            geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs.slice(i * 8, i * 8 + 8), 2))
            geometry.setIndex([0, 1, 2, 2, 1, 3]); geometry.computeBoundingSphere()
            reference.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map, flatShading: true, transparent: true, alphaTest: .001, depthWrite: true, side: THREE.FrontSide })))
          }
        }
        const refScene = sceneFor(reference), camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, .1, 100)
        for (const angle of [[4, 3, 5], [-4, 3, 5], [4, 3, -5], [-4, -3, -5], [.5, .5, 8], [.5, 8, .5]]) {
          camera.position.fromArray(angle); camera.lookAt(.7, .6, .5); camera.updateMatrixWorld()
          reference.children.map((mesh, index) => ({ mesh, index, distance: mesh.geometry.boundingSphere.center.distanceToSquared(camera.position) }))
            .sort((a, b) => b.distance - a.distance || a.index - b.index).forEach((r, i) => { r.mesh.renderOrder = i })
          renderer.render(scene, camera); const actual = pixels()
          check(renderer.info.render.calls === 1, 'Slime/honey surfaces must share one draw call')
          renderer.render(refScene, camera); const expected = pixels()
          let translucent = 0
          for (let i = 0; i < actual.length; i++) {
            const error = Math.abs(actual[i] - expected[i]); maxError = Math.max(maxError, error)
            if (error > 1) throw Error(`Pixel error ${error}: pack=${pack}, cells=${JSON.stringify(entries)}, camera=${angle}, channel=${i}`)
            if (i % 4 === 3 && actual[i] > 0 && actual[i] < 255) translucent++
          }
          check(translucent > 200, 'Expected visible semitransparent shells'); cases++
        }
        dispose(object); dispose(reference)
      }
      for (const id of ['slime_block', 'honey_block']) {
        const item = { id: 'minecraft:' + id, count: 1 }, root = new THREE.Group()
        root.add(await buildItemPreview(item, assets))
        const scene = sceneFor(root), camera = new THREE.PerspectiveCamera(40, 1, .01, 100)
        camera.position.set(2, 2, -4); camera.lookAt(.4, 0, 0); camera.updateMatrixWorld()
        renderer.render(scene, camera); check(pixels().some((v, i) => i % 4 === 3 && v > 0 && v < 255), 'Standalone items preserve alpha')
        for (const x of [0, .8]) root.add(await buildEntityMesh({ id: 'minecraft:item_frame', pos: [x, 0, 0], rotation: [0, 0], nbt: { Facing: 2, Item: item } }, assets))
        // The opaque frame backing makes composite alpha=1; it must still draw
        // correctly with both independent cached transparent item instances.
        renderer.render(scene, camera); check(pixels().some((v, i) => i % 4 === 3 && v > 0), 'Cached frames render')
        dispose(root)
      }
    }
    return { cases, maxError }
  } finally { renderer.dispose(); assets.clearCaches() }
}

const server = await createServer({
  plugins: [{ name: 'translucent-test-dependencies',
    resolveId(id) { if (['/__translucent-dependencies.js', '/__translucent-entry.js'].includes(id)) return id },
    load(id) {
      if (id === '/__translucent-dependencies.js') return 'export * as THREE from "three"; export { default as JSZip } from "jszip";'
      if (id === '/__translucent-entry.js') return `(${verifyInBrowser.toString()})().then(result => { window.__translucentResult = { result } }).catch(error => { window.__translucentResult = { error: error.stack } });`
    },
    configureServer(server) {
      server.middlewares.use('/__translucent-check', (_req, res) => {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Translucent blocks</title><script type="module" src="/__translucent-entry.js"></script>')
      })
    },
  }],
  optimizeDeps: { include: ['three', 'jszip'] },
  server: { host: '127.0.0.1', port: 5198, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/scripts/_ref/**'] } },
})
await server.listen()
const profile = resolve('scripts/_ref/translucent-browser-' + Date.now()); await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--disable-background-networking',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
try {
  let port
  for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {} if (!port) await delay(100) }
  assert.ok(port, 'Chrome started')
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0; const pending = new Map(), errors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result) }
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.description ?? a.value))
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)) }, 60000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:5198/__translucent-check' }); await delay(200)
  let result
  for (let i = 0; i < 200 && !result; i++) {
    result = (await send('Runtime.evaluate', { expression: 'window.__translucentResult', returnByValue: true })).result?.value
    if (!result) await delay(100)
  }
  assert.ok(result, 'Browser check completed'); assert.equal(result.error, undefined, result.error)
  assert.deepEqual(errors, [], 'No WebGL shader/JavaScript errors')
  console.log('PASS real WebGL translucent blocks:', result.result)
} finally { socket?.close(); chrome.kill(); await server.close() }
