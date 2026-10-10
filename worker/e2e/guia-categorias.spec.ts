// Humo de las categorías de la Guía (ui/guide.tsx), sobre el modo ver para controlar canales y programación: elegir
// varias, que valgan en Grilla, Próximos y Tu noche y se recuerden; con muchas, las rápidas, «Más» y su hoja; y el
// aviso de Tu noche cuando lo elegido no alcanza.
import { expect, test, type Page } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Math.floor(Date.now() / 1000);
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');

const ch = (id: number, cat: string) => ({ id: String(id), name: `${cat} ${id}`, cat, epg: `g${String(id).padStart(13, '0')}.uy`, logo: '' });
// Diez categorías: Deportes tiene más canales con guía, después Películas; las demás, uno cada una.
const MANY = ['Deportes', 'Deportes', 'Deportes', 'Películas', 'Películas', 'Series', 'Noticias', 'Infantiles', 'Documentales',
  'Música', 'Novelas', 'Cultura', 'Argentina'].map((c, i) => ch(i + 1, c));
const FEW = ['Deportes', 'Noticias', 'Infantiles'].map((c, i) => ch(i + 1, c));

let errors: string[] = [];

async function open(page: Page, channels: ReturnType<typeof ch>[], prefs: Record<string, string> = {}) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('prefs')) return;
    sessionStorage.setItem('prefs', '1');
    for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
  }, prefs);
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels } });
    if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
    if (/^\/api\/ui\/schedule\/hour\/\d{10}\.json$/.test(path)) {
      return path.includes(hourKey(NOW)) ? r.fulfill({ json: { h: Math.floor(NOW / 3600) * 3600, t: [], c: {} } }) : r.fulfill({ status: 404, json: {} });
    }
    // Cada canal: un partido en el aire que termina en 40 minutos, y nada más.
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [[NOW - 600, NOW + 2400, 'Final del torneo']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide .gd-chips')).toBeVisible();
}

const chips = (page: Page) => page.locator('#guide .gd-chips');
const chip = (page: Page, name: string) => chips(page).getByRole('button', { name, exact: true });

test.beforeEach(() => { errors = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('con pocas categorías: elegir varias, en las tres formas, y se recuerdan', async ({ page }) => {
  await open(page, FEW);
  await expect(chips(page).getByRole('button')).toHaveText(['Todas', 'Deportes', 'Noticias', 'Infantiles']);
  await expect(chips(page).locator('.gd-more-chip')).toHaveCount(0);
  await chip(page, 'Deportes').click();
  await chip(page, 'Infantiles').click();
  await expect(chip(page, 'Deportes')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Infantiles')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Todas')).toHaveAttribute('aria-pressed', 'false');
  // Con dos elegidas, la grilla sigue con un encabezado por categoría.
  await expect(page.locator('#guide .gd-cat')).toHaveText(['Deportes', 'Infantiles']);
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(chip(page, 'Infantiles')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(chip(page, 'Deportes')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Infantiles')).toHaveAttribute('aria-pressed', 'true');
  await chip(page, 'Todas').click();
  await expect(chip(page, 'Deportes')).toHaveAttribute('aria-pressed', 'false');
});

test('con muchas: las rápidas, «Más» y la hoja con buscador', async ({ page }, info) => {
  await open(page, MANY);
  // Todas, las 5 con más canales con guía y «Más».
  await expect(chips(page).getByRole('button')).toHaveText(['Todas', 'Deportes', 'Películas', 'Series', 'Noticias', 'Infantiles', 'Más · 10']);
  await chip(page, 'Series').click();
  await expect(chips(page).getByRole('button')).toHaveText(['Todas', 'Series', 'Deportes', 'Películas', 'Noticias', 'Infantiles', 'Documentales', 'Más · 10']);
  await expect(chips(page).locator('.gd-chips-sep')).toHaveCount(1);
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-fila.png` });
  await chips(page).getByRole('button', { name: /^Más/ }).click();
  const sheet = page.locator('dialog.gc-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sec-title').first()).toHaveText('Elegidas · 1');
  await expect(sheet.locator('.gc-row', { hasText: 'Deportes' })).toContainText('3 canales');
  await sheet.getByRole('searchbox').fill('docu');
  await expect(sheet.locator('.gc-list').last().locator('.gc-row')).toHaveText([/Documentales/]);
  await sheet.locator('.gc-row', { hasText: 'Documentales' }).click();
  await sheet.getByRole('searchbox').fill('');
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-hoja.png` });
  await sheet.getByRole('button', { name: 'Listo · 2 elegidas' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(chip(page, 'Series')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Documentales')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#guide .gd-cat')).toHaveText(['Series', 'Documentales']);
});

test('Tu noche: con lo elegido no alcanza, lo dice y ofrece sumar una categoría', async ({ page }, info) => {
  await open(page, MANY, { grilla_guide_mode: 'plan', grilla_guide_cats: '["Cultura"]' });
  const gap = page.locator('#guide .gd-plan-gap');
  await expect(gap).toBeVisible();
  await expect(gap).toContainText('Con Cultura solo hay 1 programa');
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('lo mejor de Cultura');
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-noalcanza.png` });
  await gap.getByRole('button', { name: 'Sumar Deportes' }).click();
  await expect(chip(page, 'Deportes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('Cultura y Deportes');
  await gap.getByRole('button', { name: 'Elegir otras' }).click();
  await expect(page.locator('dialog.gc-sheet')).toBeVisible();
});
