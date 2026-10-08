import './embed.css'
import { Renderer } from './renderer.js'
import { AssetProvider } from './assets.js'
import { BlockModelResolver } from './blocks.js'
import { parseLitematica } from './litematica.js'
import { ViewerPacks } from './viewerPacks.js'
import { extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from './schematicDetails.js'
import { PROTOCOL, validFile, fileURL, fetchSchematic, openFullViewer, applyCamera } from './embedProtocol.js'
import { normalizeOptions, applyTheme } from './previewOptions.js'

const params = new URLSearchParams(location.search)
const pack = params.get('pack') === 'vanilla' ? 'vanilla' : 'xk'
let options = normalizeOptions()
try { options = normalizeOptions(Object.fromEntries(['lang', 'theme', 'background', 'ui'].filter(key => params.has(key)).map(key => [key, params.get(key)]))) } catch { /* Ignore invalid URL styling. */ }
const themeMedia = matchMedia('(prefers-color-scheme: dark)')
let background
const words = {
  waiting: ['等待投影文件…', 'Waiting for a schematic…'],
  loading: ['正在加载投影…', 'Loading schematic…'],
  rendering: ['正在生成模型…', 'Building model…'],
  ready: ['左键旋转 · 右键平移 · 滚轮缩放', 'Left-drag orbit · Right-drag pan · Scroll to zoom'],
  touch: ['单指旋转 · 双指平移与缩放', 'One finger to orbit · Two fingers to pan and zoom'],
  fit: ['复位视角', 'Reset view'], full: ['完整预览 ↗', 'Full viewer ↗'],
  open: ['打开完整预览', 'Open full viewer'], retry: ['重试', 'Retry'],
  invalidURL: ['请使用 HTTPS 投影文件直链。', 'Use a direct HTTPS schematic URL.'],
  fileLimit: ['文件必须非空且不超过 64 MiB。', 'File must be nonempty and no larger than 64 MiB.'],
  notSchematic: ['链接返回了网页，请使用投影文件下载地址。', 'The URL returned a web page. Use a schematic download URL.'],
  failed: ['加载失败，请检查文件、网络及下载服务器的跨域设置。', 'Loading failed. Check the file, network and download server CORS settings.'],
  popupBlocked: ['请允许打开新标签页，再点击右上角箭头。', 'Allow popups, then click the arrow to open the viewer.'],
  handoffTimeout: ['文件传递超时，请保持此页面打开并重试。', 'File transfer timed out. Keep this page open and try again.'],
  webgl: ['无法启动 3D 预览，请检查浏览器的 WebGL 支持。', 'Cannot start 3D preview. Check browser WebGL support.'],
}
const t = key => options.labels[({ fit: 'reset', full: 'open', failed: 'error' })[key] || key] ?? words[key]?.[options.lang === 'en' ? 1 : 0] ?? key
const root = document.getElementById('preview'), message = document.getElementById('message')
const status = document.getElementById('status'), progress = document.getElementById('progress')
const retry = document.getElementById('retry'), open = document.getElementById('open')
const fit = document.getElementById('fit')

let parentOrigin = null
try { const value = params.get('parentOrigin'); if (value && new URL(value).origin === value && /^https?:/.test(value)) parentOrigin = value } catch {}
const channel = params.get('channel')
const notify = (type, detail = {}) => {
  if (parentOrigin && channel && parent !== window) parent.postMessage({ protocol: PROTOCOL, channel, type, ...detail }, parentOrigin)
}
let renderer, initialized, current, requested, lastRequest, pumping = false, active = true, controller
let cameraTimer, viewRevision = 0
const assets = new AssetProvider(), resolver = new BlockModelResolver(assets)

function refreshUI() {
  const values = applyTheme(document.documentElement, options, themeMedia.matches)
  background = values.background
  document.documentElement.lang = options.lang === 'en' ? 'en' : 'zh-CN'
  document.documentElement.style.colorScheme = values.theme
  document.title = (options.lang === 'en' ? 'Schematic preview' : '投影预览卡片') + ' | LitematicWebViewer'
  document.body.style.background = background
  root.dataset.ui = options.ui
  open.title = open.ariaLabel = t('full'); retry.textContent = t('retry')
  open.textContent = t('full'); fit.textContent = t('fit')
  if (root.dataset.state === 'waiting') status.textContent = t('waiting')
  if (root.dataset.state === 'loading') status.textContent = t('loading')
  fit.hidden = !options.controls.reset; open.hidden = !options.controls.open
  message.hidden = root.dataset.state === 'loaded' || !options.controls.status
  const hint = document.getElementById('hint')
  hint.hidden = !options.controls.hint
  const touch = matchMedia('(pointer: coarse)').matches, en = options.lang === 'en', i = options.interaction
  hint.textContent = options.labels.hint ?? [
    i.rotate && (en ? touch ? 'One finger to orbit' : 'Left-drag orbit' : touch ? '单指旋转' : '左键旋转'),
    i.pan && (en ? touch ? 'Two fingers to pan' : 'Right-drag pan' : touch ? '双指平移' : '右键平移'),
    i.zoom && (en ? touch ? 'Pinch to zoom' : 'Scroll to zoom' : touch ? '双指缩放' : '滚轮缩放'),
  ].filter(Boolean).join(' · ')
  if (renderer) {
    renderer.setBackgroundColor(background)
    renderer.setUnderwaterFogEnabled(background !== 'transparent')
    Object.assign(renderer.controls, { enableRotate: i.rotate, enablePan: i.pan, enableZoom: i.zoom, autoRotate: i.autoRotate, autoRotateSpeed: i.autoRotateSpeed })
  }
}
function cameraSnapshot() {
  return { projection: renderer.getProjectionMode(), position: renderer.camera.position.toArray(), target: renderer.controls.target.toArray(), zoom: renderer.camera.zoom, height: renderer.camera.isOrthographicCamera ? renderer.camera.top - renderer.camera.bottom : null }
}
function cameraChanged() {
  if (cameraTimer || !current) return
  cameraTimer = setTimeout(() => { cameraTimer = null; if (current) notify('camera', { camera: cameraSnapshot() }) }, 100)
}
function configureCamera(reset = false) {
  if (!renderer || !current) return
  const camera = options.camera
  renderer.setProjectionMode(camera.projection)
  if (reset) renderer.fitToBounds(current.bounds)
  if (camera.position) applyCamera(renderer, camera)
  else {
    renderer.camera.zoom = camera.zoom
    renderer.camera.updateProjectionMatrix(); renderer.controls.update()
  }
  cameraChanged()
}
function configure(patch, camera = false) {
  options = normalizeOptions(patch, options)
  refreshUI()
  if (camera) { viewRevision++; configureCamera(true) }
}

function state(type, text, fraction) {
  root.dataset.state = type; root.setAttribute('aria-busy', String(type === 'loading'))
  message.hidden = type === 'loaded' || !options.controls.status; status.textContent = text
  retry.hidden = type !== 'error' || !lastRequest
  fit.disabled = type !== 'loaded'
  progress.hidden = type !== 'loading'
  if (fraction === undefined) progress.removeAttribute('value'); else progress.value = fraction
  notify(type, { message: text, progress: fraction })
}
function updateActive() { renderer?.setActive(active && !document.hidden) }
async function initialize() {
  if (initialized) return initialized
  initialized = (async () => {
    try { renderer = new Renderer(document.getElementById('canvas'), { orbitOnly: true, pixelRatio: 1.5, alpha: true }) }
    catch { throw Error('webgl') }
    refreshUI()
    renderer.controls.addEventListener('change', cameraChanged)
    renderer.setWireframesVisible(false); renderer.setDimensionsVisible(false)
    updateActive()
    const manager = new ViewerPacks({ apply: async packs => {
      for (const value of packs) assets.addPack(value.zip, value.id)
    } })
    const warning = await manager.init({ preset: pack })
    if (warning) throw Error('failed')
    try {
      const font = new FontFace('PixelFont', 'url(fonts/PressStart2P-Regular.ttf)')
      await font.load(); document.fonts.add(font)
    } catch { /* fallback font matches the full viewer */ }
  })().catch(error => { renderer?.dispose(); renderer = null; initialized = null; throw error })
  return initialized
}

function load(source, resumeCamera) {
  requested = { source, resumeCamera, viewRevision }; lastRequest = source
  controller?.abort()
  pump()
}
async function pump() {
  if (pumping) return
  pumping = true
  while (requested) {
    const request = requested; requested = null; current = null
    controller = new AbortController()
    state('loading', t('loading'))
    try {
      let file, url
      if (typeof request.source === 'string') {
        url = fileURL(request.source, location.href)
        file = await fetchSchematic(url, location.href, controller.signal)
      } else {
        if (!validFile(request.source)) throw Error('fileLimit')
        file = new File([request.source], request.source.name || 'schematic.litematic')
      }
      if (requested) continue
      await initialize()
      const data = await parseLitematica(await file.arrayBuffer(), value => state('loading', t('loading'), value * .2))
      if (requested) continue
      const baked = await Promise.all(data.palette.map(entry => resolver.resolve(entry.name, entry.properties)))
      data.palette.forEach((entry, i) => { entry.baked = baked[i] })
      await renderer.render(data, assets, value => state('loading', t('rendering'), .2 + value * .65))
      const tiles = data.tileEntities || []
      await renderer.renderSigns(extractSigns(tiles, data), assets)
      await renderer.renderPlayerHeads(extractPlayerHeads(tiles, data), assets)
      await renderer.renderBanners(extractBanners(tiles, data), assets)
      await renderer.renderStatues(extractStatues(data), assets)
      await renderer.renderDecoratedPots(extractDecoratedPots(tiles, data), assets)
      await renderer.renderEntities(data.entities, assets, data)
      if (requested) continue
      current = { file, url, bounds: data.bounds }
      configureCamera(true)
      if (request.resumeCamera && request.viewRevision === viewRevision) applyCamera(renderer, request.resumeCamera)
      state('loaded', t('ready'), 1)
      notify('camera', { camera: cameraSnapshot() })
      updateActive()
    } catch (error) {
      if (!requested) state('error', words[error.message] ? t(error.message) : `${t('failed')} ${error.message}`)
    }
  }
  pumping = false
}
function enter() {
  if (!current || !renderer) return
  message.hidden = true
  notify('handoff-start')
  openFullViewer({ ...current, lang: options.lang, pack, background, camera: cameraSnapshot(), appearance: options }, key => {
    status.textContent = t(key); message.hidden = !options.controls.status; progress.hidden = true; retry.hidden = true
    notify('error', { stage: 'handoff', code: key, message: t(key) })
  }, () => notify('handoff-end'))
}
open.addEventListener('click', event => { event.preventDefault(); enter() })
fit.onclick = () => configureCamera(true)
// Keyboard events inside a cross-origin iframe do not bubble to the host dialog.
window.addEventListener('keydown', event => { if (event.key === 'Escape') notify('close-request') })
retry.onclick = () => load(lastRequest)
document.addEventListener('visibilitychange', updateActive)
new IntersectionObserver(entries => { active = entries[0].isIntersecting; updateActive() }).observe(root)
window.addEventListener('pagehide', event => {
  controller?.abort()
  if (event.persisted) renderer?.setActive(false)
  else renderer?.dispose()
})
window.addEventListener('pageshow', updateActive)
window.addEventListener('message', event => {
  const data = event.data
  if (!parentOrigin || event.source !== parent || event.origin !== parentOrigin || data?.protocol !== PROTOCOL || data.channel !== channel) return
  try {
    if (data.type === 'configure') configure(data.options, data.cameraChanged)
    if (data.type === 'reset') { viewRevision++; configureCamera(true) }
    if (data.type === 'handoff-request' && current) notify('handoff-data', { file: current.file, camera: cameraSnapshot() })
    if (data.type === 'load' && (typeof data.url === 'string' || data.file instanceof Blob)) {
      if (data.options) configure(data.options)
      load(data.file || data.url, data.resumeCamera)
    }
  } catch (error) { notify('error', { message: error.message }) }
})
themeMedia.addEventListener('change', refreshUI)
refreshUI()
state('waiting', t('waiting'))
notify('ready')
if (params.has('file')) load(params.get('file'))
