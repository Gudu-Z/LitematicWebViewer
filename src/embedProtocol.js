// Versioned messages shared by the card and full viewer. SDK uses the same v1 schema.
export const PROTOCOL = 'litematic-preview-v1'
export const MAX_FILE_BYTES = 64 * 1024 * 1024

export function fileURL(value, base) {
  const url = new URL(value, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('invalidURL')
  if (new URL(base).protocol === 'https:' && url.protocol !== 'https:') throw Error('invalidURL')
  return url.href
}

export function validFile(file) {
  return file instanceof Blob && file.size > 0 && file.size <= MAX_FILE_BYTES
}

export function validCamera(value) {
  return value && ['position', 'target'].every(key => Array.isArray(value[key]) && value[key].length === 3 && value[key].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) &&
    value.position.some((n, i) => n !== value.target[i])
}

export function applyCamera(renderer, value) {
  if (!validCamera(value)) return
  if (['perspective', 'orthographic'].includes(value.projection)) renderer.setProjectionMode(value.projection)
  renderer.camera.position.fromArray(value.position)
  renderer.controls.target.fromArray(value.target)
  if (renderer.camera.isOrthographicCamera && Number.isFinite(value.height) && value.height > 0 && value.height <= 1e9) {
    const aspect = (renderer.container.clientWidth || 1) / (renderer.container.clientHeight || 1)
    renderer.camera.top = value.height / 2; renderer.camera.bottom = -value.height / 2
    renderer.camera.left = -value.height * aspect / 2; renderer.camera.right = value.height * aspect / 2
  }
  if (Number.isFinite(value.zoom) && value.zoom >= .01 && value.zoom <= 100) renderer.camera.zoom = value.zoom
  renderer.camera.updateProjectionMatrix()
  renderer.controls.update()
}

export async function fetchSchematic(value, base, signal) {
  const url = fileURL(value, base)
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw Error(`HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) { await response.body?.cancel(); throw Error('fileLimit') }
  if (response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel(); throw Error('notSchematic') }
  // Enforce the compressed-file limit even when Content-Length is missing or inaccurate.
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_FILE_BYTES) throw Error('fileLimit')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  let name = 'schematic.litematic'
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || name } catch {}
  const file = new File(chunks, name)
  if (!validFile(file)) throw Error('fileLimit')
  return file
}

// Files are passed directly between browser windows, without storage or an upload.
export function openFullViewer({ file, url, lang, pack, background, camera, baseURL = location.href, readData }, onError, onFinish = () => {}) {
  const token = crypto.randomUUID()
  const destination = new URL('./', baseURL)
  const revision = new URL(baseURL).searchParams.get('v')
  if (revision) destination.searchParams.set('v', revision)
  if (url) destination.searchParams.set('file', url)
  destination.searchParams.set('lang', lang)
  destination.searchParams.set('pack', pack)
  if (background && background !== 'transparent') destination.searchParams.set('background', background)
  destination.hash = new URLSearchParams({ preview: token, origin: location.origin }).toString()
  let popup, timer, finished = false, sending = false
  const cleanup = () => { if (finished) return; finished = true; window.removeEventListener('message', receive); clearTimeout(timer); onFinish() }
  const receive = async event => {
    if (finished || sending || event.origin !== destination.origin || event.source !== popup || event.data?.protocol !== PROTOCOL || event.data.token !== token || event.data.type !== 'handoff-ready') return
    sending = true
    try {
      const payload = readData ? await readData() : { file, camera }
      if (finished) return
      if (!validFile(payload.file)) throw Error('fileLimit')
      popup.postMessage({ protocol: PROTOCOL, type: 'handoff-file', token, file: payload.file, camera: payload.camera }, destination.origin)
      cleanup()
    } catch { if (!finished) { cleanup(); onError('handoffTimeout') } }
  }
  window.addEventListener('message', receive)
  // An opener is needed for the one-shot, origin-checked transfer. The receiver drops it.
  popup = window.open(destination.href, '_blank')
  if (!popup) { cleanup(); onError('popupBlocked'); return { opened: false, cancel: cleanup } }
  timer = setTimeout(() => { cleanup(); onError('handoffTimeout') }, 60000)
  return { opened: true, cancel: cleanup }
}

export function receivePreviewFile() {
  const params = new URLSearchParams(location.hash.slice(1))
  const token = params.get('preview')
  if (!token || !/^[a-f0-9-]{36}$/.test(token) || !window.opener) return null
  let expectedOrigin = location.origin
  if (params.has('origin')) {
    try { const url = new URL(params.get('origin')); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== params.get('origin')) return null; expectedOrigin = url.origin } catch { return null }
  }
  const opener = window.opener
  return new Promise(resolve => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      window.opener = null
      history.replaceState(null, '', location.pathname + location.search)
    }
    const receive = event => {
      const data = event.data
      if (event.origin !== expectedOrigin || event.source !== opener || data?.protocol !== PROTOCOL || data.type !== 'handoff-file' || data.token !== token || !validFile(data.file)) return
      cleanup(); resolve({ file: new File([data.file], data.file.name || 'schematic.litematic'), camera: data.camera })
    }
    window.addEventListener('message', receive)
    timer = setTimeout(() => { cleanup(); resolve(null) }, 60000)
    opener.postMessage({ protocol: PROTOCOL, type: 'handoff-ready', token }, expectedOrigin)
  })
}
