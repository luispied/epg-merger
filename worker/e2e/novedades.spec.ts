// Humo de Novedades (ui/novedades.tsx): la primera vez no aparece nada; con una versión vieja anotada, al abrir sale un
// aviso breve («nowline se actualizó») con «Qué hay nuevo», que abre lo nuevo; y desde Configuración se abre siempre.
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

test('después de actualizar: aviso breve con «Qué hay nuevo», y no vuelve a aparecer', async ({ page }, info) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('nv')) { sessionStorage.setItem('nv', '1'); localStorage.setItem('grilla_seen_version', '1.33.0'); } });
  await fakeWorker(page);
  await page.goto('/');
  const toast = page.locator('.toasts .toast');
  await expect(toast.locator('.msg')).toHaveText('nowline se actualizó');
  await page.screenshot({ path: `test-results/novedades-aviso-${info.project.name}.png` });
  await toast.getByRole('button', { name: 'Qué hay nuevo' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('#nvTitle')).toHaveText('Novedades');
  await expect(sheet(page).locator('.nv-ver h3').first()).toHaveText(/^Versión \d+\.\d+\.\d+$/);
  await expect(sheet(page).locator('.nv-ver h3')).not.toContainText(['Versión 1.33.0']);
  await expect(sheet(page).locator('.nv-list li').first()).not.toContainText('`');
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('.toasts .toast')).toHaveCount(0);
  // Desde Configuración se abre siempre.
  await page.locator('#settingsBtn').click();
  await page.getByRole('button', { name: 'Ver novedades' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('#nvTitle')).toHaveText('Novedades');
});
