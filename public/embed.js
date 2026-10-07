// Standalone ES module: no dependencies and no CSS injected into the host document.
const PROTOCOL = 'litematic-preview-v1'
const MAX_BYTES = 64 * 1024 * 1024
const cards = new Set()
let maxActive = 2, serial = 0
let activePreview = null

function schedule() {
  const candidates = [...cards].filter(card => card.pinned || (card.visible && (!activePreview || card.modal)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority || a.order - b.order)
  const selected = new Set(candidates.slice(0, maxActive))
  for (const card of cards) if (!selected.has(card)) card.unmount()
  for (const card of selected) card.mount()
}

/** Limit live WebGL cards in this host page. Offscreen/unselected frames are removed. */
export function configureLitematicCards({ maxActive: count = 2 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw RangeError('maxActive must be an integer from 1 to 4')
  maxActive = count; schedule()
}

/** options: { url | file, name?, lang?, pack?, background?, poster?, onStatus? } */
export function createLitematicCard(container, options = {}) {
  return createCard(container, options)
}

function createCard(container, options, { modal = false, onClose } = {}) {
  if (!(container instanceof HTMLElement)) throw TypeError('A card container element is required')
  const lang = options.lang === 'en' ? 'en' : 'zh'
  const label = lang === 'en' ? 'Activate 3D preview' : '启用 3D 预览'
  const frameURL = new URL('./embed.html', import.meta.url)
  frameURL.searchParams.set('lang', lang)
  frameURL.searchParams.set('pack', options.pack === 'vanilla' ? 'vanilla' : 'xk')
  if (/^#[0-9a-f]{6}$/i.test(options.background)) frameURL.searchParams.set('background', options.background)
  frameURL.searchParams.set('parentOrigin', location.origin)
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:100%;height:100%;min-height:120px;overflow:hidden;background:#172332;border-radius:inherit;color:#deefff;'
  const placeholder = document.createElement('button')
  placeholder.type = 'button'
  placeholder.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;padding:16px;border:0;background:transparent;color:inherit;cursor:pointer;font:14px system-ui;'
  const caption = document.createElement('span'); caption.textContent = label
  caption.style.cssText = 'position:relative;padding:6px 12px;background:#172332dc;border-radius:6px;'
  if (options.poster) {
    const posterURL = new URL(options.poster, location.href)
    if (!['https:', 'http:'].includes(posterURL.protocol)) throw TypeError('poster must be an HTTP(S) image URL')
    const image = document.createElement('img')
    image.src = posterURL.href; image.alt = ''; image.loading = 'lazy'
    image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
    placeholder.append(image)
  }
  placeholder.append(caption); element.append(placeholder)
  let frame, ready = false, destroyed = false, source, channel, pinTimer
  const send = () => {
    if (!ready || !frame || source === undefined) return
    frame.contentWindow.postMessage({ protocol: PROTOCOL, channel, type: 'load', ...(typeof source === 'string' ? { url: source } : { file: source }) }, frameURL.origin)
  }
  const card = {
    order: ++serial, priority: 0, visible: false, pinned: false, modal,
    mount() {
      if (frame || destroyed) return
      channel = crypto.randomUUID(); ready = false
      const url = new URL(frameURL); url.searchParams.set('channel', channel)
      frame = document.createElement('iframe')
      frame.title = options.name || (lang === 'en' ? 'Schematic preview' : '投影预览')
      frame.referrerPolicy = 'no-referrer'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox')
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
      frame.src = url.href
      placeholder.hidden = true; element.dataset.state = 'loading'; element.append(frame)
    },
    unmount() {
      frame?.remove(); frame = null; ready = false; placeholder.hidden = false; element.dataset.state = 'inactive'
    },
  }
  function receive(event) {
    const data = event.data
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameURL.origin || data?.protocol !== PROTOCOL || data.channel !== channel) return
    if (data.type === 'close-request' && onClose) { onClose(); return }
    if (data.type === 'ready') { ready = true; send() }
    if (data.type === 'handoff-start') {
      card.pinned = true
      clearTimeout(pinTimer); pinTimer = setTimeout(() => { card.pinned = false; schedule() }, 65000)
    }
    if (data.type === 'handoff-end') { card.pinned = false; clearTimeout(pinTimer); schedule() }
    element.dataset.state = data.type
    element.dispatchEvent(new CustomEvent('preview-status', { detail: data }))
    options.onStatus?.(data)
  }
  const activate = () => { card.priority = Date.now(); schedule() }
  element.addEventListener('pointerenter', activate)
  placeholder.addEventListener('click', activate)
  placeholder.addEventListener('focus', activate)
  const observer = new IntersectionObserver(entries => { card.visible = entries[0].isIntersecting; schedule() }, { threshold: .01 })
  function load(value, name = options.name || 'schematic.litematic') {
    if (destroyed) throw Error('This card was destroyed')
    if (typeof value === 'string') {
      const url = new URL(value, location.href)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw TypeError('Use an HTTP(S) schematic URL')
      source = url.href
    } else {
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) value = new File([value], name)
      if (!(value instanceof Blob) || !value.size || value.size > MAX_BYTES) throw RangeError('Provide a nonempty File, Blob or ArrayBuffer up to 64 MiB')
      source = value instanceof File ? value : new File([value], name)
    }
    send()
  }
  // Validate before changing the DOM or installing global listeners.
  if (options.file !== undefined || options.url !== undefined) load(options.file ?? options.url)
  container.append(element)
  cards.add(card); window.addEventListener('message', receive); observer.observe(element)
  return {
    element, load,
    destroy() {
      destroyed = true; source = undefined; clearTimeout(pinTimer)
      observer.disconnect(); window.removeEventListener('message', receive)
      cards.delete(card); card.unmount(); element.remove(); schedule()
    },
  }
}

/** Open a model-catalog-style preview over the host page. Same source options as cards. */
export function openLitematicPreview(options = {}) {
  activePreview?.close()
  const previousFocus = document.activeElement
  const previousOverflow = document.documentElement.style.overflow
  const english = options.lang === 'en'
  const host = document.createElement('div')
  host.dataset.litematicPreview = ''
  const shadow = host.attachShadow({ mode: 'open' })
  // Only static markup is interpolated here. Filenames and titles use textContent below.
  shadow.innerHTML = `<style>
    :host { all: initial; color-scheme: dark; }
    * { box-sizing: border-box; }
    dialog { width: min(1040px, calc(100vw - 32px)); height: min(720px, calc(100dvh - 40px)); max-width: none; max-height: none; padding: 0; margin: auto; border: 1px solid #405a76; border-radius: 16px; background: #172332; color: #e4edf9; font: 14px/1.6 system-ui, sans-serif; box-shadow: 0 24px 100px #0009; overflow: hidden; }
    dialog[open] { display: flex; flex-direction: column; }
    dialog::backdrop { background: #050b16bc; backdrop-filter: blur(4px); }
    header { display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid #344b65; }
    .title { flex: 1; min-width: 0; }
    p { margin: 0 0 3px; color: #9bb7d7; font-size: 11px; letter-spacing: .04em; }
    h2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; font-weight: 600; }
    button { width: 36px; height: 36px; flex: none; padding: 0; border: 1px solid #49627e; border-radius: 8px; background: #25394f; color: #dceaff; cursor: pointer; font: 25px/1 system-ui; }
    button:hover { background: #345373; }
    button:focus-visible { outline: 2px solid #83cbff; outline-offset: 3px; }
    .viewport { flex: 1; min-height: 0; }
    @media (max-width: 600px) { dialog { width: calc(100vw - 16px); height: calc(100dvh - 24px); border-radius: 12px; } header { padding: 12px; } h2 { font-size: 16px; } }
  </style><dialog aria-labelledby="preview-title"><header><div class="title"><p></p><h2 id="preview-title"></h2></div><button type="button" autofocus>×</button></header><div class="viewport"></div></dialog>`
  const dialog = shadow.querySelector('dialog'), closeButton = shadow.querySelector('button')
  shadow.querySelector('p').textContent = english ? 'SCHEMATIC PREVIEW' : '投影快速预览'
  shadow.querySelector('h2').textContent = options.name || options.file?.name || (english ? 'Schematic' : '投影')
  closeButton.ariaLabel = english ? 'Close preview' : '关闭预览'
  let preview, closed = false, backdropDown = false
  const finish = () => {
    if (closed) return
    closed = true
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
    preview = createCard(shadow.querySelector('.viewport'), options, { modal: true, onClose: api.close })
    schedule()
  } catch (error) { api.close(); throw error }
  return api
}
