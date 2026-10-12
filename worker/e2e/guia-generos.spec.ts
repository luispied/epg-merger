// Filtro por género de la Guía (ui/guide.tsx), probado en el modo ver (la Guía es el mismo componente en la edición):
// con el botón y la hoja de filtros de Canales (ui/filtros.tsx), las opciones salen de la programación a la vista, sin
// Publicidad ni «sin clasificar»; lo puesto queda en chips con su ×; en la Grilla apaga lo que no es del género y
// esconde los canales que no tienen nada de él, en Próximos lo saca y en Tu plan arma el plan solo con esos géneros;
// se combina con las categorías, se recuerda y es el mismo estado en las tres vistas.
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const NOW = Math.floor(Date.now() / 1000);
const file = (epg: string) => createHash('sha1').update(epg).digest('hex').slice(0, 16);

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

const ch = (id: number, cat: string) => ({ id: String(id), name: `${cat} ${id}`, cat, epg: `g${String(id).padStart(13, '0')}.uy`, logo: '' });
const CHANNELS = [ch(1, 'Deportes'), ch(2, 'Noticias'), ch(3, 'Compras')];
// Por hora: cada canal da dos programas de media hora. «g» va paralelo a «t» ('' = sin clasificar).
const TITLES = ['Cine de Barrio', 'Dibujos Locos', 'Peli de la tarde', 'Sin clasificar', 'Compre YA'];
const GENRES = ['Cine', 'Infantil', 'Cine', '', 'Publicidad'];
const ROWS = {
  [CHANNELS[0].epg]: [[0, 30, 0], [30, 60, 1]],
  [CHANNELS[1].epg]: [[0, 30, 2], [30, 60, 3]],
  [CHANNELS[2].epg]: [[0, 30, 4], [30, 60, 4]],
};

// La programación por canal (lo que arma Tu plan), con el género de cada programa; vacío = sin clasificar.
const SCHED: Record<string, (string | number)[][]> = {
  [file(CHANNELS[0].epg)]: [[NOW - 600, NOW + 1800, 'Cine de Barrio', '', 'Cine'], [NOW + 1800, NOW + 5400, 'Dibujos Locos', '', 'Infantil']],
  [file(CHANNELS[1].epg)]: [[NOW - 600, NOW + 1800, 'Sin clasificar'], [NOW + 1800, NOW + 5400, 'Peli de la tarde', '', 'Cine']],
  [file(CHANNELS[2].epg)]: [[NOW - 600, NOW + 5400, 'Compre YA', '', 'Publicidad']],
};

let errors: string[] = [];

/** Captura en claro y en oscuro (para revisar el diseño); no compara nada. */
async function shots(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, scheme);
    await page.screenshot({ path: `test-results/generos-${project}-${name}-${scheme}.png` });
  }
}

async function open(page: Page, prefs: Record<string, string> = {}) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('prefs')) return;
    sessionStorage.setItem('prefs', '1');
    for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
  }, prefs);
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels: CHANNELS } });
    if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
    const hour = /^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/(\d{4})(\d{2})(\d{2})(\d{2})\.json$/.exec(path);
    if (hour) {
      const h = Date.UTC(+hour[1], +hour[2] - 1, +hour[3], +hour[4]) / 1000;
      return r.fulfill({ json: { h, t: TITLES, g: GENRES, c: ROWS } });
    }
    const sched = /^\/api\/ui\/schedule\/([0-9a-f]{16})\.json$/.exec(path);
    if (sched) return r.fulfill({ json: SCHED[sched[1]] ?? [] });
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [] });
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
const options = (page: Page) => sheet(page).locator('.filter-chips').last().locator('.chip-btn');
/** Abre la hoja, alterna estos géneros y la cierra. */
async function pick(page: Page, ...names: string[]) {
  await btn(page).click();
  for (const n of names) await sheet(page).locator('.filter-chips').last().getByRole('button', { name: n, exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(sheet(page)).toHaveCount(0);
}

test.beforeEach(() => { errors = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('los chips salen de la programación, sin Publicidad ni sin clasificar; la Grilla apaga el resto y esconde los canales sin nada', async ({ page }, info) => {
  await open(page);
  await btn(page).click();
  await expect(sheet(page).locator('.sec-title')).toHaveText(['Categorías', 'Géneros']);
  await expect(options(page)).toHaveText(['Cine', 'Infantil']);
  await shots(page, 'hoja', info.project.name);
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(active(page)).toHaveCount(0);
  await expect(page.locator('#guide .gd-cell.off')).toHaveCount(0);
  await pick(page, 'Cine');
  await expect(active(page).getByRole('button')).toHaveText(['Cine Quitar']);
  await expect(btn(page)).toHaveAccessibleName('Filtrar, 1 activo');
  // Los que no son de cine (infantil, sin clasificar, publicidad) quedan apagados; los de cine, no.
  await expect(page.locator('#guide .gd-cell.off').first()).toBeVisible();
  const on = page.locator('#guide .gd-row .gd-cell:not(.off):not(.skel)');
  await expect(on.first()).toBeVisible();
  for (const label of await on.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) expect(label).toMatch(/Cine de Barrio|Peli de la tarde/);
  for (const label of await page.locator('#guide .gd-cell.off').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) {
    expect(label).not.toMatch(/Cine de Barrio|Peli de la tarde/);
  }
  // Compras solo tiene publicidad: su fila no se muestra; las otras dos sí.
  await expect(page.locator('#guide .gd-row')).toHaveCount(2);
  await expect(page.locator('#guide .gd-row .nm')).toHaveText(['Deportes 1', 'Noticias 2']);
  await shots(page, 'grilla', info.project.name);
  await active(page).getByRole('button', { name: /^Cine/ }).click();
  await expect(page.locator('#guide .gd-cell.off')).toHaveCount(0);
  await expect(page.locator('#guide .gd-row')).toHaveCount(3);
  // Infantil solo está en un canal.
  await pick(page, 'Infantil');
  await expect(page.locator('#guide .gd-row .nm')).toHaveText(['Deportes 1']);
});

test('Grilla: si ningún canal tiene el género, lo dice y se quitan los filtros', async ({ page }, info) => {
  await open(page, { grilla_guide_genres: '["Deportes en vivo"]' });
  const empty = page.locator('#guide .empty');
  await expect(empty).toContainText('Ningún canal tiene deportes en vivo ahora');
  await expect(page.locator('#guide .gd-row')).toHaveCount(0);
  await shots(page, 'grilla-vacia', info.project.name);
  await empty.getByRole('button', { name: 'Quitar filtros' }).click();
  await expect(empty).toHaveCount(0);
  await expect(page.locator('#guide .gd-row')).toHaveCount(3);
  await expect(active(page)).toHaveCount(0);
});

test('Próximos: solo lo del género; combina con las categorías; se recuerda', async ({ page }, info) => {
  await open(page);
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await btn(page).click();
  await expect(options(page)).toHaveText(['Cine', 'Infantil']);
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  const titles = page.locator('#guide .gd-up-row .tt');
  await expect(titles.filter({ hasText: 'Sin clasificar' }).first()).toBeVisible();
  await pick(page, 'Infantil');
  await expect(titles.first()).toHaveText('Dibujos Locos');
  await expect(titles.filter({ hasText: /Sin clasificar|Cine de Barrio|Compre/ })).toHaveCount(0);
  await shots(page, 'proximos', info.project.name);
  // Con dos géneros entran los dos.
  await pick(page, 'Cine');
  await expect(titles.filter({ hasText: 'Dibujos Locos' }).first()).toBeVisible();
  await expect(titles.filter({ hasText: /Cine de Barrio|Peli de la tarde/ }).first()).toBeVisible();
  // Combinado con una categoría: solo los canales de esa categoría.
  await btn(page).click();
  await sheet(page).getByRole('button', { name: /^Noticias/ }).click();
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(titles.filter({ hasText: 'Dibujos Locos' })).toHaveCount(0);
  await expect(titles.filter({ hasText: 'Peli de la tarde' }).first()).toBeVisible();
  // Se recuerda en este navegador, aparte de los filtros de Canales.
  expect(await page.evaluate(() => localStorage.getItem('grilla_guide_genres'))).toBe('["Infantil","Cine"]');
  await page.reload();
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(active(page).getByRole('button')).toHaveText([' Tengo tiempo', 'Noticias Quitar', 'Infantil Quitar', 'Cine Quitar', 'Quitar todos']);
  await shots(page, 'chips', info.project.name);
});

test('un género elegido sin nada en esas horas se puede sacar', async ({ page }) => {
  await open(page, { grilla_guide_genres: '["Deportes en vivo","Publicidad"]', grilla_guide_mode: 'next' });
  // Publicidad nunca es un filtro; el otro no está en la programación pero se ve para poder sacarlo.
  await btn(page).click();
  await expect(options(page)).toHaveText(['Cine', 'Deportes en vivo', 'Infantil']);
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await expect(btn(page)).toHaveAccessibleName('Filtrar, 1 activo');
  await expect(page.locator('#guide .gd-up-empty')).toContainText('Nada de deportes en vivo empieza');
  await active(page).getByRole('button', { name: /^Deportes en vivo/ }).click();
  await expect(page.locator('#guide .gd-up-row').first()).toBeVisible();
});

test('Tu plan: la hoja ofrece los géneros del plan y arma el plan solo con ellos; es el mismo estado de la Guía', async ({ page }, info) => {
  await open(page, { grilla_guide_mode: 'plan' });
  const slots = page.locator('#guide .gd-plan-slot .tt');
  await expect(slots.first()).toBeVisible();
  // Sin filtro entra todo (también lo sin clasificar); la hoja ofrece Cine e Infantil, sin Publicidad ni sin clasificar.
  await expect(btn(page)).toHaveAccessibleName('Filtrar');
  await btn(page).click();
  await expect(sheet(page).locator('.sec-title')).toHaveText(['Categorías', 'Géneros']);
  await expect(options(page)).toHaveText(['Cine', 'Infantil']);
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await pick(page, 'Infantil');
  await expect(btn(page)).toHaveAccessibleName('Filtrar, 1 activo');
  await expect(active(page).getByRole('button')).toHaveText(['Infantil Quitar']);
  await expect(slots).toHaveText(['Dibujos Locos']);
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('solo de infantil');
  expect(await page.evaluate(() => localStorage.getItem('grilla_guide_genres'))).toBe('["Infantil"]');
  await shots(page, 'plan', info.project.name);
  // Con dos géneros entran los dos; sin clasificar y publicidad, nunca.
  await pick(page, 'Cine');
  await expect(slots.filter({ hasText: /Cine de Barrio|Peli de la tarde/ }).first()).toBeVisible();
  await expect(slots.filter({ hasText: /Sin clasificar|Compre/ })).toHaveCount(0);
  // El mismo filtro vale en la Grilla: vuelve a la Grilla con él.
  await page.getByRole('button', { name: 'Volver a Grilla' }).click();
  await expect(active(page).getByRole('button')).toHaveText(['Infantil Quitar', 'Cine Quitar', 'Quitar todos']);
});

test('Tu plan: si el género elegido no tiene nada en el rato, lo dice y «Quitar filtro» lo saca', async ({ page }, info) => {
  await open(page, { grilla_guide_mode: 'plan', grilla_guide_genres: '["Deportes en vivo"]' });
  const gap = page.locator('#guide .gd-plan-gap');
  await expect(gap).toContainText('no hay programas');
  await expect(gap).toContainText('deportes en vivo');
  // El elegido sin datos sigue en la hoja para poder sacarlo.
  await btn(page).click();
  await expect(options(page)).toHaveText(['Cine', 'Deportes en vivo', 'Infantil']);
  await sheet(page).getByRole('button', { name: 'Listo' }).click();
  await shots(page, 'plan-vacio', info.project.name);
  await gap.getByRole('button', { name: 'Quitar filtro' }).click();
  await expect(gap).toHaveCount(0);
  await expect(page.locator('#guide .gd-plan-slot').first()).toBeVisible();
  await expect(active(page)).toHaveCount(0);
});
