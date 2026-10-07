import { defineConfig } from 'vite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The standalone SDK has a stable public URL with a longer cache lifetime than HTML.
// Pair the example with its SDK revision so returning visitors also get new exports.
const embedSDKVersion = createHash('sha256')
  .update(readFileSync(new URL('./public/embed.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex').slice(0, 12)

export default defineConfig({
  base: './',
  define: { __EMBED_SDK_VERSION__: JSON.stringify(embedSDKVersion) },
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
        embedExample: fileURLToPath(new URL('./embed-example.html', import.meta.url)),
        entityPreview: fileURLToPath(new URL('./scripts/entity-preview.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
