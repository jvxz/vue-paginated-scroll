import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  root: resolve(import.meta.dirname),
  server: { port: 4173 },
})
