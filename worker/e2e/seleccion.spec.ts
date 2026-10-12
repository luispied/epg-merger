// Humo de la hoja de la selección (ui/seleccion.tsx) y de la programación del día en la hoja del canal (ui/epg.tsx):
// elegir una guía para varios, moverlos de categoría, ocultarlos y «Ver programación de hoy».
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

const row = (page: Page, ch: string) => page.locator('#cards .card', { hasText: ch }).first();
const sheet = (page: Page) => page.locator('#bulkDialog');
const savedEdit = (f: Fake, ch: string) => f.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT')
  .map((w) => (w.body as { channels: Record<string, unknown> }).channels[ch]).at(-1);

/** Mantener apretado Fox Sports y tocar TyC Sports: dos seleccionados; abre la hoja. */
async function selectTwo(page: Page) {
  // El reloj de Playwright: el toque que sigue al mantener apretado no cuenta hasta que pasan 600 ms.
  await page.clock.install();
  await row(page, 'Fox Sports').dispatchEvent('pointerdown', { button: 0, clientX: 50, clientY: 50 });
  await expect(page.locator('#bulkBar')).toBeVisible();
  await row(page, 'Fox Sports').dispatchEvent('pointerup');
  await page.clock.runFor(700);
  await row(page, 'TyC Sports').click();
  await expect(page.locator('#bulkCount')).toHaveText('2 seleccionados');
  await page.locator('#bulkActions').click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator('#bulkTitle')).toHaveText('2 seleccionados');
}

test('buscar una guía para varios', async ({ page }) => {
  await selectTwo(page);
  await expect(sheet(page).locator('.sec-title').first()).toHaveText('Guía para los 2');
  await sheet(page).getByRole('searchbox', { name: 'Buscar una guía para todos' }).fill('rural');
  const result = sheet(page).locator('.search-results [data-pick]', { hasText: 'Canal Rural' });
  await expect(sheet(page).locator('.search-results .list-note').first()).toHaveText('Programación por hora no disponible: se carga canal por canal.');
  await result.click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator('.toast .msg').last()).toContainText('Guía elegida para 2 canales');
  await expect(page.locator('#bulkBar')).toBeHidden();
  await expect(row(page, 'Fox Sports').locator('.guide-name')).toHaveText('Canal Rural');
  await expect.poll(() => savedEdit(fake, 'TyC Sports')).toMatchObject({ epg: 'g00000000000003.ar', manual: true });
});

test('mover de categoría y ocultar varios', async ({ page }) => {
  await selectTwo(page);
  const move = sheet(page).getByRole('button', { name: 'Mover' });
  await expect(move).toBeDisabled();
  await sheet(page).locator('select.bulk-cat').selectOption('Noticias');
  await move.click();
  await expect(page.locator('.toast .msg').last()).toContainText('2 canales movidos a Noticias');
  await expect.poll(() => savedEdit(fake, 'Fox Sports')).toMatchObject({ group: 'Noticias' });

  await selectTwo(page);
  await expect(sheet(page).locator('.menu-row .menu-text')).toHaveText(['Ocultar de la playlist', 'Volver a las categorías originales']);
  await sheet(page).getByRole('button', { name: 'Ocultar de la playlist' }).click();
  await expect(page.locator('.toast .msg').last()).toContainText('2 canales ocultos de la playlist');
  await expect.poll(() => savedEdit(fake, 'TyC Sports')).toMatchObject({ hidden: true });
});

test('la programación del día en la hoja del canal', async ({ page }) => {
  await row(page, 'ESPN').click();
  const dlg = page.locator('#channelDialog');
  await expect(dlg.locator('.gc-now')).toHaveText('Sin programación en este horario');
  const day = dlg.getByRole('button', { name: 'Ver programación de hoy' });
  await expect(day).toHaveAttribute('aria-expanded', 'false');
  await day.click();
  await expect(day).toHaveAttribute('aria-expanded', 'true');
  await expect(dlg.locator('.day-list')).toHaveText('La guía no trae programación para las próximas horas.');
  await day.click();
  await expect(dlg.locator('.day-list')).toBeHidden();
});
