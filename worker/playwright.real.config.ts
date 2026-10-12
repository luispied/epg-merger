// Punta a punta contra el Worker de verdad, local: `wrangler dev` con R2 local (e2e-real/). Nunca apunta a producción:
// el host es 127.0.0.1, el estado vive en test-results/ y se borra en cada corrida. La clave del Worker
// (TOKEN_KEY) se genera al azar para cada corrida. Correr con `npm run e2e:real`.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;
const STATE = resolve('test-results/wrangler-state');
const TOKEN_KEY = randomBytes(32).toString('base64');
// Playwright vuelve a cargar este archivo en cada worker: solo el proceso principal limpia el estado (el Worker ya lo usa).
if (process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
}

export default defineConfig({
  testDir: 'e2e-real',
  // Los flujos comparten el mismo Worker y R2: de a uno, para no pisarse el estado.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, serviceWorkers: 'block', locale: 'es-UY' },
  projects: [{ name: 'escritorio', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node build.mjs && npx wrangler dev --local --ip 127.0.0.1 --port ${PORT} --persist-to ${STATE} --var TOKEN_KEY:${TOKEN_KEY}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
