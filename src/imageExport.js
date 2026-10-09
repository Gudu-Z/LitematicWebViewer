import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import markup from './imageExport.html?raw'
import './imageExport.css'
import { getLang } from './i18n.js'
import { exportFilename, fitImageCamera, setImageAspect, validImageSize, viewDirection, MAX_EXPORT_EDGE } from './imageExportCamera.js'

const WORDS = {
  title: ['导出图片', 'Export image'], back: ['返回预览器', 'Back to viewer'],
  composition: ['构图与视角', 'Composition'], canvas: ['画布与背景', 'Canvas & background'], scene: ['场景内容', 'Scene'],
  views: ['预设视角', 'View presets'], iso: ['等轴侧', 'Isometric'], front: ['正面', 'Front'], side: ['侧面', 'Side'], top: ['顶部', 'Top'], current: ['当前视角', 'Viewer angle'], fit: ['适应画布', 'Fit canvas'],
  projection: ['投影方式', 'Projection'], orthographic: ['正交', 'Orthographic'], perspective: ['透视', 'Perspective'],
  yaw: ['水平角度', 'Azimuth'], pitch: ['俯仰角度', 'Elevation'], zoom: ['缩放', 'Scale'], padding: ['自动构图留白', 'Fit margin'], guides: ['显示三分线（不导出）', 'Thirds guides (preview only)'],
  ratio: ['画布比例', 'Aspect ratio'], custom: ['自定义', 'Custom'], width: ['宽度 / px', 'Width / px'], height: ['高度 / px', 'Height / px'], resolution: ['分辨率预设', 'Resolution presets'],
  background: ['背景', 'Background'], transparent: ['透明', 'Transparent'], solid: ['纯色', 'Solid color'], color: ['背景颜色', 'Background color'],
  entities: ['显示生物与实体', 'Show mobs & entities'], dimensions: ['显示尺寸标注', 'Show dimensions'], regions: ['显示区域线框', 'Show region outlines'], animate: ['播放动画', 'Run animations'],
  sceneHint: ['沿用预览器的资源包、渲染层级和区域选择。', 'Uses the viewer’s resource packs, layer selection and visible regions.'],
  filename: ['文件名', 'File name'], save: ['导出 PNG', 'Export PNG'], open: ['打开投影文件', 'Open schematic'], demo: ['体验示例', 'Try the demo'],
  emptyTitle: ['为你的建筑留一张图', 'Give your build a portrait'], emptyHint: ['打开或拖入投影文件，调整视角，然后导出透明背景的高清图片。', 'Open or drop a schematic, compose your view and export a high-resolution transparent image.'],
  noFile: ['尚未加载投影', 'No schematic loaded'], gesture: ['左键旋转 · 右键平移 · 滚轮缩放', 'Left-drag orbit · Right-drag pan · Scroll to zoom'],
  sizeHint: ['最长边 {max} px · 最多 16 MP', 'Up to {max} px per side · 16 MP maximum'], sizeError: ['尺寸需为 64–{max} 的整数，且总像素不超过 16 MP。', 'Use whole dimensions from 64 to {max}, with at most 16 MP total.'],
  preparing: ['正在载入投影…', 'Loading schematic…'], saving: ['正在生成 PNG…', 'Creating PNG…'], saved: ['已导出 {width} × {height} PNG', 'Exported {width} × {height} PNG'],
  failed: ['导出失败，请尝试降低图片尺寸。', 'Export failed. Try a smaller image size.'], lost: ['渲染上下文不可用，请关闭并重新打开导出界面。', 'Rendering is unavailable. Close and reopen the export studio.'],
  invalidFile: ['请选择 .litematic、.litematica 或 .nbt 文件。', 'Choose a .litematic, .litematica or .nbt file.'],
}
const tr = (key, values = {}) => {
  let text = WORDS[key]?.[getLang() === 'en' ? 1 : 0] || key
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, value)
  return text
}

export class ImageExport {
  constructor({ renderer, getData, getFileName, openFile, openDemo, getError, changeLanguage }) {
    Object.assign(this, { source: renderer, getData, getFileName, openFile, openDemo, getError, changeLanguage })
    this.dialog = document.createElement('dialog')
    this.dialog.id = 'imageExport'
    this.dialog.setAttribute('aria-labelledby', 'exportTitle')
    this.dialog.innerHTML = markup
    document.body.append(this.dialog)
    this.el = Object.fromEntries([...this.dialog.querySelectorAll('[id]')].map(el => [el.id.replace(/^export/, ''), el]))
    this.loading = false; this.exporting = false; this.maxEdge = MAX_EXPORT_EDGE
    this.el.Back.onclick = () => this.close()
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.release() })
    this.el.Lang.onclick = () => { this.changeLanguage(); this.translate() }
    for (const id of ['Open', 'EmptyOpen']) this.el[id].onclick = () => this.el.FileInput.click()
    this.el.Demo.onclick = () => this.loadDemo()
    this.el.FileInput.onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) this.loadFile(file) }
    for (const type of ['dragenter', 'dragover', 'dragleave']) this.dialog.addEventListener(type, event => { event.preventDefault(); event.stopPropagation() })
    this.dialog.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); const file = event.dataTransfer?.files[0]; if (file) this.loadFile(file) })
    this.el.Save.onclick = () => this.save()
    this.el.Fit.onclick = () => this.fit()
    for (const button of this.dialog.querySelectorAll('[data-export-view]')) button.onclick = () => this.preset(button.dataset.exportView)
    this.el.Projection.onchange = () => {
      const direction = this.camera.position.clone().sub(this.controls.target).normalize()
      this.camera = this.makeCamera()
      this.controls.object = this.camera
      this.fit(direction)
      this.markPreset(null)
    }
    this.el.Padding.onchange = () => this.fit()
    for (const id of ['Yaw', 'Pitch']) this.el[id].oninput = () => {
      const distance = this.camera.position.distanceTo(this.controls.target)
      this.camera.position.copy(this.controls.target).addScaledVector(viewDirection(+this.el.Yaw.value, +this.el.Pitch.value), distance)
      this.controls.update(); this.markPreset(null)
    }
    this.el.Zoom.oninput = () => {
      const scale = +this.el.Zoom.value / 100
      if (this.camera.isOrthographicCamera) this.camera.zoom = scale
      else this.camera.position.sub(this.controls.target).normalize().multiplyScalar(this.baseDistance / scale).add(this.controls.target)
      this.camera.updateProjectionMatrix(); this.controls.update(); this.updateAngles()
    }
    this.el.ShowGuides.onchange = () => { this.el.Guides.hidden = !this.el.ShowGuides.checked }
    this.el.Background.onchange = () => { this.el.ColorField.hidden = this.el.Background.value !== 'solid' }
    this.el.Ratio.onchange = () => {
      if (this.el.Ratio.value !== 'custom') this.applyResolution(Math.max(+this.el.Width.value, +this.el.Height.value) || 2048)
    }
    for (const id of ['Width', 'Height']) this.el[id].oninput = () => { this.el.Ratio.value = 'custom'; this.dimensionsChanged() }
    for (const button of this.dialog.querySelectorAll('[data-export-size]')) button.onclick = () => this.applyResolution(+button.dataset.exportSize)
    this.translate()
  }

  get isOpen() { return this.dialog.open }
  get dimensions() { return { width: Number(this.el.Width.value), height: Number(this.el.Height.value) } }
  get aspect() { const { width, height } = this.dimensions; return validImageSize(width, height, this.maxEdge) ? width / height : 1 }

  translate() {
    for (const el of this.dialog.querySelectorAll('[data-export-text]')) el.textContent = tr(el.dataset.exportText)
    for (const el of this.dialog.querySelectorAll('[data-export-label]')) el.setAttribute('aria-label', tr(el.dataset.exportLabel))
    this.el.Lang.textContent = getLang() === 'en' ? '中' : 'EN'
    this.el.SourceName.textContent = this.getFileName() || tr('noFile')
    this.el.LoadingText.textContent = tr('preparing')
    this.validate()
  }

  open() {
    if (this.isOpen || this.loading) return
    this.previousFocus = document.activeElement
    this.wasActive = this.source._active
    this.source.setActive(false)
    try {
      this.dialog.showModal()
      this.gl = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
      this.gl.outputColorSpace = THREE.SRGBColorSpace
      this.gl.setClearColor(0x000000, 0)
      this.gl.setPixelRatio(Math.min(devicePixelRatio, 2))
      this.el.Frame.prepend(this.gl.domElement)
      const context = this.gl.getContext()
      this.maxEdge = Math.min(MAX_EXPORT_EDGE, this.gl.capabilities.maxTextureSize, context.getParameter(context.MAX_RENDERBUFFER_SIZE))
      const contextOwner = this.gl
      this.gl.domElement.addEventListener('webglcontextlost', event => {
        if (this.gl !== contextOwner || !this.isOpen) return
        event.preventDefault(); this.message('lost', {}, true); this.contextLost = true; this.validate()
      })
      this.contextLost = false
      this.camera = this.makeCamera()
      this.controls = new OrbitControls(this.camera, this.gl.domElement)
      this.controls.screenSpacePanning = true
      this.controls.addEventListener('change', () => this.updateAngles())
      this.controls.addEventListener('start', () => this.markPreset(null))
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(this.el.Mat)
      this.el.Entities.checked = this.source.entitiesGroup.visible
      this.syncModel(true)
      this.translate(); this.resize(); this.message()
      this.lastTime = performance.now(); this.age = 0
      const tick = now => {
        if (!this.isOpen || !this.gl) return
        this.frame = requestAnimationFrame(tick)
        if (this.el.Animate.checked && !this.loading && !this.exporting) this.age += Math.min(now - this.lastTime, 100) / 50
        this.lastTime = now
        if (!this.exporting && !this.loading && document.visibilityState !== 'hidden') this.draw()
      }
      this.frame = requestAnimationFrame(tick)
    } catch (error) { this.close(); throw error }
  }

  close() {
    if (this.exporting) return
    if (this.dialog.open) this.dialog.close()
    this.release()
  }

  release() {
    cancelAnimationFrame(this.frame)
    this.observer?.disconnect()
    this.controls?.dispose()
    // The scene belongs to the viewer. Release only this context, never shared geometry/textures.
    this.gl?.dispose(); this.gl?.forceContextLoss(); this.gl?.domElement.remove()
    this.gl = null; this.controls = null
    if (this.wasActive !== undefined) { this.source.setActive(this.wasActive); this.wasActive = undefined }
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true })
    this.previousFocus = null
  }

  makeCamera() {
    return this.el.Projection.value === 'perspective' ? new THREE.PerspectiveCamera(45, this.aspect, .01, 10000) : new THREE.OrthographicCamera(-10, 10, 10, -10, .01, 10000)
  }

  syncModel(force = false) {
    if (!this.isOpen) return
    const data = this.getData()
    const changed = data !== this.modelData
    this.modelData = data
    this.el.Empty.hidden = !!data
    this.el.Frame.hidden = !data
    this.el.SourceName.textContent = this.getFileName() || tr('noFile')
    this.animated = []
    this.source.scene.traverse(object => { if (object.userData.updateAnimation) this.animated.push(object) })
    if (data && (force || changed)) {
      this.el.Filename.value = exportFilename(this.getFileName()).slice(0, -4)
      this.age = 0
      this.preset('iso')
    }
    this.validate()
  }

  bounds() {
    const box = new THREE.Box3()
    this.source.scene.updateMatrixWorld(true)
    for (const key of ['overviewGroup', 'group', 'signsGroup', 'headsGroup', 'bannersGroup', 'statuesGroup', 'potsGroup', ...(this.el.Entities.checked ? ['entitiesGroup'] : [])]) {
      const group = this.source[key]
      if (!group) continue
      // Export's entity checkbox is independent of the main viewer's visibility.
      const visible = group.visible; group.visible = true
      group.traverseVisible(object => {
        if (!object.geometry || object.userData.isEntityHitbox) return
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
        box.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld))
      })
      group.visible = visible
    }
    if (box.isEmpty()) {
      const b = this.modelData?.bounds
      if (b) box.set(new THREE.Vector3(b.minX, b.minY, b.minZ), new THREE.Vector3(b.maxX + 1, b.maxY + 1, b.maxZ + 1))
      else box.set(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
    }
    return box
  }

  fit(direction = this.camera?.position.clone().sub(this.controls.target).normalize()) {
    if (!this.modelData || !this.controls) return
    const result = fitImageCamera(this.camera, this.bounds(), this.aspect, direction || viewDirection(45, 35.2643897), +this.el.Padding.value)
    this.baseDistance = result.distance
    this.controls.target.copy(result.target)
    this.controls.minDistance = result.radius * .02
    this.controls.maxDistance = result.radius * 100
    this.controls.minZoom = .02; this.controls.maxZoom = 100
    this.controls.update(); this.updateAngles()
  }

  preset(name) {
    if (!this.modelData || !this.controls) return
    if (name === 'current') {
      this.camera = this.source.camera.clone()
      this.el.Projection.value = this.camera.isOrthographicCamera ? 'orthographic' : 'perspective'
      setImageAspect(this.camera, this.aspect)
      this.controls.object = this.camera
      const target = this.source.controls.target.clone()
      const depth = target.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3()))
      if (this.source.getMoveMode() === 'fly') target.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()), Math.max(1, depth))
      this.controls.target.copy(target)
      // Normalize orthographic zoom so the scale control starts at 100%.
      if (this.camera.isOrthographicCamera) {
        this.camera.top /= this.camera.zoom; this.camera.bottom /= this.camera.zoom; this.camera.zoom = 1; setImageAspect(this.camera, this.aspect)
      }
      this.baseDistance = this.camera.position.distanceTo(target)
      this.controls.update(); this.updateAngles()
    } else {
      const angles = { iso: [45, 35.2643897], front: [0, 0], side: [90, 0], top: [0, 90] }[name]
      if (name === 'iso') { this.el.Projection.value = 'orthographic'; this.camera = this.makeCamera(); this.controls.object = this.camera }
      this.fit(viewDirection(...angles))
    }
    this.markPreset(name)
  }

  markPreset(name) {
    for (const button of this.dialog.querySelectorAll('[data-export-view]')) button.setAttribute('aria-pressed', String(button.dataset.exportView === name))
  }

  updateAngles() {
    if (!this.controls) return
    const offset = this.camera.position.clone().sub(this.controls.target)
    const yaw = (THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z)) + 360) % 360
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(offset.y / offset.length(), -1, 1)))
    const zoom = (this.camera.isOrthographicCamera ? this.camera.zoom : this.baseDistance / offset.length()) * 100
    for (const [id, value, unit] of [['Yaw', yaw, '°'], ['Pitch', pitch, '°'], ['Zoom', zoom, '%']]) {
      this.el[id].value = value
      this.el[id + 'Value'].value = `${Math.round(value)}${unit}`
    }
  }

  applyResolution(edge) {
    const ratio = this.el.Ratio.value === 'custom' ? this.aspect : Number(this.el.Ratio.value)
    this.el.Width.value = Math.round(ratio >= 1 ? edge : edge * ratio)
    this.el.Height.value = Math.round(ratio >= 1 ? edge / ratio : edge)
    this.dimensionsChanged()
  }

  dimensionsChanged() {
    this.validate()
    if (!validImageSize(this.dimensions.width, this.dimensions.height, this.maxEdge)) return
    if (this.camera) { setImageAspect(this.camera, this.aspect); this.fit() }
    this.resize()
  }

  validate() {
    const { width, height } = this.dimensions
    const valid = validImageSize(width, height, this.maxEdge)
    this.el.SizeNote.textContent = tr(valid ? 'sizeHint' : 'sizeError', { max: this.maxEdge })
    this.el.SizeNote.classList.toggle('invalid', !valid)
    for (const id of ['Width', 'Height']) this.el[id].setAttribute('aria-invalid', String(!valid))
    this.el.FrameSize.textContent = valid ? `${width} × ${height} px` : '—'
    this.el.SaveSize.textContent = valid ? `${(width * height / 1048576).toFixed(1)} MP` : ''
    this.el.Save.disabled = !this.modelData || !valid || this.loading || this.exporting || this.contextLost
    for (const button of this.dialog.querySelectorAll('[data-export-view], #exportFit')) button.disabled = !this.modelData || this.loading || this.exporting
    for (const id of ['Projection', 'Yaw', 'Pitch', 'Zoom', 'Padding']) this.el[id].disabled = !this.modelData || this.loading || this.exporting
  }

  resize() {
    if (!this.gl || this.exporting || !this.isOpen) return
    const padding = matchMedia('(max-width:760px)').matches ? 28 : 64
    const availableWidth = Math.max(1, this.el.Mat.clientWidth - padding), availableHeight = Math.max(1, this.el.Mat.clientHeight - padding)
    const width = Math.max(1, Math.floor(Math.min(availableWidth, availableHeight * this.aspect)))
    const height = Math.max(1, Math.round(width / this.aspect))
    this.el.Frame.style.width = width + 'px'; this.el.Frame.style.height = height + 'px'
    const size = this.gl.getSize(new THREE.Vector2())
    if (size.x !== width || size.y !== height) this.gl.setSize(width, height, false)
  }

  draw() {
    if (!this.modelData || !this.gl || this.contextLost) return
    const { scene, entitiesGroup, overlay, regionGroup } = this.source
    const previous = { background: scene.background, fog: scene.fog, entities: entitiesGroup.visible, overlay: overlay.visible, regions: regionGroup.visible }
    const ages = this.animated.map(object => object.userData.animationAge)
    try {
      scene.background = this.el.Background.value === 'solid' ? new THREE.Color(this.el.Color.value) : null
      scene.fog = null
      entitiesGroup.visible = this.el.Entities.checked; overlay.visible = this.el.Dimensions.checked; regionGroup.visible = this.el.Regions.checked
      for (const object of this.animated) object.userData.animationAge = this.age
      this.source._assets?.updateAnimations(this.age)
      this.gl.render(scene, this.camera)
    } finally {
      scene.background = previous.background; scene.fog = previous.fog
      entitiesGroup.visible = previous.entities; overlay.visible = previous.overlay; regionGroup.visible = previous.regions
      this.animated.forEach((object, i) => { if (ages[i] === undefined) delete object.userData.animationAge; else object.userData.animationAge = ages[i] })
    }
  }

  setLoading(loading) {
    this.loading = loading
    if (!this.isOpen) return
    this.el.Loading.hidden = !loading
    for (const id of ['Open', 'EmptyOpen', 'Demo']) this.el[id].disabled = loading || this.exporting
    if (!loading) this.syncModel()
    this.validate()
  }

  async loadFile(file) {
    if (this.loading || this.exporting) return
    if (!/\.(litematic|litematica|nbt)$/i.test(file.name)) { this.message('invalidFile', {}, true); return }
    this.message()
    await this.openFile(file)
    if (this.getError()) { this.el.Message.textContent = this.getError(); this.el.Message.dataset.error = 'true' }
  }

  async loadDemo() {
    if (this.loading || this.exporting) return
    this.message(); await this.openDemo()
    if (this.getError()) { this.el.Message.textContent = this.getError(); this.el.Message.dataset.error = 'true' }
  }

  message(key, values, error = false) {
    this.el.Message.textContent = key ? tr(key, values) : ''
    this.el.Message.dataset.error = String(error)
  }

  async save() {
    if (this.el.Save.disabled || !this.gl) return
    const { width, height } = this.dimensions
    const size = this.gl.getSize(new THREE.Vector2()), ratio = this.gl.getPixelRatio()
    const filename = exportFilename(this.el.Filename.value)
    const disabled = [...this.dialog.querySelectorAll('input, select, button')].map(el => [el, el.disabled])
    this.exporting = true
    for (const [el] of disabled) el.disabled = true
    this.dialog.setAttribute('aria-busy', 'true')
    this.message('saving')
    try {
      await new Promise(resolve => requestAnimationFrame(resolve))
      this.gl.setPixelRatio(1); this.gl.setSize(width, height, false)
      this.draw()
      if (this.gl.getContext().isContextLost() || this.gl.domElement.width !== width || this.gl.domElement.height !== height) throw Error('Invalid output buffer')
      const blob = await new Promise(resolve => this.gl.domElement.toBlob(resolve, 'image/png'))
      if (!blob) throw Error('PNG encoding failed')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = filename
      this.dialog.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
      this.message('saved', { width, height })
    } catch (error) {
      console.error('Image export failed', error)
      this.message('failed', {}, true)
    } finally {
      this.gl.setPixelRatio(ratio); this.gl.setSize(size.x, size.y, false)
      this.exporting = false
      for (const [el, wasDisabled] of disabled) el.disabled = wasDisabled
      this.dialog.setAttribute('aria-busy', 'false')
      this.validate(); this.resize()
    }
  }
}
