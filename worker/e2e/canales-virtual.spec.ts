// La lista de Canales se virtualiza (ui/canales.tsx): con cientos de canales solo se pintan los que entran en pantalla,
// el encabezado de categoría queda pegado al bajar, y bajar hasta el final carga más sin dejar de pintar poco.
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;
const EXTRA = Array.from({ length: 400 }, (_, i) => [`Extra ${String(i).padStart(3, '0')}`, `Grupo ${Math.floor(i / 50)}`]);

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  fake = await fakeWorker(page, { extra: EXTRA });
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const cards = (page: Page) => page.locator('#cards');
const row = (page: Page, ch: string) => cards(page).locator('.card', { hasText: ch }).first();
/** Pinta filas: pocas, porque solo entran las que se ven (la lista de la prueba tiene 400 canales). */
const painted = (page: Page) => cards(page).locator('.card').count();

/** Carga toda la lista bajando: el centinela trae más canales hasta que no queda ninguno. */
async function loadAll(page: Page) {
  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    return page.locator('#loadMoreSentinel').isHidden();
  }).toBe(true);
}

/** Baja de a poco desde arriba hasta que la fila se pinta, y la deja a 300 px del borde de arriba. */
async function scrollToRow(page: Page, ch: string) {
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let k = 0; k < 400 && !(await row(page, ch).count()); k++) {
    await page.evaluate(() => window.scrollBy(0, 300));
    await frames();
  }
  const y = await row(page, ch).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((top) => window.scrollTo(0, top - 300), y);
  await frames();
}

test('solo se pintan las filas que se ven, y al final carga más', async ({ page }) => {
  expect(await painted(page)).toBeLessThan(60);
  // Bajar hasta el final: el centinela trae más canales, y la lista sigue pintando solo lo que se ve.
  await loadAll(page);
  await expect(row(page, 'Extra 399')).toBeVisible();
  expect(await painted(page)).toBeLessThan(60);
  // Subir de nuevo: las primeras filas y su encabezado vuelven.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(row(page, 'Extra 000')).toBeVisible();
  await expect(cards(page).locator('.cat-head', { hasText: 'Grupo 0' })).toHaveCount(1);
});

test('el encabezado de la categoría queda pegado al bajar por el medio de un grupo', async ({ page }) => {
  // Extra 175 está en «Grupo 3» (que empieza en Extra 150): el encabezado no está en pantalla al bajar hasta ahí.
  await loadAll(page);
  await scrollToRow(page, 'Extra 175');
  await expect(row(page, 'Extra 175')).toBeVisible();
  const head = cards(page).locator('.cat-head', { hasText: 'Grupo 3' });
  await expect(head).toHaveCount(1);
  const box = await head.boundingBox();
  expect(box!.y).toBeLessThan(200);
});

test('ocultar una fila que se ve: la de abajo sube a su lugar y la lista sigue pintando poco', async ({ page }) => {
  test.skip(test.info().project.name !== 'escritorio', 'el «…» de la fila es para el mouse');
  await loadAll(page);
  await scrollToRow(page, 'Extra 020');
  await expect(row(page, 'Extra 020')).toBeVisible();
  const before = await row(page, 'Extra 020').boundingBox();
  await row(page, 'Extra 020').locator('.row-more').click();
  await page.locator('.row-menu').getByRole('menuitem', { name: 'Ocultar' }).click();
  await expect.poll(() => fake.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT').length).toBeGreaterThan(0);
  // «Todos» no muestra los ocultos: la fila sale y la siguiente ocupa su lugar, sin saltos.
  await expect(row(page, 'Extra 020')).toHaveCount(0);
  const after = await row(page, 'Extra 021').boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(10);
  expect(await painted(page)).toBeLessThan(60);
});
