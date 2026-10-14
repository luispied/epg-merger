// Tema de punta a punta: sin preferencia la app sigue al sistema (es el valor por defecto); «Como el sistema» hace lo
// mismo; «Claro» y «Oscuro» se quedan como se eligieron. Las capturas (visual.spec.ts) miran la forma; esto
// mira el color de fondo y del texto en las pantallas que más se usan.
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** El color de fondo del cuerpo, como lo pinta el navegador. */
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** El color de la letra de la primera fila de Canales. */
const rowText = (page: Page) => page.locator('#cards .card').first().locator('.card-name')
  .evaluate((el) => getComputedStyle(el).color);

const lum = (rgb: string) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Deja la preferencia de tema guardada antes de que cargue la app (como si la hubiera elegido la persona). */
const saveTheme = (page: Page, v: string) => page.addInitScript((t) => localStorage.setItem('grilla_theme', t), v);

test('sin preferencia, la app sigue al sistema (el valor por defecto): claro y, si cambia, oscuro', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  // Con la lista pintada antes que la guía, el color de la fila se asienta después: se espera el valor final.
  await expect.poll(() => bodyBg(page).then(lum)).toBeGreaterThan(200);
  await expect.poll(() => rowText(page).then((c) => (/\d/.test(c) ? lum(c) : NaN))).toBeLessThan(120);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => bodyBg(page).then(lum)).toBeLessThan(80);
});

test('«Como el sistema»: sigue al sistema, claro o oscuro', async ({ page }) => {
  await saveTheme(page, 'auto');
  await page.emulateMedia({ colorScheme: 'light' });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  // Con la lista pintada antes que la guía, el color de la fila se asienta después: se espera el valor final.
  await expect.poll(() => bodyBg(page).then(lum)).toBeGreaterThan(200);
  await expect.poll(() => rowText(page).then((c) => (/\d/.test(c) ? lum(c) : NaN))).toBeLessThan(120);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => bodyBg(page).then(lum)).toBeLessThan(80);
});

test('«Claro» se queda claro aunque el sistema esté en oscuro', async ({ page }) => {
  await saveTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  expect(lum(await bodyBg(page))).toBeGreaterThan(200);
});

test('la Guía también se lee en oscuro: fondo oscuro al abrir la pestaña', async ({ page }) => {
  await saveTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await page.locator('#tabGuide').click();
  await expect(page.locator('#guide')).toBeVisible();
  expect(lum(await bodyBg(page))).toBeLessThan(80);
});
