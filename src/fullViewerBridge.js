import { PROTOCOL, validFile, fetchSchematic, applyCamera } from './embedProtocol.js'
import { viewerAppearance } from './viewerOptions.js'

export class FullViewerBridge {
  constructor({ params, renderer, getCurrent, getBusy, setBusy, openFile, configure, getOptions, onProjection, isExportOpen, ui }) {
    Object.assign(this, { renderer, getCurrent, getBusy, setBusy, openFile, configure, getOptions, onProjection, isExportOpen, ui })
    this.channel = params.get('channel')
    this.viewRevision = 0; this.active = true; this.visible = true
    try {
      const value = params.get('parentOrigin')
      if (params.get('embedded') === '1' && parent !== window && new URL(value).origin === value && /^https?:/.test(value)) this.origin = value
    } catch { /* No trusted host. */ }
    if (!this.origin || !this.channel) return
    // Flight movement does not emit OrbitControls events; sample the active frame too.
    if (renderer) renderer.onCameraFrame = () => this.cameraChanged()
    window.addEventListener('message', event => this.receive(event))
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) this.notify('close-request')
    }, true)
    document.addEventListener('visibilitychange', () => this.updateActive())
    new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; this.updateActive() }).observe(document.getElementById('app'))
    document.getElementById('imageExport')?.addEventListener('close', () => this.updateActive())
    window.addEventListener('pagehide', event => {
      this.controller?.abort(); clearTimeout(this.cameraTimer)
      if (event.persisted) renderer?.setActive(false)
      else { this.disposed = true; renderer?.dispose() }
    })
    window.addEventListener('pageshow', () => this.updateActive())
    ui.onProgress = progress => { if (this.loading) this.notify('loading', { progress, message: ui.statusEl.textContent }) }
    ui.onError = message => this.notify('error', { message, stage: this.loading ? 'load' : 'viewer' })
  }

  notify(type, detail = {}) {
    if (this.origin && this.channel && !this.disposed) parent.postMessage({ protocol: PROTOCOL, channel: this.channel, type, ...detail }, this.origin)
  }

  ready() {
    this.initialized = true
    this.notify('ready')
    this.pump()
  }

  snapshot() {
    const r = this.renderer
    const target = r.controls.target.clone()
    if (r.getMoveMode() === 'fly') {
      const distance = Math.max(1, r.camera.position.distanceTo(target))
      r.camera.getWorldDirection(target).multiplyScalar(distance).add(r.camera.position)
    }
    return { projection: r.getProjectionMode(), position: r.camera.position.toArray(), target: target.toArray(), zoom: r.camera.zoom, height: r.camera.isOrthographicCamera ? r.camera.top - r.camera.bottom : null }
  }

  cameraChanged() {
    if (!this.origin || this.cameraTimer || !this.getCurrent().file) return
    this.cameraTimer = setTimeout(() => {
      this.cameraTimer = null
      if (this.getCurrent().file && !this.disposed) {
        const camera = this.snapshot(), signature = JSON.stringify(camera)
        if (signature !== this.lastCamera) { this.lastCamera = signature; this.notify('camera', { camera }) }
      }
    }, 100)
  }

  resetCamera() {
    const r = this.renderer, { bounds } = this.getCurrent(), camera = this.getOptions().camera
    if (!r || !bounds) return
    r.setMoveMode('orbit')
    r.setProjectionMode(camera.projection)
    r.fitToBounds(bounds)
    if (camera.position) applyCamera(r, camera)
    else { r.camera.zoom = camera.zoom; r.camera.updateProjectionMatrix(); r.controls.update() }
    this.onProjection(); this.cameraChanged()
  }

  updateActive() { if (!this.disposed) this.renderer?.setActive(this.active && this.visible && !document.hidden && !this.isExportOpen()) }

  receive(event) {
    const data = event.data
    if (this.disposed || event.source !== parent || event.origin !== this.origin || data?.protocol !== PROTOCOL || data.channel !== this.channel) return
    try {
      if (data.type === 'configure') {
        this.configure(data.options)
        if (data.cameraChanged) { this.viewRevision++; this.resetCamera() }
      }
      if (data.type === 'active') { this.active = !!data.active; this.updateActive() }
      if (data.type === 'reset') { this.viewRevision++; this.resetCamera() }
      if (data.type === 'handoff-request') {
        const { file } = this.getCurrent()
        if (file) this.notify('handoff-data', { file, camera: this.snapshot(), appearance: viewerAppearance(this.getOptions()) })
        else this.notify('handoff-data', { file: null })
      }
      if (data.type === 'load' && (typeof data.url === 'string' || data.file instanceof Blob)) {
        if (data.options) this.configure(data.options)
        this.requested = { source: data.file || data.url, camera: data.resumeCamera, revision: this.viewRevision }
        this.controller?.abort(); this.pump()
      }
    } catch (error) { this.notify('error', { message: error.message }) }
  }

  async pump() {
    if (!this.initialized || this.pumping || this.getBusy() || this.disposed) return
    this.pumping = true
    try {
      while (this.requested && !this.disposed) {
        const request = this.requested; this.requested = null
        this.controller = new AbortController()
        this.loading = true; this.setBusy(true); this.ui.clearError()
        this.ui.setStatusKey('parsingFile'); this.ui.setProgress(0)
        try {
          const file = typeof request.source === 'string' ? await fetchSchematic(request.source, location.href, this.controller.signal) : request.source
          if (this.requested || this.disposed) continue
          if (!validFile(file)) throw Error('File must be nonempty and no larger than 64 MiB.')
          this.setBusy(false)
          const loaded = await this.openFile(file)
          if (loaded && !this.requested && !this.disposed) {
            this.resetCamera()
            if (request.camera && request.revision === this.viewRevision) applyCamera(this.renderer, request.camera)
            this.onProjection(); this.cameraChanged()
          }
        } catch (error) { if (!this.requested && !this.disposed) this.ui.showError(error.message) }
        finally { this.loading = false; this.setBusy(false) }
      }
    } finally { this.pumping = false }
  }
}
