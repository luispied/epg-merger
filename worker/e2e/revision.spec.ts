// Humo de las piezas de la lista que pasaron a Preact al final (ui/canales.tsx, ui/piezas.tsx): la tarjeta de revisión
// con su avance, el menú «…» de una fila (Esc y tocar afuera) y «Reintentar» cuando la grilla no carga.
import { expect, test } from '@playwright/test';
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

// Nombres parecidos a los de la guía: quedan dudosos y van a «A revisar».
const DOUBTFUL = ['Canal Rural Plus', 'Rural', 'ESPN 2', 'CNN Chile', 'Canal Rural Uruguay'].map((n) => [n, 'Noticias']);

test('la tarjeta de revisión cuenta los dudosos y «Empezar» abre la revisión', async ({ page }, info) => {
  await fakeWorker(page, { extra: DOUBTFUL });
  await page.goto('/');
  const card = page.locator('#reviewCard');
  await expect(card).toBeVisible();
  await expect(card.locator('.rv-text strong')).toHaveText(/^\d+ canales para revisar$/);
  await expect(card.locator('.rv-text small')).toHaveText('Tienen una guía dudosa o sin asignar');
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(card.locator('.rv-new')).toHaveCount(0);
  await page.screenshot({ path: `test-results/revision-${info.project.name}.png` });
  await card.getByRole('button', { name: 'Empezar' }).click();
  await expect(page.locator('#channelDialog')).toBeVisible();
  await expect(page.locator('#channelDialog .rv-progress')).toBeVisible();
});

test('sin dudosos no hay tarjeta', async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('#reviewCard')).toBeHidden();
});

test('el menú «…» se cierra con Esc (vuelve el foco) o tocando afuera', async ({ page }, info) => {
  test.skip(info.project.name !== 'escritorio', 'el «…» es para el mouse');
  await fakeWorker(page);
  await page.goto('/');
  const more = page.locator('#cards .card', { hasText: 'CNN' }).first().locator('.row-more');
  await more.click();
  const menu = page.locator('.row-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Ocultar', 'Dejar sin guía', 'Seleccionar']);
  await expect(menu.getByRole('menuitem', { name: 'Ocultar' })).toBeFocused();
  await page.screenshot({ path: 'test-results/menu-fila.png' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await expect(menu).toBeVisible();
  await page.locator('#statusLine').click();
  await expect(menu).toHaveCount(0);
});

test('si la grilla no carga, «Reintentar» la vuelve a pedir', async ({ page }) => {
  await fakeWorker(page);
  let fail = true;
  await page.route('**/api/cfg/c1', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'se cayó' } }) : route.fallback()));
  await page.goto('/');
  const retry = page.getByRole('button', { name: 'Reintentar' });
  await expect(retry).toBeVisible();
  await expect(page.locator('.status-bar.bad .lead')).toContainText('No se pudo cargar la grilla');
  fail = false;
  await retry.click();
  await expect(page.locator('#cards .card').first()).toBeVisible();
});
