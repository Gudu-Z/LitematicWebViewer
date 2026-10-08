import { build } from 'vite'
// Ship one dependency-free ES module at the existing public URL.
await build({
  configFile: false, publicDir: false, logLevel: 'warn',
  build: {
    outDir: 'public', emptyOutDir: false, minify: false,
    lib: { entry: 'src/embedSdk.js', formats: ['es'], fileName: () => 'embed.js' },
  },
})
