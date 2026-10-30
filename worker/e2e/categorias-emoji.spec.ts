// Las categorías que trae el proveedor con emoji delante («🇦🇷 Argentina», «⚽️ Deportes») se ven sin él en el
// modo ver (Canales y la Guía): el nombre de la categoría es el mismo, solo cambia cómo se muestra (sinEmoji, core/names.ts).
import { expect, test, type Page } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Math.floor(Date.now() / 1000);
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');

const ch = (id: number, cat: string) => ({ id: String(id), name: `${cat} ${id}`, cat, epg: `g${String(id).padStart(13, '0')}.uy`, logo: '' });
const CHANNELS = ['🇦🇷 Argentina', '⚽️ Deportes', 'Noticias'].map((c, i) => ch(i + 1, c));

let errors: string[] = [];

async function open(page: Page) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels: CHANNELS } });
    if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
    if (/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}\.json$/.test(path)) {
      return path.includes(hourKey(NOW)) ? r.fulfill({ json: { h: Math.floor(NOW / 3600) * 3600, t: [], c: {} } }) : r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) return r.fulfill({ json: [[NOW - 600, NOW + 2400, 'Final del torneo']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-cat')).toHaveCount(3);
}

test.beforeEach(() => { errors = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('Canales: la categoría se muestra sin el emoji del principio', async ({ page }, info) => {
  await open(page);
  // Capturas para comparar antes y después (SHOTS, si está): claro y oscuro, en la pantalla de Canales.
  if (process.env.SHOTS) {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-${theme}-canales.png` });
    }
  }
  await expect(page.locator('.vw-cat')).toHaveText(['Argentina', 'Deportes', 'Noticias']);
});

test('la Guía: la categoría en el filtro se ve sin emoji', async ({ page }, info) => {
  await open(page);
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide .filter-btn')).toBeVisible();
  await page.locator('#guide .filter-btn').click();
  const sheet = page.locator('dialog.filter-sheet');
  if (process.env.SHOTS) {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-${theme}-guia-filtro.png` });
    }
  }
  const chips = sheet.locator('.filter-chips');
  await expect(chips).toContainText('Argentina');
  await expect(chips).toContainText('Deportes');
  await expect(chips).not.toContainText('🇦🇷');
  await expect(chips).not.toContainText('⚽');
});
