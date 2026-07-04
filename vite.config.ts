import vue from '@vitejs/plugin-vue'
/// <reference types="node" />
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      fileName: format => (format === 'es' ? 'index.js' : 'index.cjs'),
      formats: ['es', 'cjs'],
      name: 'VuePaginatedScroll',
    },
    rollupOptions: {
      external: ['vue', '@vueuse/core'],
      output: {
        globals: {
          '@vueuse/core': 'VueUse',
          vue: 'Vue',
        },
      },
    },
  },
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
  },
})
