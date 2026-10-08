// Run after npm run build; optional --url=https://host/ checks the deployed site.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { preview } from 'vite'

const remote = process.argv.find(arg => arg.startsWith('--url='))?.slice(6)
const server = remote ? null : await preview({ base: '/LitematicWebViewer/', preview: { host: '127.0.0.1', port: 5187, strictPort: true, open: false } })
const base = remote || 'http://127.0.0.1:5187/LitematicWebViewer/'
const profile = resolve('scripts/_ref/release-26.3-browser-profile')
await mkdir(profile, { recursive: true })
await unlink(resolve(profile, 'DevToolsActivePort')).catch(() => {})
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
const errors = [], results = []
try {
  let port
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {}
    if (!port) await delay(100)
  }
  assert.ok(port, 'Chrome startup')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map(); let serial = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id); if (!callback) return
      pending.delete(message.id); clearTimeout(callback.timer)
      if (message.error) callback.reject(Error(JSON.stringify(message.error))); else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await delay(100) }
    const state = await evaluate(`({message:document.getElementById('model-message')?.textContent,detail:document.getElementById('detail')?.open,failures:window.renderCheck?.failures})`)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile('scripts/_ref/release-26.3-browser-failure.png', Buffer.from(screenshot.data, 'base64'))
    throw Error('Page timeout: ' + expression + ' ' + JSON.stringify({ state, errors }))
  }
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: new URL('scripts/entity-preview.html', base).href })
  await until('window.ready === true')
  assert.equal(await evaluate('renderCheck.catalog.filter(e => e.kind === "mob").length'), 90)
  const ready = () => until('!!renderCheck.detailView && !/加载|Loading/i.test(document.getElementById("model-message").textContent)')
  async function open(kind, id) {
    await evaluate(`if(document.getElementById('detail').open) document.getElementById('close-detail').click()`)
    await until(`!document.getElementById('detail').open && !renderCheck.detailView`)
    await evaluate(`(() => {
      const scope=document.getElementById('scope'); scope.value=${JSON.stringify(kind)}; scope.dispatchEvent(new Event('change'));
      const search=document.getElementById('search'); search.value=${JSON.stringify(id)}; search.dispatchEvent(new Event('input'));
    })()`)
    await until(`window.ready && !!document.querySelector('[data-key="${kind}/${id}"]')`)
    await evaluate(`document.querySelector('[data-key="${kind}/${id}"]').click()`)
    await ready()
  }
  async function field(path, value) {
    await evaluate(`(() => {
      const select=document.querySelector('[data-path="${path}"]'); if(!select) throw Error('Missing field ${path}');
      const option=${typeof value === 'number' ? `select.options[${value}]` : `[...select.options].find(o => new RegExp(${JSON.stringify(value)},'i').test(o.textContent))`};
      if(!option) throw Error('Missing option ${path}'); select.value=option.value; select.dispatchEvent(new Event('change'));
    })()`)
    await ready()
  }
  async function check(label, minColors = 16) {
    await delay(150)
    const result = await evaluate(`(() => {
      const group=renderCheck.detailView.group; let meshes=0, invalid=0, textures=0;
      group.updateMatrixWorld(true);
      group.traverse(o => { if(!o.isMesh) return; meshes++;
        if(o.material?.map) textures++;
        for(const attribute of Object.values(o.geometry.attributes)) for(const n of attribute.array) if(!Number.isFinite(n)) invalid++;
        for(const n of o.matrixWorld.elements) if(!Number.isFinite(n)) invalid++;
      });
      const renderer=renderCheck.detailRenderer, gl=renderer.getContext();
      renderer.render(renderCheck.detailView.scene,renderCheck.detailView.camera);
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const colors=new Set(); for(let i=0;i<pixels.length;i+=4) colors.add(pixels[i]*65536+pixels[i+1]*256+pixels[i+2]);
      return {meshes,invalid,textures,colors:colors.size,mob:group.userData.mobId,message:document.getElementById('model-message').textContent,failures:renderCheck.failures};
    })()`)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`scripts/_ref/release-26.3-${label}.png`, Buffer.from(screenshot.data, 'base64'))
    assert.ok(result.meshes > 0 && result.textures > 0, label + ' textured geometry')
    assert.equal(result.invalid, 0, label + ' finite vertices/matrices')
    assert.ok(result.colors > minColors, label + ' rendered pixels, not a blank canvas: ' + JSON.stringify(result))
    assert.deepEqual(result.failures, []); assert.ok(!/失败|Failed/i.test(result.message))
    results.push({ label, ...result }); console.log('PASS', label, result.meshes, result.colors)
  }
  for (const id of ['camel_husk', 'nautilus', 'zombie_nautilus', 'parched', 'sulfur_cube']) {
    await open('mob', id); await check(id)
    assert.equal(results.at(-1).mob, id)
  }
  await field('nbt.equipment.body', 'TNT'); await check('sulfur-tnt')
  await open('mob', 'nautilus'); await field('nbt.Age', 1); await check('nautilus-baby')
  await open('mob', 'zombie_nautilus'); await field('nbt.variant', 1); await check('nautilus-coral')
  await field('nbt.equipment.body', '钻石|Diamond'); await field('nbt.equipment.saddle', 1); await check('nautilus-armored')
  await open('block', 'oak_hanging_sign'); await field('attached', '^(否|No)$'); await field('rotation', '^3$'); await check('hanging-sign-rotation3')
  await open('block', 'lectern'); await field('has_book', '^(是|Yes)$'); await check('lectern-book')
  await open('block', 'copper_golem_statue')
  for (const pose of ['standing', 'running', 'sitting', 'star']) {
    await field('copper_golem_pose', { standing: '站立|Standing', running: '奔跑|Running', sitting: '坐下|Sitting', star: '星形|Star' }[pose]); await check('statue-' + pose)
  }
  await open('block', 'moving_piston'); await check('moving-stone')
  await field('preview_moved_block', '黏性活塞|Sticky Piston'); await field('preview_source', '^(是|Yes)$'); await field('preview_extending', '收回|Retracting'); await check('retracting-piston')
  await open('mob', 'cat'); await field('nbt.variant', '^(黑色|Black)$'); await check('black-cat')
  await open('block', 'light')
  await evaluate(`(() => { const select=document.getElementById('view-mode'); select.value='item'; select.dispatchEvent(new Event('change')) })()`)
  // This flat, nearest-filtered icon has a deliberately small color palette.
  await ready(); await check('light-item', 4)
  assert.deepEqual(errors, [], 'No WebGL/JavaScript errors')
  await writeFile('scripts/_ref/release-26.3-browser-results.json', JSON.stringify({ base, results, errors }, null, 2))
  console.log('Browser 26.3 coverage passed:', results.length, 'rendered states')
} finally {
  socket?.close(); chrome.kill()
  await server?.httpServer.close()
}
