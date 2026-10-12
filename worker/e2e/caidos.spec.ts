// Canales caídos desde la página de la cuenta en uso (la fila «Canales caídos» de Perfil): qué dice el resultado de
// la última prueba, tocarla filtra la grilla, y «Probar ahora» lanza una prueba o avisa cuándo se puede volver a lanzar.
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

// Las 7 canales de la lista de prueba: ESPN es el 1. La prueba dejó a ESPN caído (dos fallos seguidos).
const health = (checked: string, channels: Record<string, unknown>) => ({ channels, total: 7, checked, relayOk: ago(0.2), tested: 2 });
const downRow = (page: Page) => page.locator('#downRow');

async function openAccount(page: Page) {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody .account-row').click();
  await expect(downRow(page)).toBeVisible();
}

test('la fila dice cuántos caen y, al tocarla, la grilla se filtra a los caídos', async ({ page }, info) => {
  await fakeWorker(page, { health: health(ago(26), { 1: { t: ago(26), ok: false, fails: 2 }, 2: { t: ago(26), ok: true, fails: 0 } }) });
  await openAccount(page);
  await expect(downRow(page)).toContainText('1 canal caído · 2 de 7 probados · ya se puede probar');
  await page.screenshot({ path: `test-results/caidos-${info.project.name}-fila.png` });
  await downRow(page).click();
  await expect(page.locator('#linksDialog')).toBeHidden();
  await expect(page.locator('.active-filters .chip-btn', { hasText: 'Caídos' })).toBeVisible();
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await expect(page.locator('#cards .card').first()).toContainText('ESPN');
});

test('«Probar ahora» lanza la prueba: la franja aparece arriba de la lista', async ({ page }) => {
  const fake: Fake = await fakeWorker(page, { health: health(ago(26), { 1: { t: ago(26), ok: false, fails: 2 } }) });
  await openAccount(page);
  await downRow(page).getByRole('button', { name: 'Probar ahora' }).click();
  await expect(page.locator('.toasts .toast')).toContainText('Prueba lanzada');
  await expect(page.locator('#probeStrip')).toBeVisible();
  expect(fake.writes.some((w) => w.method === 'POST' && w.path === '/api/cfg/c1/health/run')).toBe(true);
});

test('«Probar ahora» antes de la próxima prueba avisa cuándo se puede volver a lanzar y no pide nada', async ({ page }) => {
  const fake = await fakeWorker(page, { health: health(ago(1), { 1: { t: ago(1), ok: true, fails: 0 } }) });
  await openAccount(page);
  await expect(downRow(page)).toContainText(/próxima prueba en \d+ h/);
  await downRow(page).getByRole('button', { name: 'Probar ahora' }).click();
  await expect(page.locator('.toasts .toast')).toContainText(/se puede volver a lanzar en \d+ h/);
  expect(fake.writes.some((w) => w.path === '/api/cfg/c1/health/run')).toBe(false);
});

test('sin canales caídos, tocar la fila avisa en vez de filtrar', async ({ page }) => {
  await fakeWorker(page, { health: health(ago(26), { 1: { t: ago(26), ok: true, fails: 0 } }) });
  await openAccount(page);
  await expect(downRow(page)).toContainText('Ninguno caído · 1 de 7 probados');
  await downRow(page).click();
  await expect(page.locator('.toasts .toast')).toContainText('No hay canales caídos entre los que ya se probaron');
  await expect(page.locator('.active-filters .chip-btn', { hasText: 'Caídos' })).toHaveCount(0);
});
