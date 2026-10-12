// Avisos por gusto, por perfil (ui/perfiles.tsx: TasteRows, ui/avisos-gusto.tsx y el botón de ui/guide.tsx), con el Worker
// y el servicio de push de mentira: nunca sale una notificación real. El interruptor vive en la página de cada perfil; la
// hoja tiene los géneros, el horario y los últimos avisos con «Menos así»; desde la hoja de un programa se apaga el género
// en todos los perfiles con «Deshacer»; y el modo ver no tiene nada de esto.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const H = Math.floor(Date.now() / 3_600_000) * 3600;
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const EPG = 'g0123456789abcd.uy';

const channels = [{ name: 'Canal Uno', category: 'Cultura', id: '1', ext: 'ts', icon: '', epgId: null }];
const cfg = { version: 1, provider: { type: 'm3u' }, channels: { 'Canal Uno': { epg: EPG, manual: true } }, groups: { order: ['Cultura'], hidden: [] } };
const guide = { version: 1, matching_rules: rules, sources: { s1: { country: 'uy', priority: 0 } }, channels: [{ id: EPG, k: 'k1', source: 's1', names: ['Canal Uno'], icon: '' }] };

interface Taste { on: boolean; when: string; tz: string; genres: { name: string; on: boolean }[]; sent: { title: string; genre: string; at: string; name: string }[] }
const iso = (daysAgo: number, h: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const ENDPOINT = 'https://push.test/s/1';
const fresh = (): Taste => ({
  on: false, when: 'tarde', tz: 'America/Argentina/Buenos_Aires',
  genres: [{ name: 'Deportes', on: false }, { name: 'Documental', on: true }, { name: 'Película', on: true }, { name: 'Serie', on: false }],
  sent: [
    { title: 'Planeta Tierra III', genre: 'Documental', at: iso(1, 19), name: 'Canal Uno' },
    { title: 'El día de la marmota', genre: 'Película', at: iso(3, 19), name: 'Canal Uno' },
  ],
});

let errors: string[] = [];
let tastes: Record<string, Taste>;
let posts: Record<string, unknown>[] = [];

/** El navegador de prueba tiene el permiso y una suscripción de mentira; no hay servicio de push. */
async function pushStub(page: Page) {
  await page.addInitScript((endpoint) => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'x', auth: 'y' } }), unsubscribe: async () => true };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => ((window as unknown as { __sub: boolean }).__sub === false ? null : sub) } }) });
  }, ENDPOINT);
}

/** Lo que devuelve el Worker para un perfil (src/push.ts → getTaste). */
const view = (id: string) => {
  const t = tastes[id];
  return { on: t.on, when: t.when, tz: t.tz, here: true, genres: t.genres, sent: t.sent.slice().reverse() };
};

test.beforeEach(async ({ page }) => {
  errors = [];
  posts = [];
  tastes = { p1: fresh(), p2: fresh() };
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
    if (path === '/api/cfg/demo' && method === 'GET') return r.fulfill({ json: { ...cfg, mainName: 'Luis' } });
    if (path === '/api/guide/index.json') return r.fulfill({ json: guide });
    if (path === '/api/push/key') return r.fulfill({ json: { key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } });
    if (path === '/api/cfg/demo/devices') return r.fulfill({ json: { devices: [], profiles: [{ id: 'p1', name: 'Luis' }, { id: 'p2', name: 'Chicos' }], mainName: 'Luis' } });
    if (path === '/api/cfg/demo/accounts') return r.fulfill({ json: { accounts: {} } });
    if (path === '/api/cfg/demo/status') return r.fulfill({ json: { guideUpToDate: true, guide: '2026-10-10T12:00:00Z', autoRefresh: false } });
    if (path === '/api/cfg/demo/push/taste') {
      const q = new URL(r.request().url()).searchParams;
      if (method === 'POST') {
        const b = r.request().postDataJSON() as Record<string, unknown>;
        posts.push(b);
        const t = tastes[String(b.profile)];
        if (!t) return r.fulfill({ status: 404, json: { error: 'perfil no encontrado' } });
        if (typeof b.on === 'boolean') t.on = b.on;
        if (typeof b.tz === 'string') t.tz = b.tz;
        if (typeof b.when === 'string') t.when = b.when;
        if (typeof b.genre === 'string') for (const g of t.genres) if (g.name === b.genre) g.on = b.genreOn === true;
        return r.fulfill({ json: view(String(b.profile)) });
      }
      const id = q.get('profile') ?? '';
      if (!tastes[id]) return r.fulfill({ status: 404, json: { error: 'perfil no encontrado' } });
      return r.fulfill({ json: view(id) });
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
    await page.screenshot({ path: `test-results/avisos-perfil-${project}-${name}-${scheme}.png` });
  }
}

const sheet = (page: Page) => page.locator('#tasteDialog');
const body = (page: Page) => page.locator('#linksBody');

/** La página de un perfil, desde la pestaña Perfil. */
async function openProfile(page: Page, name: string) {
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#tabLinks').click();
  await expect(page.locator('#linksTitle')).toHaveText('Perfiles');
  await body(page).locator('button.profile-row:not(.account-row)', { hasText: name }).first().click();
  await expect(body(page).locator('.profile-hero strong')).toHaveText(name);
}

test('cada perfil tiene su interruptor: apagado por defecto, y prenderlo en este dispositivo guarda la zona', async ({ page }, info) => {
  await openProfile(page, 'Luis');
  const sw = body(page).getByRole('switch', { name: 'Avisos por gusto: Luis' });
  await expect(sw).not.toBeChecked();
  await expect(body(page)).toContainText('Apagados');
  await shots(page, '1-apagado', info.project.name);
  await sw.click();
  await expect(sw).toBeChecked();
  expect(posts).toEqual([{ profile: 'p1', endpoint: ENDPOINT, on: true, tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) }]);
  // El otro perfil no cambia.
  expect(tastes.p2.on).toBe(false);
  await expect(body(page)).toContainText('Prendidos · Documental, Película');
});

test('la hoja del perfil: géneros automáticos, cuándo y los últimos avisos con «Menos así»', async ({ page }, info) => {
  tastes.p1.on = true;
  await openProfile(page, 'Luis');
  await body(page).getByRole('button', { name: /Géneros, horario y últimos avisos/ }).click();
  await expect(sheet(page)).toBeVisible();
  const doc = sheet(page).getByRole('button', { name: 'Documental', exact: true });
  await expect(doc).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet(page).getByRole('button', { name: 'Deportes', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet(page).getByText('Publicidad y noticias nunca avisan.')).toBeVisible();
  await expect(sheet(page).locator('.menu-row', { hasText: 'Planeta Tierra III' })).toContainText('Documental');
  await shots(page, '2-hoja', info.project.name);
  // Cuándo: mañana, tarde o noche, y el cambio queda guardado en el perfil.
  await sheet(page).getByRole('button', { name: 'Noche', exact: true }).click();
  await expect(sheet(page).getByRole('button', { name: 'Noche', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(posts.at(-1)).toMatchObject({ profile: 'p1', when: 'noche' });
  // Apagar un género desde la hoja: se pide para este perfil.
  await doc.click();
  await expect(doc).toHaveAttribute('aria-pressed', 'false');
  expect(posts.at(-1)).toMatchObject({ profile: 'p1', genre: 'Documental', genreOn: false });
  // Los que ya no suenan no se pueden apagar otra vez desde «Menos así».
  await expect(sheet(page).locator('.menu-row', { hasText: 'Planeta Tierra III' }).getByRole('button')).toHaveText('Apagado');
});

test('sin avisos en este dispositivo, el interruptor queda apagado y dice cómo prenderlos', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __sub: boolean }).__sub = false; });
  await openProfile(page, 'Luis');
  const sw = body(page).getByRole('switch', { name: 'Avisos por gusto: Luis' });
  await expect(sw).toBeDisabled();
  await expect(body(page)).toContainText('Primero prendé Avisos en Configuración');
  expect(posts).toEqual([]);
});

test('si no cargan, la hoja avisa y deja «Probar de nuevo»', async ({ page }) => {
  tastes.p1.on = true;
  await openProfile(page, 'Luis');
  // Primero termina la carga de la página del perfil; después falla solo la de la hoja.
  await expect(body(page).getByRole('switch', { name: 'Avisos por gusto: Luis' })).toBeEnabled();
  await page.route('**/api/cfg/demo/push/taste**', (r) => r.fulfill({ status: 500, json: { error: 'x' } }));
  await body(page).getByRole('button', { name: /Géneros, horario y últimos avisos/ }).click();
  await expect(sheet(page).getByText('No se pudieron cargar los avisos por gusto.')).toBeVisible();
  await page.unroute('**/api/cfg/demo/push/taste**');
  await sheet(page).getByRole('button', { name: 'Probar de nuevo' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Documental', exact: true })).toBeVisible();
});

test('la hoja del programa apaga el género en todos los perfiles que lo reciben, y «Deshacer» lo vuelve a prender', async ({ page }, info) => {
  tastes.p1.on = true;
  tastes.p2.on = true;
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#tabGuide').click();
  await page.locator('.gd-cell[aria-label*="Planeta Tierra"]').first().click();
  const programa = page.locator('dialog.gd-sheet');
  await expect(programa).toBeVisible();
  const off = programa.getByRole('button', { name: 'No avisarme de documentales' });
  await expect(off).toBeVisible();
  await shots(page, '3-hoja-programa', info.project.name);
  await off.click();
  await expect(off).toHaveCount(0);
  await expect(programa.locator('.toast')).toContainText('no te aviso más de documentales');
  expect(posts.filter((b) => b.genreOn === false).map((b) => b.profile).sort()).toEqual(['p1', 'p2']);
  await programa.getByRole('button', { name: 'Deshacer' }).click();
  await expect(programa.getByRole('button', { name: 'No avisarme de documentales' })).toBeVisible();
  expect(posts.filter((b) => b.genreOn === true).map((b) => b.profile).sort()).toEqual(['p1', 'p2']);
  expect(tastes.p1.genres.find((g) => g.name === 'Documental')!.on).toBe(true);
});

test('con el género apagado, o los avisos apagados, la hoja del programa no ofrece nada', async ({ page }) => {
  tastes.p1.genres[1].on = false;
  tastes.p1.on = true;
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await page.locator('#tabGuide').click();
  await page.locator('.gd-cell[aria-label*="Planeta Tierra"]').first().click();
  const programa = page.locator('dialog.gd-sheet');
  await expect(programa.getByRole('button', { name: 'No me interesa' })).toBeVisible();
  await expect(programa.getByRole('button', { name: /No avisarme/ })).toHaveCount(0);
});

test('venir de un aviso (?programa=…) abre la Guía con la hoja de ese programa', async ({ page }) => {
  tastes.p1.on = true;
  await page.goto(`/?programa=${EPG}&inicio=${H - 3600}`);
  const programa = page.locator('dialog.gd-sheet');
  await expect(programa).toBeVisible();
  await expect(programa.locator('.gd-sh-title')).toHaveText('Planeta Tierra');
  await expect(programa.getByRole('button', { name: 'No avisarme de documentales' })).toBeVisible();
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
