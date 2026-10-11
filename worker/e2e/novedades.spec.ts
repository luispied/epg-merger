// Humo de Novedades (ui/novedades.tsx): la primera vez no aparece nada; con una versión vieja anotada, al abrir se ve
// lo nuevo; desde Configuración se abre siempre; y ?novedades (lo que abre el aviso push) la muestra aunque ya se viera.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

const sheet = (page: import('@playwright/test').Page) => page.locator('dialog.nv-sheet');

test('primera vez: no aparece, y queda anotada la versión', async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('grilla_seen_version'))).toMatch(/^\d+\.\d+\.\d+$/);
});

test('después de actualizar: «Nowline se actualizó» con lo nuevo, y no vuelve a aparecer', async ({ page }, info) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('nv')) { sessionStorage.setItem('nv', '1'); localStorage.setItem('grilla_seen_version', '1.33.0'); } });
  await fakeWorker(page);
  await page.goto('/');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('#nvTitle')).toHaveText('Nowline se actualizó');
  await expect(sheet(page).locator('.nv-ver h3').first()).toHaveText(/^Versión \d+\.\d+\.\d+$/);
  await expect(sheet(page).locator('.nv-ver h3')).not.toContainText(['Versión 1.33.0']);
  await expect(sheet(page).locator('.nv-list li').first()).not.toContainText('`');
  await page.screenshot({ path: `test-results/novedades-${info.project.name}.png` });
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  // Desde Configuración se abre siempre.
  await page.locator('#settingsBtn').click();
  await page.getByRole('button', { name: 'Ver novedades' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('#nvTitle')).toHaveText('Novedades');
});

test('?novedades (desde el aviso push) la muestra aunque ya se haya visto', async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await page.goto('/?novedades');
  await expect(sheet(page)).toBeVisible();
});
