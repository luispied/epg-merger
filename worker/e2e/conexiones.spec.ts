// Conexiones: qué links figuran mirando. Ventana de 30 minutos, tope por lo que dice el proveedor y el aviso cuando un
// link compartido explica más conexiones que links mirando.
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const dev = (code: string, name: string, min: number | null, active = true) => ({
  code, name, active, lastUsed: ago(60), accountKey: 'ak1', profile: 'p1', ...(min === null ? {} : { lastPlay: { t: ago(min), ch: '4' } }),
  playlistUrl: `https://grilla.test/p/${code}`, epgUrl: `https://grilla.test/e/${code}`,
});

async function openConexiones(page: Page, devices: ReturnType<typeof dev>[], inUse: number, theme = 'light') {
  await page.addInitScript((t) => { localStorage.setItem('grilla_theme', t); localStorage.setItem('grilla_seen_version', '99.0.0'); }, theme);
  await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
  await fakeWorker(page);
  await page.route('**/api/cfg/c1/devices', (r) => r.fulfill({ json: { devices, profiles: [{ id: 'p1', name: 'Luis' }], mainName: 'Luis' } }));
  await page.route('**/api/cfg/c1/accounts', (r) => r.fulfill({ json: { accounts: { ak1: { expires: ago(-20 * 24 * 60), maxConnections: 3, activeConnections: inUse } } } }));
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody .account-row').click();
  await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Conexiones');
}

for (const theme of ['light', 'dark']) {
  test(`un link compartido: más conexiones que links mirando lo explica (${theme})`, async ({ page }) => {
    // Tres TV con el mismo link (SYC) abrieron canal hace 4 min; las otras dos, hace 3 y 4 horas.
    await openConexiones(page, [dev('syc', 'SYC', 4), dev('living', 'TV Living', 180), dev('cuarto', 'TV Cuarto', 240)], 3, theme);
    const watching = page.locator('#linksBody .device-list').first().locator('.conn-row');
    await expect(watching).toHaveCount(1);
    await expect(watching).toContainText('SYC');
    await expect(page.locator('#linksBody .pc-stats')).toContainText('Link mirando');
    await expect(page.locator('#linksBody')).toContainText('2 conexiones no aparecen acá');
    await expect(page.locator('#linksBody')).toContainText('un mismo link usado en varios dispositivos a la vez');
    await page.screenshot({ path: `test-results/conexiones-${theme}-${test.info().project.name}.png` });
  });
}

test('más links mirando que conexiones: solo se muestran tantos como dice el proveedor', async ({ page }) => {
  await openConexiones(page, [dev('a', 'TV Ro', 1), dev('b', 'SYC', 4), dev('c', 'TV Living', 10)], 1);
  await expect(page.locator('#linksBody .conn-row').first()).toContainText('TV Ro');
  await expect(page.locator('#linksBody .pc-stats')).toContainText('Link mirando');
  await expect(page.locator('#linksBody .conn-row')).toHaveCount(3);
  await expect(page.locator('#linksBody')).not.toContainText('no aparecen');
});

test('sin conexiones en el proveedor no hay links mirando', async ({ page }) => {
  await openConexiones(page, [dev('a', 'TV Ro', 1)], 0);
  await expect(page.locator('#linksBody')).toContainText('El proveedor no tiene conexiones abiertas ahora.');
});

test('un canal de hace más de 30 minutos ya no figura mirando', async ({ page }) => {
  await openConexiones(page, [dev('a', 'TV Living', 45)], 1);
  await expect(page.locator('#linksBody')).toContainText('Ningún link de esta cuenta abrió un canal en los últimos 30 minutos.');
});
