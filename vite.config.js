import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        entityPreview: fileURLToPath(new URL('./scripts/entity-preview.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
