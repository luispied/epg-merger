// Tests de humo de la web (e2e/): la app compilada (public/, `node build.mjs`) servida tal cual,
// en Chromium, sin red: las llamadas a /api las contesta cada test. Correr con `npm run e2e`.
import { defineConfig, devices } from '@playwright/test';

// PORT: otro puerto si el 4173 ya lo usa otro servidor de pruebas (por ejemplo, de otra copia del repo).
const PORT = Number(process.env.PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  // La prueba de capturas (e2e/visual.spec.ts) guarda en SNAP_DIR, si está, para comparar main con un PR en el CI.
  ...(process.env.SNAP_DIR ? { snapshotPathTemplate: `${process.env.SNAP_DIR}/{projectName}/{arg}{ext}` } : {}),
  use: { baseURL: `http://127.0.0.1:${PORT}`, serviceWorkers: 'block', locale: 'es-UY' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: { command: 'node e2e/serve.mjs', url: `http://127.0.0.1:${PORT}`, reuseExistingServer: !process.env.CI },
});
