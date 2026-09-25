// 入口：串联文件读取、解析、模型解析、渲染，以及资源包加载。

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
loadPackList()

const fileInput = document.getElementById('fileInput')
const packInput = document.getElementById('packInput')

document.getElementById('openBtn').addEventListener('click', () => fileInput.click())
document.getElementById('packBtn').addEventListener('click', () => packInput.click())
document.getElementById('resetPackBtn').addEventListener('click', resetPack)
document.getElementById('clearBtn').addEventListener('click', () => {
  renderer?.clear()
  currentData = null
  ui.clearError()
  ui.showMetadata({})
  ui.setStatus('已清除，可拖入新文件')
  ui.setProgress(0)
})

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0])
  e.target.value = ''
})
packInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadResourcePack(e.target.files[0])
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
  if (f.name.toLowerCase().endsWith('.zip')) loadResourcePack(f)
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

    const data = await parseLitematica(buffer)
    ui.setProgress(0.2)

    const palette = data.palette
    ui.setStatus(`正在解析方块模型（${palette.length} 种方块）…`)
    const baked = await Promise.all(palette.map((p) => resolver.resolve(p.name, p.properties)))
    palette.forEach((p, i) => {
      p.baked = baked[i]
    })
    ui.setProgress(0.35)

    currentData = data
    const stats = await renderer.render(data, assets, (p) => ui.setProgress(0.35 + p * 0.6))
    await renderCurrentSigns()
    ui.showMetadata(data.metadata)
    ui.setStatus(`完成：${stats.faces.toLocaleString()} 个面，${stats.textures} 种贴图`)
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
    if (renderer) {
      const s = renderer.debugPixels()
      ui.statusEl.textContent += ` | 调试：画面共 ${s.distinctColors} 种颜色`
    }
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
}

// 渲染当前结构里的告示牌
async function renderCurrentSigns() {
  if (!currentData || !renderer) return
  await renderer.renderSigns(extractSigns(currentData), assets)
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
    const gi = data.blocks.get(te.x + ',' + te.y + ',' + te.z)
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

async function loadResourcePack(file) {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在加载资源包 …')
    ui.setProgress(0.05)
    const zip = await JSZip.loadAsync(file)
    await assets.setResourcePack(zip)
    ui.setActivePack(null)
    await reRenderCurrent()
    ui.setStatus(currentData ? '资源包已加载并重新渲染' : '资源包已加载（打开文件后生效）')
    ui.setProgress(1)
  } catch (e) {
    console.error(e)
    ui.showError('资源包加载失败：' + (e.message || e))
    ui.setProgress(0)
  } finally {
    busy = false
  }
}

// 从列表加载已安装的资源包
async function loadPackFromUrl(pack) {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在加载资源包 ' + pack.name + ' …')
    ui.setProgress(0.05)
    const resp = await fetch('resourcepacks/' + encodeURIComponent(pack.file))
    if (!resp.ok) throw new Error('资源包下载失败（HTTP ' + resp.status + '）')
    const zip = await JSZip.loadAsync(await resp.blob())
    await assets.setResourcePack(zip)
    ui.setActivePack(pack.name)
    await reRenderCurrent()
    ui.setStatus('资源包已加载：' + pack.name)
    ui.setProgress(1)
  } catch (e) {
    console.error(e)
    ui.showError('资源包加载失败：' + (e.message || e))
    ui.setProgress(0)
  } finally {
    busy = false
  }
}

// 恢复默认材质（卸载资源包）
async function resetPack() {
  if (busy) return
  busy = true
  ui.clearError()
  try {
    ui.setStatus('正在恢复默认材质 …')
    await assets.setResourcePack(null)
    ui.setActivePack(null)
    await reRenderCurrent()
    ui.setStatus('已恢复默认材质')
    ui.setProgress(1)
  } catch (e) {
    console.error(e)
    ui.showError('恢复默认失败：' + (e.message || e))
  } finally {
    busy = false
  }
}

// 加载资源包清单并渲染列表
async function loadPackList() {
  try {
    const resp = await fetch('resourcepacks/manifest.json')
    if (!resp.ok) return
    const packs = await resp.json()
    ui.renderPackList(packs, (pack) => loadPackFromUrl(pack))
    // 默认资源包：XK 红石显示（若存在则自动加载）
    const def = packs.find((p) => /XK/i.test(p.name))
    if (def) await loadPackFromUrl(def)
  } catch {
    /* 没有清单时静默忽略 */
  }
}

// 调试/截图用：URL 带 ?demo 或 ?file=xxx 时自动加载文件
const _sp = new URLSearchParams(location.search)
if (_sp.has('demo') || _sp.has('file')) {
  autoLoadDemo()
}
