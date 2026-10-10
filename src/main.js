// 入口：串联文件读取、解析、模型解析、渲染、实体，以及资源包加载。

import './styles.css'
import { extractPlayerHeads, extractSigns, extractBanners, extractStatues, extractDecoratedPots } from './schematicDetails.js'
import { ViewerPacks } from './viewerPacks.js'
import { parseLitematica } from './litematica.js'
import { AssetProvider } from './assets.js'
import { BlockModelResolver } from './blocks.js'
import { Renderer } from './renderer.js'
import { UI } from './ui.js'
import { t, setLang, getLang, applyTranslations, blockName } from './i18n.js'
import { fetchSchematic, receivePreviewFile, applyCamera } from './embedProtocol.js'
import { ImageExport } from './imageExport.js'
import { normalizeOptions } from './previewOptions.js'
import { ViewerAppearance, readViewerAppearance } from './viewerAppearance.js'
import { FullViewerBridge } from './fullViewerBridge.js'
import { viewerAppearance } from './viewerOptions.js'
import { bindEntityHitboxShortcut } from './entityHitboxes.js'

const startupParams = new URLSearchParams(location.search)
const integration = readViewerAppearance(startupParams)
let previewOptions = integration.options
setLang(previewOptions.lang)

const container = document.getElementById('viewer')
const ui = new UI(document.body)
const assets = new AssetProvider()
const resolver = new BlockModelResolver(assets)

// 初始状态文案（默认中文）
ui.setStatusKey('dragHint')

// 渲染器初始化可能因 WebGL 不可用而失败，做保护
let renderer = null
try {
  renderer = new Renderer(container, { alpha: integration.themed })
  const background = /^#[0-9a-f]{6}$/i.test(startupParams.get('background')) ? startupParams.get('background') : '#172332'
  renderer.setBackgroundColor(background)
  document.getElementById('bgColor').value = background
  renderer.getViewportInsets = () => {
    if (document.body.classList.contains('ui-hidden')) return {}
    if (matchMedia('(max-width:900px)').matches || document.body.classList.contains('viewer-compact')) return { top: 16, bottom: 76 }
    const left = document.getElementById('sidebar').getBoundingClientRect()
    const right = document.getElementById('right-panel').getBoundingClientRect()
    return { left: left.width ? left.right + 20 : 20, right: right.width ? innerWidth - right.left + 20 : 20, top: 20, bottom: 20 }
  }
} catch (e) {
  console.error(e)
  ui.showError(t('webglInitFailed') + (e.message || e))
}

let currentData = null
let busy = false
let currentFileName = ''
let currentFile = null, integrationBridge, appearance, themeBackground

// 视图状态：渲染模式 / 当前层 / 可见区域 / 各显示开关
const view = {
  renderMode: 'all', // 'all' | 'below' | 'above' | 'single'
  layerY: 0,
  visibleRegions: null, // null = 全部显示；否则 Set<regionName>
  showEntities: true,
  showEntityHitboxes: false,
  showWireframes: true,
  showDimensions: true,
  showFog: true, // 水下雾开关
  illagerExtraArms: false,
  materialSortAsc: false, // 材料排序：false=多→少，true=少→多
}

const imageExport = renderer ? new ImageExport({
  renderer,
  getData: () => currentData,
  getFileName: () => currentFileName,
  openFile: file => openFile(file),
  openDemo: () => autoLoadDemo(true),
  getError: () => ui.errorBanner.classList.contains('hidden') ? '' : ui.errorBanner.textContent,
  changeLanguage: () => { setLang(getLang() === 'zh' ? 'en' : 'zh'); refreshLocalizedUI() },
}) : null
function openImageExport() {
  if (busy || !imageExport) return
  closeMobilePanels()
  try { imageExport.open() }
  catch (error) { ui.showError(t('webglInitFailed') + error.message) }
}
for (const id of ['imageExportBtn', 'welcomeExportBtn']) document.getElementById(id).addEventListener('click', openImageExport)

appearance = new ViewerAppearance({
  ...integration,
  onTheme(values) {
    themeBackground = values.background
    renderer?.setBackgroundColor(themeBackground)
    renderer?.setUnderwaterFogEnabled(view.showFog && themeBackground !== 'transparent')
    if (themeBackground !== 'transparent') document.getElementById('bgColor').value = themeBackground
  },
  onLayout: () => renderer?._resize(),
})
appearance.update(previewOptions)
integrationBridge = new FullViewerBridge({
  params: startupParams, renderer, ui,
  getCurrent: () => ({ file: currentFile, bounds: currentData?.bounds }),
  getBusy: () => busy, setBusy, openFile, getOptions: () => previewOptions,
  onProjection: refreshProjectionButton, isExportOpen: () => !!imageExport?.isOpen,
  configure(options) {
    const previous = previewOptions
    previewOptions = normalizeOptions(options, previewOptions)
    appearance.update(previewOptions)
    if (previewOptions.lang !== previous.lang) { setLang(previewOptions.lang); refreshLocalizedUI() }
    if (renderer) {
      const i = previewOptions.interaction
      Object.assign(renderer.controls, { enableRotate: i.rotate, enablePan: i.pan, enableZoom: i.zoom, autoRotate: i.autoRotate, autoRotateSpeed: i.autoRotateSpeed })
    }
  },
})

// 主预览器与模型图鉴分别保存趣味选项。
const ILLAGER_ARMS_PREFERENCE = 'viewer-illager-extra-arms-v1'
try { if (!integration.themed) view.illagerExtraArms = localStorage.getItem(ILLAGER_ARMS_PREFERENCE) === 'true' } catch {}
const illagerExtraArms = document.getElementById('illagerExtraArms')
illagerExtraArms.checked = view.illagerExtraArms
illagerExtraArms.disabled = !renderer

const HITBOX_PREFERENCE = 'viewer-entity-hitboxes-v1'
const hitboxesToggle = document.getElementById('showEntityHitboxes')
try { if (!integration.themed) view.showEntityHitboxes = localStorage.getItem(HITBOX_PREFERENCE) === 'true' } catch {}
hitboxesToggle.checked = view.showEntityHitboxes
hitboxesToggle.disabled = !renderer
renderer?.setEntityHitboxesVisible(view.showEntityHitboxes)
function toggleEntityHitboxes(enabled) {
  if (!renderer) return
  view.showEntityHitboxes = !!enabled
  hitboxesToggle.checked = view.showEntityHitboxes
  renderer.setEntityHitboxesVisible(view.showEntityHitboxes)
  try { if (!integration.themed) localStorage.setItem(HITBOX_PREFERENCE, String(view.showEntityHitboxes)) }
  catch { ui.showError(t('settingsSaveFailed')) }
}
hitboxesToggle.addEventListener('change', () => toggleEntityHitboxes(hitboxesToggle.checked))
bindEntityHitboxShortcut(() => { if (!busy && !imageExport?.isOpen) toggleEntityHitboxes(!view.showEntityHitboxes) })

// 全局错误捕获，让任何错误都显示在页面上
window.addEventListener('error', (e) => {
  ui.showError(t('scriptError') + (e.message || (e.error && e.error.message) || '未知错误'))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  ui.showError(t('runtimeError') + ((r && (r.message || r)) || '未知错误'))
})

// 启动自检
function checkCapabilities() {
  const problems = []
  if (typeof DecompressionStream === 'undefined') {
    problems.push(t('capDecompression'))
  }
  let webglOk = false
  try {
    const c = document.createElement('canvas')
    webglOk = !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    webglOk = false
  }
  if (!webglOk) problems.push(t('capWebgl'))
  if (problems.length) ui.showError(problems.join('；'))
}
checkCapabilities()
loadPixelFont()

const fileInput = document.getElementById('fileInput')
const packInput = document.getElementById('packInput')

document.getElementById('openBtn').addEventListener('click', () => fileInput.click())
document.getElementById('welcomeOpenBtn').addEventListener('click', () => fileInput.click())
document.getElementById('packBtn').addEventListener('click', () => packInput.click())
document.getElementById('clearBtn').addEventListener('click', () => {
  if (busy) return
  renderer?.clear()
  currentData = null
  currentFile = null
  currentFileName = ''; document.body.classList.remove('has-model')
  closeMobilePanels()
  resetViewForClear()
  ui.clearError()
  ui.showMetadata({})
  ui.setStatusKey('statusCleared')
  ui.setProgress(0)
  updateMaterialList()
  integrationBridge.notify('waiting', { message: t('statusCleared') })
})

// 材料排序切换（多→少 / 少→多）
ui.onMaterialSort = () => {
  view.materialSortAsc = !view.materialSortAsc
  updateMaterialList()
}

// 语言切换（中 / 英）
document.getElementById('langBtn').addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh')
  document.getElementById('langLabel').textContent = getLang() === 'zh' ? '中' : 'EN'
  refreshLocalizedUI()
})

// Native dialog provides focus management, Escape and a backdrop on desktop and mobile.
const settingsPanel = document.getElementById('settingsPanel')
const materialPanel = document.getElementById('materialPanel')
function selectSettingsTab(name) {
  if (name === 'packs' && !previewOptions.viewer.tools.packs) name = 'general'
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    const selected = tab.dataset.settingsTab === name
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected
  }
}
function openSettings(tab) {
  if (tab) selectSettingsTab(tab)
  renderer?.keys.clear()
  if (!settingsPanel.open) settingsPanel.showModal()
}
document.getElementById('settingsBtn').addEventListener('click', () => openSettings())
document.getElementById('packSummaryBtn').addEventListener('click', () => openSettings('packs'))
document.getElementById('materialSummaryBtn').addEventListener('click', () => {
  if (!currentData || !previewOptions.viewer.panels.materials) return
  renderer?.keys.clear()
  if (!materialPanel.open) materialPanel.showModal()
})
document.getElementById('materialCloseBtn').addEventListener('click', () => materialPanel.close())
for (const tab of document.querySelectorAll('[data-settings-tab]')) {
  tab.onclick = () => selectSettingsTab(tab.dataset.settingsTab)
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = [...document.querySelectorAll('[data-settings-tab]')].filter(el => !el.hasAttribute('data-viewer-hidden'))
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    selectSettingsTab(next.dataset.settingsTab); next.focus()
  }
}
for (const panel of [settingsPanel, materialPanel]) panel.addEventListener('click', event => {
  if (event.target !== panel) return
  const r = panel.getBoundingClientRect()
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) panel.close()
})
function closeMobilePanels() {
  for (const [button, panel] of [['controlsPanelBtn', 'sidebar'], ['infoPanelBtn', 'right-panel']]) {
    document.getElementById(button).setAttribute('aria-expanded', 'false')
    document.getElementById(panel).classList.remove('mobile-open')
  }
}
for (const [button, panel] of [['controlsPanelBtn', 'sidebar'], ['infoPanelBtn', 'right-panel']]) document.getElementById(button).onclick = () => {
  const open = document.getElementById(panel).classList.contains('mobile-open')
  closeMobilePanels()
  if (!open) { document.getElementById(panel).classList.add('mobile-open'); document.getElementById(button).setAttribute('aria-expanded', 'true') }
}
// 界面显示开关：隐藏时仅保留右上角按钮
document.getElementById('uiToggleBtn').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('ui-hidden')
  const btn = document.getElementById('uiToggleBtn')
  btn.title = hidden ? t('showUi') : t('hideUi')
  btn.setAttribute('aria-label', btn.title)
  btn.setAttribute('aria-pressed', String(hidden))
  renderer?._resize()
})

function refreshProjectionButton() {
  const button = document.getElementById('projectionBtn')
  const orthographic = renderer?.getProjectionMode() === 'orthographic'
  button.disabled = !renderer
  button.setAttribute('aria-pressed', String(orthographic))
  button.title = t(orthographic ? 'orthographicProjectionTitle' : 'perspectiveProjectionTitle')
}
document.getElementById('projectionBtn').addEventListener('click', () => {
  renderer?.setProjectionMode(renderer.getProjectionMode() === 'perspective' ? 'orthographic' : 'perspective')
  refreshProjectionButton()
})
document.getElementById('settingsCloseBtn').addEventListener('click', () => {
  settingsPanel.close()
})
document.getElementById('bgColor').addEventListener('input', (e) => {
  themeBackground = e.target.value
  previewOptions = normalizeOptions({ background: themeBackground }, previewOptions)
  renderer?.setBackgroundColor(e.target.value)
  renderer?.setUnderwaterFogEnabled(view.showFog)
  appearance.update(previewOptions)
})

// —— 移动模式 / 速度 / 层级 / 设置项 / 区域 的接线 ——
if (renderer) {
  document.getElementById('fitViewBtn').onclick = () => renderer.fitToBounds(currentData?.bounds)
  renderer.onMoveModeChange = (mode) => ui.setMoveModeLabel(mode)
  renderer.onSpeedChange = (speed) => ui.setSpeed(speed)
  renderer.onSensitivityChange = (v) => ui.setSensitivity(v)
  // 首次按 WASD 自动切到飞行模式
  renderer.onFirstMoveKey = () => renderer.setMoveMode('fly')

  // 左侧：移动模式切换按钮
  document.getElementById('moveModeBtn').addEventListener('click', () => {
    renderer.setMoveMode(renderer.getMoveMode() === 'orbit' ? 'fly' : 'orbit')
  })
  // 左侧：速度滑块
  document.getElementById('speedSlider').addEventListener('input', (e) => {
    renderer.setMoveSpeed(Number(e.target.value))
  })
  // 左侧：灵敏度滑块
  document.getElementById('sensitivitySlider').addEventListener('input', (e) => {
    renderer.setLookSensitivity(Number(e.target.value))
  })
  // 左侧：上/下一层
  document.getElementById('layerUpBtn').addEventListener('click', () => changeLayer(1))
  document.getElementById('layerDownBtn').addEventListener('click', () => changeLayer(-1))
  // 左侧：定位到此处——把当前层设为摄像机所在高度
  document.getElementById('locateBtn').addEventListener('click', async () => {
    if (busy || !currentData) return
    setBusy(true)
    try {
      const b = currentData.bounds
      const camY = Math.floor(renderer.camera.position.y)
      view.layerY = Math.max(b.minY, Math.min(b.maxY, camY))
      ui.setLayerLabel(view.layerY)
      if (view.renderMode !== 'all') await reRenderBlocks()
    } finally { setBusy(false) }
  })

  // 设置：显示实体 / 区域线框 / 尺寸
  document.getElementById('showEntities').addEventListener('change', (e) => {
    view.showEntities = e.target.checked
    renderer.setEntitiesVisible(view.showEntities)
  })
  document.getElementById('showWireframes').addEventListener('change', (e) => {
    view.showWireframes = e.target.checked
    renderer.setWireframesVisible(view.showWireframes)
  })
  document.getElementById('showDimensions').addEventListener('change', (e) => {
    view.showDimensions = e.target.checked
    renderer.setDimensionsVisible(view.showDimensions)
  })
  document.getElementById('showFog').addEventListener('change', (e) => {
    view.showFog = e.target.checked
    renderer.setUnderwaterFogEnabled(view.showFog && themeBackground !== 'transparent')
  })
  illagerExtraArms.addEventListener('change', async () => {
    if (busy) { illagerExtraArms.checked = view.illagerExtraArms; return }
    const previous = view.illagerExtraArms
    view.illagerExtraArms = illagerExtraArms.checked
    setBusy(true); ui.clearError()
    try {
      await renderCurrentEntities()
      try { if (!integration.themed) localStorage.setItem(ILLAGER_ARMS_PREFERENCE, String(view.illagerExtraArms)) }
      catch { ui.showError(t('settingsSaveFailed')) }
    } catch (error) {
      view.illagerExtraArms = previous
      illagerExtraArms.checked = previous
      ui.showError(t('settingsApplyFailed') + error.message)
    } finally { setBusy(false) }
  })
  // 设置：渲染模式
  document.getElementById('renderMode').addEventListener('change', (e) => {
    setRenderMode(e.target.value)
  })
}

// E / Q 调整渲染层级（E 上一层，Q 下一层；忽略输入框内的按键）
window.addEventListener('keydown', (e) => {
  if (busy || document.querySelector('dialog[open]') || isTypingTarget(e)) return
  if (e.code === 'KeyE') {
    e.preventDefault()
    changeLayer(1)
  } else if (e.code === 'KeyQ') {
    e.preventDefault()
    changeLayer(-1)
  }
})

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0])
  e.target.value = ''
})
packInput.addEventListener('change', (e) => {
  if (e.target.files.length) loadPackFromFiles([...e.target.files])
  e.target.value = ''
})

// 拖拽打开文件 / 资源包
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  ui.showDropOverlay(true)
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('dragleave', (e) => {
  e.preventDefault()
  dragDepth--
  if (dragDepth <= 0) {
    dragDepth = 0
    ui.showDropOverlay(false)
  }
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  ui.showDropOverlay(false)
  const files = e.dataTransfer?.files
  if (!files || !files.length) return
  const f = files[0]
  if (f.name.toLowerCase().endsWith('.zip')) loadPackFromFiles([...files].filter(file => file.name.toLowerCase().endsWith('.zip')))
  else openFile(f)
})

async function openFile(file, camera) {
  if (busy) return false
  if (!renderer) {
    ui.showError(t('renderUnavailable'))
    return false
  }
  setBusy(true)
  currentFile = null
  integrationBridge.loading = true
  integrationBridge.notify('loading', { message: t('parsingFile'), progress: 0 })
  ui.clearError()
  try {
    ui.setStatusKey('parsingFile')
    ui.setProgress(0.02)
    const buffer = await file.arrayBuffer()

    const data = await parseLitematica(buffer, (f) => {
      ui.setProgress(0.02 + f * 0.18)
      ui.setStatusKey('parsingFilePct', { p: Math.round(f * 100) })
    })
    ui.setProgress(0.2)

    const palette = data.palette
    ui.setStatusKey('statusParsing', { n: palette.length })
    const baked = await Promise.all(palette.map((p) => resolver.resolve(p.name, p.properties)))
    palette.forEach((p, i) => {
      p.baked = baked[i]
    })
    ui.setProgress(0.35)

    currentData = data
    currentFileName = file.name
    document.getElementById('fileName').textContent = currentFileName
    document.body.classList.add('has-model'); closeMobilePanels()
    resetViewForData(data)
    ui.setStatusKey('statusGeometry', { n: data.blocks.size.toLocaleString() })
    const stats = await renderer.render(data, assets, (p) => ui.setProgress(0.35 + p * 0.6))
    await renderCurrentSigns()
    await renderCurrentPlayerHeads()
    await renderCurrentBanners()
    await renderCurrentStatues()
    await renderCurrentPots()
    await renderCurrentEntities()
    ui.showMetadata(data.metadata)
    applyCamera(renderer, camera)
    refreshProjectionButton()
    updateRegionUI()
    updateMaterialList()
    const entityNote = data.entities?.length ? t('statusEntities', { n: data.entities.length }) : ''
    ui.setStatusKey('statusDone', { faces: stats.faces.toLocaleString(), textures: stats.textures, entities: entityNote })
    ui.setProgress(1)
    currentFile = file
    integrationBridge.notify('loaded', { name: file.name, message: ui.statusEl.textContent, progress: 1 })
    integrationBridge.cameraChanged()
    return true
  } catch (e) {
    console.error(e)
    ui.setProgress(0)
    if (e && e.code === 'FILE_TOO_LARGE') ui.showError(t('fileTooLarge'))
    else ui.showError(t('loadFailed') + (e.message || e))
    return false
  } finally {
    integrationBridge.loading = false
    setBusy(false)
  }
}

async function autoLoadDemo(sample = false) {
  if (busy) return
  setBusy(true); ui.clearError(); ui.setStatusKey('loadingDemo')
  try {
    const params = new URLSearchParams(location.search)
    const name = sample ? 'demo.litematic' : params.get('file') || 'demo.litematic'
    const file = await fetchSchematic(name, location.href)
    setBusy(false)
    await openFile(file)
  } catch (e) {
    ui.showError(t(e.message || 'demoFailed'))
  } finally { setBusy(false) }
}

// 重新解析方块贴图并重渲染当前已加载的结构
async function reRenderCurrent() {
  if (!currentData || !renderer) return
  // 资源包集合已变化：贴图缓存已被清空，这里同步移除旧网格并释放其贴图，
  // 避免旧贴图残留（泄漏）或在异步重解析期间被动画循环重新上传。
  renderer.clear(true)
  resolver.clear()
  const palette = currentData.palette
  const baked = await Promise.all(palette.map((p) => resolver.resolve(p.name, p.properties)))
  palette.forEach((p, i) => {
    p.baked = baked[i]
  })
  await renderer.render(currentData, assets, (p) => ui.setProgress(p), makeBlockFilter(), false)
  await renderCurrentSigns()
  await renderCurrentPlayerHeads()
  await renderCurrentBanners()
  await renderCurrentStatues()
  await renderCurrentPots()
  await renderCurrentEntities()
}

// 渲染当前结构里的告示牌
async function renderCurrentSigns() {
  if (!currentData || !renderer) return
  const tes = filterByRegion(currentData.tileEntities || [])
  await renderer.renderSigns(extractSigns(tes, currentData), assets)
}

// 渲染当前结构里的实体
async function renderCurrentEntities() {
  if (!currentData || !renderer) return
  const ents = filterByRegion(currentData.entities || []).map(entity => ({
    ...entity,
    renderOptions: { ...entity.renderOptions, illagerExtraArms: view.illagerExtraArms },
  }))
  await renderer.renderEntities(ents, assets, currentData)
}

// 渲染当前结构里的玩家头颅（用玩家自己的皮肤）
async function renderCurrentPlayerHeads() {
  if (!currentData || !renderer) return
  const tes = filterByRegion(currentData.tileEntities || [])
  await renderer.renderPlayerHeads(extractPlayerHeads(tes, currentData), assets)
}

// 渲染当前结构里的旗帜（底色 + 图案）
async function renderCurrentBanners() {
  if (!currentData || !renderer) return
  try {
    const tes = filterByRegion(currentData.tileEntities || [])
    await renderer.renderBanners(extractBanners(tes, currentData), assets)
  } catch (e) {
    console.error('旗帜渲染失败', e)
  }
}

// 渲染当前结构里的铜傀儡雕像
async function renderCurrentStatues() {
  if (!currentData || !renderer) return
  try {
    await renderer.renderStatues(extractStatues(currentData), assets)
  } catch (e) {
    console.error('铜傀儡雕像渲染失败', e)
  }
}

// 渲染当前结构里的装饰罐侧面（陶片图案）
async function renderCurrentPots() {
  if (!currentData || !renderer) return
  try {
    const tes = filterByRegion(currentData.tileEntities || [])
    await renderer.renderDecoratedPots(extractDecoratedPots(tes, currentData), assets)
  } catch (e) {
    console.error('装饰罐渲染失败', e)
  }
}

// 区域是否可见（visibleRegions 为 null 表示全部可见）
function regionVisible(region) {
  if (!view.visibleRegions) return true
  return view.visibleRegions.has(region)
}

// 按可见区域过滤实体/方块实体列表
function filterByRegion(list) {
  if (!view.visibleRegions) return list
  return (list || []).filter((e) => regionVisible(e.region))
}

// 构造方块过滤函数（层级 + 区域），返回 null 表示无需过滤
function makeBlockFilter() {
  const mode = view.renderMode
  const layerY = view.layerY
  const regions = currentData?.regions || []
  const hidden = view.visibleRegions ? regions.filter((r) => !view.visibleRegions.has(r.name)) : []
  if (mode === 'all' && hidden.length === 0) return null
  const inAny = (x, y, z, list) =>
    list.some((r) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && z >= r.minZ && z <= r.maxZ)
  return (x, y, z) => {
    if (mode === 'single' && y !== layerY) return false
    if (mode === 'below' && y > layerY) return false
    if (mode === 'above' && y < layerY) return false
    if (hidden.length && inAny(x, y, z, hidden)) return false
    return true
  }
}

// 层级/区域变化：重建方块网格，复用实体和方块实体模型并同步层级显隐。
async function reRenderBlocks() {
  if (!currentData || !renderer) return
  await renderer.renderBlocks(currentData, assets, makeBlockFilter())
  renderer.setLayerVisibility(view.renderMode, view.layerY)
}

// 载入新文件时重置视图状态
function resetViewForData(data) {
  view.renderMode = 'all'
  view.layerY = data.bounds.minY
  view.visibleRegions = null
  renderer?.setLayerVisibility('all', view.layerY)
  ui.setLayerLabel(view.layerY)
  setRenderModeControl('all')
  // 显示左侧控制面板
  document.getElementById('controlPanel')?.classList.add('loaded')
}

// 清除结构时重置视图相关 UI（区域列表、层级、渲染模式、左侧控制面板）
function resetViewForClear() {
  view.renderMode = 'all'
  view.layerY = 0
  view.visibleRegions = null
  renderer?.setLayerVisibility('all', 0)
  ui.setLayerLabel('-')
  setRenderModeControl('all')
  updateRegionUI()
  document.getElementById('controlPanel')?.classList.remove('loaded')
}

// 切换某个区域的可见性
async function toggleRegion(name) {
  if (busy || !currentData) return
  setBusy(true)
  try {
    if (!view.visibleRegions) {
      view.visibleRegions = new Set((currentData.regions || []).map((r) => r.name))
    }
    if (view.visibleRegions.has(name)) view.visibleRegions.delete(name)
    else view.visibleRegions.add(name)
    updateRegionUI()
    await reRenderBlocks()
    await renderCurrentSigns()
    await renderCurrentPlayerHeads()
    await renderCurrentBanners()
    await renderCurrentStatues()
    await renderCurrentPots()
    await renderCurrentEntities()
  } finally { setBusy(false) }
}

// 调整当前层（delta = ±1）
async function changeLayer(delta) {
  if (busy || !currentData) return
  setBusy(true)
  try {
    const b = currentData.bounds
    if (view.renderMode === 'all') {
      // 在「全部渲染」模式下按上/下一层，自动切到「上方/下方」模式，
      // 并从结构最远端开始：上方→最底层，下方→最高层（首次显示全貌）
      view.renderMode = delta > 0 ? 'above' : 'below'
      setRenderModeControl(view.renderMode)
      view.layerY = delta > 0 ? b.minY : b.maxY
    } else if (
      (view.renderMode === 'below' && delta > 0 && view.layerY >= b.maxY) ||
      (view.renderMode === 'above' && delta < 0 && view.layerY <= b.minY)
    ) {
      // 「下方/上方」达到最大/最小层时，自动还原为「全部渲染」
      view.renderMode = 'all'
      setRenderModeControl('all')
    } else {
      view.layerY = Math.max(b.minY, Math.min(b.maxY, view.layerY + delta))
    }
    ui.setLayerLabel(view.layerY)
    await reRenderBlocks()
  } finally { setBusy(false) }
}

// 渲染模式切换
async function setRenderMode(mode) {
  if (busy) return
  setBusy(true)
  try {
    view.renderMode = mode
    await reRenderBlocks()
  } finally { setBusy(false) }
}

// 同步「渲染模式」下拉框（不触发 change）
function setRenderModeControl(mode) {
  const sel = document.getElementById('renderMode')
  if (sel) sel.value = mode
}

// 更新区域列表 UI
function updateRegionUI() {
  ui.renderRegionList(currentData?.regions || [], view.visibleRegions, (name) => toggleRegion(name))
}

// 更新材料清单：按方块类型统计数量（忽略属性，如 oak_stairs 的所有朝向/含水状态合并计数）
function updateMaterialList() {
  if (!currentData) {
    ui.renderMaterialList([], view.materialSortAsc)
    return
  }
  const counts = new Map()
  for (const gi of currentData.blocks.values()) {
    const p = currentData.palette[gi]
    const name = (p.name || '').replace(/^minecraft:/, '')
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  const list = [...counts.entries()].map(([name, count]) => ({
    name: blockName(name), // 当前语言的译名，缺失回退英文 ID
    key: name, // 英文 ID（tooltip 用）
    count,
  }))
  list.sort((a, b) => (view.materialSortAsc ? a.count - b.count : b.count - a.count))
  ui.renderMaterialList(list, view.materialSortAsc)
}

// 语言切换后刷新所有文案（静态 data-i18n + 动态面板/状态）
function refreshLocalizedUI() {
  previewOptions = normalizeOptions({ lang: getLang() }, previewOptions)
  applyTranslations()
  document.getElementById('langLabel').textContent = getLang() === 'zh' ? '中' : 'EN'
  ui.refreshStatus()
  ui.showMetadata(currentData?.metadata || {})
  updateRegionUI()
  updateMaterialList()
  updatePackPanels()
  ui.refreshPackStatus()
  if (renderer) ui.setMoveModeLabel(renderer.getMoveMode())
  ui.setLayerLabel(currentData ? view.layerY : '-')
  // 界面显示开关的 title 依赖当前隐藏状态
  const toggleBtn = document.getElementById('uiToggleBtn')
  const bodyHidden = document.body.classList.contains('ui-hidden')
  toggleBtn.title = bodyHidden ? t('showUi') : t('hideUi')
  toggleBtn.setAttribute('aria-label', toggleBtn.title)
  refreshProjectionButton()
  imageExport?.translate()
  appearance?.update(previewOptions)
}

// 是否正在输入框里打字（避免 E/Q 等快捷键误触发）
function isTypingTarget(e) {
  const t = e.target
  return t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A', 'SUMMARY'].includes(t.tagName))
}

// —— 资源包管理 ——

const packManager = new ViewerPacks({
  translate: t,
  ...(integration.themed ? { storage: { getItem: () => null, setItem() {} }, read: async () => [], write: async () => {} } : {}),
  apply: async packs => {
    const previous = [...assets.packs]
    const replace = values => {
      assets.clearPacks()
      for (const pack of values) assets.addPack(pack.zip, pack.id ?? pack.name)
    }
    replace(packs)
    try { await reRenderCurrent() }
    catch (error) {
      replace(previous)
      await reRenderCurrent()
      throw error
    }
  },
})

function setBusy(on) {
  busy = on
  document.getElementById('app').setAttribute('aria-busy', String(on))
  document.getElementById('packSettings').setAttribute('aria-busy', String(on))
  illagerExtraArms.disabled = on || !renderer
  for (const id of ['imageExportBtn', 'welcomeExportBtn']) document.getElementById(id).disabled = on || !renderer
  imageExport?.setLoading(on)
  for (const el of document.querySelectorAll('#openBtn, #clearBtn, #welcomeOpenBtn, #fileInput, #packBtn, #packInput, #controlPanel button, #controlPanel select, #regionListBody button')) {
    el.disabled = on || (el.id === 'clearBtn' && !currentData)
  }
  updatePackPanels()
  if (!on && !currentData) document.getElementById('welcomeStatus').textContent = ''
  if (!on) queueMicrotask(() => integrationBridge?.pump())
}

function updatePackPanels() {
  ui.renderPackPanels(packManager.active, packManager.available, {
    onLoad: id => runPackAction(() => packManager.load(id), 'packLoaded', { name: packManager.library.get(id).name }),
    onUnload: id => runPackAction(() => packManager.unload(id), 'packUnloaded', { name: packManager.library.get(id).name }),
    onMove: (id, delta) => runPackAction(() => packManager.move(id, delta), 'packOrderUpdated'),
  }, busy)
}

async function runPackAction(action, success = 'packUpdated', vars) {
  if (busy) return
  setBusy(true); ui.clearError(); ui.setPackStatus('packApplying'); ui.setStatusKey('packApplying'); ui.setProgress(0)
  try {
    const warning = await action()
    ui.setPackStatus(warning || success, warning ? undefined : vars, !!warning)
    ui.setStatusKey(success, vars); ui.setProgress(currentData ? 1 : 0)
  } catch (error) {
    ui.setPackStatus('packOperationFailed', { error: t(error.message || String(error)) }, true)
    ui.setStatusKey('packOperationFailed', { error: t(error.message || String(error)) })
    ui.setProgress(currentData ? 1 : 0)
  } finally { setBusy(false) }
}

function loadPackFromFiles(files) {
  if (busy || !files.length) return
  openSettings('packs')
  return runPackAction(() => packManager.importFiles(files))
}

document.getElementById('unloadAllPacks').onclick = () => runPackAction(() => packManager.unloadAll(), 'packAllUnloaded')

async function initializePacks() {
  setBusy(true); ui.setPackStatus('loadingPackShort'); ui.setStatusKey('loadingPackShort')
  try {
    const preset = startupParams.get('pack')
    const warning = await packManager.init({ preset: ['xk', 'vanilla'].includes(preset) ? preset : integration.themed ? 'xk' : undefined })
    ui.setPackStatus(warning || 'packUpdated', undefined, !!warning)
    ui.setStatusKey('dragHint')
  } catch (error) { ui.setPackStatus('packOperationFailed', { error: t(error.message || String(error)) }, true) }
  finally { setBusy(false) }
}

// 加载像素字体（供轴标签/告示牌文字使用）
async function loadPixelFont() {
  try {
    const face = new FontFace('PixelFont', 'url(fonts/PressStart2P-Regular.ttf)')
    await face.load()
    document.fonts.add(face)
  } catch (e) {
    console.warn('像素字体加载失败，使用默认字体', e)
  }
}

// 调试/截图用：URL 带 ?demo 或 ?file=xxx 时自动加载文件
const previewFile = receivePreviewFile()
await initializePacks()
refreshLocalizedUI()
integrationBridge.ready()
const _sp = new URLSearchParams(location.search)
if (previewFile) {
  const received = await previewFile
  if (received) {
    if (received.appearance && integration.themed) {
      try {
        previewOptions = normalizeOptions(viewerAppearance(received.appearance), previewOptions)
        setLang(previewOptions.lang); appearance.update(previewOptions); refreshLocalizedUI()
        const url = new URL(location.href)
        url.searchParams.set('appearance', JSON.stringify(viewerAppearance(previewOptions)))
        url.searchParams.set('lang', previewOptions.lang)
        history.replaceState(null, '', url)
      } catch { /* Keep the validated URL appearance if the sender sent invalid options. */ }
    }
    await openFile(received.file, received.camera)
  }
  else if (_sp.has('file')) await autoLoadDemo()
  else ui.showError(t('previewTransferFailed'))
} else if (_sp.has('demo') || _sp.has('file')) {
  autoLoadDemo()
}
