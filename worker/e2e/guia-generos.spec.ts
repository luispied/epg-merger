// Filtro por género de la Guía (ui/guide.tsx), probado en el modo ver (la Guía es el mismo componente en la edición):
// los chips salen de la programación a la vista, sin Publicidad ni «sin clasificar»; en la Grilla apaga lo que no es del
// género y en Próximos lo saca; se combina con las categorías, se recuerda y es de la Guía.
import { expect, test, type Page } from '@playwright/test';

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
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide nav[aria-label="Categorías"]')).toBeVisible();
}

const genres = (page: Page) => page.locator('#guide nav[aria-label="Géneros"]');
const genre = (page: Page, name: string) => genres(page).getByRole('button', { name, exact: true });
const cats = (page: Page) => page.locator('#guide nav[aria-label="Categorías"]');

test.beforeEach(() => { errors = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('los chips salen de la programación, sin Publicidad ni sin clasificar; la Grilla apaga el resto', async ({ page }, info) => {
  await open(page);
  await expect(genres(page).getByRole('button')).toHaveText(['Todos', 'Cine', 'Infantil']);
  await expect(genre(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#guide .gd-cell.off')).toHaveCount(0);
  await genre(page, 'Cine').click();
  await expect(genre(page, 'Cine')).toHaveAttribute('aria-pressed', 'true');
  await expect(genre(page, 'Todos')).toHaveAttribute('aria-pressed', 'false');
  // Los que no son de cine (infantil, sin clasificar, publicidad) quedan apagados; los de cine, no.
  await expect(page.locator('#guide .gd-cell.off').first()).toBeVisible();
  const on = page.locator('#guide .gd-row .gd-cell:not(.off):not(.skel)');
  await expect(on.first()).toBeVisible();
  for (const label of await on.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) expect(label).toMatch(/Cine de Barrio|Peli de la tarde/);
  for (const label of await page.locator('#guide .gd-cell.off').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) {
    expect(label).not.toMatch(/Cine de Barrio|Peli de la tarde/);
  }
  await shots(page, 'grilla', info.project.name);
  await genre(page, 'Todos').click();
  await expect(page.locator('#guide .gd-cell.off')).toHaveCount(0);
});

test('Próximos: solo lo del género; combina con las categorías; se recuerda', async ({ page }, info) => {
  await open(page);
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(genres(page).getByRole('button')).toHaveText(['Todos', 'Cine', 'Infantil']);
  const titles = page.locator('#guide .gd-up-row .tt');
  await expect(titles.filter({ hasText: 'Sin clasificar' }).first()).toBeVisible();
  await genre(page, 'Infantil').click();
  await expect(titles.first()).toHaveText('Dibujos Locos');
  await expect(titles.filter({ hasText: /Sin clasificar|Cine de Barrio|Compre/ })).toHaveCount(0);
  await shots(page, 'proximos', info.project.name);
  // Con dos géneros entran los dos.
  await genre(page, 'Cine').click();
  await expect(titles.filter({ hasText: 'Dibujos Locos' }).first()).toBeVisible();
  await expect(titles.filter({ hasText: /Cine de Barrio|Peli de la tarde/ }).first()).toBeVisible();
  // Combinado con una categoría: solo los canales de esa categoría.
  await cats(page).getByRole('button', { name: 'Noticias', exact: true }).click();
  await expect(titles.filter({ hasText: 'Dibujos Locos' })).toHaveCount(0);
  await expect(titles.filter({ hasText: 'Peli de la tarde' }).first()).toBeVisible();
  // Se recuerda en este navegador, aparte de los filtros de Canales.
  expect(await page.evaluate(() => localStorage.getItem('grilla_guide_genres'))).toBe('["Infantil","Cine"]');
  await page.reload();
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(genre(page, 'Infantil')).toHaveAttribute('aria-pressed', 'true');
  await expect(genre(page, 'Cine')).toHaveAttribute('aria-pressed', 'true');
});

test('un género elegido sin nada en esas horas se puede sacar; Tu noche no lleva géneros', async ({ page }) => {
  await open(page, { grilla_guide_genres: '["Deportes en vivo","Publicidad"]', grilla_guide_mode: 'next' });
  // Publicidad nunca es un filtro; el otro no está en la programación pero se ve para poder sacarlo.
  await expect(genres(page).getByRole('button')).toHaveText(['Todos', 'Cine', 'Deportes en vivo', 'Infantil']);
  await expect(page.locator('#guide .gd-up-empty')).toContainText('Nada de deportes en vivo empieza');
  await genre(page, 'Deportes en vivo').click();
  await expect(page.locator('#guide .gd-up-row').first()).toBeVisible();
  await page.getByRole('button', { name: /armada para vos/ }).click();
  await expect(page.locator('#guide .gd-plan')).toBeVisible();
  await expect(genres(page)).toHaveCount(0);
});
