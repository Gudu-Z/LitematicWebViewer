export function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Loading cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })
}

// Reject the waiting caller immediately; the guarded operation must also check
// the signal before attaching resources when its underlying request finishes.
export function withAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(Object.assign(new Error('Loading cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })) }
    // The operation has already started when passed in. Always observe it,
    // including a late rejection after cancellation or a pre-aborted signal.
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
