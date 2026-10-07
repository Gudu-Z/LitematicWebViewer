import './embed.css'
import { Renderer } from './renderer.js'
import { AssetProvider } from './assets.js'
import { BlockModelResolver } from './blocks.js'
import { parseLitematica } from './litematica.js'
import { ViewerPacks } from './viewerPacks.js'
import { extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from './schematicDetails.js'
import { PROTOCOL, validFile, fileURL, fetchSchematic, openFullViewer } from './embedProtocol.js'

const params = new URLSearchParams(location.search)
const lang = params.get('lang') === 'en' ? 'en' : 'zh'
const pack = params.get('pack') === 'vanilla' ? 'vanilla' : 'xk'
const background = /^#[0-9a-f]{6}$/i.test(params.get('background')) ? params.get('background') : '#172332'
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
const t = key => words[key]?.[lang === 'en' ? 1 : 0] || key
document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
document.title = (lang === 'en' ? 'Schematic preview' : '投影预览卡片') + ' | LitematicWebViewer'
document.body.style.background = background
const root = document.getElementById('preview'), message = document.getElementById('message')
const status = document.getElementById('status'), progress = document.getElementById('progress')
const retry = document.getElementById('retry'), open = document.getElementById('open')
const fit = document.getElementById('fit')
open.title = open.ariaLabel = t('open'); retry.textContent = t('retry')
open.textContent = t('full'); fit.textContent = t('fit')
document.getElementById('hint').textContent = t(matchMedia('(pointer: coarse)').matches ? 'touch' : 'ready')

let parentOrigin = null
try { const value = params.get('parentOrigin'); if (value && new URL(value).origin === value && /^https?:/.test(value)) parentOrigin = value } catch {}
const channel = params.get('channel')
const notify = (type, detail = {}) => {
  if (parentOrigin && channel && parent !== window) parent.postMessage({ protocol: PROTOCOL, channel, type, ...detail }, parentOrigin)
}
let renderer, initialized, current, requested, lastRequest, pumping = false, active = true, controller
const assets = new AssetProvider(), resolver = new BlockModelResolver(assets)

function state(type, text, fraction) {
  root.dataset.state = type; root.setAttribute('aria-busy', String(type === 'loading'))
  message.hidden = type === 'loaded'; status.textContent = text
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
    try { renderer = new Renderer(document.getElementById('canvas'), { orbitOnly: true, pixelRatio: 1.5 }) }
    catch { throw Error('webgl') }
    renderer.setBackgroundColor(background)
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

function load(source) {
  requested = { source }; lastRequest = source
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
      state('loaded', t('ready'), 1)
      updateActive()
    } catch (error) {
      if (!requested) state('error', words[error.message] ? t(error.message) : `${t('failed')} ${error.message}`)
    }
  }
  pumping = false
}
function enter() {
  if (!current || !renderer) return
  notify('handoff-start')
  openFullViewer({ ...current, lang, pack, background, camera: {
    position: renderer.camera.position.toArray(), target: renderer.controls.target.toArray(),
  } }, key => { state('error', t(key)); retry.hidden = true }, () => notify('handoff-end'))
}
open.addEventListener('click', event => { event.preventDefault(); enter() })
fit.onclick = () => { if (current) renderer.fitToBounds(current.bounds) }
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
  if (data.type === 'load' && (typeof data.url === 'string' || data.file instanceof Blob)) load(data.file || data.url)
})
state('waiting', t('waiting'))
notify('ready')
if (params.has('file')) load(params.get('file'))
