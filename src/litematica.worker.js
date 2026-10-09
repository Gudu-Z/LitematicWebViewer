import { inspectLitematica, readLitematicaWindow } from './litematicaWindow.js'
import { buildSchematicOverview } from './schematicOverview.js'

let file, info, archive, activeDetail, pendingDetail
const sendError = (id, error) => self.postMessage({ id, type: 'error', error: { name: error.name, message: error.message, code: error.code } })
const progress = id => bytes => self.postMessage({ id, type: 'progress', bytes: typeof bytes === 'number' ? bytes : bytes.bytes, phase: bytes?.phase })
async function detailLoop() {
  if (activeDetail) return
  while (pendingDetail) {
    const request = pendingDetail; pendingDetail = null
    const controller = new AbortController()
    activeDetail = { id: request.id, controller }
    try {
      const options = { signal: controller.signal, onProgress: progress(request.id) }
      const data = archive ? await archive.readWindow(request.selection, options) : await readLitematicaWindow(file, info, request.selection, options)
      controller.signal.throwIfAborted()
      self.postMessage({ id: request.id, type: 'loaded', data })
    } catch (error) { sendError(request.id, error) }
    finally { activeDetail = null }
  }
}
self.onmessage = async ({ data }) => {
  const { id } = data
  if (data.type === 'cancel') {
    if (activeDetail?.id === id) activeDetail.controller.abort()
    if (pendingDetail?.id === id) pendingDetail = null
    return
  }
  if (data.type === 'detail') {
    if (pendingDetail) sendError(pendingDetail.id, new DOMException('Superseded', 'AbortError'))
    pendingDetail = data
    activeDetail?.controller.abort()
    void detailLoop()
    return
  }
  try {
    if (data.type === 'inspect') {
      file = data.file
      info = data.info || await inspectLitematica(file, { onProgress: progress(id) })
      self.postMessage({ id, type: 'inspected', info })
    } else if (data.type === 'overview') {
      const result = await buildSchematicOverview(file, info, { onProgress: progress(id) })
      archive?.dispose(); archive = result.archive
      self.postMessage({ id, type: 'loaded', data: result.data, cacheMode: archive.mode }, [result.data.overview.states.buffer])
    } else if (data.type === 'load') {
      const result = await readLitematicaWindow(file, info, data.selection, { onProgress: progress(id) })
      self.postMessage({ id, type: 'loaded', data: result })
    }
  } catch (error) { sendError(id, error) }
}
