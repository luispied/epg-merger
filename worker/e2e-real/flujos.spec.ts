// Punta a punta contra el Worker real (wrangler dev, R2 local): la API y la web hablando entre sí, sin nada simulado.
// Alta, lista, Canales, modo ver con su código, código quitado, el modo ver que no llega al editor y claves por casa.
// Cada prueba arma su propia casa con la API, así no depende de las demás.
import { randomUUID } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

// El Worker limita los POST a 20 por minuto y por IP (rateLimited). Cada prueba tiene su propia IP de origen, así que
// el límite no la afecta; el Worker real corre igual.
const test = base.extend<{ api: APIRequestContext }>({
  api: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'CF-Connecting-IP': `prueba-${randomUUID()}` } });
    await use(api);
    await api.dispose();
  },
});

type Casa = { cfgId: string; editKey: string; pid: string };

/** Arma una casa como la web: configuración sin credenciales, lista subida, un perfil «Abuela». */
async function nuevaCasa(api: APIRequestContext): Promise<Casa> {
  const r = await api.post('/api/cfg', {
    data: { provider: { type: 'xtream', servers: ['http://proveedor.test:8080'], list: 'upload' }, channels: {}, mainName: 'Prueba' },
  });
  expect(r.ok()).toBe(true);
  const { cfgId, editKey } = await r.json() as { cfgId: string; editKey: string };
  const headers = { Authorization: `Bearer ${editKey}` };
  const list = await api.put(`/api/cfg/${cfgId}/list`, {
    headers,
    data: { channels: [
      { id: '1', name: 'ESPN', category: 'Deportes', ext: 'ts', icon: '', epgId: null },
      { id: '2', name: 'CNN', category: 'Noticias', ext: 'ts', icon: '', epgId: null },
    ] },
  });
  expect(list.ok()).toBe(true);
  const p = await api.post(`/api/cfg/${cfgId}/profiles`, { headers, data: { name: 'Abuela' } });
  expect(p.ok()).toBe(true);
  const { profile } = await p.json() as { profile: { id: string } };
  return { cfgId, editKey, pid: profile.id };
}

/** El código «solo ver» del perfil (lo que da «Compartir para ver»). */
async function codigoVer(api: APIRequestContext, c: Casa): Promise<string> {
  const r = await api.post(`/api/cfg/${c.cfgId}/profiles/${c.pid}/view`, {
    headers: { Authorization: `Bearer ${c.editKey}` }, data: {},
  });
  expect(r.ok()).toBe(true);
  return (await r.json() as { code: string }).code;
}

/** Abre la web con la configuración de la casa guardada en este navegador, como la deja el alta. */
async function abrirEditor(page: Page, c: Casa) {
  await page.addInitScript((k) => {
    localStorage.setItem('grilla_web_v1', JSON.stringify({ cfgId: k.cfgId, editKey: k.editKey }));
    localStorage.setItem('grilla_home_v1', JSON.stringify({ configs: [{ cfgId: k.cfgId, editKey: k.editKey, name: 'Mi proveedor' }] }));
  }, c);
  await page.goto('/');
}

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('alta: la configuración se lee solo con su clave y no lleva credenciales', async ({ api }) => {
  const c = await nuevaCasa(api);
  const sin = await api.get(`/api/cfg/${c.cfgId}`);
  expect(sin.status()).toBe(401);
  const con = await api.get(`/api/cfg/${c.cfgId}`, { headers: { Authorization: `Bearer ${c.editKey}` } });
  expect(con.status()).toBe(200);
  const cfg = await con.json() as { provider: { type: string } };
  expect(cfg.provider.type).toBe('xtream');
  expect(JSON.stringify(cfg)).not.toMatch(/password|contraseña|username/i);
});

test('Canales: la lista subida aparece con sus canales', async ({ page, api }) => {
  const c = await nuevaCasa(api);
  await abrirEditor(page, c);
  await expect(page.locator('#cards .card')).toHaveCount(2);
  await expect(page.locator('#cards')).toContainText('ESPN');
  await expect(page.locator('#cards')).toContainText('CNN');
});

test('modo ver: el código de un perfil muestra sus canales, sin nada para editar', async ({ page, api }) => {
  const c = await nuevaCasa(api);
  const code = await codigoVer(api, c);
  await page.goto(`/ver#${code}`);
  await expect(page.locator('.vw-row')).toHaveCount(2);
  await expect(page.locator('.vw-who')).toContainText('Abuela');
  await expect(page.locator('.vw-row').first()).toContainText('ESPN');
});

test('modo ver: pegar el código al abrir nowline lo deja en modo ver, y abrir otra vez no lleva al editor', async ({ page, api }) => {
  const c = await nuevaCasa(api);
  const code = await codigoVer(api, c);
  await page.goto('/');
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#homeLink').click();
  await page.locator('#askDialog input').fill(`ver.${code}`);
  await page.locator('#askCheck').click();
  await expect(page).toHaveURL(/\/ver#/);
  await expect(page.locator('.vw-row')).toHaveCount(2);
  await page.goto('/');
  await expect(page).toHaveURL(/\/ver#/);
  await expect(page.locator('#editor')).toBeHidden();
});

test('modo ver: un código quitado dice que ya no funciona', async ({ page, api }) => {
  const c = await nuevaCasa(api);
  const code = await codigoVer(api, c);
  const del = await api.delete(`/api/cfg/${c.cfgId}/profiles/${c.pid}/view`, {
    headers: { Authorization: `Bearer ${c.editKey}` }, data: {},
  });
  expect(del.ok()).toBe(true);
  await page.goto(`/ver#${code}`);
  await expect(page.locator('.vw-problem')).toContainText('Este código ya no funciona');
});

test('claves: la de una casa no sirve para leer ni guardar otra', async ({ api }) => {
  const a = await nuevaCasa(api);
  const b = await nuevaCasa(api);
  const conClaveDeB = { Authorization: `Bearer ${b.editKey}` };
  expect((await api.get(`/api/cfg/${a.cfgId}`, { headers: conClaveDeB })).status()).toBe(401);
  const put = await api.put(`/api/cfg/${a.cfgId}`, {
    headers: conClaveDeB,
    data: { provider: { type: 'xtream', servers: ['http://proveedor.test:8080'] }, channels: { ESPN: { hidden: true } }, mainName: 'Intruso' },
  });
  expect(put.status()).toBe(401);
  const sigue = await api.get(`/api/cfg/${a.cfgId}`, { headers: { Authorization: `Bearer ${a.editKey}` } });
  expect((await sigue.json() as { channels: Record<string, unknown> }).channels).toEqual({});
});

test('guardar un canal oculto: la configuración lo conserva al volver a leerla', async ({ api }) => {
  const c = await nuevaCasa(api);
  const headers = { Authorization: `Bearer ${c.editKey}` };
  const cfg = await (await api.get(`/api/cfg/${c.cfgId}`, { headers })).json() as Record<string, unknown>;
  const put = await api.put(`/api/cfg/${c.cfgId}`, { headers, data: { ...cfg, channels: { ESPN: { hidden: true } } } });
  expect(put.ok()).toBe(true);
  const again = await (await api.get(`/api/cfg/${c.cfgId}`, { headers })).json() as { channels: Record<string, { hidden?: boolean }> };
  expect(again.channels.ESPN?.hidden).toBe(true);
});
