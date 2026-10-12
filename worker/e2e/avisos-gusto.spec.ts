// Avisos por gusto (ui/avisos-gusto.tsx, el botón de ui/guide.tsx y src/taste.ts del Worker), con el Worker y el
// servicio de push de mentira: nunca sale una notificación real. La fila de Configuración abre la hoja con el
// interruptor, los géneros, cuándo y cuántos, y los últimos avisos con «Menos así»; desde la hoja de un programa se
// apaga el género con «Deshacer»; y el modo ver no tiene nada de esto.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const H = Math.floor(Date.now() / 3_600_000) * 3600;
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const EPG = 'g0123456789abcd.uy';

const channels = [{ name: 'Canal Uno', category: 'Cultura', id: '1', ext: 'ts', icon: '', epgId: null }];
const cfg = { version: 1, provider: { type: 'm3u' }, channels: { 'Canal Uno': { epg: EPG, manual: true } }, groups: { order: ['Cultura'], hidden: [] } };
const guide = { version: 1, matching_rules: rules, sources: { s1: { country: 'uy', priority: 0 } }, channels: [{ id: EPG, k: 'k1', source: 's1', names: ['Canal Uno'], icon: '' }] };

interface Taste { on: boolean; when: string; per: string; tz: string; genres: { name: string; on: boolean }[]; sent: { title: string; genre: string; at: string; name: string }[] }
const iso = (daysAgo: number, h: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const fresh = (): Taste => ({
  on: false, when: 'tarde', per: 'semana', tz: 'America/Argentina/Buenos_Aires',
  genres: [{ name: 'Deportes', on: false }, { name: 'Documental', on: true }, { name: 'Película', on: true }, { name: 'Serie', on: false }],
  sent: [
    { title: 'Planeta Tierra III', genre: 'Documental', at: iso(1, 19), name: 'Canal Uno' },
    { title: 'El día de la marmota', genre: 'Película', at: iso(3, 19), name: 'Canal Uno' },
  ],
});

let errors: string[] = [];
let taste: Taste;
let posts: Record<string, unknown>[] = [];
let subscribed = true;

/** El navegador de prueba tiene el permiso y una suscripción de mentira; no hay servicio de push. */
async function pushStub(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    const sub = { endpoint: 'https://push.test/s/1', toJSON: () => ({ endpoint: 'https://push.test/s/1', keys: { p256dh: 'x', auth: 'y' } }), unsubscribe: async () => true };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => ((window as unknown as { __sub: boolean }).__sub === false ? null : sub) } }) });
  });
}

test.beforeEach(async ({ page }) => {
  errors = [];
  posts = [];
  taste = fresh();
  subscribed = true;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await pushStub(page);
  await page.addInitScript((list) => {
    localStorage.setItem('grilla_web_v1', JSON.stringify({ cfgId: 'demo', editKey: 'k' }));
    localStorage.setItem('grilla_list_demo', JSON.stringify(list));
  }, channels);
  await page.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    const method = r.request().method();
    if (path === '/api/cfg/demo' && method === 'GET') return r.fulfill({ json: cfg });
    if (path === '/api/guide/index.json') return r.fulfill({ json: guide });
    if (path === '/api/push/key') return r.fulfill({ json: { key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } });
    if (path === '/api/cfg/demo/push/taste') {
      if (method === 'POST') {
        const b = r.request().postDataJSON() as Record<string, unknown>;
        posts.push(b);
        if (typeof b.on === 'boolean') taste.on = b.on;
        if (typeof b.tz === 'string') taste.tz = b.tz;
        if (typeof b.when === 'string') taste.when = b.when;
        if (typeof b.per === 'string') taste.per = b.per;
        if (typeof b.genre === 'string') for (const g of taste.genres) if (g.name === b.genre) g.on = b.genreOn === true;
      }
      return r.fulfill({ json: taste });
    }
    const m = path.match(/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/(\d{10})\.json$/);
    if (m) {
      for (const h of [H, H + 3600]) {
        if (hourKey(h) === m[1]) return r.fulfill({ json: { h, t: ['Planeta Tierra'], g: ['Documental'], c: { [EPG]: [h === H ? [-60, 60, 0] : [0, 60, 0]] } } });
      }
      return r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [[H - 3600, H + 3600, 'Planeta Tierra', 'La vida en el planeta.', 'Documental']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [EPG], r: [] } });
    if (path.endsWith('/habits')) return r.fulfill({ json: { ch: {}, t: {}, no: {}, more: {}, mg: {} } });
    if (method !== 'GET') return r.fulfill({ json: {} });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
});

test.afterEach(() => { expect(errors).toEqual([]); });

/** Captura en claro y en oscuro (para revisar el diseño); no compara nada. */
async function shots(page: Page, name: string, project: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, scheme);
    await page.screenshot({ path: `test-results/avisos-gusto-${project}-${name}-${scheme}.png` });
  }
}

const settings = (page: Page) => page.locator('#settingsDialog');
const taste_ = (page: Page) => page.locator('#tasteDialog');

async function openSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#settingsBtn').click();
  await expect(settings(page)).toBeVisible();
}

test('la fila de Configuración sale con los avisos prendidos y abre la hoja: apagado por defecto, prende con la zona del dispositivo', async ({ page }, info) => {
  await openSettings(page);
  const row = settings(page).getByRole('button', { name: /Avisos por gusto/ });
  await expect(row).toContainText('Apagados');
  await shots(page, '1-configuracion', info.project.name);
  await row.click();
  await expect(taste_(page)).toBeVisible();
  const sw = taste_(page).getByRole('switch', { name: /Avisarme lo que me gusta/ });
  await expect(sw).not.toBeChecked();
  await expect(taste_(page).getByText('Si no hay uno bueno, no manda nada.')).toBeVisible();
  await expect(taste_(page).getByRole('group', { name: 'Cuándo' })).toHaveCount(0);
  await sw.check();
  await expect(sw).toBeChecked();
  expect(posts).toEqual([{ on: true, tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) }]);
  // Géneros (los apagados quedan sin elegir), cuándo y cuántos, y los últimos avisos.
  const chips = taste_(page).locator('.filter-chips .chip-btn');
  await expect(chips).toHaveText(['Deportes', 'Documental', 'Película', 'Serie']);
  await expect(taste_(page).getByRole('button', { name: 'Documental', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(taste_(page).getByRole('button', { name: 'Deportes', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(taste_(page).getByRole('button', { name: 'Tarde · 18 a 20' })).toHaveAttribute('aria-pressed', 'true');
  await expect(taste_(page).getByRole('button', { name: '3 por semana' })).toHaveAttribute('aria-pressed', 'true');
  await expect(taste_(page).locator('.menu-row', { hasText: 'Planeta Tierra III' })).toContainText('Documental');
  await shots(page, '2-hoja', info.project.name);
  // Cuándo y cuántos.
  await taste_(page).getByRole('button', { name: 'Noche · 20 a 22' }).click();
  await expect(taste_(page).getByRole('button', { name: 'Noche · 20 a 22' })).toHaveAttribute('aria-pressed', 'true');
  await taste_(page).getByRole('button', { name: '1 por día' }).click();
  await expect(taste_(page).getByRole('button', { name: '1 por día' })).toHaveAttribute('aria-pressed', 'true');
  await expect(taste_(page).getByText('Como mucho uno por día; nunca de noche')).toBeVisible();
  expect(posts.slice(1)).toEqual([{ when: 'noche' }, { per: 'dia' }]);
  // La fila de Configuración dice lo que quedó.
  await taste_(page).getByRole('button', { name: 'Cerrar' }).click();
  await expect(row).toContainText('Prendidos · Documental, Película');
});

test('géneros: se apagan y prenden con los chips; «Menos así» apaga el género con «Deshacer»', async ({ page }, info) => {
  taste.on = true;
  await openSettings(page);
  await settings(page).getByRole('button', { name: /Avisos por gusto/ }).click();
  const doc = taste_(page).getByRole('button', { name: 'Documental', exact: true });
  await doc.click();
  await expect(doc).toHaveAttribute('aria-pressed', 'false');
  await doc.click();
  await expect(doc).toHaveAttribute('aria-pressed', 'true');
  expect(posts).toEqual([{ genre: 'Documental', genreOn: false }, { genre: 'Documental', genreOn: true }]);
  // «Menos así» en el último aviso: apaga el género y se puede deshacer.
  await taste_(page).locator('.menu-row', { hasText: 'Planeta Tierra III' }).getByRole('button', { name: 'Menos así' }).click();
  await expect(doc).toHaveAttribute('aria-pressed', 'false');
  await expect(taste_(page).locator('.menu-row', { hasText: 'Planeta Tierra III' }).getByRole('button')).toHaveText('Apagado');
  await expect(taste_(page).locator('.toast')).toContainText('no te aviso más de documentales');
  await shots(page, '3-menos-asi', info.project.name);
  await taste_(page).getByRole('button', { name: 'Deshacer' }).click();
  await expect(doc).toHaveAttribute('aria-pressed', 'true');
  await expect(taste_(page).locator('.menu-row', { hasText: 'Planeta Tierra III' }).getByRole('button')).toHaveText('Menos así');
});

test('el ? de la hoja abre la ayuda en «Avisos por gusto» y la flecha vuelve a la hoja', async ({ page }) => {
  taste.on = true;
  await openSettings(page);
  await settings(page).getByRole('button', { name: /Avisos por gusto/ }).click();
  await taste_(page).getByRole('button', { name: 'Ayuda' }).click();
  const help = page.locator('#helpDialog');
  await expect(help).toBeVisible();
  await expect(help.locator('.help-topic:not([hidden])')).toHaveCount(1);
  await expect(help.locator('#helpTaste')).toHaveJSProperty('open', true);
  await expect(help.locator('#helpTaste')).toContainText('Menos así');
  await page.locator('#helpBack').click();
  await expect(taste_(page)).toBeVisible();
});

test('sin avisos en este dispositivo no hay fila de avisos por gusto', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __sub: boolean }).__sub = false; });
  await openSettings(page);
  await expect(settings(page).getByRole('switch', { name: /Avisos/ }).first()).not.toBeChecked();
  await expect(settings(page).getByRole('button', { name: /Avisos por gusto/ })).toHaveCount(0);
});

test('si no cargan, la hoja avisa y deja «Probar de nuevo»', async ({ page }) => {
  taste.on = true;
  await openSettings(page);
  await page.route('**/api/cfg/demo/push/taste', (r) => r.fulfill({ status: 500, json: { error: 'x' } }));
  await settings(page).getByRole('button', { name: /Avisos por gusto/ }).click();
  await expect(taste_(page).getByText('No se pudieron cargar los avisos por gusto.')).toBeVisible();
  await page.unroute('**/api/cfg/demo/push/taste');
  await taste_(page).getByRole('button', { name: 'Probar de nuevo' }).click();
  await expect(taste_(page).getByRole('switch', { name: /Avisarme lo que me gusta/ })).toBeChecked();
});

test('la hoja del programa ofrece «No avisarme de documentales» (con Deshacer) y el aviso la abre', async ({ page }, info) => {
  taste.on = true;
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#tabGuide').click();
  await page.locator('.gd-cell[aria-label*="Planeta Tierra"]').first().click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  const off = sheet.getByRole('button', { name: 'No avisarme de documentales' });
  await expect(off).toBeVisible();
  await shots(page, '4-hoja-programa', info.project.name);
  await off.click();
  await expect(off).toHaveCount(0);
  await expect(sheet.locator('.toast')).toContainText('no te aviso más de documentales');
  expect(posts).toEqual([{ genre: 'Documental', genreOn: false }]);
  await sheet.getByRole('button', { name: 'Deshacer' }).click();
  await expect(sheet.getByRole('button', { name: 'No avisarme de documentales' })).toBeVisible();
  expect(taste.genres.find((g) => g.name === 'Documental')!.on).toBe(true);
});

test('con el género apagado, o los avisos apagados, la hoja del programa no ofrece nada', async ({ page }) => {
  taste.genres[1].on = false;
  taste.on = true;
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#tabGuide').click();
  await page.locator('.gd-cell[aria-label*="Planeta Tierra"]').first().click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /No avisarme/ })).toHaveCount(0);
});

test('venir de un aviso (?programa=…) abre la Guía con la hoja de ese programa', async ({ page }) => {
  taste.on = true;
  await page.goto(`/?programa=${EPG}&inicio=${H - 3600}`);
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.gd-sh-title')).toHaveText('Planeta Tierra');
  await expect(sheet.getByRole('button', { name: 'No avisarme de documentales' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

test('el modo ver no tiene avisos por gusto', async ({ page }) => {
  const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
  await page.route(`**/api/view/${CODE}`, (r) => r.fulfill({ json: { name: 'Abuela', channels: [{ id: '1', name: 'Canal Uno', cat: 'Cultura', epg: EPG, logo: '' }] } }));
  await page.route(`**/api/view/${CODE}/connections`, (r) => r.fulfill({ json: { watching: [] } }));
  await page.route(`**/api/view/${CODE}/habits`, (r) => r.fulfill({ json: { ch: {}, t: {}, no: {}, more: {} } }));
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
  await page.locator('.gd-cell[aria-label*="Planeta Tierra"]').first().click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /No avisarme/ })).toHaveCount(0);
  expect(posts).toEqual([]);
});
