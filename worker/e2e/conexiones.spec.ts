// La pantalla de Conexiones de una cuenta (perfiles.tsx, ConnectionsPage): cuántas están en uso según el proveedor, qué
// links están mirando ahora (los que abrieron un canal hace menos de una hora) y los demás, sin cortar la lista.
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

async function openConnections(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody .account-row').click();
  await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Conexiones');
}

test('conexiones: los que miran ahora arriba, los demás abajo, y lo que el proveedor cuenta de más', async ({ page }, info) => {
  await fakeWorker(page, {
    accounts: { ak1: { expires: new Date(Date.now() + 20 * 86_400_000).toISOString(), maxConnections: 5, activeConnections: 3 } },
    devices: [
      dev('d1', 'TV del living', { lastPlay: { t: ago(20), ch: '4' } }),
      dev('d2', 'Tablet', { lastPlay: { t: ago(30), ch: '1' } }),
      dev('d3', 'Celu vieja'),
      dev('d4', 'Cocina', { active: false, lastPlay: { t: ago(5 * 60), ch: '2' } }),
    ],
  });
  await openConnections(page);
  const stats = page.locator('#linksBody .pc-stat');
  await expect(stats.nth(0)).toContainText('3 de 5');
  await expect(stats.nth(1)).toContainText('2');
  await expect(stats.nth(1)).toContainText('Links mirando');

  const watching = page.locator('#linksBody .conn-row').filter({ hasText: /TV del living|Tablet/ });
  await expect(watching).toHaveCount(2);
  // Los que abrieron un canal hace menos tiempo, primero.
  await expect(page.locator('#linksBody .conn-row').first()).toContainText('TV del living');
  await expect(page.locator('#linksBody .conn-row').first().locator('small')).toHaveText('CNN · hace 20 min');
  await expect(page.locator('#linksBody .conn-row').nth(1).locator('small')).toHaveText('ESPN · hace 30 min');
  await expect(page.locator('#linksBody .sub-title')).toHaveText(['Mirando ahora', 'Los demás links']);

  // Abajo: primero el que tuvo un canal (desactivado, así que se ve apagado), y después el que nunca tuvo.
  const rest = page.locator('#linksBody .conn-row');
  await expect(rest.nth(2)).toHaveClass(/off/);
  await expect(rest.nth(2).locator('small')).toHaveText('Desactivado');
  await expect(rest.nth(3)).toContainText('Celu vieja');
  await expect(rest.nth(3).locator('small')).toHaveText('Sin canales registrados todavía');

  // Hay 3 en uso y solo 2 se ven: el aviso explica la diferencia.
  await expect(page.locator('#linksBody .help', { hasText: 'Una conexión no aparece' })).toBeVisible();
  await page.screenshot({ path: `test-results/conexiones-${info.project.name}.png` });
});

test('conexiones sin links mirando: lo dice en vez de dejar la sección vacía', async ({ page }) => {
  await fakeWorker(page, {
    accounts: { ak1: { expires: new Date(Date.now() + 20 * 86_400_000).toISOString(), maxConnections: 2, activeConnections: 0 } },
    devices: [dev('d1', 'TV del living', { lastPlay: { t: ago(4 * 60), ch: '4' } }), dev('d3', 'Celu vieja', { lastPlay: { t: ago(5 * 60), ch: '1' } })],
  });
  await openConnections(page);
  await expect(page.locator('#linksBody .pc-stat').first()).toContainText('0 de 2');
  await expect(page.locator('#linksBody .help', { hasText: 'El proveedor no tiene conexiones abiertas ahora.' })).toBeVisible();
  // Sin conexiones que no aparecen, no hay aviso de «no aparece».
  await expect(page.locator('#linksBody .help', { hasText: 'no aparece' })).toHaveCount(0);
  // El que abrió un canal hace más de una hora figura en «Los demás links», con su último canal.
  await expect(page.locator('#linksBody .conn-row', { hasText: 'Celu vieja' }).locator('small')).toHaveText('Último canal: ESPN · hace 5 h');
});
