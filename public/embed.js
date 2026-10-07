// Standalone ES module: no dependencies and no CSS injected into the host document.
const PROTOCOL = 'litematic-preview-v1'
const MAX_BYTES = 64 * 1024 * 1024
const cards = new Set()
let maxActive = 2, serial = 0

function schedule() {
  const candidates = [...cards].filter(card => card.pinned || card.visible)
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
    order: ++serial, priority: 0, visible: false, pinned: false,
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
      placeholder.hidden = true; element.append(frame)
    },
    unmount() {
      frame?.remove(); frame = null; ready = false; placeholder.hidden = false
    },
  }
  function receive(event) {
    const data = event.data
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameURL.origin || data?.protocol !== PROTOCOL || data.channel !== channel) return
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
