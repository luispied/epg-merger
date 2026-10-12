// Humo de las categorías de la Guía (ui/guide.tsx), sobre el modo ver para controlar canales y programación: el botón de
// filtros y su hoja (la de Canales, ui/filtros.tsx), elegir varias, que valgan en Grilla, Próximos y Tu noche y se
// recuerden; y el aviso de Tu noche cuando lo elegido no alcanza.
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
    if (/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}\.json$/.test(path)) {
      return path.includes(hourKey(NOW)) ? r.fulfill({ json: { h: Math.floor(NOW / 3600) * 3600, t: [], c: {} } }) : r.fulfill({ status: 404, json: {} });
    }
    // Cada canal: un partido en el aire que termina en 40 minutos, y nada más.
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [[NOW - 600, NOW + 2400, 'Final del torneo']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide .filter-btn')).toBeVisible();
}

const btn = (page: Page) => page.locator('#guide .filter-btn');
const sheet = (page: Page) => page.locator('dialog.filter-sheet');
const active = (page: Page) => page.locator('#guide nav[aria-label="Filtros activos"]');
const opt = (page: Page, name: string) => sheet(page).getByRole('button', { name, exact: true });

test.beforeEach(() => { errors = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('la hoja ofrece las categorías en el orden de la lista; lo elegido queda en chips con su ×', async ({ page }, info) => {
  await open(page, FEW);
  // Sin filtros no hay fila de chips ni número en el botón.
  await expect(active(page)).toHaveCount(0);
  await expect(btn(page)).toHaveAccessibleName('Filtrar');
  await btn(page).click();
  await expect(sheet(page).locator('.sec-title')).toHaveText(['Categorías', 'Géneros']);
  await expect(sheet(page).locator('.filter-chips .chip-btn')).toHaveText(['Deportes1', 'Noticias1', 'Infantiles1']);
  await opt(page, 'Deportes 1').click();
  await opt(page, 'Infantiles 1').click();
  await expect(opt(page, 'Deportes 1')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-hoja.png` });
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(btn(page)).toHaveAccessibleName('Filtrar, 2 activos');
  await expect(active(page).getByRole('button')).toHaveText(['Deportes Quitar', 'Infantiles Quitar', 'Quitar todos']);
  // Con dos elegidas, la grilla sigue con un encabezado por categoría.
  await expect(page.locator('#guide .gd-cat')).toHaveText(['Deportes', 'Infantiles']);
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(active(page).getByRole('button', { name: /Infantiles/ })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Guía' }).click();
  await page.getByRole('radio', { name: 'Grilla' }).click();
  await expect(active(page).getByRole('button')).toHaveText(['Deportes Quitar', 'Infantiles Quitar', 'Quitar todos']);
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-chips.png` });
  await active(page).getByRole('button', { name: /^Deportes/ }).click();
  await expect(page.locator('#guide .gd-cat')).toHaveCount(0);
  await active(page).getByRole('button', { name: /^Infantiles/ }).click();
  await expect(active(page)).toHaveCount(0);
  await expect(btn(page)).toHaveAccessibleName('Filtrar');
});

test('Tu noche: con lo elegido no alcanza, lo dice y ofrece sumar una categoría', async ({ page }, info) => {
  await open(page, MANY, { grilla_guide_mode: 'plan', grilla_guide_cats: '["Cultura"]' });
  const gap = page.locator('#guide .gd-plan-gap');
  await expect(gap).toBeVisible();
  await expect(gap).toContainText('Con Cultura solo hay 1 programa');
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('lo mejor de Cultura');
  await page.screenshot({ path: `test-results/categorias-${info.project.name}-noalcanza.png` });
  await gap.getByRole('button', { name: 'Sumar Deportes' }).click();
  await expect(active(page).getByRole('button', { name: /^Deportes/ })).toBeVisible();
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('Cultura y Deportes');
  await gap.getByRole('button', { name: 'Elegir otras' }).click();
  await expect(sheet(page)).toBeVisible();
  // En Tu noche solo valen las categorías: la hoja no ofrece géneros.
  await expect(sheet(page).locator('.sec-title')).toHaveText(['Categorías']);
});
