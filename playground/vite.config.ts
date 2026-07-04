/// <reference types="node" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Standalone dev server for the playground. Imports the library straight from
// ../src for instant HMR against source.
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  server: {
    // Honor the harness-assigned port (via PORT env) when present.
    port: process.env.PORT ? Number(process.env.PORT) : 5174,
  },
})
