import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const xterm = JSON.parse(readFileSync(new URL('./node_modules/@xterm/xterm/package.json', import.meta.url), 'utf8'))

export default defineConfig({
  clearScreen: false,
  define: { __XTERM_VERSION__: JSON.stringify(xterm.version) },
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
})
