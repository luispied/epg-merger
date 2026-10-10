// Humo de Categorías (ui/categorias.tsx): la lista y su buscador, mover con el teclado, la hoja de una categoría
// (ocultar, renombrar) y ordenar sus canales. Lo que se cambia se guarda en el Worker.
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

const sheet = (page: Page) => page.locator('#categoriesDialog');
const rows = (page: Page) => sheet(page).locator('.cat-row');
async function openCategories(page: Page) {
  await page.locator('#categoriesBtn').click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator('#categoriesTitle')).toHaveText('Categorías');
}
/** El último orden de categorías que la app mandó al Worker. */
const savedOrder = (f: Fake) => f.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT')
  .map((w) => (w.body as { groups: { order: string[] } }).groups.order).at(-1);

test('la lista, el buscador y mover con el teclado', async ({ page }) => {
  await openCategories(page);
  await expect(sheet(page).locator('.meta-line')).toHaveText('3 categorías');
  await expect(rows(page).locator('.menu-text')).toHaveText([/^Deportes3 canales/, /^Noticias2 canales/, /^Infantiles2 canales/]);

  const search = sheet(page).getByPlaceholder('Buscar categoría');
  await search.fill('noti');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator('.drag-handle')).toHaveCount(0);
  await search.fill('zzz');
  await expect(sheet(page).locator('#categoriesList')).toHaveText('Ninguna categoría coincide.');
  await search.fill('');
  await expect(rows(page)).toHaveCount(3);

  // Flecha arriba sobre la manija: Noticias pasa primera y el foco la sigue.
  await rows(page).nth(1).locator('.drag-handle').focus();
  await page.keyboard.press('ArrowUp');
  await expect(rows(page).locator('.menu-text')).toHaveText([/^Noticias/, /^Deportes/, /^Infantiles/]);
  await expect(rows(page).nth(0).locator('.drag-handle')).toBeFocused();
  await expect.poll(() => savedOrder(fake)).toEqual(['Noticias', 'Deportes', 'Infantiles']);

  // Arrastrar Infantiles desde su manija hasta arriba de todo (con mouse: en el iPhone emulado el mouse no arrastra).
  if (test.info().project.name !== 'escritorio') return;
  const handle = rows(page).nth(2).locator('.drag-handle');
  const from = (await handle.boundingBox())!;
  const top = (await rows(page).nth(0).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect(rows(page).locator('.menu-text')).toHaveText([/^Infantiles/, /^Noticias/, /^Deportes/]);
  await expect.poll(() => savedOrder(fake)).toEqual(['Infantiles', 'Noticias', 'Deportes']);
});

test('la hoja de una categoría: ocultar y renombrar', async ({ page }) => {
  await openCategories(page);
  await rows(page).filter({ hasText: 'Infantiles' }).click();
  const menu = page.locator('#catMenuDialog');
  await expect(menu).toBeVisible();
  await expect(page.locator('#catMenuName')).toHaveValue('Infantiles');
  await expect(menu.locator('.ch-meta')).toHaveText('2 canales');
  await expect(menu.getByRole('button', { name: 'Categoría siguiente' })).toBeDisabled();

  await menu.locator('.opt-row', { hasText: 'Visible en la playlist' }).getByRole('switch').uncheck();
  await expect(menu.locator('.opt-row', { hasText: 'Visible en la playlist' }).getByRole('switch')).not.toBeChecked();
  await expect(rows(page).filter({ hasText: 'Infantiles' })).toHaveClass(/is-off/);

  await page.locator('#catMenuName').fill('Chicos');
  await page.locator('#catMenuName').press('Enter');
  await expect(page.locator('#catMenuName')).toHaveValue('Chicos');
  await expect(menu.locator('.ch-meta')).toHaveText('2 canales · en el proveedor: Infantiles');
  await menu.locator('summary', { hasText: 'Más opciones' }).click();
  await menu.getByRole('button', { name: 'Volver al nombre original' }).click();
  await expect(menu).toBeHidden();
  await expect(rows(page).nth(2).locator('.menu-text')).toHaveText(/^Infantiles/);

  // ‹ en la segunda categoría lleva a la primera.
  await rows(page).nth(1).click();
  await expect(page.locator('#catMenuName')).toHaveValue('Noticias');
  await menu.getByRole('button', { name: 'Categoría anterior' }).click();
  await expect(page.locator('#catMenuName')).toHaveValue('Deportes');
});

test('ordenar los canales de una categoría', async ({ page }) => {
  await openCategories(page);
  await rows(page).filter({ hasText: 'Deportes' }).click();
  await page.locator('#catMenuDialog').getByRole('button', { name: 'Ordenar los canales' }).click();
  const order = page.locator('#orderDialog');
  await expect(order).toBeVisible();
  await expect(page.locator('#orderTitle')).toHaveText('Deportes');
  const names = order.locator('.ord-row .menu-text');
  await expect(names).toHaveText(['ESPN', 'Fox Sports', 'TyC Sports']);
  await expect(order.getByRole('button', { name: 'Volver al orden del proveedor' })).toHaveCount(0);

  await order.locator('.ord-row').first().locator('.drag-handle').focus();
  await page.keyboard.press('ArrowDown');
  await expect(names).toHaveText(['Fox Sports', 'ESPN', 'TyC Sports']);
  await expect(order.locator('.ord-row').nth(1).locator('.drag-handle')).toBeFocused();

  await order.getByRole('button', { name: 'Volver al orden del proveedor' }).click();
  await expect(names).toHaveText(['ESPN', 'Fox Sports', 'TyC Sports']);

  // «‹» vuelve a la hoja de la categoría.
  await order.getByRole('button', { name: 'Volver' }).click();
  await expect(order).toBeHidden();
  await expect(page.locator('#catMenuName')).toHaveValue('Deportes');
});
