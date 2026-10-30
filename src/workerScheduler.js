// Dedicated-worker geometry needs a real task boundary for queued commands.
// Repeated setTimeout(0) calls acquire a browser timer clamp; MessageChannel
// yields to the task queue without adding that delay to every 65,536 cells.
export function createWorkerScheduler({ MessageChannel: Channel = globalThis.MessageChannel } = {}) {
  const pending = new Set()
  let channel = null, disposed = false
  const closeChannel = () => {
    const previous = channel
    channel = null
    for (const port of [previous?.port1, previous?.port2]) if (port) {
      try { port.onmessage = null; port.onmessageerror = null; port.close() } catch { /* Already closed. */ }
    }
  }
  const complete = entry => {
    if (pending.delete(entry)) entry.resolve()
  }
  const scheduleTimer = entry => {
    if (entry.timer === undefined) entry.timer = setTimeout(() => complete(entry), 0)
  }
  const fallback = () => {
    closeChannel()
    for (const entry of pending) scheduleTimer(entry)
  }
  if (typeof Channel === 'function') {
    try {
      channel = new Channel()
      channel.port1.onmessage = () => {
        if (!channel || disposed) return
        const entry = pending.values().next().value
        if (entry) complete(entry)
      }
      channel.port1.onmessageerror = fallback
      channel.port1.start?.()
    } catch { closeChannel() }
  }
  return {
    yieldTask() {
      if (disposed) return Promise.reject(Object.assign(new Error('Worker scheduler disposed'), { name: 'AbortError', code: 'ABORT_ERR' }))
      return new Promise(resolve => {
        const entry = { resolve, timer: undefined }
        pending.add(entry)
        if (channel) {
          try { channel.port2.postMessage(0) } catch { fallback() }
        } else scheduleTimer(entry)
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      closeChannel()
      // Wake interrupted geometry so its existing signal check can finish;
      // closing a MessagePort alone would strand the await forever.
      for (const entry of pending) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.resolve()
      }
      pending.clear()
    },
  }
}
