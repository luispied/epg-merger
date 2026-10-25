// Ayudas (?): cada pantalla con su botón de ayuda abre su tema, y solo ese. La de la Guía y la de Canales están en
// hojas.spec.ts y guide.spec.ts; acá, Configuración, Categorías y Links, que son las que faltaban.
import { expect, test, type Page } from '@playwright/test';
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

/** Solo un tema visible en la ayuda, y es el que se pidió. */
async function expectTopic(page: Page, topic: string) {
  const help = page.locator('#helpDialog');
  await expect(help).toBeVisible();
  await expect(help.locator('.help-topic:not([hidden])')).toHaveCount(1);
  await expect(help.locator(`.help-topic[data-topic="${topic}"]`)).toBeVisible();
}

test('Configuración: su ? abre el tema de Configuración', async ({ page }) => {
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody').getByRole('button', { name: /^Configuración/ }).click();
  await expect(page.locator('#linksDialog')).toBeVisible();
  await page.locator('#linksDialog #linksHelpBtn').click();
  await expectTopic(page, 'settings');
});

test('Categorías: «Cómo funciona» abre el tema de Categorías', async ({ page }) => {
  await page.locator('#categoriesBtn').click();
  await expect(page.locator('#categoriesTitle')).toHaveText('Categorías');
  await page.locator('#categoriesDialog .help-btn[aria-label="Cómo funciona"]').click();
  await expectTopic(page, 'categories');
});

test('Links: «Cómo funciona» abre el tema de Links', async ({ page }) => {
  await page.locator('#tabLinks').click();
  await expect(page.locator('#linksDialog')).toBeVisible();
  await page.locator('#linksHelpBtn').click();
  await expectTopic(page, 'links');
});
