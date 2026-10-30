import './embed.css'
import { Renderer } from './renderer.js'
import { AssetProvider } from './assets.js'
import { BlockModelResolver } from './blocks.js'
import { SchematicWorkerClient } from './workerClient.js'
import { throwIfAborted, withAbort } from './loadingTask.js'
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
  decompress: ['正在解压文件…', 'Decompressing file…'],
  decompressBytes: ['正在解压文件（已处理 {size}）…', 'Decompressing file ({size} processed)…'],
  parse: ['正在解析方块…', 'Reading blocks…'],
  models: ['正在准备方块模型…', 'Preparing block models…'],
  count: ['正在统计可见面…', 'Counting visible faces…'],
  fill: ['正在生成模型…', 'Building model…'],
  textures: ['正在准备贴图…', 'Preparing textures…'],
  assemble: ['正在显示模型…', 'Displaying model…'],
  upload: ['正在上传模型…', 'Uploading model…'],
  gpuRestoreFailed: ['显卡资源恢复失败，请重新打开投影。', 'Graphics resources could not be restored. Please reopen the schematic.'],
  details: ['正在生成告示牌、头颅等…', 'Building signs, heads and other details…'],
  entities: ['正在加载展示框等实体…', 'Loading item frames and other entities…'],
  ready: ['左键旋转 · 右键平移 · 滚轮缩放', 'Left-drag orbit · Right-drag pan · Scroll to zoom'],
  touch: ['单指旋转 · 双指平移与缩放', 'One finger to orbit · Two fingers to pan and zoom'],
  fit: ['复位视角', 'Reset view'], full: ['完整预览 ↗', 'Full viewer ↗'],
  open: ['打开完整预览', 'Open full viewer'], retry: ['重试', 'Retry'],
  invalidURL: ['请使用 HTTPS 投影文件直链。', 'Use a direct HTTPS schematic URL.'],
  fileLimit: ['文件必须非空且不超过 64 MiB。', 'File must be nonempty and no larger than 64 MiB.'],
  fileTooLarge: ['投影过大，无法在浏览器中完整预览。', 'The schematic is too large to preview in the browser.'],
  geometryTooLarge: ['可见模型数据超出内存预算，无法完整预览。请拆分投影后重试。', 'The visible model exceeds the memory budget for a complete preview. Split the schematic and try again.'],
  decompressedTooLarge: ['投影解压后超过 512 MiB，请减少物品 NBT 数据或拆分投影后重试。', 'The decompressed schematic exceeds 512 MiB. Reduce item NBT data or split the schematic before retrying.'],
  retainedNbtTooLarge: ['跳过非渲染内容后，需要保留的 NBT 仍超过 512 MiB，请拆分投影后重试。', 'The retained NBT still exceeds 512 MiB after skipping non-rendered content. Split the schematic before retrying.'],
  nbtScanTooLarge: ['投影数据超过 16 GiB 的扫描上限，请减少无关 NBT 或拆分投影后重试。', 'The schematic exceeds the 16 GiB scan limit. Reduce unused NBT or split the schematic before retrying.'],
  nbtComplexityTooLarge: ['NBT 结构过于复杂，请减少嵌套数据或拆分投影后重试。', 'The NBT structure is too complex. Reduce nested data or split the schematic before retrying.'],
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
let inFlight, suspended = false, disposed = false
let loadingStage = 'loading', loadingDetails = {}, loadingFraction
let cameraTimer, viewRevision = 0
const assets = new AssetProvider(), resolver = new BlockModelResolver(assets)
const workerClient = new SchematicWorkerClient()

function loadingText() {
  if (loadingStage === 'decompress' && Number.isFinite(loadingDetails.processedBytes) && loadingDetails.processedBytes > 0) {
    const bytes = loadingDetails.processedBytes, gib = bytes >= 1024 ** 3
    const size = `${(bytes / 1024 ** (gib ? 3 : 2)).toFixed(1)} ${gib ? 'GiB' : 'MiB'}`
    return t('decompressBytes').replace('{size}', size)
  }
  const fraction = loadingDetails.stageFraction ?? loadingDetails.fraction
  return t(words[loadingStage] ? loadingStage : 'loading') + (Number.isFinite(fraction) ? ` ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` : '')
}
function loadingProgress(fraction, phase, details = {}) {
  loadingFraction = fraction
  if (phase) {
    loadingDetails = typeof details === 'number' ? { stageFraction: details } : details.detail || details
    loadingStage = loadingDetails.phase || phase
  }
  state('loading', loadingText(), fraction)
}

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
  if (root.dataset.state === 'loading') status.textContent = loadingText()
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
    renderer.requestRender()
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
function updateActive() { renderer?.setActive(!suspended && !disposed && active && !document.hidden) }
async function initialize() {
  if (initialized) return initialized
  initialized = (async () => {
    try { renderer = new Renderer(document.getElementById('canvas'), { orbitOnly: true, pixelRatio: 1.5, alpha: true }) }
    catch { throw Error('webgl') }
    renderer.workerClient = workerClient
    renderer.onRenderError = () => state('error', t('gpuRestoreFailed'))
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
  if (disposed) return
  requested = { source, resumeCamera, viewRevision }; lastRequest = source
  controller?.abort()
  pump()
}
async function pump() {
  if (pumping || suspended || disposed) return
  pumping = true
  while (requested && !suspended && !disposed) {
    const request = requested; requested = null; current = null
    inFlight = request
    const jobController = new AbortController(), { signal } = jobController
    controller = jobController
    const checkRequest = () => throwIfAborted(signal)
    loadingProgress(undefined, 'loading')
    const endTextureLoad = assets.beginTextureLoad()
    let endSceneUpdate, data
    try {
      let file, url
      if (typeof request.source === 'string') {
        url = fileURL(request.source, location.href)
        file = await fetchSchematic(url, location.href, signal)
      } else {
        if (!validFile(request.source)) throw Error('fileLimit')
        file = new File([request.source], request.source.name || 'schematic.litematic')
      }
      checkRequest()
      await withAbort(initialize(), signal)
      checkRequest()
      endSceneUpdate = renderer.beginSceneUpdate()
      const bytes = await withAbort(file.arrayBuffer(), signal)
      checkRequest()
      data = await workerClient.parse(bytes, (value, detail) => {
        const stage = detail || { phase: value < .5 ? 'decompress' : 'parse', stageFraction: value < .5 ? value * 2 : value * 2 - 1 }
        if (!signal.aborted) loadingProgress(value * .2, stage.phase, stage)
      }, { renderOnly: true, signal })
      checkRequest()
      loadingProgress(.2, 'models')
      const baked = await withAbort(Promise.all(data.palette.map(entry => resolver.resolve(entry.name, entry.properties))), signal)
      checkRequest()
      data.palette.forEach((entry, i) => { entry.baked = baked[i] })
      await renderer.render(data, assets, value => {
        if (!signal.aborted) loadingProgress(.2 + value * .65)
      }, undefined, true, { signal, onStage: detail => {
        if (!signal.aborted) loadingProgress(loadingFraction, detail.phase, detail)
      } })
      checkRequest()
      loadingProgress(.85, 'details')
      const tiles = data.tileEntities || []
      await renderer.renderSigns(extractSigns(tiles, data), assets, { signal })
      checkRequest()
      await renderer.renderPlayerHeads(extractPlayerHeads(tiles, data), assets, { signal })
      checkRequest()
      await renderer.renderBanners(extractBanners(tiles, data), assets, { signal })
      checkRequest()
      await renderer.renderStatues(extractStatues(data), assets, { signal })
      checkRequest()
      await renderer.renderDecoratedPots(extractDecoratedPots(tiles, data), assets, { signal })
      checkRequest()
      await renderer.renderEntities(data.entities, assets, data, value => {
        if (!signal.aborted) loadingProgress(.85 + value * .15, 'entities', { stageFraction: value })
      }, { signal })
      checkRequest()
      current = { file, url, bounds: data.bounds }
      configureCamera(true)
      if (request.resumeCamera && request.viewRevision === viewRevision) applyCamera(renderer, request.resumeCamera)
      state('loaded', t('ready'), 1)
      notify('camera', { camera: cameraSnapshot() })
      updateActive()
    } catch (error) {
      if (!requested && !signal.aborted && !disposed) {
        const key = error.code === 'FILE_TOO_LARGE'
          ? { decompressed: 'decompressedTooLarge', retained: 'retainedNbtTooLarge', scan: 'nbtScanTooLarge', complexity: 'nbtComplexityTooLarge', geometry: 'geometryTooLarge' }[error.reason] || 'fileTooLarge' : error.message
        state('error', words[key] ? t(key) : `${t('failed')} ${error.message}`)
      }
    } finally {
      // Cards never rebuild layers, so do not retain a second block store after loading.
      if (data) workerClient.release(data)
      else workerClient.cancel()
      if (controller === jobController) controller = null
      inFlight = null
      try {
        endTextureLoad()
        assets.trimTextures()
      } finally { endSceneUpdate?.() }
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
  suspended = true
  if (event.persisted && inFlight && !requested) requested = inFlight
  controller?.abort()
  workerClient.cancel()
  if (event.persisted) renderer?.setActive(false)
  else { disposed = true; requested = null; workerClient.dispose(); renderer?.dispose(); clearTimeout(cameraTimer) }
})
window.addEventListener('pageshow', () => { suspended = false; updateActive(); pump() })
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
