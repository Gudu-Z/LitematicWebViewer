// Built into public/embed.js. No dependencies or global host styles in the shipped module.
import { normalizeOptions, applyTheme, themeValues } from './previewOptions.js'
import { PROTOCOL, openFullViewer } from './embedProtocol.js'
import { viewerAppearance } from './viewerOptions.js'
const MAX_BYTES = 64 * 1024 * 1024
const cards = new Set()
let maxActive = 2, serial = 0
let activePreview = null

function schedule() {
  const modalVisible = activePreview || [...cards].some(card => card.visible && card.modal)
  const candidates = [...cards].filter(card => !card.full && (card.pinned || (card.visible && (!modalVisible || card.modal))))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority || a.order - b.order)
  const selected = new Set(candidates.slice(0, maxActive))
  for (const card of cards) {
    if (card.full) { if (card.visible) card.mount(); card.setActive(card.visible && (!modalVisible || card.modal)) }
    else if (!selected.has(card)) card.unmount()
  }
  for (const card of selected) card.mount()
}

/** Limit live WebGL cards in this host page. Offscreen/unselected frames are removed. */
export function configureLitematicCards({ maxActive: count = 2 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw RangeError('maxActive must be an integer from 1 to 4')
  maxActive = count; schedule()
}

/** See the integration guide for theme, controls, camera and host-driven UI options. */
export function createLitematicCard(container, options = {}) {
  return createCard(container, options)
}

/** Full viewer with layers, materials, resource packs and image export. */
export function createLitematicViewer(container, options = {}) {
  return createCard(container, options, { full: true })
}

function createCard(container, options, { modal = false, full = false, onClose, onOptions } = {}) {
  if (!(container instanceof HTMLElement)) throw TypeError('A card container element is required')
  let config = normalizeOptions(options)
  const media = matchMedia('(prefers-color-scheme: dark)')
  const frameURL = full ? new URL(/* @vite-ignore */ './index.html', import.meta.url) : new URL(/* @vite-ignore */ './embed.html', import.meta.url)
  // Keep the iframe and handoff receiver fresh when an integration upgrades its SDK.
  frameURL.searchParams.set('v', new URL(import.meta.url).searchParams.get('v') || 'viewer-1')
  if (full) frameURL.searchParams.set('embedded', '1')
  frameURL.searchParams.set('lang', config.lang)
  frameURL.searchParams.set('pack', options.pack === 'vanilla' ? 'vanilla' : 'xk')
  frameURL.searchParams.set('parentOrigin', location.origin)
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:100%;height:100%;min-height:120px;overflow:hidden;border-radius:inherit;'
  const placeholder = document.createElement('button')
  placeholder.type = 'button'
  placeholder.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;padding:16px;border:0;background:transparent;color:inherit;cursor:pointer;font:14px system-ui;'
  const caption = document.createElement('span')
  caption.style.cssText = 'position:relative;padding:6px 12px;border-radius:6px;'
  if (options.poster) {
    const posterURL = new URL(options.poster, location.href)
    if (!['https:', 'http:'].includes(posterURL.protocol)) throw TypeError('poster must be an HTTP(S) image URL')
    const image = document.createElement('img')
    image.src = posterURL.href; image.alt = ''; image.loading = 'lazy'
    image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
    placeholder.append(image)
  }
  placeholder.append(caption); element.append(placeholder)
  let frame, ready = false, destroyed = false, source, channel, pinTimer, latestCamera, loaded = false
  let handoff, transfer, onStatus = options.onStatus, onCameraChange = options.onCameraChange
  const assertAlive = () => { if (destroyed) throw Error('This card was destroyed') }
  const post = data => { if (frame && ready) frame.contentWindow.postMessage({ protocol: PROTOCOL, channel, ...data }, frameURL.origin) }
  const appearance = () => {
    const values = themeValues(config, media.matches)
    element.style.background = values.background; element.style.color = values.text
    element.style.borderRadius = Object.hasOwn(config.style, 'radius') ? `${values.radius}px` : 'inherit'
    placeholder.style.fontFamily = values.fontFamily; caption.style.background = values.surface
    caption.textContent = config.labels.activate ?? (config.lang === 'en' ? 'Activate 3D preview' : '启用 3D 预览')
    caption.hidden = config.ui === 'none'
    placeholder.ariaLabel = caption.textContent
    if (frame) frame.title = options.name || (config.lang === 'en' ? 'Schematic preview' : '投影预览')
  }
  appearance()
  const send = () => {
    if (!ready || !frame || source === undefined) return
    post({ type: 'load', ...(full ? {} : { options: config }), resumeCamera: latestCamera, ...(typeof source === 'string' ? { url: source } : { file: source }) })
  }
  const card = {
    order: ++serial, priority: 0, visible: false, pinned: false, full, active: true,
    setActive(active) { this.active = active; post({ type: 'active', active }) },
    get modal() { return modal || !!element.closest('dialog:modal') },
    mount() {
      if (frame || destroyed) return
      channel = crypto.randomUUID(); ready = false
      const url = new URL(frameURL); url.searchParams.set('channel', channel)
      if (full) url.searchParams.set('appearance', JSON.stringify(viewerAppearance(config)))
      url.searchParams.set('theme', config.theme); url.searchParams.set('ui', config.ui)
      if (config.background) url.searchParams.set('background', config.background)
      frame = document.createElement('iframe')
      frame.title = options.name || (config.lang === 'en' ? 'Schematic preview' : '投影预览')
      frame.referrerPolicy = 'no-referrer'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox' + (full ? ' allow-downloads' : ''))
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
      frame.src = url.href
      placeholder.hidden = true; element.dataset.state = 'loading'; element.append(frame)
    },
    unmount() {
      if (!frame) return
      frame.remove(); frame = null; ready = false; loaded = false; placeholder.hidden = false; element.dataset.state = 'inactive'
      emit({ type: 'inactive' })
    },
  }
  function emit(data) {
    element.dispatchEvent(new CustomEvent('preview-status', { detail: data }))
    onStatus?.(data)
  }
  function receive(event) {
    const data = event.data
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameURL.origin || data?.protocol !== PROTOCOL || data.channel !== channel) return
    if (data.type === 'close-request' && onClose) { onClose(); return }
    if (data.type === 'camera') {
      latestCamera = data.camera
      element.dispatchEvent(new CustomEvent('preview-camera', { detail: data.camera }))
      onCameraChange?.(data.camera)
      return
    }
    if (data.type === 'handoff-data') { transfer?.resolve(data); transfer = null; return }
    if (data.type === 'ready') { ready = true; post({ type: 'configure', options: config }); if (full) post({ type: 'active', active: card.active }); send() }
    if (data.type === 'loaded') loaded = true
    if (data.type === 'waiting' || data.type === 'loading' || (data.type === 'error' && !['handoff', 'viewer'].includes(data.stage))) loaded = false
    if (data.type === 'handoff-start') {
      card.pinned = true
      clearTimeout(pinTimer); pinTimer = setTimeout(() => { card.pinned = false; schedule() }, 65000)
    }
    if (data.type === 'handoff-end') { card.pinned = false; clearTimeout(pinTimer); schedule() }
    element.dataset.state = data.type
    emit(data)
  }
  const activate = () => { card.priority = Date.now(); schedule() }
  element.addEventListener('pointerenter', activate)
  placeholder.addEventListener('click', activate)
  placeholder.addEventListener('focus', activate)
  const observer = new IntersectionObserver(entries => { card.visible = entries[0].isIntersecting; schedule() }, { threshold: .01 })
  function load(value, name = options.name || 'schematic.litematic') {
    assertAlive()
    if (typeof value === 'string') {
      const url = new URL(value, location.href)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw TypeError('Use an HTTP(S) schematic URL')
      source = url.href
    } else {
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) value = new File([value], name)
      if (!(value instanceof Blob) || !value.size || value.size > MAX_BYTES) throw RangeError('Provide a nonempty File, Blob or ArrayBuffer up to 64 MiB')
      source = value instanceof File ? value : new File([value], name)
    }
    latestCamera = null; loaded = false; send()
  }
  // Validate before changing the DOM or installing global listeners.
  if (options.file !== undefined || options.url !== undefined) load(options.file ?? options.url)
  container.append(element)
  media.addEventListener('change', appearance)
  cards.add(card); window.addEventListener('message', receive); observer.observe(element)
  return {
    element, load,
    setOptions(patch) {
      assertAlive()
      const next = normalizeOptions(patch, config)
      if (['url', 'file', 'pack', 'poster'].some(key => key in patch)) throw TypeError('Use load() for sources; pack and poster are creation options')
      config = next
      if ('onStatus' in patch) onStatus = patch.onStatus
      if ('onCameraChange' in patch) onCameraChange = patch.onCameraChange
      if ('name' in patch) options = { ...options, name: String(patch.name) }
      if ('camera' in patch) latestCamera = null
      appearance(); onOptions?.(config, options.name)
      // Full-viewer visitors can change language and background themselves. A host theme
      // patch must not overwrite unrelated choices made inside that session.
      const update = full ? Object.fromEntries(Object.keys(patch).filter(key => Object.hasOwn(config, key)).map(key => [key, patch[key]])) : config
      post({ type: 'configure', options: update, cameraChanged: 'camera' in patch })
    },
    setCamera(camera) { this.setOptions({ camera }) },
    resetView() { assertAlive(); latestCamera = null; post({ type: 'reset' }) },
    openFullViewer() {
      assertAlive()
      if (!loaded || !ready || handoff) return false
      card.pinned = true
      emit({ type: 'handoff-start' })
      // Open synchronously in the host's click handler; collect the iframe data afterwards.
      const task = openFullViewer({
        baseURL: frameURL.href, url: typeof source === 'string' ? source : undefined,
        lang: config.lang, pack: options.pack === 'vanilla' ? 'vanilla' : 'xk', background: themeValues(config, media.matches).background, appearance: config,
        readData: () => new Promise((resolve, reject) => { transfer = { resolve, reject }; post({ type: 'handoff-request' }) }),
      }, code => emit({ type: 'error', stage: 'handoff', code, message: config.lang === 'en' ? 'Could not open the full viewer. Allow popups and retry.' : '无法打开完整预览，请允许弹出窗口后重试。' }), () => {
        transfer?.reject(Error('Transfer ended')); transfer = null; handoff = null; card.pinned = false
        if (!destroyed) { emit({ type: 'handoff-end' }); schedule() }
      })
      if (task.opened) handoff = task
      return task.opened
    },
    destroy() {
      destroyed = true; source = undefined; clearTimeout(pinTimer)
      handoff?.cancel(); transfer?.reject(Error('Card destroyed')); media.removeEventListener('change', appearance)
      observer.disconnect(); window.removeEventListener('message', receive)
      cards.delete(card); card.unmount(); element.remove(); schedule()
    },
  }
}

/** Open a model-catalog-style preview over the host page. Same source options as cards. */
export function openLitematicPreview(options = {}) {
  let config = normalizeOptions(options)
  activePreview?.close()
  const previousFocus = document.activeElement
  const previousOverflow = document.documentElement.style.overflow
  const media = matchMedia('(prefers-color-scheme: dark)')
  const host = document.createElement('div')
  host.dataset.litematicPreview = ''
  const shadow = host.attachShadow({ mode: 'open' })
  // Only static markup is interpolated here. Filenames and titles use textContent below.
  shadow.innerHTML = `<style>
    :host { all: initial; }
    :host([data-theme="dark"]) { color-scheme: dark; }
    :host([data-theme="light"]) { color-scheme: light; }
    * { box-sizing: border-box; }
    dialog { width: min(var(--lwv-dialog-width, var(--_lwv-dialog-width)), calc(100vw - 32px)); height: min(var(--lwv-dialog-height, var(--_lwv-dialog-height)), calc(100dvh - 40px)); max-width: none; max-height: none; padding: 0; margin: auto; border: 1px solid var(--lwv-border, var(--_lwv-border)); border-radius: var(--lwv-radius, var(--_lwv-radius)); background: var(--lwv-surface, var(--_lwv-surface)); color: var(--lwv-text, var(--_lwv-text)); font: 14px/1.6 var(--lwv-font, var(--_lwv-font)); box-shadow: 0 24px 100px #0005; overflow: hidden; }
    dialog[open] { display: flex; flex-direction: column; }
    dialog::backdrop { background: var(--lwv-backdrop, var(--_lwv-backdrop)); backdrop-filter: blur(4px); }
    header { display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--lwv-border, var(--_lwv-border)); }
    header.compact { position: absolute; left: 8px; top: 8px; padding: 0; border: 0; z-index: 1; }
    [hidden] { display: none !important; }
    .title { flex: 1; min-width: 0; }
    p { margin: 0 0 3px; color: var(--lwv-muted, var(--_lwv-muted)); font-size: 11px; letter-spacing: .04em; }
    h2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; font-weight: 600; }
    button { width: 36px; height: 36px; flex: none; padding: 0; border: 1px solid var(--lwv-border, var(--_lwv-border)); border-radius: min(8px, var(--lwv-radius, var(--_lwv-radius))); background: var(--lwv-surface, var(--_lwv-surface)); color: inherit; cursor: pointer; font: 25px/1 system-ui; }
    button:hover { border-color: var(--lwv-accent, var(--_lwv-accent)); }
    button:focus-visible { outline: 2px solid var(--lwv-accent, var(--_lwv-accent)); outline-offset: 3px; }
    .viewport { flex: 1; min-height: 0; }
    @media (max-width: 600px) { dialog { max-width: calc(100vw - 16px); max-height: calc(100dvh - 24px); } header { padding: 12px; } h2 { font-size: 16px; } }
  </style><dialog part="dialog" aria-labelledby="preview-title"><header part="header"><div class="title"><p part="subtitle"></p><h2 part="title" id="preview-title"></h2></div><button part="close-button" type="button" autofocus>×</button></header><div part="viewport" class="viewport"></div></dialog>`
  const dialog = shadow.querySelector('dialog'), closeButton = shadow.querySelector('button')
  let name = options.name || options.file?.name
  const appearance = () => {
    applyTheme(host, config, media.matches)
    const english = config.lang === 'en'
    shadow.querySelector('p').textContent = config.labels.subtitle ?? (english ? 'SCHEMATIC PREVIEW' : '投影快速预览')
    shadow.querySelector('h2').textContent = name || (english ? 'Schematic' : '投影')
    closeButton.ariaLabel = config.labels.close ?? (english ? 'Close preview' : '关闭预览')
    shadow.querySelector('.title').hidden = !config.controls.title
    shadow.querySelector('header').classList.toggle('compact', !config.controls.title)
  }
  appearance(); media.addEventListener('change', appearance)
  let preview, closed = false, backdropDown = false
  const finish = () => {
    if (closed) return
    closed = true
    media.removeEventListener('change', appearance)
    if (activePreview === api) activePreview = null
    preview?.destroy()
    host.remove()
    if (document.documentElement.style.overflow === 'hidden') document.documentElement.style.overflow = previousOverflow
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    schedule()
  }
  const api = {
    element: host,
    load(source, name) { if (closed) throw Error('This preview was closed'); preview.load(source, name) },
    setOptions(patch) { if (closed) throw Error('This preview was closed'); preview.setOptions(patch) },
    setCamera(camera) { this.setOptions({ camera }) },
    resetView() { if (closed) throw Error('This preview was closed'); preview.resetView() },
    openFullViewer() { if (closed) throw Error('This preview was closed'); return preview.openFullViewer() },
    close() { if (dialog.open) dialog.close(); finish() },
  }
  closeButton.onclick = api.close
  dialog.addEventListener('cancel', event => { event.preventDefault(); api.close() })
  dialog.addEventListener('close', finish)
  const outside = event => {
    const bounds = dialog.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom
  }
  dialog.addEventListener('pointerdown', event => { backdropDown = event.button === 0 && event.target === dialog && outside(event) })
  dialog.addEventListener('pointerup', event => {
    if (backdropDown && event.target === dialog && outside(event)) api.close()
    backdropDown = false
  })
  dialog.addEventListener('pointercancel', () => { backdropDown = false })
  document.body.append(host)
  document.documentElement.style.overflow = 'hidden'
  activePreview = api
  try {
    dialog.showModal()
    preview = createCard(shadow.querySelector('.viewport'), options, { modal: true, onClose: api.close, onOptions(value, title) { config = value; name = title ?? name; appearance() } })
    schedule()
  } catch (error) { api.close(); throw error }
  return api
}
