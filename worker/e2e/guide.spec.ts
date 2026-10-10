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
    const m = path.match(/^\/api\/ui\/schedule\/hour\/(\d{10})\.json$/);
    if (m) {
      for (const h of [H, H + 3600]) if (hourKey(h) === m[1]) return r.fulfill({ json: hour(h) });
      return r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) {
      return r.fulfill({ json: [[H - 3600, H + 3600, 'Noticiero central', 'Las noticias del día.'], [H + 3600, H + 7200, 'Película de la noche']] });
    }
    // El noticiero vuelve a empezar después de la película.
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: ['g0123456789abcd.uy'], r: [[0, H - 3600, [[0, H + 7200]]]] } });
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
  await expect(live.locator('.rp')).toContainText('↻');
  await expect(page.locator('.gd-nowline')).toHaveCount(1);
  // El canal sin guía se ve como hueco para corregir.
  await expect(page.locator('.gd-cell.gap.quiet')).toContainText('Sin guía');
  await live.click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('En el aire');
  await expect(sheet).toContainText('Las noticias del día.');
  await expect(sheet.locator('.gd-again')).toContainText('Vuelve a empezar');
  await expect(sheet.locator('.gd-again')).toContainText('En este canal');
  await expect(sheet).toContainText('Película de la noche');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // Canales vuelve a la lista.
  await page.locator('#tabHome').click();
  await expect(page.locator('#guide')).toBeHidden();
});
