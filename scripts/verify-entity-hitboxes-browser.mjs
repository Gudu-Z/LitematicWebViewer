import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
// Run npm run build first. Uses a fresh browser profile and the production bundle.
const profile = resolve('scripts/_ref/hitboxes-chrome-profile-' + Date.now())
await mkdir(profile, { recursive: true }); await unlink(resolve(profile, 'DevToolsActivePort')).catch(() => {})
const vite = spawn(process.execPath, ['--input-type=module', '--eval', "import {preview} from 'vite';await preview({preview:{host:'127.0.0.1',port:5178,strictPort:true,open:false}})"], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let chrome, socket, log = ''
vite.stderr.on('data', b => log += String(b))
try {
  for (let i = 0; i < 250; i++) { try { if ((await fetch('http://127.0.0.1:5178/')).ok) break } catch {} await delay(100) }
  const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium')
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr.on('data', b => log += String(b))
  let port
  for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {} if (!port) await delay(100) }
  assert.ok(port, 'Chrome failed: ' + log.slice(-1000))
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let nextId = 0
  const pending = new Map(), errors = []
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data)
    if (m.id) { const callback = pending.get(m.id); if (!callback) return; pending.delete(m.id); clearTimeout(callback.timer); m.error ? callback.reject(Error(JSON.stringify(m.error))) : callback.resolve(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => reject(Error(method + ' timeout')), 60000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value }

  const waitFor = async expression => {
    for (let i = 0; i < 240; i++) { if (await evaluate(expression)) return; await delay(150) }
    throw Error('Timed out: ' + expression + '\n' + errors.join('\n'))
  }
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const change = async (id, checked) => {
    await evaluate(`(()=>{const e=document.getElementById('${id}');e.checked=${checked};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await frame()
  }
  const navigate = async url => {
    await evaluate('window.oldTestDocument = true')
    await send(url ? 'Page.navigate' : 'Page.reload', url ? { url } : {})
    await waitFor('!window.oldTestDocument && document.readyState === "complete"')
  }
  const shortcut = async () => {
    for (const [type, key, code, v] of [['keyDown', 'F3', 'F3', 114], ['keyDown', 'b', 'KeyB', 66], ['keyUp', 'b', 'KeyB', 66], ['keyUp', 'F3', 'F3', 114]]) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: v })
  }
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile('scripts/_ref/' + name + '.png', Buffer.from(result.data, 'base64'))
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false })
  await navigate('http://127.0.0.1:5178/scripts/entity-preview.html?scope=mob&q=zombie&pack=vanilla')
  await waitFor('window.ready && window.renderCheck && !renderCheck.settings.busy')
  assert.equal(await evaluate('document.getElementById("entity-hitboxes").checked'), false)
  await evaluate(`window.hitboxList = root => {const all=[]; root.traverse(o=>{if(o.userData.isEntityHitbox)all.push(o)});return all}; window.firstView=renderCheck.scenes[0]; window.firstCamera=JSON.stringify(firstView.camera.matrixWorld.elements); document.getElementById('pause').click()`)
  await shortcut()
  assert.ok(await evaluate('renderCheck.settings.hitboxes && renderCheck.scenes.every(v=>hitboxList(v.group).length===1)'))
  assert.equal(await evaluate('JSON.stringify(firstView.camera.matrixWorld.elements)'), await evaluate('firstCamera'), 'toggle keeps catalog camera')
  assert.ok(await evaluate('renderCheck.scenes[0]===firstView'), 'toggle keeps existing models')
  await evaluate('document.querySelector(\'[data-key="mob/zombie"]\').click()')
  await waitFor('renderCheck.detailView && document.getElementById("detail").open')
  await evaluate('window.detailBefore=renderCheck.detailView; window.oldBox=detailBefore.group.userData.entityHitbox.bounds; document.getElementById("reset-view").focus()')
  assert.equal(await evaluate('hitboxList(renderCheck.detailView.group).filter(o=>o.visible).length'), 1)
  await screenshot('entity-hitboxes-adult')
  await shortcut()
  assert.ok(await evaluate('renderCheck.detailView===detailBefore && hitboxList(detailBefore.group).every(o=>!o.visible)'), 'detail toggles without rebuild')
  await shortcut()
  await evaluate(`(()=>{const age=document.querySelector('[data-path="nbt.Age"]'); if(!age)throw Error('Baby option missing');age.selectedIndex=1;age.dispatchEvent(new Event('change'));age.blur()})()`)
  await waitFor('renderCheck.detailView !== detailBefore && renderCheck.detailView?.group.userData.entityHitbox.bounds.max[1]<1')
  await screenshot('entity-hitboxes-baby')
  await evaluate('document.getElementById("close-detail").click(); document.getElementById("language").click()')
  await waitFor('window.ready && document.documentElement.lang==="en"')
  assert.equal(await evaluate('document.getElementById("entity-hitboxes").nextElementSibling.textContent'), 'Show entity hitboxes')
  await navigate()
  await waitFor('window.ready && window.renderCheck && !renderCheck.settings.busy')
  assert.ok(await evaluate('renderCheck.settings.hitboxes && renderCheck.scenes.every(v=>{let n=0;v.group.traverse(o=>{if(o.userData.isEntityHitbox&&o.visible)n++});return n===1})'), 'catalog preference restored')
  await evaluate('document.getElementById("open-settings").click()')
  await screenshot('entity-hitboxes-settings')

  // Upload an actual small schematic through the main viewer's ordinary file input.
  const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
  const double = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
  const float = n => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
  const string = s => { const b = Buffer.from(s), length = Buffer.alloc(2); length.writeUInt16BE(b.length); return Buffer.concat([length, b]) }
  const tag = (type, name, data) => Buffer.concat([Buffer.from([type]), string(name), data])
  const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])])
  const list = (type, items) => Buffer.concat([Buffer.from([type]), int(items.length), ...items])
  const vec = xyz => compound(...xyz.map((v, i) => tag(3, 'xyz'[i], int(v))))
  const mob = (id, pos, extra = []) => compound(tag(8, 'id', string('minecraft:' + id)), tag(9, 'Pos', list(6, pos.map(double))), tag(9, 'Rotation', list(5, [0, 0].map(float))), ...extra)
  const blocks = Buffer.alloc(48)
  for (let i = 0; i < 48; i++) { const long = Math.floor(i / 32), bit = BigInt(i % 32 * 2); blocks.writeBigUInt64BE(blocks.readBigUInt64BE(long * 8) | (1n << bit), long * 8) }
  const region = compound(tag(10, 'Position', vec([0, 0, 0])), tag(10, 'Size', vec([8, 4, 6])),
    tag(9, 'BlockStatePalette', list(10, ['air', 'stone'].map(id => compound(tag(8, 'Name', string('minecraft:' + id)))))),
    tag(12, 'BlockStates', Buffer.concat([int(6), blocks])),
    tag(9, 'Entities', list(10, [mob('armor_stand', [1.5, 1, 2]), mob('armor_stand', [3, 1, 2], [tag(1, 'Small', Buffer.from([1]))]), mob('oak_boat', [5.5, 1, 3], [tag(9, 'Passengers', list(10, [mob('pig', [5.5, 1.1875, 3])]))])])),
  )
  const file = resolve('scripts/_ref/hitboxes.litematic')
  await writeFile(file, gzipSync(tag(10, '', compound(tag(3, 'Version', int(7)), tag(10, 'Regions', compound(tag(10, 'hitboxes', region)))))))
  await navigate('http://127.0.0.1:5178/?pack=vanilla')
  await waitFor('document.querySelector("#viewer canvas") && document.getElementById("showEntityHitboxes") && !document.getElementById("showEntityHitboxes").disabled')
  assert.equal(await evaluate('document.getElementById("showEntityHitboxes").checked'), false, 'main preference separate from catalog')
  const input = await send('Runtime.evaluate', { expression: 'document.getElementById("fileInput")' })
  await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [file] })
  await waitFor('document.body.classList.contains("has-model") && !document.getElementById("imageExportBtn").disabled')
  await shortcut()
  assert.ok(await evaluate('document.getElementById("showEntityHitboxes").checked'))
  await screenshot('entity-hitboxes-main')
  await evaluate('document.getElementById("imageExportBtn").click()')
  await waitFor('!document.getElementById("exportSave").disabled && document.getElementById("imageExport").open')
  await frame()
  const on = await evaluate('document.querySelector("#exportFrame canvas").toDataURL()')
  await change('showEntityHitboxes', false)
  const off = await evaluate('document.querySelector("#exportFrame canvas").toDataURL()')
  assert.ok(on !== off, 'hitboxes render in the real main/export scene')
  await change('showEntityHitboxes', true)
  await evaluate('document.getElementById("exportBack").click()')
  await navigate()
  await waitFor('document.getElementById("showEntityHitboxes") && !document.getElementById("showEntityHitboxes").disabled')
  assert.ok(await evaluate('document.getElementById("showEntityHitboxes").checked'), 'main preference restored')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('Browser hitboxes: catalog/detail toggles, cameras, babies, English, saved preferences, real schematic and export rendering passed; no browser errors.')
} catch (error) { console.error(log.slice(-3000)); throw error }
finally { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); socket?.close(); chrome?.kill(); vite.kill() }
