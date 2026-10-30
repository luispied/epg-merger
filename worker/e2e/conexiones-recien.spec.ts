// «Mirando» al abrir un canal (perfiles.tsx, ConnectionsPage): un link que abrió un canal hace menos de 15 minutos cuenta
// como mirando aunque el proveedor todavía marque 0 conexiones (tarda 4 a 5 minutos en mostrarla).
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dev = (code: string, name: string, extra: Record<string, unknown> = {}) => ({
  code, name, active: true, lastUsed: ago(60), accountKey: 'ak1', profile: 'p1', playlistUrl: `https://grilla.test/p/${code}`, epgUrl: `https://grilla.test/e/${code}`, ...extra,
});
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

for (const scheme of ['light', 'dark'] as const) {
  test(`conexiones recién: un link que abrió un canal figura mirando aunque el proveedor marque 0 (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await fakeWorker(page, {
      accounts: { ak1: { expires: new Date(Date.now() + 20 * 86_400_000).toISOString(), maxConnections: 3, activeConnections: 0 } },
      devices: [
        dev('d1', 'TV Living', { lastPlay: { t: ago(3), ch: '4' } }),
        dev('d2', 'TV de Mama', { lastPlay: { t: ago(16 * 60), ch: '1' } }),
      ],
    });
    await page.goto('/');
    await expect(page.locator('#editor')).toBeVisible();
    await page.locator('#tabLinks').click();
    await page.locator('#linksBody .account-row').click();
    await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
    await expect(page.locator('#linksTitle')).toHaveText('Conexiones');

    await expect(page.locator('#linksBody .pc-stat').first()).toContainText('0 de 3');
    await expect(page.locator('#linksBody .pc-stat').nth(1)).toContainText('1');
    await expect(page.locator('#linksBody .conn-row').first()).toContainText('TV Living');
    await expect(page.locator('#linksBody .sub-title').first()).toHaveText('Mirando ahora');
    await page.screenshot({ path: `test-results/conexiones-recien-${scheme}.png` });
  });
}
