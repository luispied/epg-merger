// Perfil infantil en modo ver, contra el Worker real (wrangler dev, R2 local): el código «solo ver» de un perfil infantil
// muestra lo apto y dice «No disponible en este perfil» en lo demás. La programación de prueba se escribe en el R2 local
// (wrangler r2 --local) con el mismo formato que la corrida; el filtro lo aplica el Worker de verdad.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test as base, type APIRequestContext } from '@playwright/test';

const STATE = resolve('test-results/wrangler-state');

const test = base.extend<{ api: APIRequestContext }>({
  api: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'CF-Connecting-IP': `infantil-${randomUUID()}` } });
    await use(api);
    await api.dispose();
  },
});

/** El nombre de archivo de la programación de un canal: los primeros 16 caracteres del sha1 de su alias (como el Worker). */
const archivoDe = (alias: string) => createHash('sha1').update(alias).digest('hex').slice(0, 16);

/** Sube un objeto al R2 local del Worker de prueba. */
function sembrar(clave: string, cuerpo: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'nowline-e2e-'));
  const archivo = join(dir, 'objeto.json');
  writeFileSync(archivo, JSON.stringify(cuerpo));
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `grilla/${clave}`, '--file', archivo, '--local', '--persist-to', STATE], { stdio: 'pipe' });
}

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'iphone', 'la prueba de viewport móvil corre en el proyecto iphone');
});

test('perfil infantil en modo ver: lo apto se ve y lo demás dice «No disponible en este perfil»', async ({ page, api }) => {
  // Una casa con dos canales y un perfil infantil (solo Infantil y Educativo, sin géneros opcionales).
  const r = await api.post('/api/cfg', { data: { provider: { type: 'xtream', servers: ['http://proveedor.test:8080'], list: 'upload' }, channels: { ESPN: { epg: 'espn.prueba' } }, mainName: 'Prueba' } });
  expect(r.ok()).toBe(true);
  const { cfgId, editKey } = await r.json() as { cfgId: string; editKey: string };
  const auth = { Authorization: `Bearer ${editKey}` };
  expect((await api.put(`/api/cfg/${cfgId}/list`, { headers: auth, data: { channels: [
    { id: '1', name: 'ESPN', category: 'Deportes', ext: 'ts', icon: '', epgId: null },
    { id: '2', name: 'CNN', category: 'Noticias', ext: 'ts', icon: '', epgId: null },
  ] } })).ok()).toBe(true);
  const p = await api.post(`/api/cfg/${cfgId}/profiles`, { headers: auth, data: { name: 'Chicos' } });
  const { profile } = await p.json() as { profile: { id: string } };
  expect((await api.put(`/api/cfg/${cfgId}/profiles/${profile.id}`, { headers: auth, data: { kids: { genres: [] } } })).ok()).toBe(true);
  const code = (await (await api.post(`/api/cfg/${cfgId}/profiles/${profile.id}/view`, { headers: auth, data: {} })).json() as { code: string }).code;

  // La programación de ESPN: un programa apto (Infantil) y uno que no (Deportes).
  const view = await (await api.get(`/api/view/${code}`)).json() as { channels: { name: string; epg: string }[] };
  const espn = view.channels.find((c) => c.name === 'ESPN')!;
  const hoy = Math.floor(Date.now() / 1000);
  sembrar(`ui/schedule/${archivoDe(espn.epg)}.json`, [
    [hoy, hoy + 1800, 'Bob Esponja', '', 'Infantil'],
    [hoy + 1800, hoy + 3600, 'Partido de la noche', '', 'Deportes'],
  ]);

  await page.goto(`/ver#${code}`);
  await page.locator('.vw-row', { hasText: 'ESPN' }).click();
  await expect(page.getByText('Bob Esponja')).toBeVisible();
  await expect(page.getByText('No disponible en este perfil').first()).toBeVisible();
  await expect(page.getByText('Partido de la noche')).toHaveCount(0);
});
