// Run after npm run build. --large also runs the automatic whole-scene tests
// against the two private local originals after the manual-range checks finish.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { preview } from 'vite'

const server = await preview({ base: '/LitematicWebViewer/', preview: { host: '127.0.0.1', port: 5196, strictPort: true, open: false } })
const profile = resolve('scripts/_ref/window-browser-' + Date.now())
await mkdir(profile, { recursive: true })
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
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 600; i++) { if (await evaluate(expression)) return; await delay(200) }
    throw Error('Page timeout: ' + expression + ' ' + JSON.stringify(await evaluate(`({status:document.getElementById('status')?.textContent,dialog:document.getElementById('schematicLoad')?.textContent,error:document.getElementById('errorBanner')?.textContent})`)))
  }
  const idle = () => until('document.getElementById("app")?.getAttribute("aria-busy")==="false"')
  const choosing = () => until('document.querySelector("#schematicLoad .load-range")?.hidden===false')
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const upload = async file => {
    const input = await send('Runtime.evaluate', { expression: 'document.getElementById("fileInput")' })
    await send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [resolve(file)] })
  }
  const screenshot = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`scripts/_ref/window-${name}.png`, Buffer.from(shot.data, 'base64'))
  }
  async function check(label) {
    await idle(); await delay(200)
    const result = await evaluate(`(() => {
      const c=document.querySelector('#viewer canvas'), gl=c.getContext('webgl2'), pixels=new Uint8Array(c.width*c.height*4);
      gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const colors=new Set(); for(let i=0;i<pixels.length;i+=16) colors.add(pixels[i]*65536+pixels[i+1]*256+pixels[i+2]);
      return {status:document.getElementById('status').textContent,range:document.getElementById('loadedRange').textContent,error:document.getElementById('errorBanner').textContent,colors:colors.size,contextLost:gl.isContextLost()};
    })()`)
    assert.equal(result.error, '', label + ': ' + result.error)
    assert.match(result.status, /完成|Done/)
    assert.ok(result.colors > 32, 'Textured geometry rendered: ' + JSON.stringify(result))
    assert.equal(result.contextLost, false)
    await screenshot(label)
    console.log('PASS', label, JSON.stringify(result)); results.push({ label, ...result })
  }
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5196/LitematicWebViewer/?pack=vanilla' })
  await idle()
  await upload('samples/demo.litematic'); await check('demo')
  await click('#changeRangeBtn'); await choosing()
  await evaluate(`document.querySelector('[name=minX]').value='';document.querySelector('[name=minX]').dispatchEvent(new Event('input',{bubbles:true}))`)
  assert.equal(await evaluate('document.querySelector(".load-submit").disabled'), true)
  await click('.range-center')
  assert.equal(await evaluate('document.querySelector(".load-submit").disabled'), false)
  await click('.load-cancel'); await idle()
  assert.equal(await evaluate('document.querySelector("#fileName").textContent'), 'demo.litematic')
  await click('#changeRangeBtn'); await choosing(); await click('.load-submit'); await check('demo-range')
  assert.equal(await evaluate('document.querySelector("#loadedRange").hidden'), false)
  await click('#langBtn')
  assert.match(await evaluate('document.querySelector("#loadedRange").textContent'), /Partial preview/)
  await click('#changeRangeBtn'); await choosing()
  assert.equal(await evaluate('document.getElementById("schematicLoadTitle").textContent'), 'Choose a range to load')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate('document.querySelector("#schematicLoad").getBoundingClientRect().right<=innerWidth'))
  await screenshot('mobile-range'); await click('.load-cancel'); await idle()
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await click('#langBtn')

  // The dialog follows host-supplied light themes as well as standalone dark UI.
  await evaluate(`document.documentElement.style.setProperty('--ui-surface','#ffffff');document.documentElement.style.setProperty('--ui-text','#213348')`)
  await click('#changeRangeBtn'); await choosing()
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#schematicLoad")).backgroundColor'), 'rgb(255, 255, 255)')
  await screenshot('light-range'); await click('.load-cancel'); await idle()
  await evaluate(`document.documentElement.style.removeProperty('--ui-surface');document.documentElement.style.removeProperty('--ui-text')`)

  await click('#clearBtn')
  assert.equal(await evaluate('document.querySelector("#changeRangeBtn").hidden'), true)
  assert.equal(await evaluate('document.querySelector("#loadedRange").hidden'), true)
  assert.deepEqual(errors, [])
  await writeFile('scripts/_ref/window-browser-results.json', JSON.stringify(results, null, 2))
  console.log('PASS range validation, cancel, reload, localization, mobile dialog and cleanup')
} finally {
  socket?.close(); chrome.kill()
  await new Promise(resolve => server.httpServer.close(resolve))
}
if (process.argv.includes('--large')) await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/verify-schematic-overview-browser.mjs', '--large'], { windowsHide: true, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(Error('Whole-scene browser checks failed: ' + code)))
})
