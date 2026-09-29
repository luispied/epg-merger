import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { b64urlDecode, decryptToken, encryptToken } from '../src/crypto.ts';
import { handle, rateLimited } from '../src/index.ts';
import { parseM3u } from '../src/provider.ts';
import { CATEGORIES, makeEnv, mockXtream, STREAMS } from './helpers.ts';

const BASE = 'https://grilla.example';
const S1 = 'http://s1.example:8080';
const S2 = 'http://s2.example';
let restore = () => {};
afterEach(() => restore());

const req = (path: string, init: RequestInit & { key?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return new Request(BASE + path, { ...init, headers });
};

const CONFIG = {
  provider: { type: 'xtream', servers: [S1, S2] },
  channels: {
    'AR| Telefe HD': { epg: 'Telefe.ar', logo: 'https://g/telefe.png', name: 'Telefe' },
    ESPN: { epg: null, group: 'Deportes AR' },
    'Canal oculto': { hidden: true },
  },
  groups: { order: ['Deportes AR', '🇦🇷 Argentina'] },
};

async function setup(extra: Partial<typeof CONFIG> = {}, down: string[] = []) {
  const t = makeEnv();
  const mock = mockXtream({ streams: STREAMS, categories: CATEGORIES, down });
  restore = mock.restore;
  const created = await (await handle(req('/api/cfg', { method: 'POST', body: JSON.stringify({ ...CONFIG, ...extra }) }), t.env, t.ctx, t.cache)).json() as { cfgId: string; editKey: string };
  const links = await (await handle(req(`/api/cfg/${created.cfgId}/token`, {
    method: 'POST', key: created.editKey, body: JSON.stringify({ username: 'user', password: 'pa ss' }),
  }), t.env, t.ctx, t.cache)).json() as { token: string; playlistUrl: string; epgUrl: string };
  return { ...t, ...created, ...links, mock };
}

test('token: cifra las credenciales y solo sirve para su configuración', async () => {
  const { env } = makeEnv();
  const token = await encryptToken(env.TOKEN_KEY, 'cfgAAAAAAAAAAAAAAAAA', { u: 'user', p: 'secreto' });
  assert.ok(!new TextDecoder().decode(b64urlDecode(token)).includes('secreto'));
  assert.deepEqual(await decryptToken(env.TOKEN_KEY, 'cfgAAAAAAAAAAAAAAAAA', token), { u: 'user', p: 'secreto' });
  assert.equal(await decryptToken(env.TOKEN_KEY, 'otraBBBBBBBBBBBBBBBB', token), null);
  assert.equal(await decryptToken(env.TOKEN_KEY, 'cfgAAAAAAAAAAAAAAAAA', token.slice(0, -2) + 'AA'), null);
});

test('configuración: crear, leer y guardar solo con la clave de edición', async () => {
  const t = await setup();
  const get = (key?: string) => handle(req(`/api/cfg/${t.cfgId}`, { key }), t.env, t.ctx, t.cache);
  assert.equal((await get()).status, 401);
  assert.equal((await get('otra-clave')).status, 401);
  const cfg = await (await get(t.editKey)).json() as { channels: Record<string, unknown> };
  assert.deepEqual(cfg.channels['Canal oculto'], { hidden: true });
  const put = await handle(req(`/api/cfg/${t.cfgId}`, { method: 'PUT', key: t.editKey,
    body: JSON.stringify({ ...CONFIG, channels: {} }) }), t.env, t.ctx, t.cache);
  assert.equal(put.status, 200);
  assert.deepEqual((await (await get(t.editKey)).json() as { channels: object }).channels, {});
  // Lo guardado no tiene credenciales ni el token.
  const raw = [...(t.env.BUCKET as unknown as { data: Map<string, { value: string }> }).data.values()].map((v) => v.value).join('');
  assert.ok(!raw.includes('pa ss') && !raw.includes(t.token));
});

test('configuración: rechaza credenciales dentro de las URLs de los servidores', async () => {
  const t = makeEnv();
  const res = await handle(req('/api/cfg', { method: 'POST', body: JSON.stringify({
    ...CONFIG, provider: { type: 'xtream', servers: ['http://user:pass@s1.example'] } }) }), t.env, t.ctx, t.cache);
  assert.equal(res.status, 400);
});

test('playlist: lista en vivo con ediciones, ocultos, orden y canales nuevos', async () => {
  const t = await setup();
  const res = await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  const text = await res.text();
  const lines = text.trim().split('\n');
  assert.equal(lines[0], `#EXTM3U url-tvg="${BASE}/p/${t.cfgId}/epg.xml.gz"`);
  // Orden: la categoría guardada primero; la nueva ("PPV / Eventos"), al final.
  assert.match(lines[1], /tvg-id="ESPN" .*group-title="Deportes AR",ESPN$/);
  assert.match(lines[3], /tvg-id="Telefe.ar" tvg-name="Telefe" tvg-logo="https:\/\/g\/telefe.png" group-title="🇦🇷 Argentina",Telefe$/);
  // Canal nuevo: tal cual, sin EPG ni logo; '/' fuera del group-title.
  assert.match(lines[5], /tvg-id="Evento del día" tvg-name="Evento del día" tvg-logo="" group-title="PPV - Eventos"/);
  assert.equal(lines[6], `${BASE}/s/${t.cfgId}/${t.token}/12.ts`);
  assert.ok(!text.includes('Canal oculto'));
  assert.ok(!text.includes('pa ss') && !text.includes('pa%20ss'), 'en modo redirect la playlist no lleva credenciales');
});

test('playlist: link con token inválido o de otra configuración → 403', async () => {
  const t = await setup();
  const other = await setup();
  const res = await handle(new Request(`${BASE}/p/${t.cfgId}/${other.token}/playlist.m3u8`), t.env, t.ctx, t.cache);
  assert.equal(res.status, 403);
});

test('balanceador: la lista se baja del segundo servidor si el primero está caído', async () => {
  const t = await setup({}, [S1]);
  const res = await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  assert.ok(t.mock.calls.some((c) => c.startsWith(`${S2}/player_api.php`)));
});

test('balanceador: /s/ redirige al primer servidor sano, con las mismas credenciales', async () => {
  const t = await setup({}, [S1]);
  const res = await handle(new Request(`${BASE}/s/${t.cfgId}/${t.token}/11.m3u8`), t.env, t.ctx, t.cache);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${S2}/live/user/pa%20ss/11.m3u8`);
  await t.settle();
  // El estado de cada servidor queda guardado: el próximo cambio de canal no vuelve a probar.
  const before = t.mock.calls.length;
  await handle(new Request(`${BASE}/s/${t.cfgId}/${t.token}/10.m3u8`), t.env, t.ctx, t.cache);
  assert.equal(t.mock.calls.length, before);
});

test('lista guardada: si el proveedor no responde, sale la última que se pudo bajar', async () => {
  const t = await setup();
  await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache);
  await t.settle();
  t.cache.data.clear();
  restore();
  const down = mockXtream({ down: [S1, S2] });
  restore = down.restore;
  const res = await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Telefe/);
  // Lo guardado no lleva credenciales ni URLs de stream.
  const saved = (t.env.BUCKET as unknown as { data: Map<string, { value: string }> }).data.get(`list/${t.cfgId}.json`)!.value;
  assert.ok(!saved.includes('pa ss') && !saved.includes('/live/'));
});

test('URLs directas: sin redirect, al servidor sano del momento', async () => {
  const t = await setup({ directUrls: true } as Partial<typeof CONFIG>, [S1]);
  const text = await (await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.ok(text.includes(`${S2}/live/user/pa%20ss/10.m3u8`));
});

test('M3U: la lista se baja al servir y los streams van tal cual', async () => {
  const t = makeEnv();
  const mock = mockXtream({});
  restore = mock.restore;
  const created = await (await handle(req('/api/cfg', { method: 'POST', body: JSON.stringify({
    provider: { type: 'm3u' }, channels: { 'Clan (1080p)': { epg: 'Clan.es' } } }) }), t.env, t.ctx, t.cache)).json() as { cfgId: string; editKey: string };
  const links = await (await handle(req(`/api/cfg/${created.cfgId}/token`, { method: 'POST', key: created.editKey,
    body: JSON.stringify({ url: 'http://lista.example/es.m3u' }) }), t.env, t.ctx, t.cache)).json() as { playlistUrl: string };
  const text = await (await handle(new Request(links.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.match(text, /tvg-id="Clan.es" .*group-title="Kids",Clan \(1080p\)\nhttp:\/\/cdn\/clan.m3u8/);
});

test('lista del proveedor de paso, y guía/interfaz desde R2', async () => {
  const t = makeEnv();
  const mock = mockXtream({ streams: STREAMS, categories: CATEGORIES, down: [S1] });
  restore = mock.restore;
  const res = await handle(req('/api/provider/list', { method: 'POST', body: JSON.stringify({
    type: 'xtream', servers: [S1, S2], username: 'user', password: 'pa ss' }) }), t.env, t.ctx, t.cache);
  const body = await res.json() as { server: string; channels: { name: string; category: string }[] };
  assert.equal(body.server, S2);
  assert.deepEqual(body.channels.map((c) => c.category), ['🇦🇷 Argentina', 'Deportes', 'PPV / Eventos', '🇦🇷 Argentina']);
  assert.equal(t.env.BUCKET instanceof Object && (t.env.BUCKET as unknown as { data: Map<string, unknown> }).data.size, 0, 'no guarda nada');

  await t.env.BUCKET.put('guide/index.json', '{"channels":[]}');
  await t.env.BUCKET.put('ui/schedule/abc.json', '[]');
  const guide = await handle(req('/api/guide/index.json'), t.env, t.ctx, t.cache);
  assert.equal(guide.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await guide.text(), '{"channels":[]}');
  assert.equal((await handle(req('/api/ui/schedule/abc.json'), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await handle(req('/api/ui/../cfg/x.json'), t.env, t.ctx, t.cache)).status, 404);
});

test('guía de la configuración: la que dejó la corrida diaria en R2', async () => {
  const t = await setup();
  assert.equal((await handle(new Request(t.epgUrl), t.env, t.ctx, t.cache)).status, 404);
  await t.env.BUCKET.put(`epg/${t.cfgId}.xml.gz`, 'gz');
  const res = await handle(new Request(t.epgUrl), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/gzip');
});

test('límite de pedidos por IP', () => {
  const now = 1_000_000;
  for (let i = 0; i < 20; i++) assert.equal(rateLimited('1.2.3.4', now), false);
  assert.equal(rateLimited('1.2.3.4', now), true);
  assert.equal(rateLimited('1.2.3.4', now + 61_000), false);
});

test('parseo M3U igual que providers.py', () => {
  const chs = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="a.ar" tvg-logo="l" group-title="G",Canal A\n#EXTVLCOPT:x\nhttp://a\n' +
    '#EXTINF:-1,Canal B\n#EXTGRP:Grupo B\nhttp://b\n#EXTINF:-1 tvg-name="C",\nhttp://c\n');
  assert.deepEqual(chs.map((c) => [c.name, c.category, c.epgId, c.icon, c.url]), [
    ['Canal A', 'G', 'a.ar', 'l', 'http://a'], ['Canal B', 'Grupo B', null, '', 'http://b'], ['C', 'General', null, '', 'http://c']]);
});
