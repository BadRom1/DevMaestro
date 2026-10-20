import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Fixtures du prototype n° 5 lues en `?raw` par les tests jsdom de la vue conversation.
  server: { fs: { allow: ['.', '../spikes/05-vue-conversation/fixtures'] } },
  test: {
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 30000,
  },
})
