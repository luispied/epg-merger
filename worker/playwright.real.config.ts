// Punta a punta contra el Worker de verdad, local: `wrangler dev` con R2 local (e2e-real/). Nunca apunta a producción:
// el host es 127.0.0.1, el estado vive en test-results/ y se borra en cada corrida. La clave del Worker
// (TOKEN_KEY) y las claves VAPID de los avisos push se generan al azar para cada corrida. Correr con `npm run e2e:real`.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;
const STATE = resolve('test-results/wrangler-state');
const TOKEN_KEY = randomBytes(32).toString('base64');
// Par VAPID de prueba (los avisos push del Worker lo necesitan para estar activos): la pública va sin comprimir, como la RFC.
const vapid = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const vapidJwk = vapid.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
const VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')]).toString('base64url');
const VAPID_PRIVATE_KEY = (vapid.privateKey.export({ format: 'jwk' }) as { d: string }).d;
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
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] } },
    // Viewport de celular (Chromium, como el resto de la suite): el perfil infantil en modo ver se mira sobre todo en el celular.
    { name: 'iphone', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: `node build.mjs && npx wrangler dev --local --ip 127.0.0.1 --port ${PORT} --persist-to ${STATE}`
      + ` --var TOKEN_KEY:${TOKEN_KEY} --var VAPID_PUBLIC_KEY:${VAPID_PUBLIC_KEY} --var VAPID_PRIVATE_KEY:${VAPID_PRIVATE_KEY}`,
    url: `http://127.0.0.1:${PORT}/`,
    // El servicio de push de mentira está en 127.0.0.1: el Worker no lo manda por el proxy de salida (si hay uno).
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
