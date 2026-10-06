import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { submissionPayload, submitIndexNow } from './submit-indexnow.mjs'

const payload = await submissionPayload()
assert.deepEqual(payload.urlList, [
  'https://lwv.loafing.club/',
  'https://lwv.loafing.club/scripts/entity-preview.html',
])
assert.equal(payload.keyLocation, 'https://lwv.loafing.club/indexnow-key.txt')
assert.equal(payload.host, 'lwv.loafing.club')
// Keep HTML, structured data, robots and submissions on the same canonical host.
for (const [file, url] of [['index.html', payload.urlList[0]], ['scripts/entity-preview.html', payload.urlList[1]]]) {
  const html = await readFile(new URL('../' + file, import.meta.url), 'utf8')
  assert.equal(html.match(/rel="canonical" href="([^"]+)"/)[1], url)
  assert.equal(html.match(/property="og:url" content="([^"]+)"/)[1], url)
  const structured = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])
  assert.equal(structured.url, url)
  assert.ok(!html.includes('gudu-z.github.io'), 'stale canonical or sharing URL in ' + file)
}
const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8')
assert.ok(robots.includes('Sitemap: https://lwv.loafing.club/sitemap.xml'))
assert.ok(!/^Disallow:\s*\/\s*$/m.test(robots), 'must allow crawling')
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
console.log('Passed canonical custom domain, HTML/JSON-LD/robots/sitemap agreement, submission scope, ownership validation, CDN retry, HTTP 200/202 receipts and rejection handling. No external submissions made.')
