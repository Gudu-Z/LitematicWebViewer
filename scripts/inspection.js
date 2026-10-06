import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import JSZip from 'jszip'
import { AssetProvider } from '../src/assets.js'
import { CATALOG, CATEGORY_NAMES, ITEM_OPTIONS, officialName, entityFields, getPath, filterCatalog, language, setLanguage } from './inspection-catalog.js'
import { buildInspectionModel, disposeInspectionModel, fieldsFor, inspectionItemId } from './inspection-models.js'
import { t, optionLabel, translateDocument } from './inspection-i18n.js'

const $ = id => document.getElementById(id)
const PAGE_SIZE = 24
const sharedTextures = new Set(), failures = []
function makeAssets() {
  const provider = new AssetProvider()
  provider.baseUrl = new URL('../assets/minecraft/', location.href).href
  const load = provider.getTexture.bind(provider)
  provider.getTexture = async key => {
    const texture = await load(key)
    if (texture && !provider.retired) sharedTextures.add(texture)
    else if (texture) texture.dispose()
    else failures.push('贴图：' + key)
    return texture
  }
  return provider
}
let assets = makeAssets(), scenes = [], generation = 0, detailGeneration = 0
let activeEntry = null, activeFields = [], activeValues = {}, activeItem = '', detailView = null
let paused = false, age = 0, lastTime = performance.now(), packZip = null
let route = readRoute()
setLanguage(route.lang)
translateDocument()
let activeView = 'world'
const entryName = entry => officialName(entry.id, entry.kind === 'block' ? 'block' : 'entity')
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.domElement.className = 'grid-canvas'
document.body.prepend(renderer.domElement)
const detailRenderer = new THREE.WebGLRenderer({ antialias: true })
detailRenderer.setPixelRatio(Math.min(devicePixelRatio, 2))
$('detail-stage').append(detailRenderer.domElement)
const detailCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 200)
const controls = new OrbitControls(detailCamera, detailRenderer.domElement)
controls.enableDamping = true

function readRoute() {
  const p = new URLSearchParams(location.search)
  const raw = p.get('scope'), scope = raw === 'features' ? 'mob' : ['block', 'mob', 'entity'].includes(raw) ? raw : 'all'
  return { scope, query: p.get('q') || '', page: Math.max(0, Math.floor(Number(p.get('page')) || 0)), pack: p.get('pack') === 'vanilla' ? 'vanilla' : 'xk', lang: p.get('lang') === 'en' ? 'en' : 'zh' }
}
function writeRoute() {
  const p = new URLSearchParams({ scope: route.scope, page: route.page })
  if (route.query) p.set('q', route.query)
  if (route.pack === 'vanilla') p.set('pack', 'vanilla')
  if (route.lang === 'en') p.set('lang', 'en')
  history.replaceState(null, '', '?' + p)
}
const dispose = group => disposeInspectionModel(group, sharedTextures)
function clearViews() {
  for (const view of scenes) dispose(view.group)
  scenes = []
  renderer.renderLists.dispose()
}
function modelMessage(group, entry) {
  let count = 0
  group?.traverse(o => { if (o.isMesh || o.isPoints) count++ })
  if (count) return ''
  return ['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void'].includes(entry.id)
    ? t('此方块在世界中不可见') : t('此对象当前没有可显示的模型')
}
function createView(group, entry, slot) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#202f43')
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7f9e, 1.65))
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(3, 5, 4); scene.add(sun)
  scene.add(group)
  group.updateMatrixWorld(true)
  group.traverse(o => { if (o.isSkinnedMesh) { o.skeleton.update(); o.computeBoundingBox() } })
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty()) box.set(new THREE.Vector3(-.5, 0, -.5), new THREE.Vector3(.5, 1, .5))
  const center = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3())
  const radius = Math.max(extent.x, extent.y, extent.z, .6) * .76
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, .01, 200)
  const direction = entry.kind === 'block' ? new THREE.Vector3(.8, .6, 1) : new THREE.Vector3(.3, .18, 1)
  camera.position.copy(center).add(direction.clone().multiplyScalar(radius * 5)); camera.lookAt(center)
  return { scene, group, entry, slot, center, radius, camera, direction }
}
function animationTime(group) {
  group.traverse(o => { if (o.userData.updateAnimation) o.userData.animationAge = age })
}
async function defaultFields(entry, provider, values = {}) {
  return entry.kind === 'block' ? fieldsFor(entry, provider, values) : entityFields(entry)
}
function initialValues(entry, fields) {
  return Object.fromEntries(fields.map(f => {
    const current = getPath(entry.fixture, f.path)
    const option = f.options.find(o => JSON.stringify(o.value) === JSON.stringify(current))
    // 缺省有角、保留南瓜、原色潜影贝等状态与实际默认实体一致。
    const implicit = { 'nbt.HasLeftHorn': 1, 'nbt.HasRightHorn': 1, 'nbt.Pumpkin': 1, 'nbt.Color': entry.id === 'shulker' ? 16 : 0, 'nbt.CollarColor': 14 }
    const preferred = f.options.find(o => o.value === implicit[f.path])
    return [f.path, (option || preferred || f.options[0]).value]
  }))
}
async function renderPage() {
  const token = ++generation, provider = assets
  window.ready = false
  clearViews(); $('grid').replaceChildren(); $('grid').setAttribute('aria-busy', 'true')
  const matches = filterCatalog(route.scope, route.query)
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE))
  route.page = Math.min(route.page, pages - 1); writeRoute()
  $('scope').value = route.scope; $('search').value = route.query; $('pack').value = route.pack
  $('status').textContent = `${t(CATEGORY_NAMES[route.scope] || '全部')} · ${matches.length.toLocaleString()} ${language === 'en' ? 'entries' : '项'}`
  $('page-label').textContent = `${route.page + 1} / ${pages}`
  $('previous').disabled = route.page === 0; $('next').disabled = route.page >= pages - 1
  $('empty').hidden = matches.length > 0
  const entries = matches.slice(route.page * PAGE_SIZE, (route.page + 1) * PAGE_SIZE)
  const jobs = entries.map(({ entry, matchedItem, matchedBlock }) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cell'; button.dataset.key = entry.key
    const slot = document.createElement('div'); slot.className = 'model-slot'
    const message = document.createElement('span'); message.className = 'cell-message'; message.textContent = t('加载中…'); slot.append(message)
    const caption = document.createElement('div'); caption.className = 'caption'
    const title = document.createElement('strong'); title.textContent = entryName(entry)
    const note = document.createElement('small'); note.textContent = matchedItem ? officialName(matchedItem, 'item') : t(CATEGORY_NAMES[entry.kind])
    caption.append(title, note); button.append(slot, caption); $('grid').append(button)
    button.onclick = () => openDetail(entry, matchedItem, matchedBlock)
    return async () => {
      let group
      try {
        const fields = await defaultFields(entry, provider, { block: matchedBlock })
        if (token !== generation) return
        const values = initialValues(entry, fields)
        if (matchedBlock) values.block = matchedBlock
        group = await buildInspectionModel(entry, provider, values, matchedItem)
        if (token !== generation) { dispose(group); return }
        message.textContent = modelMessage(group, entry)
        if (group) scenes.push(createView(group, entry, slot))
      } catch (error) {
        dispose(group)
        if (token === generation) message.textContent = t('模型加载失败')
        failures.push(entry.key + ': ' + error.message)
      }
    }
  })
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < jobs.length && token === generation) await jobs[cursor++]()
  }))
  if (token === generation) { $('grid').setAttribute('aria-busy', 'false'); window.ready = true }
}

function fillFields() {
  $('state-fields').replaceChildren()
  for (const [index, f] of activeFields.entries()) {
    const row = document.createElement('div'); row.className = 'state-field'
    const label = document.createElement('label'); label.textContent = t(f.label, f.path); label.htmlFor = 'state-' + index
    const select = document.createElement('select'); select.id = label.htmlFor; select.dataset.path = f.path
    f.options.forEach((o, i) => select.add(new Option(optionLabel(o), String(i))))
    select.value = String(Math.max(0, f.options.findIndex(o => JSON.stringify(o.value) === JSON.stringify(activeValues[f.path]))))
    select.onchange = () => {
      activeValues[f.path] = f.options[Number(select.value)].value
      if (f.path === 'block') refreshBlockFields()
      else rebuildDetail()
    }
    row.append(label, select); $('state-fields').append(row)
  }
  if (!activeFields.length) {
    const note = document.createElement('p'); note.className = 'no-state'; note.textContent = t('此对象使用默认外观。'); $('state-fields').append(note)
  }
}
function fillItems() {
  const query = $('item-search').value.trim().toLowerCase()
  const options = ITEM_OPTIONS.filter(o => (officialName(o.value, 'item') + ' ' + o.label + ' ' + o.value).toLowerCase().includes(query))
  const select = $('item-select'); select.replaceChildren(new Option(t('空展示框'), ''))
  // 筛选时保留当前选中项，避免浏览选项就意外更换模型。
  const selected = ITEM_OPTIONS.find(o => o.value === activeItem)
  if (selected && !options.includes(selected)) select.add(new Option(officialName(selected.value, 'item'), selected.value))
  for (const o of options) select.add(new Option(officialName(o.value, 'item'), o.value))
  select.value = activeItem
}
async function openDetail(entry, item = '', block) {
  const token = ++detailGeneration
  activeEntry = entry; activeItem = item || ''; activeFields = []; activeValues = {}
  activeView = 'world'; $('view-mode').value = 'world'
  $('view-mode').options[1].textContent = t(entry.kind === 'mob' ? '刷怪蛋' : '物品形态')
  if (detailView) dispose(detailView.group)
  detailView = null; controls.enabled = false
  $('detail-title').textContent = entryName(entry); $('detail-category').textContent = t(CATEGORY_NAMES[entry.kind])
  $('detail-id').textContent = 'minecraft:' + entry.id
  $('state-fields').replaceChildren(); $('item-fields').hidden = entry.key !== 'entity/item_frame'
  $('reset-state').disabled = true
  $('item-search').value = ''; fillItems()
  $('model-message').textContent = t('正在加载模型…')
  if (!$('detail').open) $('detail').showModal()
  try {
    const fields = await defaultFields(entry, assets, { block })
    if (token !== detailGeneration || !$('detail').open) return
    activeFields = fields
    activeValues = initialValues(entry, activeFields)
    if (block) activeValues.block = block
    fillFields()
    $('reset-state').disabled = false
    await rebuildDetail()
  } catch (error) { if (token === detailGeneration) $('model-message').textContent = t('加载失败：') + error.message }
}
async function refreshBlockFields(reset = false) {
  const token = ++detailGeneration, entry = activeEntry, previous = reset ? {} : { ...activeValues }
  $('reset-state').disabled = true
  try {
    const fields = await defaultFields(entry, assets, previous)
    if (token !== detailGeneration || !$('detail').open) return
    activeFields = fields; activeValues = initialValues(entry, fields)
    for (const field of fields) if (field.options.some(o => o.value === previous[field.path])) activeValues[field.path] = previous[field.path]
    fillFields(); $('reset-state').disabled = false
    await rebuildDetail()
  } catch (error) { if (token === detailGeneration) $('model-message').textContent = t('加载失败：') + error.message }
}
async function rebuildDetail() {
  const token = ++detailGeneration, entry = activeEntry, provider = assets
  const values = structuredClone(activeValues), item = activeItem
  $('model-message').textContent = t('正在加载模型…')
  let group
  try {
    group = await buildInspectionModel(entry, provider, values, item, activeView)
    if (token !== detailGeneration || !$('detail').open) { dispose(group); return }
    if (detailView) dispose(detailView.group)
    detailView = group ? createView(group, entry, $('detail-stage')) : null
    const viewedItem = activeView !== 'world' ? inspectionItemId(entry, values) : null
    $('model-message').textContent = activeView !== 'world' && !viewedItem ? t('此对象没有对应的物品或刷怪蛋') : modelMessage(group, entry) || (viewedItem || item ? officialName(viewedItem || item, 'item') : t('切换状态可对照不同外观'))
    $('detail-id').textContent = values.id || 'minecraft:' + (values.block || entry.id)
    controls.enabled = !!detailView
    resetCamera()
  } catch (error) {
    dispose(group)
    if (token === detailGeneration) { $('model-message').textContent = t('加载失败：') + error.message; failures.push(entry.key + ': ' + error.message) }
  }
}
function resetCamera() {
  if (!detailView) return
  const { center, radius, direction } = detailView
  controls.target.copy(center)
  const aspect = Math.max(.25, $('detail-stage').clientWidth / $('detail-stage').clientHeight)
  detailCamera.position.copy(center).add(direction.clone().normalize().multiplyScalar(radius * 3.5 / Math.min(1, aspect)))
  detailCamera.near = .01; detailCamera.far = Math.max(200, radius * 25)
  controls.minDistance = radius * .6; controls.maxDistance = radius * 12
  controls.update(); controls.saveState()
}
function closeDetail() { $('detail').close() }
$('detail').addEventListener('close', () => {
  ++detailGeneration; controls.enabled = false
  if (detailView) dispose(detailView.group)
  detailView = null; activeEntry = null; detailRenderer.renderLists.dispose()
})
$('close-detail').onclick = closeDetail
$('detail').addEventListener('click', event => { if (event.target === $('detail')) {
  const r = $('detail').getBoundingClientRect()
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDetail()
} })
$('reset-view').onclick = resetCamera
$('reset-state').onclick = () => {
  if (activeEntry.kind === 'block') return refreshBlockFields(true)
  activeValues = initialValues(activeEntry, activeFields); activeItem = ''; fillFields(); fillItems(); rebuildDetail()
}
$('item-search').oninput = fillItems
$('item-select').onchange = () => { activeItem = $('item-select').value; rebuildDetail() }
$('view-mode').onchange = () => { activeView = $('view-mode').value; rebuildDetail() }
$('language').onclick = async () => {
  route.lang = language === 'en' ? 'zh' : 'en'; setLanguage(route.lang); translateDocument()
  $('pause').textContent = t(paused ? '继续动画' : '暂停动画')
  if ($('detail').open) {
    $('detail-title').textContent = entryName(activeEntry); $('detail-category').textContent = t(CATEGORY_NAMES[activeEntry.kind])
    $('view-mode').options[1].textContent = t(activeEntry.kind === 'mob' ? '刷怪蛋' : '物品形态')
    activeFields = await defaultFields(activeEntry, assets, activeValues)
    fillFields(); fillItems(); rebuildDetail()
  }
  renderPage()
}
$('scope').onchange = () => { route.scope = $('scope').value; route.page = 0; renderPage() }
let searchTimer
$('search').oninput = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { route.query = $('search').value; route.page = 0; renderPage() }, 180)
}
for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).onclick = () => { route.page += step; renderPage(); window.scrollTo({ top: 0 }) }
$('pause').onclick = () => {
  paused = !paused; $('pause').textContent = t(paused ? '继续动画' : '暂停动画'); $('pause').setAttribute('aria-pressed', String(paused))
}
let packGeneration = 0
async function changePack() {
  const token = ++packGeneration
  ++generation; clearViews(); $('status').textContent = t('正在加载资源包…'); window.ready = false
  if ($('detail').open) closeDetail()
  const next = makeAssets()
  try {
    if (route.pack === 'xk') {
      if (!packZip) {
        const response = await fetch(new URL('../resourcepacks/XK redstone display 26.3.0.zip', location.href))
        if (!response.ok) throw Error(t('资源包下载失败'))
        packZip = await JSZip.loadAsync(await response.arrayBuffer())
      }
      next.addPack(packZip, 'XK')
    }
    if (token !== packGeneration) return
    assets.retired = true
    for (const promise of assets.textureCache.values()) promise.then(texture => { if (texture) { sharedTextures.delete(texture); texture.dispose() } })
    assets = next
    await renderPage()
  } catch (error) { $('status').textContent = t('加载失败：') + error.message; failures.push(error.message) }
}
$('pack').onchange = () => { route.pack = $('pack').value; changePack() }

function renderFrame(now) {
  if (!paused) age += Math.min(100, now - lastTime) / 50
  lastTime = now
  assets.updateAnimations(age)
  const width = document.documentElement.clientWidth
  renderer.setSize(width, innerHeight, false)
  renderer.setScissorTest(false); renderer.setClearColor('#131c29', 1); renderer.clear(); renderer.setScissorTest(true)
  for (const view of scenes) {
    const r = view.slot.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= innerHeight || r.width === 0) continue
    const aspect = r.width / r.height
    view.camera.left = -view.radius * aspect; view.camera.right = view.radius * aspect; view.camera.updateProjectionMatrix()
    animationTime(view.group)
    renderer.setViewport(r.left, innerHeight - r.bottom, r.width, r.height)
    renderer.setScissor(Math.max(0, r.left), Math.max(0, innerHeight - r.bottom), Math.min(width, r.right) - Math.max(0, r.left), Math.min(innerHeight, r.bottom) - Math.max(0, r.top))
    renderer.render(view.scene, view.camera)
  }
  if ($('detail').open) {
    const stage = $('detail-stage'), width = stage.clientWidth, height = stage.clientHeight
    detailRenderer.setSize(width, height, false)
    if (detailView) {
      animationTime(detailView.group); controls.update()
      detailCamera.aspect = width / height; detailCamera.updateProjectionMatrix()
      detailRenderer.render(detailView.scene, detailCamera)
    } else { detailRenderer.setClearColor('#202f43'); detailRenderer.clear() }
  }
}
renderer.setAnimationLoop(renderFrame)
window.renderCheck = { renderer, detailRenderer, failures, catalog: CATALOG, get scenes() { return scenes }, get detailView() { return detailView }, get age() { return age } }
await changePack()
