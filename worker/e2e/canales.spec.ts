// Humo de la lista de Canales (ui/canales.tsx): las filas con su encabezado de categoría, la búsqueda (lista plana con
// la categoría de cada fila), el vacío con «Ver todos los canales», la vista detallada, el menú «…» y elegir varios.
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

const cards = (page: Page) => page.locator('#cards');
const row = (page: Page, ch: string) => cards(page).locator('.card', { hasText: ch }).first();
/** Lo último que la app mandó al Worker para un canal. */
const savedEdit = (f: Fake, ch: string) => f.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT')
  .map((w) => (w.body as { channels: Record<string, unknown> }).channels[ch]).at(-1);

/** Elige un estado en la hoja de filtros (el botón de filtros, el chip y «Listo»). */
async function pickState(page: Page, name: string) {
  await page.locator('.filter-btn').click();
  const sheet = page.locator('.filter-sheet');
  await sheet.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await sheet.getByRole('button', { name: 'Listo' }).click();
}

test('las filas con su categoría y su guía', async ({ page }) => {
  await expect(cards(page).locator('.cat-head')).toHaveText(['Deportes3', 'Noticias2', 'Infantiles2']);
  await expect(cards(page).locator('.card-name')).toHaveText(['ESPN', 'Fox Sports', 'TyC Sports', 'CNN', 'TN', 'Disney Channel', 'Cartoon Network']);
  await expect(row(page, 'ESPN').locator('.guide-name')).toHaveText('ESPN');
  await expect(row(page, 'ESPN').locator('.cc')).toHaveText('AR');
  await expect(row(page, 'ESPN')).toHaveAttribute('aria-label', 'ESPN, guía ESPN');
  await expect(row(page, 'Fox Sports').locator('.guide')).toHaveText('Sin guía asignada');
  await expect(row(page, 'Fox Sports').locator('.tag.bad')).toHaveText('Sin guía');
  await expect(row(page, 'ESPN').locator('.mono')).toHaveText('ES');
  await expect(cards(page).locator('.where')).toHaveCount(0);
});

test('filtrar por categoría: se elige en la hoja y se quita con su ×', async ({ page }) => {
  await page.locator('.filter-btn').click();
  const sheet = page.locator('.filter-sheet');
  await sheet.getByRole('button', { name: /^Noticias/ }).click();
  await sheet.getByRole('button', { name: 'Listo' }).click();
  await expect(cards(page).locator('.card-name')).toHaveText(['CNN', 'TN']);
  await expect(page.locator('.active-filters .chip-btn', { hasText: 'Noticias' })).toBeVisible();
  await expect(page.locator('.filter-btn')).toHaveAttribute('aria-label', 'Filtrar, 1 activo');
  await page.locator('.active-filters .chip-btn', { hasText: 'Noticias' }).click();
  await expect(cards(page).locator('.card-name')).toHaveCount(7);
  await expect(page.locator('.active-filters')).toBeHidden();
});

test('buscar, el vacío y ver todos', async ({ page }) => {
  const search = page.locator('#searchBox');
  await search.fill('sports');
  await expect(cards(page).locator('.card-name')).toHaveText(['Fox Sports', 'TyC Sports']);
  await expect(cards(page).locator('.cat-head')).toHaveCount(0);
  await expect(cards(page).locator('.where')).toHaveText(['Deportes', 'Deportes']);

  await search.fill('zzz');
  await expect(cards(page).locator('.empty')).toContainText('Nada coincide con “zzz”.');
  await cards(page).getByRole('button', { name: 'Ver todos los canales' }).click();
  await expect(search).toHaveValue('');
  await expect(cards(page).locator('.card')).toHaveCount(7);

  // Sin canales ocultos, el estado «Ocultos» no se ofrece en la hoja de filtros (#318).
  await page.locator('.filter-btn').click();
  await expect(page.locator('.filter-sheet').getByRole('button', { name: /^Ocultos/ })).toHaveCount(0);
  await page.locator('.filter-sheet').getByRole('button', { name: 'Listo' }).click();
  await expect(page.locator('.filter-btn')).toHaveAttribute('aria-label', 'Filtrar');
  await expect(cards(page).locator('.card')).toHaveCount(7);
});

test('buscar por el programa en el aire: todas las palabras y también la descripción', async ({ page }) => {
  // Lo que está dando ESPN ahora, en el índice de la hora y su descripción en el archivo aparte.
  await page.route(/\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}(-d)?\.json$/, (r) => {
    const h = Math.floor(Date.now() / 3_600_000) * 3600;
    return r.fulfill({ json: r.request().url().endsWith('-d.json')
      ? { d: ['Inter enfrenta a Parma. Desde el Stadio Giuseppe Meazza.'], c: { 'g00000000000001.ar': [[-30, 0]] } }
      : { h, t: ['Live: Fútbol Serie A · Inter de Milán vs. Parma'], c: { 'g00000000000001.ar': [[-30, 90, 0]] } } });
  });
  await page.reload(); // la hora ya se pidió al abrir (y quedó sin datos)
  await expect(page.locator('#cards .card').first()).toBeVisible();
  const search = page.locator('#searchBox');
  await search.fill('inter parma');
  await expect(cards(page).locator('.card-name')).toHaveText(['ESPN']);
  await search.fill('meazza');
  await expect(cards(page).locator('.card-name')).toHaveText(['ESPN']);
  await search.fill('juventus');
  await expect(cards(page).locator('.empty')).toBeVisible();
});

test('buscar por tema: «mundial» o «cocina» encuentran el programa en el aire aunque el título no lo diga', async ({ page }) => {
  const h = Math.floor(Date.now() / 3_600_000) * 3600;
  await page.route(/\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}(-d)?\.json$/, (r) => r.fulfill({ json: r.request().url().endsWith('-d.json')
    ? { d: [], c: {} }
    : { h, t: ['Uruguay vs. Brasil', 'Sabores de casa'], c: { 'g00000000000001.ar': [[-30, 90, 0]] } } }));
  let asked = 0;
  // El índice de temas (ui/schedule/topics.json): un solo pedido, recién al buscar.
  await page.route('**/api/ui/schedule/topics.json', (r) => {
    asked++;
    return r.fulfill({ json: { g: ['Deportes', 'Cocina'], v: ['mundial', 'fútbol', 'recetas'], t: ['sabores de casa', 'uruguay vs. brasil'], r: [[1, 2], [0, 0, 1]] } });
  });
  await page.reload();
  await expect(page.locator('#cards .card').first()).toBeVisible();
  expect(asked).toBe(0);
  const search = page.locator('#searchBox');
  await search.fill('mundial');
  await expect(cards(page).locator('.card-name')).toHaveText(['ESPN']);
  await search.fill('deportes fútbol'); // el género y los temas, todas las palabras
  await expect(cards(page).locator('.card-name')).toContainText(['ESPN']);
  await search.fill('cocina'); // el que da «Sabores de casa» no está en este perfil: nada coincide
  await expect(cards(page).locator('.empty')).toBeVisible();
  expect(asked).toBe(1);
});

test('vista detallada: lo que está dando ahora', async ({ page }) => {
  await expect(cards(page).locator('.row-now')).toHaveCount(0);
  await page.locator('#viewBtn').click();
  await expect(cards(page)).toHaveClass(/detail/);
  await expect(cards(page).locator('.row-now')).toHaveCount(2);
  await expect(row(page, 'ESPN').locator('.row-now .epg-now')).toHaveText('Sin programación en este horario');
});

test('ocultar desde el menú «…» y elegir varios', async ({ page }) => {
  const desk = test.info().project.name === 'escritorio';
  if (desk) {
    // El «…» de la fila es para el mouse; en el teléfono se desliza o se mantiene apretado.
    await row(page, 'TN').locator('.row-more').click();
    await page.locator('.row-menu').getByRole('menuitem', { name: 'Ocultar' }).click();
    await expect.poll(() => savedEdit(fake, 'TN')).toMatchObject({ hidden: true });
    await pickState(page, 'Ocultos');
    await expect(cards(page).locator('.card-name')).toHaveText(['TN']);
    await expect(row(page, 'TN')).toHaveClass(/is-hidden/);
    await expect(row(page, 'TN').locator('.mark')).toHaveText('oculto');
    await pickState(page, 'Todos');
    await row(page, 'CNN').locator('.row-more').click();
    await page.locator('.row-menu').getByRole('menuitem', { name: 'Seleccionar' }).click();
  } else {
    // El reloj de Playwright: el toque que sigue al mantener apretado no cuenta hasta que pasan 600 ms.
    await page.clock.install();
    await row(page, 'CNN').dispatchEvent('pointerdown', { button: 0, clientX: 50, clientY: 50 });
    await expect(page.locator('#bulkBar')).toBeVisible();
    await row(page, 'CNN').dispatchEvent('pointerup');
    await page.clock.runFor(700);
  }
  const n = desk ? 6 : 7;
  await expect(page.locator('#bulkBar')).toBeVisible();
  await expect(page.locator('#bulkCount')).toHaveText('1 seleccionado');
  await expect(cards(page).locator('.card.selected .card-name')).toHaveText(['CNN']);
  await expect(cards(page).locator('.sel-box')).toHaveCount(n);

  await row(page, 'ESPN').click();
  await expect(page.locator('#bulkCount')).toHaveText('2 seleccionados');
  await expect(cards(page).locator('.card.selected .card-name')).toHaveText(['ESPN', 'CNN']);
  await row(page, 'CNN').click();
  await expect(cards(page).locator('.card.selected .card-name')).toHaveText(['ESPN']);

  await page.locator('#bulkAll').click();
  await expect(cards(page).locator('.card.selected')).toHaveCount(n);
  await expect(page.locator('#bulkAll')).toHaveText('Ninguno');
  await page.locator('#bulkCancel').click();
  await expect(page.locator('#bulkBar')).toBeHidden();
  await expect(cards(page).locator('.sel-box')).toHaveCount(0);
});
