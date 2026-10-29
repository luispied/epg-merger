// El foco al abrir una hoja cae en la hoja, no en la ✕ (ui/sheet.ts, settleFocus): en la edición.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

test.beforeEach(async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

// Si la ✕ de la última hoja abierta tiene el foco. Las páginas (Perfil) no son hojas: ahí basta con que no caiga en la ✕.
const topSheetFocus = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const opened = [...document.querySelectorAll('dialog[open]')];
    const d = opened[opened.length - 1];
    const a = document.activeElement;
    return { dialog: a === d, closeButton: a instanceof HTMLButtonElement && a.getAttribute('aria-label') === 'Cerrar' };
  });

test('Perfil, Configuración y Ayuda abren con el foco fuera de la ✕', async ({ page }) => {
  await page.locator('#tabLinks').click();
  await page.getByRole('button', { name: /^Configuración/ }).click();
  await expect.poll(async () => (await topSheetFocus(page)).closeButton).toBe(false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.locator('#tabLinks').click();
  await page.getByRole('button', { name: /^Ayuda/ }).click();
  await expect.poll(async () => (await topSheetFocus(page)).closeButton).toBe(false);
});

test('el buscador de Categorías y de Perfil no toma el foco al abrir (no abre el teclado)', async ({ page }) => {
  await page.locator('#categoriesBtn').click();
  await expect(page.locator('#categoriesDialog .cat-filter input')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.search-field') ? 'buscador' : 'fuera')).toBe('fuera');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.locator('#tabLinks').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.search-field') ? 'buscador' : 'fuera')).toBe('fuera');
});
