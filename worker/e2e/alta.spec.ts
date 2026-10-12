// Alta de punta a punta: sin configuración guardada, el proveedor Xtream baja la lista, se guarda la configuración y la
// primera pantalla es Canales con los canales cargados. El Worker lo simula esta prueba (sin cookies ni storage previos).
import { expect, test, type Route } from '@playwright/test';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('alta Xtream: baja la lista, guarda la configuración y queda en Canales', async ({ page }) => {
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/**', (r: Route) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method !== 'GET') writes.push({ method, path, body: req.postDataJSON() });
    const json = (body: unknown, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/provider/list') {
      return json({ channels: [
        { id: '1', name: 'ESPN', category: 'Deportes', ext: 'ts', icon: '', epgId: null },
        { id: '2', name: 'CNN', category: 'Noticias', ext: 'ts', icon: '', epgId: null },
      ] });
    }
    if (path === '/api/cfg' && method === 'POST') return json({ cfgId: 'c9', editKey: 'k9' });
    if (path === '/api/home' && method === 'POST') return json({ homeId: 'Hogar0123456789abcd', homeKey: 'Clave0123456789abcdefgh' });
    if (path.startsWith('/api/home/') && method === 'PUT') return json({});
    if (path === '/api/cfg/c9/list' && method === 'PUT') return json({});
    if (path === '/api/cfg/c9/devices') return json({ devices: [], profiles: [], mainName: 'Luis' });
    if (path === '/api/cfg/c9/accounts') return json({ accounts: {} });
    if (path === '/api/cfg/c9/status') return json({ guideUpToDate: true, guide: '2026-10-10T12:00:00Z', autoRefresh: true });
    if (path === '/api/guide/index.json') return json({ matching_rules: [], sources: {}, channels: [] });
    return json({ error: 'sin red en el test' }, 404);
  });
  await page.goto('/');
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#servers').fill('http://proveedor.test:8080');
  await page.locator('#username').fill('usuario');
  await page.locator('#password').fill('clave');
  await page.locator('#xtreamForm button[type=submit]').click();
  // Al terminar, la app muestra Canales con las dos filas y el aviso de carga.
  await expect(page.locator('#onboarding')).toBeHidden();
  await expect(page.locator('#cards .card', { hasText: 'ESPN' })).toBeVisible();
  await expect(page.locator('#cards .card', { hasText: 'CNN' })).toBeVisible();
  await expect(page.locator('.toasts .toast .msg')).toHaveText('2 canales cargados');
  // La configuración que se guarda trae el proveedor Xtream y su lista; la clave no sale en claro en la configuración.
  const cfg = writes.find((w) => w.path === '/api/cfg' && w.method === 'POST')?.body as { provider: { type: string } };
  expect(cfg.provider.type).toBe('xtream');
  expect(JSON.stringify(cfg)).not.toContain('clave');
});
