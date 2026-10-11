// Humo de Configuración (ui/settings.tsx): lo que muestra al abrirse, las preferencias que se guardan en el navegador,
// «Actualizar la guía ahora» y los atajos a la salud de la guía y a «Usar en otro dispositivo».
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  fake = await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const sheet = (page: Page) => page.locator('#settingsDialog');
async function openSettings(page: Page) {
  await page.locator('#settingsBtn').click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator('#settingsTitle')).toHaveText('Configuración');
}

test('muestra la guía, los avisos y la versión', async ({ page }) => {
  await openSettings(page);
  const s = sheet(page);
  await expect(s.locator('.meta-line')).toHaveText(await page.locator('#statusLine').textContent() ?? '');
  await expect(s.getByRole('button', { name: /Actualizar la guía ahora/ })).toContainText('Al día · última actualización');
  await expect(s.getByRole('button', { name: /Salud de la guía/ })).toContainText('Todavía no hay datos de programación');
  // El Worker tiene avisos: aparece el interruptor (Chromium sin pantalla los da por bloqueados).
  await expect(s.locator('.menu-row', { hasText: 'Avisos' })).toContainText('Bloqueados: activalos en los ajustes del sitio del navegador');
  const avisos = s.locator('.menu-row', { hasText: 'Avisos' }).getByRole('switch');
  await expect(avisos).toBeDisabled();
  await expect(avisos).not.toBeChecked();
  await expect(s.locator('.app-version')).toHaveText(/^Versión \d+\.\d+\.\d+/);
  // Sin datos de programación, la salud lo dice en vez de filtrar.
  await s.getByRole('button', { name: /Salud de la guía/ }).click();
  await expect(page.locator('.toast .msg')).toContainText('Todavía no hay datos de programación para comparar');
});

test('las preferencias se guardan y se ven al volver a abrir', async ({ page }) => {
  await openSettings(page);
  const s = sheet(page);
  await s.getByRole('radio', { name: 'Claro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(s.getByRole('radio', { name: 'Claro' })).toHaveAttribute('aria-checked', 'true');
  await s.locator('.menu-row', { hasText: 'Mostrar logos' }).locator('input').uncheck();
  await expect(page.locator('body')).toHaveClass(/no-logos/);
  await s.locator('select').selectOption('todos');
  await s.getByRole('button', { name: 'Cerrar' }).click();
  await expect(sheet(page)).toBeHidden();

  await openSettings(page);
  await expect(s.getByRole('radio', { name: 'Claro' })).toHaveAttribute('aria-checked', 'true');
  await expect(s.getByRole('radio', { name: 'Oscuro' })).toHaveAttribute('aria-checked', 'false');
  await expect(s.locator('.menu-row', { hasText: 'Mostrar logos' }).locator('input')).not.toBeChecked();
  await expect(s.locator('select')).toHaveValue('todos');
  const prefs = await page.evaluate(() => [localStorage.getItem('grilla_theme'), localStorage.getItem('grilla_logos'), localStorage.getItem('grilla_start_filter')]);
  expect(prefs).toEqual(['light', '0', 'todos']);
});

test('actualizar la guía ahora', async ({ page }) => {
  await openSettings(page);
  await sheet(page).getByRole('button', { name: /Actualizar la guía ahora/ }).click();
  await expect(page.locator('.toast .msg')).toContainText('Actualizando la guía');
  await expect(sheet(page)).toBeHidden();
  expect(fake.writes.some((w) => w.method === 'POST' && w.path === '/api/cfg/c1/refresh')).toBe(true);
});

test('usar en otro dispositivo abre Perfil en esa página', async ({ page }) => {
  await openSettings(page);
  await sheet(page).getByRole('button', { name: /Usar en otro dispositivo/ }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator('#linksDialog')).toBeVisible();
  await expect(page.locator('#linksTitle')).toHaveText('Otro dispositivo');
});

test('letra grande agranda toda la app y queda elegida en este dispositivo', async ({ page }) => {
  await openSettings(page);
  const big = sheet(page).locator('.menu-row', { hasText: 'Letra grande' }).getByRole('switch');
  await expect(big).not.toBeChecked();
  await expect(page.locator('html')).not.toHaveAttribute('data-text', 'lg');
  await big.check();
  await expect(page.locator('html')).toHaveAttribute('data-text', 'lg');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe('1.12');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-text', 'lg');
  await openSettings(page);
  await sheet(page).locator('.menu-row', { hasText: 'Letra grande' }).getByRole('switch').uncheck();
  await expect(page.locator('html')).not.toHaveAttribute('data-text', 'lg');
});
