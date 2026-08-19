import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  testDir: './test/browser',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: './node_modules/.bin/vite --config test/browser/vite.config.ts --host 127.0.0.1',
    reuseExistingServer: true,
    url: 'http://127.0.0.1:4173',
  },
})
