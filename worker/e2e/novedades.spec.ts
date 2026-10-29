// Humo de Novedades (ui/novedades.tsx): al abrir no aparece nada, ni la primera vez ni después de una versión nueva
// (el aviso de versión nueva va encima de la barra, ui/actualizacion.tsx); lo nuevo se abre desde Configuración.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

const sheet = (page: import('@playwright/test').Page) => page.locator('dialog.nv-sheet');

test('al abrir no sale aviso, ni después de una versión vieja', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('nv')) { sessionStorage.setItem('nv', '1'); localStorage.setItem('grilla_seen_version', '1.33.0'); } });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('.toasts .toast')).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
});

test('desde Configuración se abre Ver novedades', async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody').getByRole('button', { name: /^Configuración/ }).click();
  await page.getByRole('button', { name: 'Ver novedades' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('#nvTitle')).toHaveText('Novedades');
  await expect(sheet(page).locator('.nv-ver h3').first()).toHaveText(/^Versión \d+\.\d+\.\d+$/);
  await expect(sheet(page).locator('.nv-list li').first()).not.toContainText('`');
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(sheet(page)).toHaveCount(0);
});
