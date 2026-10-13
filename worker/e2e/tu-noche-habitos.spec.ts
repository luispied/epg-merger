// Tu noche aprende lo que se mira (ui/guide.tsx + habits.ts del Worker), sobre el modo ver: lo de siempre sube al
// plan con el porqué, y «No me interesa» lo saca al momento (y se puede deshacer).
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Math.floor(Date.now() / 1000);
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const file = (epg: string) => createHash('sha1').update(epg).digest('hex').slice(0, 16);

const CHANNELS = [
  { id: '1', name: 'Deportes 1', cat: 'Deportes', epg: 'g00000000000001.uy', logo: '' },
  { id: '2', name: 'Infantil 2', cat: 'Infantiles', epg: 'g00000000000002.uy', logo: '' },
];
// Los dos en el aire hasta dentro de 40 minutos: sin hábitos gana el partido en vivo.
const SCHED: Record<string, string> = { [file(CHANNELS[0].epg)]: 'Final del torneo en vivo', [file(CHANNELS[1].epg)]: 'Dibujitos' };
const hours = Array(24).fill(0) as number[];
hours[new Date((NOW - 600) * 1000).getUTCHours()] = 4;
// El género que la corrida le puso a cada programa (la IA), por archivo del canal; vacío = sin clasificar.
let genres: Record<string, string> = {};
const HABITS = { ch: { [CHANNELS[1].epg]: { n: 6, h: hours } }, t: { dibujitos: { n: 5 } } as Record<string, { n: number; g?: string }>, no: {} as Record<string, string>, more: {}, ng: {} as Record<string, string> };

let errors: string[] = [];
let posts: { title: string; kind: string; genre?: string }[] = [];

async function open(page: Page, habits: typeof HABITS | null) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('grilla_guide_mode', 'plan'));
  let h = habits && structuredClone(habits);
  await page.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels: CHANNELS } });
    if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
    if (path === `/api/view/${CODE}/habits`) {
      if (!h) return r.fulfill({ status: 404, json: {} });
      if (r.request().method() === 'POST') {
        const body = r.request().postDataJSON() as { title: string; kind: string; genre?: string };
        posts.push(body);
        const k = body.title.toLowerCase();
        delete h.no[k];
        delete h.more[k];
        if (body.kind === 'no' || body.kind === 'more') h[body.kind === 'no' ? 'no' : 'more'][k] = new Date().toISOString();
        if (body.kind === 'no' && body.genre) h.ng[k] = body.genre;
        // Tres «No me interesa» seguidos del mismo género: el Worker apaga ese género y lo avisa (push.ts).
        const streak = body.kind === 'no' && body.genre && Object.values(h.ng).filter((g) => g === body.genre).length >= 3;
        return r.fulfill({ json: streak ? { ...h, autoOff: body.genre } : h });
      }
      return r.fulfill({ json: h });
    }
    if (/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}\.json$/.test(path)) {
      return path.includes(hourKey(NOW)) ? r.fulfill({ json: { h: Math.floor(NOW / 3600) * 3600, t: [], c: {} } }) : r.fulfill({ status: 404, json: {} });
    }
    const m = /^\/api\/ui\/schedule\/([0-9a-f]{16})\.json$/.exec(path);
    if (m) return r.fulfill({ json: [genres[m[1]] ? [NOW - 600, NOW + 2400, SCHED[m[1]] ?? 'Otra cosa', '', genres[m[1]]] : [NOW - 600, NOW + 2400, SCHED[m[1]] ?? 'Otra cosa']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
}

const first = (page: Page) => page.locator('#guide .gd-plan-list > li').first();

test.beforeEach(() => { errors = []; posts = []; genres = {}; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('sin hábitos, lo mejor de los canales y ningún porqué', async ({ page }) => {
  await open(page, null);
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(page.locator('#guide .gd-plan-why')).toHaveCount(0);
  await expect(page.locator('#guide .gd-plan-lead')).not.toContainText('solés mirar');
});

test('con hábitos sube lo de siempre con el porqué, y «No me interesa» lo saca y se deshace', async ({ page }, info) => {
  await open(page, HABITS);
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('lo que solés mirar');
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Dibujitos');
  await expect(first(page).locator('.gd-plan-why')).toHaveText('Lo mirás seguido');
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-plan.png` });
  await first(page).locator('.gd-plan-card').click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.toast')).toContainText('no te lo sugiero más');
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-hoja.png` });
  expect(posts).toEqual([{ title: 'Dibujitos', kind: 'no' }]);
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await sheet.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(page.locator('#guide .gd-plan-list')).not.toContainText('Dibujitos');
  // Otra vez en la hoja del partido: tocar «No me interesa» dos veces lo deja como estaba.
  await first(page).locator('.gd-plan-card').click();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'false');
  expect(posts.slice(1).map((p) => p.kind)).toEqual(['no', 'clear']);
});

test('tres «No me interesa» seguidos del mismo género: se apaga ese género y se dice', async ({ page }, info) => {
  genres = { [file(CHANNELS[1].epg)]: 'Infantil' };
  const antes = new Date(Date.now() - 3_600_000).toISOString();
  await open(page, { ...HABITS, no: { 'serie a': antes, 'serie b': antes }, ng: { 'serie a': 'Infantil', 'serie b': 'Infantil' } });
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Dibujitos');
  await first(page).locator('.gd-plan-card').click();
  const sheet = page.locator('dialog.gd-sheet');
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.locator('.toast')).toContainText('Ya van tres «No me interesa» seguidos de infantiles: no se avisan más en este perfil.');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-corte-claro.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-corte-oscuro.png` });
  expect(posts).toEqual([{ title: 'Dibujitos', kind: 'no', genre: 'Infantil' }]);
});

test('la publicidad que la IA reconoce no se sugiere', async ({ page }) => {
  genres = { [file(CHANNELS[0].epg)]: 'Publicidad' };
  await open(page, null);
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Dibujitos');
  await expect(page.locator('#guide .gd-plan-list')).not.toContainText('Final del torneo en vivo');
});

test('el género de lo que se mira sube programas parecidos, con el porqué', async ({ page }, info) => {
  genres = { [file(CHANNELS[0].epg)]: 'Deportes', [file(CHANNELS[1].epg)]: 'Infantil' };
  // Se miró deporte tres veces (otros programas, ya sin emitir): no hay hábito de este canal ni de este título.
  await open(page, { ch: {}, t: { 'otro partido': { n: 3, g: 'Deportes' }, 'una peli': { n: 1, g: 'Película' } }, no: {}, more: {} });
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(first(page).locator('.gd-plan-why')).toHaveText('Como lo que mirás: deportes');
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-genero-claro.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-genero-oscuro.png` });
});

test('sin géneros en la guía, el plan sale como antes', async ({ page }) => {
  await open(page, { ch: {}, t: { 'otro partido': { n: 3, g: 'Deportes' } }, no: {}, more: {} });
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(page.locator('#guide .gd-plan-why')).toHaveCount(0);
});

test('«Más como esto» en un programa sube todo su género, y lo dice debajo', async ({ page }, info) => {
  genres = { [file(CHANNELS[0].epg)]: 'Deportes', [file(CHANNELS[1].epg)]: 'Infantil' };
  await open(page, HABITS);
  await first(page).locator('.gd-plan-card').click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Más como esto' }).click();
  await expect(sheet.locator('.toast')).toContainText('te voy a sugerir más de infantil');
  await expect(sheet.locator('.gd-taste-hint')).toHaveText('Tu plan sube también los de infantil.');
  expect(posts).toEqual([{ title: 'Dibujitos', kind: 'more', genre: 'Infantil' }]);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-mas-genero-claro.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-mas-genero-oscuro.png` });
  // Tocarlo otra vez lo deshace: se borra el pedido y el hint.
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await sheet.getByRole('button', { name: 'Más como esto' }).click();
  await expect(sheet.getByRole('button', { name: 'Más como esto' })).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet.locator('.gd-taste-hint')).toHaveCount(0);
  expect(posts.map((p) => p.kind)).toEqual(['more', 'clear']);
});
