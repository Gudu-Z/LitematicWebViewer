// One worker owns a compressed archive for the lifetime of a large-file session.
// Request IDs and cancellation prevent a stale camera response replacing a new one.
export class SchematicWorkerClient {
  constructor() {
    this.worker = new Worker(new URL('./litematica.worker.js', import.meta.url), { type: 'module' })
    this.pending = new Map()
    this.serial = 0
    this.worker.onmessage = ({ data }) => {
      const task = this.pending.get(data.id)
      if (!task) return
      if (data.type === 'progress') { task.onProgress?.(data.bytes, data.phase); return }
      this.pending.delete(data.id); task.cleanup()
      if (data.type === 'error') task.reject(Object.assign(new Error(data.error.message), data.error))
      else task.resolve(data)
    }
    this.worker.onerror = event => { event.preventDefault(); this.dispose(new Error(event.message || 'Schematic worker failed')) }
    this.worker.onmessageerror = () => this.dispose(new Error('Could not read schematic worker result'))
  }
  request(type, values = {}, { signal, onProgress } = {}) {
    if (this.disposed || signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id); signal.removeEventListener('abort', cancel)
        this.worker.postMessage({ type: 'cancel', id })
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      this.pending.set(id, { resolve, reject, onProgress, cleanup: () => signal?.removeEventListener('abort', cancel) })
      signal?.addEventListener('abort', cancel, { once: true })
      this.worker.postMessage({ ...values, type, id })
    })
  }
  dispose(error = new DOMException('Session closed', 'AbortError')) {
    if (this.disposed) return
    this.disposed = true; this.worker.terminate()
    for (const task of this.pending.values()) { task.cleanup(); task.reject(error) }
    this.pending.clear()
  }
}
