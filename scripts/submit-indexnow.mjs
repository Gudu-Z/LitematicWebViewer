// Notify participating search engines after Pages deployment. No account credentials required.
// Protocol: https://www.indexnow.org/documentation (keyLocation supports project subdirectories).
import { readFile, appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const site = new URL('https://gudu-z.github.io/LitematicWebViewer/')
const publicDir = new URL('../public/', import.meta.url)

export async function submissionPayload() {
  const key = (await readFile(new URL('indexnow-key.txt', publicDir), 'utf8')).trim()
  if (!/^[a-f0-9]{32}$/.test(key)) throw Error('Invalid IndexNow ownership key')
  const sitemap = await readFile(new URL('sitemap.xml', publicDir), 'utf8')
  const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url.replaceAll('&amp;', '&'))
  if (!urlList.length || urlList.some(url => {
    const parsed = new URL(url)
    return parsed.origin !== site.origin || !parsed.pathname.startsWith(site.pathname) || parsed.hash
  })) throw Error('Sitemap contains no URLs or URLs outside this project')
  return { host: site.host, key, keyLocation: new URL('indexnow-key.txt', site).href, urlList }
}

export async function submitIndexNow({ request = fetch, attempts = 6, pause = delay } = {}) {
  const payload = await submissionPayload()
  // The Pages deploy can finish before the CDN serves the new public ownership file.
  let published = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request(payload.keyLocation, { signal: AbortSignal.timeout(15000) })
      published = response.ok && (await response.text()).trim() === payload.key
    } catch { /* A temporary CDN/network failure can be retried before notification. */ }
    if (published) break
    if (attempt + 1 < attempts) await pause(5000)
  }
  if (!published) throw Error('The deployed IndexNow ownership file is not available or does not match; no URLs submitted')
  const response = await request('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
  })
  if (![200, 202].includes(response.status)) throw Error(`IndexNow HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return { status: response.status, urls: payload.urlList }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--dry-run')) {
      const { urlList } = await submissionPayload()
      console.log('Dry run; no request sent. URLs:\n' + urlList.join('\n'))
    } else {
      const result = await submitIndexNow()
      const message = `IndexNow received ${result.urls.length} URLs (HTTP ${result.status}${result.status === 202 ? ', key validation pending' : ''}). This is a submission receipt, not confirmation of indexing.`
      console.log(message)
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
