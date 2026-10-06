import assert from 'node:assert/strict'
import { submissionPayload, submitIndexNow } from './submit-indexnow.mjs'

const payload = await submissionPayload()
assert.deepEqual(payload.urlList, [
  'https://gudu-z.github.io/LitematicWebViewer/',
  'https://gudu-z.github.io/LitematicWebViewer/scripts/entity-preview.html',
])
assert.equal(new URL(payload.keyLocation).pathname, '/LitematicWebViewer/indexnow-key.txt')
assert.equal(payload.host, 'gudu-z.github.io')
const keyResponse = () => new Response(payload.key + '\n')

for (const status of [200, 202]) {
  const calls = []
  const result = await submitIndexNow({ request: async (url, options) => {
    calls.push(url)
    if (url === payload.keyLocation) return keyResponse()
    assert.equal(url, 'https://api.indexnow.org/indexnow')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), payload)
    return new Response('', { status })
  } })
  assert.equal(result.status, status)
  assert.equal(calls.length, 2, 'one ownership check and one notification')
}
for (const response of [() => new Response('', { status: 404 }), () => new Response('old or mismatched key')]) {
  let calls = 0
  await assert.rejects(submitIndexNow({ attempts: 2, pause: async () => {}, request: async url => {
    assert.equal(url, payload.keyLocation, 'must not submit with a missing or stale ownership file')
    calls++; return response()
  } }), /no URLs submitted/)
  assert.equal(calls, 2)
}
let checks = 0, posts = 0
await submitIndexNow({ pause: async () => {}, request: async url => {
  if (url === payload.keyLocation) {
    if (++checks === 1) throw Error('temporary network failure')
    return keyResponse()
  }
  posts++; return new Response('', { status: 200 })
} })
assert.equal(checks, 2); assert.equal(posts, 1)
for (const status of [403, 422, 429, 500]) {
  let posts = 0
  await assert.rejects(submitIndexNow({ request: async url => {
    if (url === payload.keyLocation) return keyResponse()
    posts++; return new Response('rejected', { status })
  } }), new RegExp('HTTP ' + status))
  assert.equal(posts, 1, 'do not repeatedly send rejected submissions')
}
console.log('Passed sitemap submission scope, ownership validation, CDN retry, HTTP 200/202 receipts and rejection handling. No external submissions made.')
