// Primera carga: un error pasajero del servidor no tiene que dejar la pantalla sin lista. Los GET con 5xx se reintentan
// solos (fetchRetry, web/app.ts), así que la lista llega sin que la persona toque «Reintentar». Si el fallo sigue, el
// aviso aparece y «Reintentar» la vuelve a pedir (revision.spec.ts). Acá se mira el camino feliz tras un 5xx.
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

test('un 500 de la configuración se reintenta solo: la lista aparece sin tocar «Reintentar»', async ({ page }) => {
  await fakeWorker(page);
  let hits = 0;
  // Dos fallos pasajeros y después el Worker responde como siempre.
  await page.route('**/api/cfg/c1', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    hits++;
    return hits <= 2 ? route.fulfill({ status: 500, json: { error: 'pasajero' } }) : route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  await expect(page.locator('.status-bar.bad')).toHaveCount(0);
  expect(hits).toBe(3);
});

test('un 500 de la guía se reintenta solo: la Guía carga sin aviso de error', async ({ page }) => {
  await fakeWorker(page);
  let hits = 0;
  await page.route('**/api/guide/index.json', (route) => {
    hits++;
    return hits <= 2 ? route.fulfill({ status: 500, json: { error: 'pasajero' } }) : route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('.status-bar.bad')).toHaveCount(0);
  expect(hits).toBe(3);
});
