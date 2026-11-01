// Canales caídos en la lista: un canal que la prueba ocultó sola sale apagado, con «Oculto por caído» y el chip
// «Caído» deshabilitado a la derecha (no se puede tocar). Mismo aspecto en claro y en oscuro.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('un caído que la prueba ocultó: fila apagada, «Oculto por caído» y chip «Caído» deshabilitado', async ({ page }, info) => {
  await fakeWorker(page, { health: { channels: { 1: { t: ago(26), ok: false, fails: 2 } }, autoHidden: ['1'], total: 7, checked: ago(26), relayOk: ago(0.2), tested: 2 } });
  await page.goto('/');
  const row = page.locator('#cards .card.row-card.is-caido').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Oculto por caído');
  await expect(row.locator('.caido-chip')).toBeDisabled();
  await expect(row.locator('.caido-chip')).toHaveText('Caído');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/caido-fila-${info.project.name}-${scheme}.png` });
  }
});

test('un oculto a mano que responde: sigue oculto en la app, con «Sale en TiviMate: responde»', async ({ page }, info) => {
  const now = new Date().toISOString();
  // ESPN (id 1) lo ocultó a mano; la prueba dice que responde.
  await fakeWorker(page, { cfgChannels: { ESPN: { hidden: true } }, health: { channels: { 1: { t: now, ok: true, fails: 0 } }, manualOpen: ['1'], total: 7, checked: now, relayOk: now, tested: 1 } });
  await page.goto('/');
  const row = page.locator('#cards .card.row-card', { hasText: 'ESPN' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Sale en TiviMate: responde');
  await expect(row.locator('.caido-chip')).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/sale-en-tivi-${info.project.name}-${scheme}.png` });
  }
});
