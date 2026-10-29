// Los canales que abrió un link (perfiles.tsx, LinkHistory): de la más nueva a la más vieja, agrupados por día, con
// «Ahora» en el último si abrió un canal hace menos de 15 minutos. Claro y oscuro.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
function yesterdayAt(h: number, m: number) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

async function openHistory(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody .account-row').click();
  await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Conexiones');
  await page.locator('#linksBody .conn-row', { hasText: 'TV del living' }).click();
  await expect(page.locator('#linksBody .sub-title')).toHaveText('Canales que abrió «TV del living»');
}

test('historial del link: hoy y ayer, el último con «Ahora»', async ({ page }, info) => {
  await fakeWorker(page, {
    hist: { d1: [
      { t: ago(5), ch: '4', p: 'Noticias del mediodía' },
      { t: ago(70), ch: '1' },
      { t: yesterdayAt(22, 31), ch: '4' },
    ] },
  });
  await openHistory(page);
  const days = page.locator('#linksBody .hist-day');
  await expect(days).toHaveText(['Hoy', 'Ayer']);
  const rows = page.locator('#linksBody .hist-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('CNN');
  await expect(rows.nth(0).locator('.hist-now')).toHaveText('Ahora');
  await expect(rows.nth(0).locator('.hist-prog')).toHaveText('Noticias del mediodía');
  await expect(rows.nth(1).locator('.hist-prog')).toHaveCount(0);
  await expect(rows.nth(1).locator('.hist-now')).toHaveCount(0);
  await expect(rows.nth(2)).toContainText('22:31');
  await page.screenshot({ path: `test-results/historial-${info.project.name}-claro.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `test-results/historial-${info.project.name}-oscuro.png` });
});

test('historial del link: sin aperturas, lo dice', async ({ page }) => {
  await fakeWorker(page);
  await openHistory(page);
  await expect(page.locator('#linksBody .help')).toHaveText('Todavía no abrió ningún canal.');
  await expect(page.locator('#linksBody .hist-row')).toHaveCount(0);
});

test('conexiones: «‹» de la lista de canales vuelve a Conexiones', async ({ page }) => {
  await fakeWorker(page, { hist: { d1: [{ t: ago(5), ch: '4' }] } });
  await openHistory(page);
  await expect(page.locator('#linksBody .hist-row')).toHaveCount(1);
  await page.locator('#linksBack').click();
  await expect(page.locator('#linksTitle')).toHaveText('Conexiones');
});
