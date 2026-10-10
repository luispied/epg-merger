// Tests de humo de la web (e2e/): la app compilada (public/, `node build.mjs`) servida tal cual,
// en Chromium, sin red: las llamadas a /api las contesta cada test. Correr con `npm run e2e`.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block', locale: 'es-UY' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: { command: 'node e2e/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
