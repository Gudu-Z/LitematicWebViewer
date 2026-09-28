// 入口：串联文件读取、解析、模型解析、渲染、实体，以及资源包加载。

import './styles.css'
import JSZip from 'jszip'
import { parseLitematica } from './litematica.js'
import { AssetProvider } from './assets.js'
import { BlockModelResolver } from './blocks.js'
import { Renderer } from './renderer.js'
import { UI } from './ui.js'

const container = document.getElementById('viewer')
const ui = new UI(document.body)
const assets = new AssetProvider()
const resolver = new BlockModelResolver(assets)

// 渲染器初始化可能因 WebGL 不可用而失败，做保护
let renderer = null
try {
  renderer = new Renderer(container)
} catch (e) {
  console.error(e)
  ui.showError('无法初始化 3D 渲染（WebGL 可能不可用）：' + (e.message || e))
}

let currentData = null
let busy = false
let packs = [] // 资源包清单 [{name, file}]

// 全局错误捕获，让任何错误都显示在页面上
window.addEventListener('error', (e) => {
  ui.showError('脚本错误：' + (e.message || (e.error && e.error.message) || '未知错误'))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  ui.showError('运行错误：' + ((r && (r.message || r)) || '未知错误'))
})

// 启动自检
function checkCapabilities() {
  const problems = []
  if (typeof DecompressionStream === 'undefined') {
    problems.push('当前浏览器不支持 DecompressionStream（解压 .litematica 必需），请升级浏览器')
  }
  let webglOk = false
  try {
    const c = document.createElement('canvas')
    webglOk = !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    webglOk = false
  }
  if (!webglOk) problems.push('当前浏览器不支持 WebGL，无法 3D 渲染')
  if (problems.length) ui.showError(problems.join('；'))
}
checkCapabilities()
loadPixelFont()
loadPackList()

const fileInput = document.getElementById('fileInput')
const packInput = document.getElementById('packInput')

document.getElementById('openBtn').addEventListener('click', () => fileInput.click())
document.getElementById('packBtn').addEventListener('click', () => packInput.click())
document.getElementById('clearBtn').addEventListener('click', () => {
  renderer?.clear()
  currentData = null
  ui.clearError()
  ui.showMetadata({})
  ui.setStatus('已清除，可拖入新文件')
  ui.setProgress(0)
})

// 设置面板开关 + 背景色
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.toggle('hidden')
})
document.getElementById('settingsCloseBtn').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.add('hidden')
})
document.getElementById('bgColor').addEventListener('input', (e) => {
  renderer?.setBackgroundColor(e.target.value)
})

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0])
  e.target.value = ''
})
packInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadPackFromFile(e.target.files[0])
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
  if (f.name.toLowerCase().endsWith('.zip')) loadPackFromFile(f)
  else openFile(f)
})

async function openFile(file) {
  if (busy) return
  if (!renderer) {
    ui.showError('3D 渲染不可用，无法预览')
    return
  }
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在解析文件 …')
    ui.setProgress(0.02)
    const buffer = await file.arrayBuffer()

    const data = await parseLitematica(buffer, (f) => {
      ui.setProgress(0.02 + f * 0.18)
      ui.setStatus(`正在解析文件 … ${Math.round(f * 100)}%`)
    })
    ui.setProgress(0.2)

    const palette = data.palette
    ui.setStatus(`正在解析方块模型（${palette.length} 种方块）…`)
    const baked = await Promise.all(palette.map((p) => resolver.resolve(p.name, p.properties)))
    palette.forEach((p, i) => {
      p.baked = baked[i]
    })
    ui.setProgress(0.35)

    currentData = data
    ui.setStatus(`正在生成几何体（${data.blocks.size.toLocaleString()} 个方块）…`)
    const stats = await renderer.render(data, assets, (p) => ui.setProgress(0.35 + p * 0.6))
    await renderCurrentSigns()
    await renderCurrentEntities()
    ui.showMetadata(data.metadata)
    const entityNote = data.entities?.length ? `，${data.entities.length} 个实体` : ''
    ui.setStatus(`完成：${stats.faces.toLocaleString()} 个面，${stats.textures} 种贴图${entityNote}`)
    ui.setProgress(1)
  } catch (e) {
    console.error(e)
    ui.showError('加载失败：' + (e.message || e))
    ui.setProgress(0)
  } finally {
    busy = false
  }
}

async function autoLoadDemo() {
  try {
    const params = new URLSearchParams(location.search)
    const name = params.get('file') || 'demo.litematic'
    const resp = await fetch(name)
    if (!resp.ok) return
    const blob = await resp.blob()
    await openFile(new File([blob], name))
  } catch (e) {
    console.error(e)
  }
}

// 重新解析方块贴图并重渲染当前已加载的结构
async function reRenderCurrent() {
  if (!currentData || !renderer) return
  resolver.clear()
  const palette = currentData.palette
  const baked = await Promise.all(palette.map((p) => resolver.resolve(p.name, p.properties)))
  palette.forEach((p, i) => {
    p.baked = baked[i]
  })
  await renderer.render(currentData, assets, (p) => ui.setProgress(p))
  await renderCurrentSigns()
  await renderCurrentEntities()
}

// 渲染当前结构里的告示牌
async function renderCurrentSigns() {
  if (!currentData || !renderer) return
  await renderer.renderSigns(extractSigns(currentData), assets)
}

// 渲染当前结构里的实体
async function renderCurrentEntities() {
  if (!currentData || !renderer) return
  await renderer.renderEntities(currentData.entities || [], assets, currentData)
}

// 从方块实体中提取告示牌：{x, y, z, rotation, lines}
function extractSigns(data) {
  const signs = []
  for (const te of data.tileEntities || []) {
    if (te.id !== 'minecraft:sign' && te.id !== 'minecraft:hanging_sign') continue
    const lines = []
    const ft = te.nbt && te.nbt.front_text
    if (ft && Array.isArray(ft.messages)) {
      for (const m of ft.messages) lines.push(textComponentToString(m))
    } else {
      // 旧格式：Text1..Text4
      for (let i = 1; i <= 4; i++) lines.push(textComponentToString(te.nbt && te.nbt['Text' + i]))
    }
    if (lines.every((l) => !l)) continue
    const b = data.bounds
    const gi = data.blocks.get((te.x - b.minX) + (te.z - b.minZ) * b.width + (te.y - b.minY) * (b.width * b.depth))
    const rotation = gi !== undefined ? data.palette[gi].properties?.rotation : 0
    signs.push({ x: te.x, y: te.y, z: te.z, rotation: Number(rotation) || 0, lines })
  }
  return signs
}

// 把 JSON 文本组件转成纯文本（简化处理）
function textComponentToString(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text
    if (Array.isArray(c.extra)) return c.extra.map(textComponentToString).join('')
    if (typeof c.translate === 'string') return c.translate
  }
  return ''
}

// —— 资源包管理 ——

function updatePackPanels() {
  const loaded = assets.getPackNames()
  ui.renderPackPanels(loaded, packs, {
    onLoad: (pack) => loadPack(pack),
    onUnload: (name) => unloadPack(name),
    onMove: (name, delta) => movePack(name, delta),
  })
}

// 从清单里的 URL 加载资源包
async function loadPack(pack) {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在加载资源包 ' + pack.name + ' …')
    const resp = await fetch('resourcepacks/' + encodeURIComponent(pack.file))
    if (!resp.ok) throw new Error('资源包下载失败（HTTP ' + resp.status + '）')
    const zip = await JSZip.loadAsync(await resp.blob())
    assets.addPack(zip, pack.name)
    await reRenderCurrent()
    updatePackPanels()
    ui.setStatus('资源包已加载：' + pack.name)
  } catch (e) {
    console.error(e)
    ui.showError('资源包加载失败：' + (e.message || e))
  } finally {
    busy = false
  }
}

// 卸载资源包
async function unloadPack(name) {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    assets.removePack(name)
    await reRenderCurrent()
    updatePackPanels()
    ui.setStatus('已卸载资源包：' + name)
  } catch (e) {
    console.error(e)
    ui.showError('卸载失败：' + (e.message || e))
  } finally {
    busy = false
  }
}

// 调整资源包优先级（delta = -1 上移 / +1 下移）
async function movePack(name, delta) {
  if (busy) return
  busy = true
  try {
    assets.movePack(name, delta)
    await reRenderCurrent()
    updatePackPanels()
  } catch (e) {
    console.error(e)
    ui.showError('调整优先级失败：' + (e.message || e))
  } finally {
    busy = false
  }
}

// 从用户选择的文件加载资源包
async function loadPackFromFile(file) {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在加载资源包 …')
    const zip = await JSZip.loadAsync(file)
    assets.addPack(zip, file.name.replace(/\.zip$/i, ''))
    await reRenderCurrent()
    updatePackPanels()
    ui.setStatus('资源包已加载（打开文件后生效）')
  } catch (e) {
    console.error(e)
    ui.showError('资源包加载失败：' + (e.message || e))
  } finally {
    busy = false
  }
}

// 加载资源包清单并渲染两栏列表
async function loadPackList() {
  try {
    const resp = await fetch('resourcepacks/manifest.json')
    if (!resp.ok) return
    packs = await resp.json()
    updatePackPanels()
    // 默认资源包：XK 红石显示（若存在则自动加载）
    const def = packs.find((p) => /XK/i.test(p.name))
    if (def) await loadPack(def)
  } catch {
    /* 没有清单时静默忽略 */
  }
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
const _sp = new URLSearchParams(location.search)
if (_sp.has('demo') || _sp.has('file')) {
  autoLoadDemo()
}
