// Humo de la Guía (ui/guide.tsx): con una configuración y una programación simuladas, la grilla
// muestra los programas, la línea de ahora y la hoja del programa; los huecos llevan al canal.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const H = Math.floor(Date.now() / 3_600_000) * 3600; // hora UTC en curso
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');

const channels = [
  { name: 'Canal Uno', category: 'Noticias', id: '1', ext: 'ts', icon: '', epgId: null },
  { name: 'Canal Dos', category: 'Noticias', id: '2', ext: 'ts', icon: '', epgId: null },
];
const cfg = {
  version: 1, provider: { type: 'm3u' },
  channels: { 'Canal Uno': { epg: 'g0123456789abcd.uy', manual: true }, 'Canal Dos': { epg: null, manual: true } },
  groups: { order: ['Noticias'], hidden: [] },
};
const guide = {
  version: 1, matching_rules: rules, sources: { s1: { country: 'uy', priority: 0 } },
  channels: [{ id: 'g0123456789abcd.uy', k: 'k1', source: 's1', names: ['Canal Uno'], icon: '' }],
};
// Un programa en el aire desde hace una hora hasta el final de esta, otro la hora siguiente.
const hour = (h: number) => ({ h, t: [h === H ? 'Noticiero central' : 'Película de la noche'], c: { 'g0123456789abcd.uy': [h === H ? [-60, 60, 0] : [0, 60, 0]] } });

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((list) => {
    localStorage.setItem('grilla_web_v1', JSON.stringify({ cfgId: 'demo', editKey: 'k' }));
    localStorage.setItem('grilla_list_demo', JSON.stringify(list));
  }, channels);
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/cfg/demo' && r.request().method() === 'GET') return r.fulfill({ json: cfg });
    if (path === '/api/guide/index.json') return r.fulfill({ json: guide });
    // La resolución medida por el relay: el Canal Uno en 1080; el Dos todavía sin medir.
    if (path === '/api/cfg/demo/health') return r.fulfill({ json: { channels: {}, res: { 1: { t: '2026-10-10T04:00:00Z', w: 1920, h: 1080 } } } });
    const m = path.match(/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/(\d{10})\.json$/);
    if (m) {
      for (const h of [H, H + 3600]) if (hourKey(h) === m[1]) return r.fulfill({ json: hour(h) });
      return r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) {
      return r.fulfill({ json: [[H - 3600, H + 3600, 'Noticiero central', 'Las noticias del día.', 'Noticias'], [H + 3600, H + 7200, 'Película de la noche']] });
    }
    // El noticiero vuelve a empezar después de la película, y otra vez mañana. La misma emisión viene dos veces (la
    // guía trae dos títulos a esa hora), con la repetición de mañana en la segunda: el ↻ muestra la más cercana.
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: ['g0123456789abcd.uy'], r: [[0, H - 3600, [[0, H + 7200]]], [0, H - 3600, [[0, H + 86400]]]] } });
    if (r.request().method() !== 'GET') return r.fulfill({ json: {} });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(2);
});

test('la resolución medida sale como etiqueta en Canales y en la Guía', async ({ page }) => {
  await expect(page.locator('#cards .card').first().locator('.qtag')).toHaveText('FHD');
  await expect(page.locator('#cards .qtag')).toHaveCount(1);
  await page.locator('#tabGuide').click();
  const tag = page.locator('.gd-ch .qtag');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveText('FHD');
  await expect(tag).toHaveAttribute('title', 'Resolución: 1920 × 1080');
});

test('un programa muy corto va sin texto y la hora actual no tapa la marca de la regla', async ({ page }) => {
  // Un programa de 4 minutos justo después del que está en el aire.
  await page.route(/\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}\.json$/, (r) => {
    const k = new URL(r.request().url()).pathname.match(/(\d{10})\.json$/)![1];
    if (k !== hourKey(H)) return r.fallback();
    return r.fulfill({ json: { h: H, t: ['Noticiero central', 'Avance'], c: { 'g0123456789abcd.uy': [[-60, 50, 0], [50, 4, 1]] } } });
  });
  await page.goto('/');
  await page.locator('#tabGuide').click();
  const tiny = page.locator('.gd-cell.tiny[aria-label*="Avance"]');
  await expect(tiny).toHaveCount(1);
  await expect(tiny).toHaveText('');
  await expect(tiny).toHaveAttribute('title', /Avance, de/);
  // El rótulo de una marca cerca de la píldora de la hora queda vacío; la píldora se ve.
  const pill = await page.locator('.gd-now-pill').boundingBox();
  for (const tick of await page.locator('.gd-tick').all()) {
    if (!(await tick.textContent())) continue;
    const b = (await tick.boundingBox())!;
    const overlap = b.x + 6 < pill!.x + pill!.width && b.x + 46 > pill!.x;
    expect(overlap).toBe(false);
  }
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('la Guía muestra la programación y la hoja del programa', async ({ page }) => {
  await page.locator('#tabGuide').click();
  await expect(page.locator('#guide')).toBeVisible();
  await expect(page.locator('#tabGuide')).toHaveAttribute('aria-current', 'page');
  const live = page.locator('.gd-cell.live');
  await expect(live).toHaveCount(1);
  await expect(live).toContainText('Noticiero central');
  const soon = await page.evaluate((t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), H + 7200);
  await expect(live.locator('.rp')).toHaveText(`↻ ${soon} · `);
  await expect(page.locator('.gd-nowline')).toHaveCount(1);
  // El canal sin guía se ve como hueco para corregir.
  await expect(page.locator('.gd-cell.gap.quiet')).toContainText('Sin guía');
  await live.click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('En el aire');
  await expect(sheet).toContainText('Las noticias del día.');
  await expect(sheet.locator('.gd-sh-genre')).toHaveText('Noticias');
  await expect(sheet.locator('.gd-again')).toContainText('Vuelve a empezar');
  await expect(sheet.locator('.gd-again')).toContainText('En este canal');
  await expect(sheet.locator('.gd-again .also')).toHaveCount(1);
  await expect(sheet).toContainText('Película de la noche');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // Canales vuelve a la lista.
  await page.locator('#tabHome').click();
  await expect(page.locator('#guide')).toBeHidden();
});

test('Próximos: lo que viene y «Tengo tiempo»', async ({ page }) => {
  await page.locator('#tabGuide').click();
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(page.getByRole('radio', { name: 'Próximos' })).toHaveAttribute('aria-checked', 'true');
  const row = page.locator('.gd-up-row', { hasText: 'Película de la noche' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Canal Uno');
  const budget = async (m: number) => page.locator('.gd-budget input').evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, m);
  await page.locator('.gd-time-chip').click();
  await budget(20);
  await expect(page.locator('.gd-up-row:not(.dim)')).toHaveCount(0); // la película no entra en 20 min
  await budget(360);
  await expect(row).toContainText('Entra');
  await expect(page.locator('.gd-time-chip')).toContainText('Tengo 6 h');
  // La fila abre la hoja del programa.
  await row.click();
  await expect(page.locator('dialog.gd-sheet')).toContainText('Película de la noche');
  await page.keyboard.press('Escape');
  // Vuelve a la grilla y la elección queda guardada.
  await page.getByRole('radio', { name: 'Grilla' }).click();
  await expect(page.locator('.gd-cell.live')).toHaveCount(1);
});

test('Tu mañana/tarde/noche: arma el plan con la programación de los canales', async ({ page }) => {
  await page.locator('#tabGuide').click();
  // Tu plan no es una vista más: una tarjeta arriba de Grilla y Próximos abre su página, con flecha para volver.
  const teaser = page.locator('#guide .gd-teaser');
  await expect(teaser).toContainText('armada para vos');
  await teaser.click();
  await expect(page.locator('#guide .gd-head h1')).toHaveText(/^Tu (mañana|tarde|noche|madrugada)$/);
  await expect(page.locator('#guide .gd-teaser')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Grilla' })).toHaveCount(0);
  const slot = page.locator('.gd-plan-slot', { hasText: 'Película de la noche' });
  await expect(slot).toBeVisible();
  await expect(slot.locator('.remind-btn')).toBeVisible();
  await slot.locator('.gd-plan-card').click();
  await expect(page.locator('dialog.gd-sheet')).toContainText('Película de la noche');
  await page.keyboard.press('Escape');
  // La flecha vuelve a la vista de antes, con la tarjeta otra vez arriba.
  await page.getByRole('button', { name: 'Volver a Grilla' }).click();
  await expect(page.getByRole('radio', { name: 'Grilla' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#guide .gd-teaser')).toBeVisible();
});

test('«Ahora» aparece solo cuando la línea de ahora no se ve', async ({ page }) => {
  await page.locator('#tabGuide').click();
  await expect(page.locator('.gd-cell.live')).toHaveCount(1);
  const now = page.locator('#guide .gd-now-btn');
  await expect(now).toHaveCount(0);
  await page.locator('#guide .gd').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(now).toBeVisible();
  await now.click();
  await expect(now).toHaveCount(0);
});

test('la Guía no tiene su (?): su ayuda está en Perfil > Ayuda, en la sección Guía', async ({ page }, info) => {
  await page.locator('#tabGuide').click();
  await expect(page.locator('.help-btn')).toHaveCount(0);
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody').getByRole('button', { name: /^Ayuda/ }).click();
  await expect(page.locator('#linksDialog .ayuda section[data-modo="editor"][data-pantalla="guia"]')).toContainText('Próximos y Tengo tiempo');
  await page.screenshot({ path: `test-results/ayuda-guia-${info.project.name}.png`, animations: 'disabled' });
});

test('abierta pasada la media hora, el esqueleto se va cuando llegan los programas', async ({ page }) => {
  // A las y 40 la grilla arranca en una media hora (hace una hora, redondeado a 30 min): el esqueleto tiene que buscar
  // la hora entera que la contiene, si no se queda tapando los programas para siempre.
  await page.clock.setFixedTime(new Date((H + 40 * 60) * 1000));
  await page.reload();
  await page.locator('#tabGuide').click();
  await expect(page.locator('#guide .gd-cell:not(.skel)', { hasText: 'Noticiero central' })).toBeVisible();
  await expect(page.locator('#guide .gd-cell.skel')).toHaveCount(0);
});
