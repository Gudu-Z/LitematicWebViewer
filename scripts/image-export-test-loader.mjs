import { readFile } from 'node:fs/promises'

// Load the actual studio methods in Node; only Vite's non-JavaScript imports need adapters.
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  if (url.endsWith('.html?raw')) return {
    format: 'module', source: 'export default ' + JSON.stringify(await readFile(new URL(url), 'utf8')), shortCircuit: true,
  }
  return next(url, context)
}
