// El cruce de canales con la guía se guarda en IndexedDB de este navegador (web/cache.ts): con la misma guía del día,
// la lista y las preferencias, la próxima apertura lo reusa; si cambia la guía, se vuelve a calcular.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const channels = [{ name: 'Canal Uno', category: 'Noticias', id: '1', ext: 'ts', icon: '', epgId: null }];
const cfg = { version: 1, provider: { type: 'm3u' }, channels: {}, groups: { order: ['Noticias'], hidden: [] } };
const guide = (generatedAt: string) => ({
  version: 1, generated_at: generatedAt, matching_rules: rules, sources: { s1: { country: 'uy', priority: 0 } },
  channels: [{ id: 'g0123456789abcd.uy', k: 'k1', source: 's1', names: ['Canal Uno'], icon: '' }],
});

async function stored(page: import('@playwright/test').Page) {
  return page.evaluate(() => new Promise<string | null>((resolve) => {
    const open = indexedDB.open('nowline');
    open.onsuccess = () => {
      const get = open.result.transaction('cache').objectStore('cache').get('cruce');
      get.onsuccess = () => { open.result.close(); resolve(get.result ? JSON.stringify(get.result.key) : null); };
      get.onerror = () => resolve(null);
    };
    open.onerror = () => resolve(null);
  }));
}

test('el cruce queda guardado y se reemplaza cuando cambia la guía del día', async ({ page }) => {
  let day = '2026-10-11T04:00:00Z';
  await page.addInitScript((list) => {
    localStorage.setItem('grilla_web_v1', JSON.stringify({ cfgId: 'demo', editKey: 'k' }));
    localStorage.setItem('grilla_list_demo', JSON.stringify(list));
  }, channels);
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/cfg/demo' && r.request().method() === 'GET') return r.fulfill({ json: cfg });
    if (path === '/api/guide/index.json') return r.fulfill({ json: guide(day) });
    if (path === '/api/cfg/demo/health') return r.fulfill({ json: { channels: {}, res: {} } });
    if (r.request().method() !== 'GET') return r.fulfill({ json: {} });
    return r.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await expect.poll(() => stored(page)).toMatch(/^"[0-9a-f]{64}"$/);
  const first = await stored(page);

  // Otro día: la clave cambia, así que el cruce se calcula de nuevo y reemplaza lo guardado.
  day = '2026-10-12T04:00:00Z';
  await page.goto('/');
  await expect(page.locator('#cards .card')).toHaveCount(1);
  await expect.poll(() => stored(page)).not.toBe(first);
  await expect.poll(() => stored(page)).toMatch(/^"[0-9a-f]{64}"$/);
});
