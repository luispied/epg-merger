// La vista «Por género» de Categorías: se cambia con el segmentado, arma las categorías de los canales con guía según
// su género (los sin guía quedan en la del proveedor), y vuelve tal como se dejó. Lo que cambia se guarda en el Worker.
import { expect, test } from '@playwright/test';
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

/** Lo último que la app guardó de la configuración. */
const lastSaved = (f: Fake) => f.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT').map((w) => w.body as Record<string, unknown>).at(-1);

test('cambia a «Por género» y vuelve a las del proveedor', async ({ page }) => {
  await page.locator('#categoriesBtn').click();
  const sheet = page.locator('#categoriesDialog');
  const row = (name: string) => sheet.locator('.cat-row', { hasText: name });
  await expect(sheet.locator('.cat-row .menu-text')).toHaveText([/^Deportes/, /^Noticias/, /^Infantiles/]);

  await sheet.getByRole('button', { name: 'Por género' }).click();
  await expect(sheet.getByRole('button', { name: 'Por género' })).toHaveAttribute('aria-pressed', 'true');
  // Solo categorías de género: CNN es Documental y ESPN, Deportes. Lo que no tiene género claro (o guía) va a «Generalistas y mixtos».
  await expect(sheet.locator('.cat-row .menu-text')).toHaveText([/^Deportes/, /^Documentales/, /^Generalistas y mixtos/]);
  await expect(row('Documentales').locator('small')).toHaveText('1 canal');
  await expect(row('Generalistas y mixtos').locator('small')).toHaveText('5 canales');
  await expect.poll(() => lastSaved(fake)?.view).toBe('genre');
  expect(lastSaved(fake)).toMatchObject({ channels: { CNN: { group: 'Documentales' } } });

  await sheet.getByRole('button', { name: 'Del proveedor' }).click();
  await expect(sheet.getByRole('button', { name: 'Del proveedor' })).toHaveAttribute('aria-pressed', 'true');
  await expect(row('Noticias').locator('small')).toHaveText('2 canales');
  await expect.poll(() => lastSaved(fake)).toHaveProperty('views.genre');
  expect(lastSaved(fake)?.view).toBeUndefined();
  expect(lastSaved(fake)?.channels).not.toHaveProperty('CNN.group');
});
