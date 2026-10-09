import { inspectLitematica, readLitematicaWindow } from './litematicaWindow.js'

let file, info
self.onmessage = async ({ data }) => {
  const onProgress = bytes => self.postMessage({ type: 'progress', bytes })
  try {
    if (data.type === 'inspect') {
      file = data.file
      info = data.info || await inspectLitematica(file, { onProgress })
      self.postMessage({ type: 'inspected', info })
    } else if (data.type === 'load' && file && info) {
      const result = await readLitematicaWindow(file, info, data.selection, { onProgress })
      self.postMessage({ type: 'loaded', data: result })
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: { message: error.message, code: error.code } })
  }
}
