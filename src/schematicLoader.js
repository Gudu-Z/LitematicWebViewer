import { defaultWindow, validateWindow, MAX_WINDOW_VOLUME } from './litematicaWindow.js'
import { t } from './i18n.js'
import './schematicLoader.css'

const coordinates = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ']
export const rangeLabel = b => ['X', 'Y', 'Z'].map(a => `${a}: ${b['min' + a]}…${b['max' + a]}`).join(' · ')

// A session retains only the File and small inspection result, never unpacked data.
// Terminating its worker cancels decompression even while NBT fields are being read.
export function loadSchematic(file, { session, selectRange = false, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./litematica.worker.js', import.meta.url), { type: 'module' })
    const dialog = document.createElement('dialog')
    dialog.id = 'schematicLoad'
    dialog.setAttribute('aria-labelledby', 'schematicLoadTitle')
    dialog.innerHTML = `<form>
      <h2 id="schematicLoadTitle"></h2><p class="load-file"></p>
      <p class="load-status" role="status" aria-live="polite"></p>
      <progress></progress>
      <section class="load-range" hidden>
        <p class="range-explanation"></p><p class="source-range"></p>
        <div class="range-grid"><span></span><span class="range-from"></span><span class="range-to"></span>
          ${['X', 'Y', 'Z'].map(a => `<span>${a}</span>${['min', 'max'].map(edge => `<input type="number" step="1" required name="${edge + a}" aria-label="${a} ${edge}" />`).join('')}`).join('')}
        </div>
        <div class="range-presets"><button type="button" class="range-center"></button><button type="button" class="range-column"></button></div>
        <p class="range-volume"></p><p class="range-error" role="alert"></p>
      </section>
      <div class="load-actions"><button type="button" class="load-cancel"></button><button type="submit" class="primary load-submit" hidden></button></div>
    </form>`
    const q = selector => dialog.querySelector(selector)
    const inputs = Object.fromEntries(coordinates.map(key => [key, q(`[name=${key}]`)]))
    let info, selection, settled = false, choosing = false, phase = 'inspect'
    const originalFocus = document.activeElement
    function finish(error, data) {
      if (settled) return
      settled = true
      worker.terminate()
      window.removeEventListener('pagehide', cancel)
      dialog.close(); dialog.remove()
      originalFocus?.focus?.()
      if (error) reject(error)
      else resolve({ data, session: { file, info, selection } })
    }
    const cancel = () => finish(new DOMException('Cancelled', 'AbortError'))
    window.addEventListener('pagehide', cancel, { once: true })
    q('.load-cancel').textContent = t('cancelLoad')
    q('.load-cancel').onclick = cancel
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel() })
    dialog.addEventListener('close', () => { if (!settled) cancel() })
    for (const type of ['dragenter', 'dragover', 'drop']) dialog.addEventListener(type, event => { event.preventDefault(); event.stopPropagation() })
    q('.load-file').textContent = file.name || t('metaNone')
    q('#schematicLoadTitle').textContent = t('inspectingSchematic')
    q('.load-status').textContent = t('streamReadHint')
    q('.range-explanation').textContent = t('rangeExplanation', { n: MAX_WINDOW_VOLUME.toLocaleString() })
    q('.range-from').textContent = t('rangeFrom'); q('.range-to').textContent = t('rangeTo')
    q('.load-submit').textContent = t('loadRange')
    q('.range-center').textContent = t('rangeCenter')
    q('.range-column').textContent = t('rangeColumn')
    for (const a of ['X', 'Y', 'Z']) {
      inputs['min' + a].ariaLabel = `${a} ${t('rangeFrom')}`
      inputs['max' + a].ariaLabel = `${a} ${t('rangeTo')}`
    }
    function readSelection() { return Object.fromEntries(coordinates.map(key => [key, inputs[key].value === '' ? NaN : Number(inputs[key].value)])) }
    function validate() {
      try {
        const b = validateWindow(readSelection(), info.bounds)
        q('.range-volume').textContent = t('rangeVolume', { size: `${b.width} × ${b.height} × ${b.depth}`, n: (b.width * b.height * b.depth).toLocaleString() })
        q('.range-error').textContent = ''; q('.load-submit').disabled = false
        return b
      } catch (error) {
        q('.range-error').textContent = t(error.code, { n: MAX_WINDOW_VOLUME.toLocaleString() })
        q('.range-volume').textContent = ''; q('.load-submit').disabled = true
        return null
      }
    }
    function setSelection(b) {
      for (const key of coordinates) { inputs[key].value = b[key]; inputs[key].min = info.bounds[key.replace('max', 'min')]; inputs[key].max = info.bounds[key.replace('min', 'max')] }
      validate()
    }
    function choose() {
      choosing = true
      q('#schematicLoadTitle').textContent = t('selectLoadRange')
      q('.load-status').textContent = t('sourceBlockCount', { n: info.metadata.totalBlocks.toLocaleString() })
      q('.source-range').textContent = t('sourceRange') + rangeLabel(info.bounds)
      q('progress').hidden = true; q('.load-range').hidden = false; q('.load-submit').hidden = false
      q('.range-column').disabled = info.bounds.height > MAX_WINDOW_VOLUME
      setSelection(selection || session?.selection || info.suggestedWindow || defaultWindow(info.bounds))
      inputs.minX.focus()
    }
    q('.range-center').onclick = () => setSelection(info.suggestedWindow || defaultWindow(info.bounds))
    q('.range-column').onclick = () => {
      const b = defaultWindow(info.bounds), height = info.bounds.height
      const side = Math.min(32, Math.floor(Math.sqrt(MAX_WINDOW_VOLUME / height)))
      if (side < 1) return
      for (const a of ['X', 'Z']) {
        const size = Math.min(side, info.bounds['max' + a] - info.bounds['min' + a] + 1)
        b['min' + a] = Math.floor((info.bounds['min' + a] + info.bounds['max' + a] - size + 1) / 2)
        b['max' + a] = b['min' + a] + size - 1
      }
      b.minY = info.bounds.minY; b.maxY = info.bounds.maxY; setSelection(b)
    }
    q('.range-grid').addEventListener('input', validate)
    function load(value) {
      phase = 'load'; choosing = false; selection = value
      q('#schematicLoadTitle').textContent = t('readingSchematicRange')
      q('.load-status').textContent = t('streamReadHint')
      q('.load-range').hidden = true; q('.load-submit').hidden = true; q('progress').hidden = false
      q('progress').value = 0; q('progress').max = info.decompressedBytes
      worker.postMessage({ type: 'load', selection })
    }
    q('form').onsubmit = event => { event.preventDefault(); if (!choosing) return; const b = validate(); if (b) load(b) }
    worker.onmessage = ({ data: message }) => {
      if (message.type === 'progress') {
        const mib = Math.floor(message.bytes / 1048576)
        q('.load-status').textContent = t('streamReadProgress', { n: mib })
        if (info) q('progress').value = message.bytes
        onProgress?.(phase === 'inspect' ? 0 : message.bytes / info.decompressedBytes)
      } else if (message.type === 'inspected') {
        info = message.info
        if (info.requiresWindow || selectRange) choose()
        else load(null)
      } else if (message.type === 'loaded') finish(null, message.data)
      else if (message.type === 'error') {
        if (info && ['windowTooLarge', 'windowTooComplex'].includes(message.error.code)) {
          choose(); q('.range-error').textContent = t(message.error.code)
        }
        else finish(Object.assign(new Error(message.error.message), { code: message.error.code }))
      }
    }
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'Schematic worker failed')) }
    worker.onmessageerror = () => finish(new Error('Could not read schematic worker result'))
    document.body.append(dialog); dialog.showModal()
    worker.postMessage({ type: 'inspect', file, info: session?.file === file ? session.info : undefined })
  })
}
