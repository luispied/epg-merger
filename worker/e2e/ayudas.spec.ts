// Ayuda: una sola página en Perfil > Aplicación, con una sección por pantalla y un buscador. Ninguna pantalla tiene su (?).
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('ninguna pantalla tiene (?): Categorías y Perfil no llevan botón de ayuda', async ({ page }) => {
  await page.locator('#categoriesBtn').click();
  await expect(page.locator('#categoriesTitle')).toHaveText('Categorías');
  await expect(page.locator('#categoriesDialog .help-btn')).toHaveCount(0);
  await page.locator('#tabLinks').click();
  await expect(page.locator('#linksDialog')).toBeVisible();
  await expect(page.locator('#linksDialog .help-btn')).toHaveCount(0);
});

test('Perfil > Ayuda muestra una sección por pantalla, y el buscador filtra', async ({ page }) => {
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody').getByRole('button', { name: /^Ayuda/ }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Ayuda');
  const ayuda = page.locator('#linksDialog .ayuda');
  const visibles = ayuda.locator('section[data-pantalla]:not([hidden])');
  await expect(visibles).toHaveCount(6);
  await ayuda.getByRole('searchbox', { name: 'Buscar en la ayuda' }).fill('Tengo tiempo');
  await expect(visibles).toHaveCount(1);
  await expect(visibles.first()).toHaveAttribute('data-pantalla', 'guia');
  await ayuda.getByRole('searchbox').fill('no existe esta palabra');
  await expect(visibles).toHaveCount(0);
  await expect(ayuda.getByText('Ninguna sección coincide')).toBeVisible();
});
