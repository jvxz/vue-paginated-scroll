import vue from '@vitejs/plugin-vue'
/// <reference types="node" />
import { defineConfig } from 'vite'

// Standalone dev server for the playground. Imports the library straight from
// ../src for instant HMR against source.
export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  server: {
    // Honor the harness-assigned port (via PORT env) when present.
    port: process.env.PORT ? Number(process.env.PORT) : 5174,
  },
})
