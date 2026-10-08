import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { parseEvent, zonedToUtc } from '../src/events.ts';
import { checkAllPush, encryptWebPush, expiryThreshold, notifyExpiry, notifyReminders } from '../src/push.ts';
import { MAX_REMINDERS } from '../src/remind.ts';
import { b64urlDecode, b64urlEncode, decryptToken, encryptToken, sourceAlias } from '../src/crypto.ts';
import { handle, rateLimited } from '../src/index.ts';
import { accountKey } from '../src/account.ts';
import { checkAllHealth, isDue, pickBatch, runHealthCheck, visibleChannels } from '../src/streamcheck.ts';
import { buildPlaylist } from '../src/playlist.ts';
import { mediaKey, resetMediaMaps } from '../src/logos.ts';
import { channelsFromXtreamM3u, parseM3u } from '../src/provider.ts';
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

// Cada configuración de prueba entra con su propia IP: el límite por IP es de todo el archivo.
let setups = 0;
async function setup(extra: Partial<typeof CONFIG> = {}, down: string[] = []) {
  const t = makeEnv();
  const mock = mockXtream({ streams: STREAMS, categories: CATEGORIES, down });
  restore = mock.restore;
  const created = await (await handle(req('/api/cfg', { method: 'POST', headers: { 'CF-Connecting-IP': `setup-${++setups}` }, body: JSON.stringify({ ...CONFIG, ...extra }) }), t.env, t.ctx, t.cache)).json() as { cfgId: string; editKey: string };
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
  // Lo guardado no tiene credenciales; el token (cifrado) solo en el link corto.
  const data = (t.env.BUCKET as unknown as { data: Map<string, { value: string }> }).data;
  const raw = [...data.entries()].filter(([k]) => !k.startsWith('short/')).map(([, v]) => v.value).join('');
  assert.ok(!raw.includes('pa ss') && !raw.includes(t.token));
  assert.ok(![...data.values()].some((v) => v.value.includes('pa ss')));
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
  const code = /\/l\/([^.]+)\.m3u8$/.exec(t.playlistUrl)![1];
  assert.equal(lines[0], `#EXTM3U url-tvg="${BASE}/g/${code}.xml.gz"`);
  // Orden: la categoría guardada primero; la nueva ("PPV / Eventos"), al final.
  assert.match(lines[1], /tvg-id="ESPN" .*group-title="Deportes AR",ESPN$/);
  assert.match(lines[3], /tvg-id="Telefe.ar" tvg-name="Telefe" tvg-logo="https:\/\/g\/telefe.png" group-title="🇦🇷 Argentina",Telefe$/);
  // Canal nuevo: tal cual, sin EPG ni logo; '/' fuera del group-title.
  assert.match(lines[5], /tvg-id="Evento del día" tvg-name="Evento del día" tvg-logo="" group-title="PPV - Eventos"/);
  assert.equal(lines[6], `${BASE}/s/${code}/12.ts`);
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
  // Lo viejo de ui/ que nombra las fuentes ya no se sirve.
  await t.env.BUCKET.put('ui/sources_report.json', '{}');
  assert.equal((await handle(req('/api/ui/sources_report.json'), t.env, t.ctx, t.cache)).status, 404);
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

test('sin TOKEN_KEY: error claro en vez de un 500', async () => {
  const t = makeEnv();
  const res = await handle(req('/api/guide/index.json'), { ...t.env, TOKEN_KEY: undefined as unknown as string }, t.ctx, t.cache);
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /TOKEN_KEY/);
});

test('servidor que no es Xtream o que rechaza: el error dice por qué (sin la URL)', async () => {
  const t = makeEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).hostname;
    if (host === 'waf.example') return new Response('<h1>Sorry, you have been blocked</h1>', { status: 403, headers: { Server: 'cloudflare' } });
    return new Response('<div align="center">Parked domain</div>');
  }) as typeof fetch;
  restore = () => void (globalThis.fetch = original);
  const res = await handle(req('/api/provider/list', { method: 'POST', body: JSON.stringify({
    type: 'xtream', servers: ['http://waf.example:8880', 'http://parked.example'], username: 'user', password: 'secreta' }) }), t.env, t.ctx, t.cache);
  const { error } = await res.json() as { error: string };
  assert.match(error, /waf\.example:8880: HTTP 403 \(cloudflare\): Sorry, you have been blocked/);
  assert.match(error, /parked\.example: no respondió JSON .*Parked domain/);
  assert.ok(!error.includes('secreta'));
});

test('lista subida: el Worker no va al proveedor y usa la que subió GitHub o la app', async () => {
  const t = await setup({ provider: { type: 'xtream', servers: [S1, S2], list: 'upload' } } as Partial<typeof CONFIG>, [S1, S2]);
  const before = t.mock.calls.length;
  assert.equal((await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache)).status, 502, 'sin lista subida todavía');
  const put = (body: unknown, key = t.editKey) => handle(req(`/api/cfg/${t.cfgId}/list`, { method: 'PUT', key, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  assert.equal((await put({ channels: [] }, 'otra')).status, 401);
  assert.equal((await put({ channels: [{ name: 'x', id: 'no-numérico' }] })).status, 400);
  const ok = await put({ channels: [
    { name: 'AR| Telefe HD', category: '🇦🇷 Argentina', id: 10, ext: 'ts', icon: '', epgId: 'telefe.ar', url: 'http://s/live/u/p/10.ts' },
    { name: 'Evento', category: 'PPV', id: '12' },
  ] });
  assert.deepEqual(await ok.json(), { ok: true, channels: 2 });
  const saved = (t.env.BUCKET as unknown as { data: Map<string, { value: string }> }).data.get(`list/${t.cfgId}.json`)!.value;
  assert.ok(!saved.includes('/live/'), 'no guarda URLs aunque vengan');
  const text = await (await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.match(text, /tvg-name="Telefe".*\n.*\/s\/.*\/10\.ts/);
  assert.match(text, /,Evento\n.*\/12\.m3u8/);
  assert.equal(t.mock.calls.length, before, 'no le pidió nada al proveedor');
});

test('balanceador: un servidor que responde 403 al Worker cuenta como vivo', async () => {
  const t = await setup();
  restore();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (new URL(String(input)).origin === S1) return new Response('403 Forbidden', { status: 403 });
    throw new TypeError('timeout');
  }) as typeof fetch;
  restore = () => void (globalThis.fetch = original);
  const res = await handle(new Request(`${BASE}/s/${t.cfgId}/${t.token}/11.m3u8`), t.env, t.ctx, t.cache);
  assert.equal(res.headers.get('Location'), `${S1}/live/user/pa%20ss/11.m3u8`);
});

test('lista guardada: se puede leer con la clave de edición (para editar en la web)', async () => {
  const t = await setup({ provider: { type: 'xtream', servers: [S1], list: 'upload' } } as Partial<typeof CONFIG>);
  const get = (key?: string) => handle(req(`/api/cfg/${t.cfgId}/list`, { key }), t.env, t.ctx, t.cache);
  assert.equal((await get(t.editKey)).status, 404);
  await handle(req(`/api/cfg/${t.cfgId}/list`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ channels: [{ name: 'A', id: 1 }] }) }), t.env, t.ctx, t.cache);
  assert.equal((await get()).status, 401);
  const list = await (await get(t.editKey)).json() as { channels: { name: string }[] };
  assert.deepEqual(list.channels.map((c) => c.name), ['A']);
});

test('configuración: guarda qué EPG se eligió a mano', async () => {
  const t = await setup({ channels: { A: { epg: 'x.ar', manual: true }, B: { epg: 'y.ar', manual: 'sí' } } } as unknown as Partial<typeof CONFIG>);
  const cfg = await (await handle(req(`/api/cfg/${t.cfgId}`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { channels: Record<string, object> };
  assert.deepEqual(cfg.channels, { A: { epg: 'x.ar', manual: true }, B: { epg: 'y.ar' } });
});

test('lista M3U de un proveedor Xtream: stream_id y extensión de la URL, sin la URL', () => {
  const chs = channelsFromXtreamM3u('#EXTM3U\n#EXTINF:-1 tvg-id="t.ar" group-title="AR",AR| Telefe\nhttp://s:8080/live/u/p/123.ts\n'
    + '#EXTINF:-1 group-title="AR",Sin extensión\nhttp://s:8080/u/p/456\n#EXTINF:-1,Película\nhttp://s/movie/u/p/abc.mkv\n'
    + '#EXTINF:-1,Serie\nhttp://s/series/u/p/9.mp4\n#EXTINF:-1 group-title="MX",Con código\nhttp://s:8880/live/u/p/a4d75cbc-a207-4944-81ce-4e3b218bfa87.ts\n');
  assert.deepEqual(chs, [
    { name: 'AR| Telefe', category: 'AR', id: '123', ext: 'ts', icon: '', epgId: 't.ar' },
    { name: 'Sin extensión', category: 'AR', id: '456', ext: 'ts', icon: '', epgId: null },
    { name: 'Con código', category: 'MX', id: 'a4d75cbc-a207-4944-81ce-4e3b218bfa87', ext: 'ts', icon: '', epgId: null },
  ]);
});

test('ids con código (UUID): la lista subida y el redirect los aceptan', async () => {
  const t = await setup({ provider: { type: 'xtream', servers: [S1], list: 'upload' } } as Partial<typeof CONFIG>);
  const uuid = 'a4d75cbc-a207-4944-81ce-4e3b218bfa87';
  const put = await handle(req(`/api/cfg/${t.cfgId}/list`, { method: 'PUT', key: t.editKey,
    body: JSON.stringify({ channels: [{ name: 'A', category: 'X', id: uuid, ext: 'ts' }, { name: 'B', id: '../x' }] }) }), t.env, t.ctx, t.cache);
  assert.deepEqual(await put.json(), { ok: true, channels: 1 });
  const text = await (await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.ok(text.includes(`/${uuid}.ts`));
  const res = await handle(new Request(`${BASE}/s/${t.cfgId}/${t.token}/${uuid}.ts`), t.env, t.ctx, t.cache);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${S1}/live/user/pa%20ss/${uuid}.ts`);
});

test('sin relay, un proveedor que bloquea al Worker es un error y la configuración no guarda la contraseña', async () => {
  const t = makeEnv();
  const mock = mockXtream({ down: [S1] });
  restore = mock.restore;
  const bucket = t.env.BUCKET as unknown as { data: Map<string, { value: string }> };
  const res = await handle(req('/api/provider/list', { method: 'POST', headers: { 'CF-Connecting-IP': 'ip-bloq' }, body: JSON.stringify({
    type: 'xtream', servers: [S1], username: 'user', password: 'pa ss' }) }), t.env, t.ctx, t.cache);
  assert.equal(res.status, 502);
  assert.deepEqual(Object.keys(await res.json() as object), ['error']);
  // Un "link" que mande una web vieja se ignora: no queda nada en known/ ni en links/.
  const created = await handle(req('/api/cfg', { method: 'POST', headers: { 'CF-Connecting-IP': 'ip-cfg' }, body: JSON.stringify({
    provider: { type: 'xtream', servers: [S1], list: 'upload' }, channels: {}, link: { username: 'user', password: 'pa ss' } }) }), t.env, t.ctx, t.cache);
  assert.equal(created.status, 201);
  assert.ok(![...bucket.data.keys()].some((k) => k.startsWith('known/') || k.startsWith('links/')));
  const all = [...bucket.data.values()].map((v) => v.value).join('');
  assert.ok(!all.includes('pa ss'), 'no guarda la contraseña');
});

test('links cortos: no muestran la configuración ni el token, y los largos siguen andando', async () => {
  const t = await setup();
  const links = await (await handle(req(`/api/cfg/${t.cfgId}/token`, { method: 'POST', key: t.editKey,
    body: JSON.stringify({ username: 'user', password: 'pa ss' }) }), t.env, t.ctx, t.cache)).json() as
    { playlistUrl: string; epgUrl: string; longPlaylistUrl: string; longEpgUrl: string; token: string };
  assert.match(links.playlistUrl, /^https:\/\/grilla\.example\/l\/[A-Za-z0-9_-]{11}\.m3u8$/);
  assert.ok(!links.playlistUrl.includes(t.cfgId) && !links.playlistUrl.includes(links.token));
  const text = await (await handle(new Request(links.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.ok(!text.includes(t.cfgId) && !text.includes(links.token), 'la playlist corta tampoco los muestra');
  const stream = text.split('\n').find((l) => l.includes('/s/'))!;
  const r = await handle(new Request(stream), t.env, t.ctx, t.cache);
  assert.equal(r.status, 302);
  await t.env.BUCKET.put(`epg/${t.cfgId}.xml.gz`, 'gz');
  assert.equal((await handle(new Request(links.epgUrl), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await handle(new Request(links.longPlaylistUrl), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await handle(new Request(`${BASE}/l/inexistente00.m3u8`), t.env, t.ctx, t.cache)).status, 404);
  assert.equal((await handle(new Request(links.playlistUrl.replace('.m3u8', '.xml.gz').replace('/l/', '/l/')), t.env, t.ctx, t.cache)).status, 404);
});

test('GitHub: con GITHUB_TOKEN, crear o guardar una configuración lanza la corrida (una por minuto)', async () => {
  const { dispatchRefresh } = await import('../src/github.ts');
  const t = makeEnv();
  const calls: { url: string; auth: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  restore = () => void (globalThis.fetch = original);
  assert.equal(await dispatchRefresh(t.env, t.cache), false, 'sin token no hace nada');
  const env = { ...t.env, GITHUB_TOKEN: 'ghp_x' };
  assert.equal(await dispatchRefresh(env, t.cache), true);
  assert.equal(await dispatchRefresh(env, t.cache), false, 'no más de una por minuto');
  assert.deepEqual(calls, [{ url: 'https://api.github.com/repos/luispied/epg-merger/actions/workflows/refresh-lists.yml/dispatches', auth: 'Bearer ghp_x' }]);
});

test('estado de la guía: al día solo si se armó después del último cambio', async () => {
  const t = await setup();
  const status = async () => (await handle(req(`/api/cfg/${t.cfgId}/status`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as
    Promise<{ guideUpToDate: boolean; guide: string | null; autoRefresh: boolean }>;
  assert.deepEqual([(await status()).guideUpToDate, (await status()).guide], [false, null]);
  await new Promise((r) => setTimeout(r, 5));
  await t.env.BUCKET.put(`epg/${t.cfgId}.xml.gz`, 'gz');
  assert.equal((await status()).guideUpToDate, true);
  await new Promise((r) => setTimeout(r, 5));
  await handle(req(`/api/cfg/${t.cfgId}`, { method: 'PUT', key: t.editKey, body: JSON.stringify(CONFIG) }), t.env, t.ctx, t.cache);
  assert.equal((await status()).guideUpToDate, false, 'un cambio deja la guía pendiente');
  assert.equal((await handle(req(`/api/cfg/${t.cfgId}/status`), t.env, t.ctx, t.cache)).status, 401);
  const r = await (await handle(req(`/api/cfg/${t.cfgId}/refresh`, { method: 'POST', key: t.editKey }), t.env, t.ctx, t.cache)).json();
  assert.deepEqual(r, { started: false, autoRefresh: false });
});

test('config: las categorías sin guía se guardan (y no aparecen si no hay)', () => {
  const withNoEpg = parseConfig({ ...CONFIG, groups: { order: [], hidden: [], noEpg: ['General', 42] } });
  assert.deepEqual(withNoEpg.groups, { order: [], hidden: [], noEpg: ['General'] });
  assert.deepEqual(parseConfig(CONFIG).groups, { order: ['Deportes AR', '🇦🇷 Argentina'], hidden: [] });
});

test('playlist: logo propio y orden propio de los canales dentro de la categoría', () => {
  const cfg = parseConfig({
    provider: { type: 'm3u' },
    channels: {
      B: { customLogo: 'https://mi.logo/b.png' },
      C: { epg: 'c.ar', logo: 'https://guia/c.png', customLogo: 'javascript:alert(1)' },
    },
    groups: { order: ['G'], hidden: [], channels: { G: ['C', 'A'] } },
  });
  assert.equal(cfg.channels.C.customLogo, undefined, 'solo URLs http/https');
  const ch = (name: string) => ({ name, category: 'G', id: name, ext: 'ts', icon: '', epgId: null });
  const text = buildPlaylist([ch('A'), ch('B'), ch('C')], cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}` });
  const names = [...text.matchAll(/,(.+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['C', 'A', 'B']);
  assert.match(text, /tvg-name="B" tvg-logo="https:\/\/mi\.logo\/b\.png"/);
  assert.match(text, /tvg-name="C" tvg-logo="https:\/\/guia\/c\.png"/);
});

test('config: preferencias de cruce importadas de GitHub (validadas)', () => {
  const cfg = parseConfig({
    ...CONFIG,
    matching: { minScore: 0.45, feed: 'east', categories: { 'USA ENTERTAINMENT': { country: 'us', prefer_sources: ['a', 3] }, X: 'basura' } },
  });
  assert.deepEqual(cfg.matching, { minScore: 0.45, feed: 'east', categories: { 'USA ENTERTAINMENT': { country: 'us', prefer_sources: ['a'] } } });
  assert.equal(parseConfig({ ...CONFIG, matching: { minScore: 7 } }).matching, undefined);
});

test('playlist: categorías renombradas, separadores propios y categorías creadas a mano', () => {
  const cfg = parseConfig({
    provider: { type: 'm3u' },
    channels: { B: { group: 'Mi categoría' } },
    groups: {
      order: ['Nueva sección', 'G', 'Mi categoría'], hidden: [],
      rename: { G: 'Argentina HD', 'Nueva sección': 'Deportes', X: '', Y: 5 },
      custom: ['Mi categoría', 'Vacía'], separators: ['Nueva sección'],
    },
  });
  assert.deepEqual(cfg.groups?.rename, { G: 'Argentina HD', 'Nueva sección': 'Deportes' });
  assert.deepEqual(cfg.groups?.custom, ['Mi categoría', 'Vacía']);
  const ch = (name: string) => ({ name, category: 'G', id: name, ext: 'ts', icon: '', epgId: null });
  const text = buildPlaylist([ch('A'), ch('B')], cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}`, separatorUrl: 'https://x/sep' });
  const lines = text.split('\n').filter((l) => l.startsWith('#EXTINF'));
  assert.match(lines[0], /group-title="Deportes",Deportes/, 'el separador propio va primero, con su nombre');
  assert.match(lines[1], /group-title="Argentina HD",A/);
  assert.match(lines[2], /group-title="Mi categoría",B/);
  assert.match(text, /Deportes\nhttps:\/\/x\/sep\n/);
  // Un separador del proveedor (canal con el nombre de su categoría) toma el nombre nuevo.
  const prov = buildPlaylist([{ ...ch('▆▆ DEP ▆▆'), category: '▆▆ DEP ▆▆' }], parseConfig({
    provider: { type: 'm3u' }, channels: {}, groups: { rename: { '▆▆ DEP ▆▆': 'DEPORTES' } },
  }), { epgUrl: '', streamUrl: () => '/s/x' });
  assert.match(prov, /group-title="DEPORTES",DEPORTES/);
});

test('GET /sep responde sin pedirle nada al proveedor', async () => {
  const t = makeEnv();
  const res = await handle(req('/sep'), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Separador/);
});

test('dispositivos: cada link tiene nombre, se lista, se renombra y quitarlo corta solo ese link', async () => {
  const t = await setup();
  const mk = async (name: string) => await (await handle(req(`/api/cfg/${t.cfgId}/token`, { method: 'POST', key: t.editKey,
    body: JSON.stringify({ username: 'user', password: 'pa ss', name }) }), t.env, t.ctx, t.cache)).json() as { code: string; playlistUrl: string; epgUrl: string };
  const living = await mk('  TV   del living ');
  const cuarto = await mk('TV cuarto');
  const list = async () => (await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as
    { devices: { code: string; name: string; created: string; lastUsed?: string; playlistUrl: string }[] }).devices;
  let devices = await list();
  // El link de arriba (setup) también se anotó, sin nombre.
  assert.deepEqual(devices.map((d) => d.name), ['Sin nombre', 'TV del living', 'TV cuarto']);
  assert.equal(devices[1].playlistUrl, living.playlistUrl);
  assert.ok(devices[1].created);
  // Usar el link anota el último uso.
  assert.equal(devices[1].lastUsed, undefined);
  assert.equal((await handle(new Request(living.playlistUrl), t.env, t.ctx, t.cache)).status, 200);
  await Promise.all(t.pending ?? []);
  // Renombrar.
  assert.equal((await handle(req(`/api/cfg/${t.cfgId}/devices/${cuarto.code}`, { method: 'PATCH', key: t.editKey, body: JSON.stringify({ name: 'Cuarto' }) }), t.env, t.ctx, t.cache)).status, 200);
  // Desactivar corta el link sin borrarlo; activar lo devuelve (el nombre no se toca).
  const patch = (code: string, body: object) => handle(req(`/api/cfg/${t.cfgId}/devices/${code}`, { method: 'PATCH', key: t.editKey, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  assert.equal((await patch(living.code, { active: false })).status, 200);
  // La playlist responde con un aviso (un solo canal); la guía y los streams, 403.
  const offList = await handle(new Request(living.playlistUrl), t.env, t.ctx, t.cache);
  assert.equal(offList.status, 200);
  const offText = await offList.text();
  assert.match(offText, /Link desactivado: reactivalo en Grilla/);
  assert.equal(offText.match(/#EXTINF/g)?.length, 1);
  assert.equal((await handle(new Request(living.epgUrl), t.env, t.ctx, t.cache)).status, 403);
  assert.equal((await handle(new Request(`${BASE}/s/${living.code}/desactivado.ts`), t.env, t.ctx, t.cache)).status, 403);
  const off = (await list()).find((d) => d.code === living.code) as { name: string; active: boolean };
  assert.deepEqual([off.name, off.active], ['TV del living', false]);
  assert.equal((await patch(living.code, { active: true })).status, 200);
  assert.doesNotMatch(await (await handle(new Request(living.playlistUrl), t.env, t.ctx, t.cache)).text(), /desactivado/);
  assert.equal((await list()).find((d) => d.code === living.code)?.name, 'TV del living');
  // Quitar uno: ese link muere, el otro sigue.
  assert.equal((await handle(req(`/api/cfg/${t.cfgId}/devices/${cuarto.code}`, { method: 'DELETE', key: t.editKey }), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await handle(new Request(cuarto.playlistUrl), t.env, t.ctx, t.cache)).status, 404);
  assert.equal((await handle(new Request(cuarto.epgUrl), t.env, t.ctx, t.cache)).status, 404);
  assert.equal((await handle(new Request(living.playlistUrl), t.env, t.ctx, t.cache)).status, 200);
  devices = await list();
  assert.deepEqual(devices.map((d) => d.name), ['Sin nombre', 'TV del living']);
  // Sin la clave de edición no se ve ni se toca nada.
  assert.equal((await handle(req(`/api/cfg/${t.cfgId}/devices`, {}), t.env, t.ctx, t.cache)).status, 401);
  // Borrar la configuración borra todos sus links.
  assert.equal((await handle(req(`/api/cfg/${t.cfgId}`, { method: 'DELETE', key: t.editKey }), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await handle(new Request(living.playlistUrl), t.env, t.ctx, t.cache)).status, 404);
});

test('dispositivos: una configuración no puede tocar los links de otra', async () => {
  const a = await setup();
  const b = await setup();
  const [dev] = (await (await handle(req(`/api/cfg/${a.cfgId}/devices`, { key: a.editKey }), a.env, a.ctx, a.cache)).json() as { devices: { code: string }[] }).devices;
  const res = await handle(req(`/api/cfg/${b.cfgId}/devices/${dev.code}`, { method: 'DELETE', key: b.editKey }), b.env, b.ctx, b.cache);
  assert.equal(res.status, 404);
});

test('dispositivos: el último uso se anota como mucho una vez por hora', async () => {
  const { touchDevice } = await import('../src/devices.ts');
  const t = makeEnv();
  const rec = { cfgId: 'cfgAAAAAAAAAAAAAAAAA', token: 'tk' };
  await t.env.BUCKET.put('short/codigo0001.json', JSON.stringify(rec));
  const t0 = new Date('2026-10-02T10:00:00Z');
  await touchDevice(t.env.BUCKET, 'codigo0001', rec, t0);
  const first = JSON.parse(await (await t.env.BUCKET.get('short/codigo0001.json'))!.text());
  assert.equal(first.lastUsed, t0.toISOString());
  await touchDevice(t.env.BUCKET, 'codigo0001', first, new Date('2026-10-02T10:30:00Z'));
  assert.equal(JSON.parse(await (await t.env.BUCKET.get('short/codigo0001.json'))!.text()).lastUsed, t0.toISOString());
  await touchDevice(t.env.BUCKET, 'codigo0001', first, new Date('2026-10-02T11:01:00Z'));
  assert.equal(JSON.parse(await (await t.env.BUCKET.get('short/codigo0001.json'))!.text()).lastUsed, '2026-10-02T11:01:00.000Z');
});

test('categorías nuevas: se ubican solas junto a las que se les parecen', async () => {
  const { placeNewGroups } = await import('../src/groups.ts');
  const order = ['▆▆ PPV EVENTS ▆▆', 'PPV FUTBOL PREMIER', 'PPV FUTBOL CHAMPIONS', '▆▆ PAÍSES ▆▆', 'AR| DEPORTES', 'AR| CINE', 'ES| DEPORTES'];
  const present = [...order, 'PPV FUTBOL LALIGA', 'PPV FUTBOL SERIE A', 'AR| NOTICIAS', 'Misc'];
  assert.deepEqual(placeNewGroups(order, present), [
    '▆▆ PPV EVENTS ▆▆', 'PPV FUTBOL PREMIER', 'PPV FUTBOL CHAMPIONS', 'PPV FUTBOL LALIGA', 'PPV FUTBOL SERIE A',
    '▆▆ PAÍSES ▆▆', 'AR| DEPORTES', 'AR| CINE', 'AR| NOTICIAS', 'ES| DEPORTES', 'Misc',
  ]);
  // Sin orden guardado se respeta el del proveedor; lo ya ordenado no se toca.
  assert.deepEqual(placeNewGroups([], ['B', 'A']), ['B', 'A']);
  assert.deepEqual(placeNewGroups(order, order), order);
  // Una categoría que hoy no está conserva su lugar en el orden guardado.
  assert.deepEqual(placeNewGroups(['A', 'GONE', 'B'], ['A', 'B']), ['A', 'GONE', 'B']);
});

test('playlist: una categoría nueva del proveedor sale junto a las de su familia', async () => {
  const { buildPlaylist } = await import('../src/playlist.ts');
  const ch = (name: string, category: string) => ({ id: name, name, category, icon: '', ext: 'm3u8' });
  const out = buildPlaylist([ch('c1', 'AR| CINE'), ch('c2', 'PPV FUTBOL LALIGA'), ch('c3', 'PPV FUTBOL PREMIER')],
    { version: 1, provider: { type: 'xtream', servers: [] }, channels: {}, groups: { order: ['PPV FUTBOL PREMIER', 'AR| CINE'], hidden: [] } } as never,
    { epgUrl: '', streamUrl: (c) => `/s/${c.id}` });
  const groups = [...out.matchAll(/group-title="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['PPV FUTBOL PREMIER', 'PPV FUTBOL LALIGA', 'AR| CINE']);
});


test('hora de los eventos PPV: formatos, zona del proveedor y fecha', () => {
  const MX = 'America/Mexico_City'; // UTC-6 todo el año
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString().slice(0, 16));
  const t = (name: string, now: string) => parseEvent(name, MX, Date.parse(now));
  // Sin fecha: el día más cercano a «ahora».
  assert.equal(iso(t('11:00  Belarus vs. San Marino  UEFA Nations League', '2025-10-03T17:30:00Z')?.start), '2025-10-03T17:00');
  assert.equal(t('11:00  Belarus vs. San Marino  UEFA Nations League', '2025-10-03T17:30:00Z')?.clean, 'Belarus vs. San Marino · UEFA Nations League');
  assert.equal(iso(t('08:00 - League Two - Crewe Alexandra vs. Bristol Rovers', '2025-10-03T13:00:00Z')?.start), '2025-10-03T14:00');
  assert.equal(t('08:00 - League Two - Crewe Alexandra vs. Bristol Rovers', '2025-10-03T13:00:00Z')?.clean, 'Crewe Alexandra vs. Bristol Rovers · League Two');
  assert.equal(iso(t('01:00  Evento tarde  Liga', '2025-10-04T05:00:00Z')?.start), '2025-10-04T07:00'); // pasada la medianoche, mañana
  assert.equal(iso(t('003 MX: Liga Femenil / Leon vs Tigres - 7:05PM - Purple 3', '2025-10-04T00:00:00Z')?.start), '2025-10-04T01:05');
  assert.equal(iso(t('[CONCACAF Nations League] Dominica vs Guyana - 15:00', '2025-10-03T20:00:00Z')?.start), '2025-10-03T21:00');
  // Con fecha: mes/día en un formato y día/mes en otro.
  const a = t('10/03 NCAAF 12:00pm Assumption vs Bentley = CBS USA ***', '2025-10-03T12:00:00Z');
  assert.equal(iso(a?.start), '2025-10-03T18:00');
  assert.equal(a?.clean, 'Assumption vs Bentley · NCAAF · CBS USA');
  assert.equal(iso(t('Soccer 03/10 09:00am - Paris Saint-Germain vs Toulouse FC: French Ligue 1', '2025-10-03T12:00:00Z')?.start), '2025-10-03T15:00');
  assert.equal(iso(t('PPV  016 || 03/10 18:00 | PBR | Rattler Days - Nights 2', '2025-10-03T12:00:00Z')?.start), '2025-10-04T00:00');
  // Lo que no es una hora de evento no se toca.
  assert.equal(t('VIVO 0.34 | ¹⁹²⁰ [6:15 PM] |', '2025-10-03T12:00:00Z'), null);
  assert.equal(t('WNBA | NBATV', '2025-10-03T12:00:00Z'), null);
  assert.equal(t('25:99  Algo  Liga', '2025-10-03T12:00:00Z'), null);
  // Año nuevo y horario de verano.
  assert.equal(iso(t('Soccer 01/01 09:00am - Algo vs Otro', '2025-12-31T20:00:00Z')?.start), '2026-01-01T15:00');
  assert.equal(iso(zonedToUtc(2025, 7, 1, 12, 0, 'America/New_York')), '2025-07-01T16:00');
  assert.equal(iso(zonedToUtc(2025, 1, 1, 12, 0, 'America/New_York')), '2025-01-01T17:00');
});


// ---- avisos push ----
const toBytes = (s: string) => b64urlDecode(s);
const concatBytes = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };

async function hkdfBytes(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

/** Lo que haría el navegador: descifra un mensaje push (RFC 8291) con su clave privada y su secreto de autenticación. */
async function decryptPush(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]);
  const cipher = body.slice(21 + body[20]);
  const asKey = await crypto.subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256));
  const enc = new TextEncoder();
  const ikm = await hkdfBytes(shared, auth, concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdfBytes(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfBytes(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, cipher as BufferSource));
  assert.equal(plain[plain.length - 1], 2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('push: el cifrado coincide con el ejemplo de la RFC 8291', async () => {
  const body = await encryptWebPush(
    toBytes('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    toBytes('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    toBytes('BTBZMqHH6r4Tts7J_aSIgg'),
    { salt: toBytes('DGv6ra1nlYgDCS1FRnbzlw'), ephemeral: {
      publicRaw: toBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
      d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' } },
  );
  // El ejemplo de la RFC cifra el texto ya en base64url, tal cual.
  assert.equal(b64urlEncode(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('push: suscribirse, aviso de prueba, canales nuevos y suscripciones caídas', async () => {
  const t = await setup();
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  t.env.VAPID_PUBLIC_KEY = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
  t.env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  // Sin las claves la función no existe; con ellas, la web pide la pública.
  const key = await handle(req('/api/push/key'), t.env, t.ctx, t.cache);
  assert.equal(key.status, 200);
  assert.equal((await key.json() as { key: string }).key, t.env.VAPID_PUBLIC_KEY);
  // El «navegador»: un par de claves y un secreto de autenticación.
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://push.example/s/abc', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } };
  const pushed: { url: string; headers: Headers; body: Uint8Array }[] = [];
  let status = 201;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://push.example/')) {
      pushed.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBuffer) });
      return new Response(null, { status });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const post = (path: string, body: object, method = 'POST') => handle(req(`/api/cfg/${t.cfgId}/push${path}`, { method, key: t.editKey, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
    assert.equal((await post('', { endpoint: 'http://inseguro/x', keys: sub.keys })).status, 400);
    // La lista ya tiene dos canales: lo que había no se avisa como nuevo.
    const putList = (names: string[]) => t.env.BUCKET.put(`list/${t.cfgId}.json`, JSON.stringify({ channels: names.map((name) => ({ name, category: 'Deportes' })) }));
    await putList(['ESPN', 'TNT']);
    assert.equal((await post('', sub)).status, 200);
    // Aviso de prueba: llega firmado con VAPID y cifrado para ese navegador.
    assert.deepEqual(await (await post('/test', {})).json(), { sent: 1 });
    assert.match(pushed[0].headers.get('Authorization') ?? '', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(pushed[0].headers.get('Content-Encoding'), 'aes128gcm');
    assert.equal((JSON.parse(await decryptPush(pushed[0].body, ua.privateKey, uaPublic, auth)) as { title: string }).title, 'Avisos activados');
    // Sin cambios en la lista, la corrida programada no manda nada.
    await checkAllPush(t.env);
    assert.equal(pushed.length, 1);
    // Llegan canales nuevos (y uno separador, que no cuenta): un solo aviso.
    await putList(['ESPN', 'TNT', 'Fox Sports', '▆▆ SECCIÓN ▆▆', 'DAZN 1']);
    await checkAllPush(t.env);
    assert.equal(pushed.length, 2);
    const msg = JSON.parse(await decryptPush(pushed[1].body, ua.privateKey, uaPublic, auth)) as { title: string; body: string };
    assert.equal(msg.title, 'Hay 2 canales nuevos');
    assert.match(msg.body, /Fox Sports, DAZN 1/);
    await checkAllPush(t.env);
    assert.equal(pushed.length, 2);
    // Si el servicio de push dice que la suscripción ya no existe, se borra.
    status = 410;
    await putList(['ESPN', 'TNT', 'Fox Sports', 'DAZN 1', 'Nuevo']);
    await checkAllPush(t.env);
    assert.equal(await t.env.BUCKET.get(`push/${t.cfgId}.json`), null);
    // Y darse de baja a mano también la borra.
    assert.equal((await post('', sub)).status, 200);
    assert.equal((await post('', { endpoint: sub.endpoint }, 'DELETE')).status, 200);
    assert.equal(await t.env.BUCKET.get(`push/${t.cfgId}.json`), null);
    // Sin la clave de edición no se puede.
    assert.equal((await handle(req(`/api/cfg/${t.cfgId}/push`, { method: 'POST', body: JSON.stringify(sub) }), t.env, t.ctx, t.cache)).status, 401);
  } finally {
    globalThis.fetch = real;
  }
});

test('credenciales: al cambiarlas, los links cortos siguen iguales y pasan a usar los datos nuevos', async () => {
  const t = await setup();
  const mk = async (name: string) => await (await handle(req(`/api/cfg/${t.cfgId}/token`, { method: 'POST', key: t.editKey,
    body: JSON.stringify({ username: 'user', password: 'vieja', name }) }), t.env, t.ctx, t.cache)).json() as { playlistUrl: string; code: string };
  const a = await mk('TV');
  const b = await mk('Celu');
  const res = await handle(req(`/api/cfg/${t.cfgId}/credentials`, { method: 'PUT', key: t.editKey,
    body: JSON.stringify({ username: 'user2', password: 'nueva' }) }), t.env, t.ctx, t.cache);
  // 3 = el dispositivo de setup() + los dos de acá
  assert.deepEqual(await res.json(), { ok: true, updated: 3 });
  for (const d of [a, b]) {
    const rec = JSON.parse(await (await t.env.BUCKET.get(`short/${d.code}.json`))!.text()) as { token: string };
    assert.deepEqual(await decryptToken(t.env.TOKEN_KEY, t.cfgId, rec.token), { u: 'user2', p: 'nueva' });
  }
  const list = await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { playlistUrl: string }[] };
  const urls = list.devices.map((d) => d.playlistUrl);
  assert.ok(urls.includes(a.playlistUrl) && urls.includes(b.playlistUrl) && urls.length === 3);
  const bad = await handle(req(`/api/cfg/${t.cfgId}/credentials`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ username: '' }) }), t.env, t.ctx, t.cache);
  assert.equal(bad.status, 400);
});

test('cuentas: un dispositivo puede usar otra cuenta del proveedor, se reutiliza por nombre y se actualiza aparte', async () => {
  const t = await setup();
  const post = async (body: Record<string, unknown>) => await handle(req(`/api/cfg/${t.cfgId}/token`, { method: 'POST', key: t.editKey, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  const tokenOf = async (code: string) => decryptToken(t.env.TOKEN_KEY, t.cfgId,
    (JSON.parse(await (await t.env.BUCKET.get(`short/${code}.json`))!.text()) as { token: string }).token);
  const main = await (await post({ username: 'yo', password: 'a', name: 'TV' })).json() as { code: string };
  const mama = await (await post({ username: 'mama', password: 'b', account: 'Mamá', name: 'Tablet' })).json() as { code: string };
  // Sin usuario ni contraseña: se reutiliza la de la cuenta con ese nombre.
  const mama2 = await (await post({ account: 'Mamá', name: 'Celu' })).json() as { code: string };
  assert.deepEqual(await tokenOf(mama2.code), { u: 'mama', p: 'b' });
  assert.equal((await post({ account: 'Otra', name: 'X' })).status, 400);
  // Cambiar los datos de una cuenta no toca las demás (ni los de setup(), que son de la principal).
  const res = await handle(req(`/api/cfg/${t.cfgId}/credentials`, { method: 'PUT', key: t.editKey,
    body: JSON.stringify({ username: 'mama2', password: 'c', account: 'Mamá' }) }), t.env, t.ctx, t.cache);
  assert.deepEqual(await res.json(), { ok: true, updated: 2 });
  assert.deepEqual(await tokenOf(mama.code), { u: 'mama2', p: 'c' });
  assert.deepEqual(await tokenOf(mama2.code), { u: 'mama2', p: 'c' });
  assert.deepEqual(await tokenOf(main.code), { u: 'yo', p: 'a' });
  const res2 = await handle(req(`/api/cfg/${t.cfgId}/credentials`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ username: 'yo2', password: 'd' }) }), t.env, t.ctx, t.cache);
  assert.deepEqual(await tokenOf(mama.code), { u: 'mama2', p: 'c' });
  assert.deepEqual(await tokenOf(main.code), { u: 'yo2', p: 'd' });
  assert.equal(((await res2.json()) as { updated: number }).updated, 2); // el de setup() y el de 'TV'
  const list = await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { name: string; account?: string }[] };
  assert.deepEqual(list.devices.filter((d) => d.account).map((d) => d.name).sort(), ['Celu', 'Tablet']);
  // Cada dispositivo lleva la huella de su cuenta (con la que la prueba diaria publica su vencimiento); la de reutilizar se hereda.
  const keys = (await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { name: string; accountKey?: string }[] }).devices;
  const keyOf = (n: string) => keys.find((d) => d.name === n)?.accountKey;
  assert.equal(keyOf('Tablet'), await accountKey('mama2', 'c'));
  assert.equal(keyOf('Celu'), keyOf('Tablet'));
  assert.equal(keyOf('TV'), await accountKey('yo2', 'd'));
});

test('perfiles: cada link filtra por categoría y por canal, y se cambia sin cambiar la dirección', async () => {
  const t = await setup();
  const call = (path: string, method: string, body?: unknown) =>
    handle(req(`/api/cfg/${t.cfgId}/${path}`, { method, key: t.editKey, ...(body ? { body: JSON.stringify(body) } : {}) }), t.env, t.ctx, t.cache);
  const kids = await (await call('token', 'POST', {
    username: 'user', password: 'pa ss', name: 'Chicos', filter: { only: true, groups: ['🇦🇷 Argentina'], channels: ['ESPN'] },
  })).json() as { playlistUrl: string; code: string };
  const names = async (url: string) => [...(await (await handle(new Request(url), t.env, t.ctx, t.cache)).text()).matchAll(/group-title="[^"]*",(.*)/g)].map((m) => m[1]);
  // Completa: lo mismo que antes del perfil.
  const full = await names(t.playlistUrl);
  assert.ok(full.includes('ESPN') && full.includes('Telefe'));
  // Perfil "solo": la categoría pedida + el canal suelto; el resto no.
  const only = await names(kids.playlistUrl);
  assert.ok(only.includes('ESPN') && only.includes('Telefe'));
  assert.ok(!only.includes('Evento del día'));
  // Perfil "ocultar": todo menos lo listado, sin tocar la dirección.
  assert.equal((await call(`devices/${kids.code}`, 'PATCH', { filter: { groups: ['Deportes AR'], channels: ['AR| Telefe HD'] } })).status, 200);
  const hide = await names(kids.playlistUrl);
  assert.ok(!hide.includes('ESPN') && !hide.includes('Telefe') && hide.includes('Evento del día'));
  const list = await (await call('devices', 'GET')).json() as { devices: { code: string; filter?: { groups: string[]; only?: boolean } }[] };
  assert.deepEqual(list.devices.find((d) => d.code === kids.code)!.filter, { groups: ['Deportes AR'], channels: ['AR| Telefe HD'] });
  // Sin nada que filtrar vuelve a ver todo; el otro dispositivo nunca se vio afectado.
  assert.equal((await call(`devices/${kids.code}`, 'PATCH', { filter: { groups: [], channels: [] } })).status, 200);
  assert.deepEqual((await names(kids.playlistUrl)).sort(), full.sort());
  assert.deepEqual((await names(t.playlistUrl)).sort(), full.sort());
});

test('canales caídos: la API devuelve lo que dejó la corrida y vacío si no hubo; se borra con la configuración', async () => {
  const t = await setup();
  const get = () => handle(req(`/api/cfg/${t.cfgId}/health`, { key: t.editKey }), t.env, t.ctx, t.cache);
  assert.deepEqual(await (await get()).json(), { channels: {} });
  const saved = { checked: '2026-10-07T07:30:00', channels: { '11': { t: 'x', ok: false, fails: 2 } } };
  await t.env.BUCKET.put(`health/${t.cfgId}.json`, JSON.stringify(saved));
  assert.deepEqual(await (await get()).json(), saved);
  const noKey = await handle(req(`/api/cfg/${t.cfgId}/health`), t.env, t.ctx, t.cache);
  assert.equal(noKey.status, 401);
  await handle(req(`/api/cfg/${t.cfgId}`, { method: 'DELETE', key: t.editKey }), t.env, t.ctx, t.cache);
  assert.equal(await t.env.BUCKET.get(`health/${t.cfgId}.json`), null);
});

test('vencimiento: umbrales 7, 3, 1 y 0; un aviso por umbral; renovar vuelve a empezar', async () => {
  assert.deepEqual([30, 8, 7, 5, 3, 2, 1, 0, -2].map(expiryThreshold), [null, null, 7, 7, 3, 3, 1, 0, 0]);
  const t = await setup();
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  t.env.VAPID_PUBLIC_KEY = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
  t.env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://push.example/s/exp', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } };
  const pushed: Uint8Array[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://push.example/')) {
      pushed.push(new Uint8Array(init?.body as ArrayBuffer));
      return new Response(null, { status: 201 });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const put = (expires: string | null) => t.env.BUCKET.put(`health/${t.cfgId}.json`, JSON.stringify({ channels: {}, account: { status: 'Active', expires } }));
    assert.equal((await handle(req(`/api/cfg/${t.cfgId}/push`, { method: 'POST', key: t.editKey, body: JSON.stringify(sub) }), t.env, t.ctx, t.cache)).status, 200);
    const day = 86_400_000;
    const now = new Date('2026-10-07T12:00:00Z');
    const iso = (days: number) => new Date(now.getTime() + days * day + 3_600_000).toISOString();
    const text = async (i: number) => (JSON.parse(await decryptPush(pushed[i], ua.privateKey, uaPublic, auth)) as { title: string; body: string });
    // Falta mucho, sin vencimiento o sin datos: nada.
    await put(iso(30));
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 0);
    await put(null);
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 0);
    assert.equal(pushed.length, 0);
    // Cruza los 7 días: un aviso; el mismo día no se repite.
    await put(iso(6));
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 1);
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 0);
    assert.equal((await text(0)).title, 'Tu suscripción está por vencer');
    assert.match((await text(0)).body, /faltan 6 días/);
    // Tres días, un día y hoy: un aviso por umbral.
    await put(iso(2));
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 1);
    await put(iso(0));
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 1);
    assert.match((await text(2)).body, /vence hoy/);
    // Ya vencida: no repite el aviso del día 0 (mismo umbral).
    assert.equal(await notifyExpiry(t.env, t.cfgId, new Date(now.getTime() + 2 * day)), 0);
    // Renovó: otro vencimiento, vuelve a avisar al acercarse.
    await put(iso(5));
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 1);
    assert.equal(pushed.length, 4);
    // El estado de vencimiento sobrevive a que alguien se suscriba desde otro navegador.
    const other = { ...sub, endpoint: 'https://push.example/s/otro' };
    await handle(req(`/api/cfg/${t.cfgId}/push`, { method: 'POST', key: t.editKey, body: JSON.stringify(other) }), t.env, t.ctx, t.cache);
    assert.equal(await notifyExpiry(t.env, t.cfgId, now), 0);
  } finally {
    globalThis.fetch = real;
  }
});

test('recordatorios: la API los guarda, los lista y los borra; la corrida avisa los que empiezan en 30 minutos y descarta los vencidos', async () => {
  const t = await setup();
  const call = (method: string, body?: object) =>
    handle(req(`/api/cfg/${t.cfgId}/remind`, { method, key: t.editKey, ...(body ? { body: JSON.stringify(body) } : {}) }), t.env, t.ctx, t.cache);
  // Sin las claves de push, la función no existe.
  assert.equal((await call('GET')).status, 404);
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  t.env.VAPID_PUBLIC_KEY = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
  t.env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://push.example/s/rem', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } };
  const pushed: Uint8Array[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://push.example/')) {
      pushed.push(new Uint8Array(init?.body as ArrayBuffer));
      return new Response(null, { status: 201 });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const item = (start: number, title = 'Noticiero') => ({ epg: 'Telefe.ar', name: 'Telefe', title, start });
    // Validación: ya empezó, falta demasiado o no es un programa.
    assert.equal((await call('POST', item(nowS - 60))).status, 400);
    assert.equal((await call('POST', item(nowS + 5 * 86400))).status, 400);
    assert.equal((await call('POST', { epg: 'x' })).status, 400);
    // Alta (dos veces el mismo no duplica), lista y baja.
    assert.equal((await call('POST', item(nowS + 3600))).status, 200);
    assert.equal((await call('POST', item(nowS + 3600))).status, 200);
    assert.equal((await call('POST', item(nowS + 7200, 'Novela'))).status, 200);
    let list = await (await call('GET')).json() as { items: { start: number; title: string }[] };
    assert.deepEqual(list.items.map((i) => i.title), ['Noticiero', 'Novela']);
    assert.equal((await call('DELETE', { epg: 'Telefe.ar', start: nowS + 7200 })).status, 200);
    list = await (await call('GET')).json() as typeof list;
    assert.deepEqual(list.items.map((i) => i.title), ['Noticiero']);
    // Sin la clave de edición no se puede.
    assert.equal((await handle(req(`/api/cfg/${t.cfgId}/remind`), t.env, t.ctx, t.cache)).status, 401);
    // La corrida: sin dispositivos suscritos no avisa ni borra lo que falta.
    assert.equal(await notifyReminders(t.env, t.cfgId, new Date((nowS + 3600 - 600) * 1000)), 0);
    assert.equal(((await (await call('GET')).json()) as typeof list).items.length, 1);
    await handle(req(`/api/cfg/${t.cfgId}/push`, { method: 'POST', key: t.editKey, body: JSON.stringify(sub) }), t.env, t.ctx, t.cache);
    // Falta más de media hora: todavía no.
    assert.equal(await notifyReminders(t.env, t.cfgId, new Date((nowS + 3600 - 31 * 60) * 1000)), 0);
    assert.equal(pushed.length, 0);
    // Empieza en menos de 30 minutos: un aviso, y se borra.
    assert.equal(await notifyReminders(t.env, t.cfgId, new Date((nowS + 3600 - 20 * 60) * 1000)), 1);
    const msg = JSON.parse(await decryptPush(pushed[0], ua.privateKey, uaPublic, auth)) as { title: string; body: string };
    assert.equal(msg.title, 'Empieza pronto: Noticiero');
    assert.match(msg.body, /Telefe/);
    assert.equal(await notifyReminders(t.env, t.cfgId, new Date((nowS + 3600 - 10 * 60) * 1000)), 0);
    assert.equal(pushed.length, 1);
    // Un recordatorio que ya venció sin poder avisarse se descarta sin mandar nada.
    await call('POST', item(nowS + 600, 'Viejo'));
    assert.equal(await notifyReminders(t.env, t.cfgId, new Date((nowS + 600 + 20 * 60) * 1000)), 0);
    assert.equal(await t.env.BUCKET.get(`remind/${t.cfgId}.json`), null);
    // Tope por configuración.
    for (let i = 0; i < MAX_REMINDERS; i++) assert.equal((await call('POST', item(nowS + 3600 + i * 60, `P${i}`))).status, 200);
    assert.equal((await call('POST', item(nowS + 3600 + 99 * 60, 'Uno más'))).status, 400);
    // Se borra con la configuración.
    await handle(req(`/api/cfg/${t.cfgId}`, { method: 'DELETE', key: t.editKey }), t.env, t.ctx, t.cache);
    assert.equal(await t.env.BUCKET.get(`remind/${t.cfgId}.json`), null);
  } finally {
    globalThis.fetch = real;
  }
});

test('probar canales a mano: una vez por día, sin relay avisa y con relay deja el pedido al cron (sin GitHub)', async () => {
  const t = await setup();
  const run = () => handle(req(`/api/cfg/${t.cfgId}/health/run`, { method: 'POST', key: t.editKey, body: '{}' }), t.env, t.ctx, t.cache);
  assert.deepEqual(await (await run()).json(), { started: false, reason: 'no-relay' });
  t.env.GITHUB_TOKEN = 'ghs_test';
  t.env.RELAY_URL = 'https://relay.example';
  t.env.RELAY_SECRET = 'r'.repeat(40);
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.github.com/')) {
      calls.push(`${init?.method} ${String(input).replace(/^https:\/\/api.github.com\/repos\/[^/]+\/[^/]+/, '')}`);
      return new Response(null, { status: 204 });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const first = await (await run()).json() as { started: boolean; requested: string };
    assert.equal(first.started, true);
    assert.deepEqual(calls, []);
    // Otra vez el mismo día: no se vuelve a lanzar, y dice cuándo.
    const again = await (await run()).json() as { started: boolean; reason: string; nextAt: string };
    assert.deepEqual([again.started, again.reason], [false, 'recent']);
    assert.ok(Date.parse(again.nextAt) > Date.now() + 19 * 3600 * 1000);
    // La lista de canales caídos trae cuándo se pidió.
    const h = await (await handle(req(`/api/cfg/${t.cfgId}/health`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { requested?: string };
    assert.equal(h.requested, first.requested);
    // Si la última prueba terminada fue hace más de 20 horas y el pedido también, se puede de nuevo.
    await t.env.BUCKET.put(`healthreq/${t.cfgId}.json`, JSON.stringify({ at: new Date(Date.now() - 21 * 3600 * 1000).toISOString() }));
    await t.env.BUCKET.put(`health/${t.cfgId}.json`, JSON.stringify({ checked: new Date(Date.now() - 22 * 3600 * 1000).toISOString(), channels: {} }));
    assert.equal(((await (await run()).json()) as { started: boolean }).started, true);
    // Una prueba terminada hace poco también lo impide.
    await t.env.BUCKET.put(`healthreq/${t.cfgId}.json`, JSON.stringify({ at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() }));
    await t.env.BUCKET.put(`health/${t.cfgId}.json`, JSON.stringify({ checked: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), channels: {} }));
    assert.equal(((await (await run()).json()) as { started: boolean }).started, false);
    // Sin la clave de edición no se puede.
    assert.equal((await handle(req(`/api/cfg/${t.cfgId}/health/run`, { method: 'POST', body: '{}' }), t.env, t.ctx, t.cache)).status, 401);
  } finally {
    globalThis.fetch = real;
  }
});

test('relay: cuando el proveedor bloquea al Worker, el relay baja la lista (al dar de alta, al pedir la playlist y al cambiar los servidores)', async () => {
  const t = await setup({ provider: { type: 'xtream', servers: [S1], list: 'upload' } } as Partial<typeof CONFIG>, [S1]);
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  let status = 200;
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://relay.example/')) {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
      if (status !== 200) return new Response(JSON.stringify({ error: 'el proveedor no respondió' }), { status });
      return new Response(JSON.stringify({ server: S1, channels: [{ name: 'Canal del relay', category: 'X', id: '7', ext: 'ts', icon: '', epgId: null }] }));
    }
    return base(input, init);
  }) as typeof fetch;
  const bucket = t.env.BUCKET as unknown as { data: Map<string, { value: string; uploaded?: Date }> };
  const listKey = `list/${t.cfgId}.json`;
  const listNames = () => (JSON.parse(bucket.data.get(listKey)!.value) as { channels: { name: string }[] }).channels.map((c) => c.name);
  const provider = (ip: string) => handle(req('/api/provider/list', { method: 'POST', headers: { 'CF-Connecting-IP': ip },
    body: JSON.stringify({ type: 'xtream', servers: [S1], username: 'user', password: 'pa ss' }) }), t.env, t.ctx, t.cache);
  try {
    // Sin relay configurado, el bloqueo sigue siendo un error.
    assert.equal((await provider('relay-0')).status, 502);
    t.env.RELAY_URL = 'https://relay.example/';
    t.env.RELAY_SECRET = 'r'.repeat(40);
    // Al dar de alta: el relay baja la lista y la respuesta lo avisa.
    const res = await provider('relay-1');
    assert.equal(res.status, 200);
    const body = await res.json() as { viaRelay: boolean; channels: { name: string }[] };
    assert.equal(body.viaRelay, true);
    assert.equal(body.channels[0].name, 'Canal del relay');
    assert.equal(calls[0].url, 'https://relay.example/v1/list');
    assert.equal(calls[0].auth, `Bearer ${'r'.repeat(40)}`);
    assert.deepEqual(calls[0].body, { servers: [S1], username: 'user', password: 'pa ss' });
    // Sin lista guardada, la playlist la pide al relay en el mismo pedido.
    const playlist = () => handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache);
    const first = await playlist();
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes('Canal del relay'));
    assert.deepEqual(listNames(), ['Canal del relay']);
    // Lista vieja: sale igual y se renueva en segundo plano, una sola vez por ventana.
    bucket.data.set(listKey, { value: JSON.stringify({ channels: [{ name: 'Vieja', category: 'X', id: '1', ext: 'ts', icon: '', epgId: null }] }), uploaded: new Date(Date.now() - 60 * 60_000) });
    const before = calls.length;
    assert.ok((await (await playlist()).text()).includes('Vieja'));
    await t.settle();
    assert.equal(calls.length, before + 1);
    assert.deepEqual(listNames(), ['Canal del relay']);
    await playlist();
    await t.settle();
    assert.equal(calls.length, before + 1);
    // Cambiar los servidores baja la lista ya, con las credenciales de un dispositivo de la cuenta.
    bucket.data.set(listKey, { value: '{"channels":[]}', uploaded: new Date() });
    const put = await handle(req(`/api/cfg/${t.cfgId}/servers`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ servers: ['http://nuevo.example'] }) }), t.env, t.ctx, t.cache);
    assert.equal(put.status, 200);
    await t.settle();
    assert.deepEqual(calls[calls.length - 1].body, { servers: ['http://nuevo.example'], username: 'user', password: 'pa ss' });
    assert.deepEqual(listNames(), ['Canal del relay']);
    // Si el relay falla, no se inventa nada: el error sigue siendo del proveedor.
    status = 500;
    assert.equal((await provider('relay-2')).status, 502);
  } finally {
    globalThis.fetch = base;
  }
});

test('prueba de canales por el relay: tandas, una por día, pedido a mano, y el vencimiento de cada cuenta', async () => {
  const t = await setup({ provider: { type: 'xtream', servers: [S1], list: 'upload' }, channels: { Oculto: { hidden: true } } } as Partial<typeof CONFIG>);
  const ch = (id: string, name = `Canal ${id}`, category = 'Aire') => ({ name, category, id, ext: 'ts', icon: '', epgId: null });
  const channels = [ch('1'), ch('2'), ch('3'), ch('4', 'Oculto'), ch('5', 'Evento', 'PPV EVENTS'), ch('6', 'Sep', '▆▆▆ DEPORTES ▆▆▆')];
  const bucket = t.env.BUCKET as unknown as { data: Map<string, { value: string; uploaded?: Date }> };
  bucket.data.set(`list/${t.cfgId}.json`, { value: JSON.stringify({ channels }), uploaded: new Date() });
  // Una segunda cuenta (la de un familiar) con un dispositivo propio.
  await handle(req(`/api/cfg/${t.cfgId}/token`, { method: 'POST', key: t.editKey, body: JSON.stringify({ username: 'mama', password: 'x', account: 'Mamá', name: 'Tablet' }) }), t.env, t.ctx, t.cache);
  const calls: { path: string; body: { username: string; channels?: { id: string }[] } }[] = [];
  let aborted = false;
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://relay.example') {
      const body = JSON.parse(String(init?.body));
      calls.push({ path: url.pathname, body });
      const account = { status: 'Active', expires: body.username === 'user' ? '2026-12-01T00:00:00+00:00' : '2027-02-01T00:00:00+00:00', trial: false, maxConnections: 2 };
      if (url.pathname === '/v1/account') return new Response(JSON.stringify({ server: S1, account }));
      if (url.pathname === '/v1/list') return new Response(JSON.stringify({ server: S1, channels }));
      const results = Object.fromEntries((body.channels ?? []).map((c: { id: string }) => [c.id, c.id === '2' ? 'down' : 'up']));
      return new Response(JSON.stringify({ server: S1, account, results: aborted ? {} : results, aborted }));
    }
    return base(input, init);
  }) as typeof fetch;
  const health = () => JSON.parse(bucket.data.get(`health/${t.cfgId}.json`)!.value) as { probedBy?: string; checked?: string; tested?: number; total?: number; account?: { expires: string }; accounts: Record<string, { expires: string }>; channels: Record<string, { ok: boolean; fails: number }> };
  const now = new Date('2026-10-07T10:00:00Z');
  try {
    // Sin relay no hace nada.
    assert.equal(await runHealthCheck(t.env, t.cfgId, now), false);
    t.env.RELAY_URL = 'https://relay.example';
    t.env.RELAY_SECRET = 'r'.repeat(40);
    assert.equal(await runHealthCheck(t.env, t.cfgId, now), true);
    // Solo los canales que valen la pena (sin ocultos, eventos ni separadores), por la cuenta principal; la otra solo trae sus datos.
    const probe = calls.filter((c) => c.path === '/v1/probe');
    assert.equal(probe.length, 1);
    assert.deepEqual(probe[0].body.channels!.map((c) => c.id), ['1', '2', '3']);
    assert.ok(probe.every((c) => c.body.username === 'user'));
    assert.equal(calls.filter((c) => c.path === '/v1/account').length, 1);
    let h = health();
    assert.equal(h.tested, 3);
    assert.equal(h.total, 3);
    assert.equal(h.channels['2'].ok, false);
    assert.equal(h.channels['1'].ok, true);
    assert.equal(h.account!.expires, '2026-12-01T00:00:00+00:00');
    assert.deepEqual(Object.values(h.accounts).map((a) => a.expires).sort(), ['2026-12-01T00:00:00+00:00', '2027-02-01T00:00:00+00:00']);
    assert.ok(!JSON.stringify(h).includes('pa ss'));
    // Una sola prueba por día: la próxima vuelta del cron no hace nada, salvo que alguien la pida a mano.
    const n = calls.length;
    assert.equal(await checkAllHealth(t.env, new Date(now.getTime() + 3600_000)), 0);
    assert.equal(calls.length, n);
    bucket.data.set(`healthreq/${t.cfgId}.json`, { value: JSON.stringify({ at: new Date(now.getTime() + 7200_000).toISOString() }) });
    assert.equal(await checkAllHealth(t.env, new Date(now.getTime() + 9000_000)), 1);
    assert.equal(health().channels['2'].fails, 2);
    // Si la cuenta rechaza, no se anota nada de los canales y no se insiste hasta el día siguiente.
    aborted = true;
    assert.equal(await runHealthCheck(t.env, t.cfgId, new Date(now.getTime() + 30 * 3600_000)), true);
    assert.equal(health().channels['2'].fails, 2);
    assert.equal(await runHealthCheck(t.env, t.cfgId, new Date(now.getTime() + 31 * 3600_000)), false);
    // Perfil activo: Mamá. La prueba se pide enseguida, la hace su cuenta y lo que probó la anterior no cuenta.
    aborted = false;
    const setActive = (account: string) => handle(req(`/api/cfg/${t.cfgId}/active`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ account }) }), t.env, t.ctx, t.cache);
    assert.equal((await setActive('Nadie')).status, 400);
    assert.deepEqual(await (await setActive('Mamá')).json(), { ok: true, activeAccount: 'Mamá' });
    assert.ok(bucket.data.has(`healthreq/${t.cfgId}.json`));
    // (el pedido queda con la hora real; acá se lo corre a después de la última prueba del test)
    bucket.data.set(`healthreq/${t.cfgId}.json`, { value: JSON.stringify({ at: new Date(now.getTime() + 32 * 3600_000).toISOString() }) });
    const before = calls.length;
    assert.equal(await runHealthCheck(t.env, t.cfgId, new Date(now.getTime() + 32.5 * 3600_000)), true);
    const after = calls.slice(before).filter((c) => c.path === '/v1/probe');
    assert.ok(after.length && after.every((c) => c.body.username === 'mama'));
    h = health();
    assert.equal(h.channels['2'].fails, 1);
    assert.equal(h.account!.expires, '2027-02-01T00:00:00+00:00');
    assert.equal(h.probedBy, await accountKey('mama', 'x'));
    // Guardar la configuración desde una web que no conoce el perfil activo no lo borra.
    await handle(req(`/api/cfg/${t.cfgId}`, { method: 'PUT', key: t.editKey, body: JSON.stringify({ provider: { type: 'xtream', servers: [S1], list: 'upload' }, channels: {} }) }), t.env, t.ctx, t.cache);
    assert.equal((await (await handle(req(`/api/cfg/${t.cfgId}`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { activeAccount?: string }).activeAccount, 'Mamá');
    assert.deepEqual(await (await setActive('')).json(), { ok: true, activeAccount: '' });
    // Datos de cada perfil al momento, por huella.
    const live = await (await handle(req(`/api/cfg/${t.cfgId}/accounts`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { live: boolean; accounts: Record<string, { expires: string }> };
    assert.equal(live.live, true);
    assert.equal(live.accounts[await accountKey('mama', 'x')].expires, '2027-02-01T00:00:00+00:00');
    assert.equal(live.accounts[await accountKey('user', 'pa ss')].expires, '2026-12-01T00:00:00+00:00');
  } finally {
    globalThis.fetch = base;
  }
  // Piezas sueltas.
  const old = (t_: string) => ({ t: t_, ok: true, fails: 0 });
  assert.deepEqual(pickBatch([ch('b'), ch('a'), ch('c')], { a: old('2026-01-02'), c: old('2026-01-01') }, 2).map((c) => c.id), ['b', 'c']);
  assert.deepEqual(visibleChannels(channels, parseConfig({ provider: { type: 'xtream', servers: [S1] }, channels: { Canal_: {} }, groups: { hidden: ['Aire'] } })).length, 0);
  assert.equal(isDue(null, undefined, now), true);
  assert.equal(isDue({ checked: now.toISOString() }, undefined, new Date(now.getTime() + 19 * 3600_000)), false);
  assert.equal(isDue({ checked: now.toISOString() }, new Date(now.getTime() + 1000).toISOString(), new Date(now.getTime() + 2000)), true);
});

test('servidores: se cambian sin tocar los links, se validan y sin relay no se lanza nada en GitHub', async () => {
  const t = await setup();
  const put = (body: unknown, key: string | undefined = t.editKey) =>
    handle(req(`/api/cfg/${t.cfgId}/servers`, { method: 'PUT', key, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  t.env.GITHUB_TOKEN = 'ghs_test';
  const gh: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.github.com/')) {
      gh.push(String(init?.body));
      return new Response(null, { status: 204 });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const before = await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { playlistUrl: string }[] };
    // Con credenciales dentro de la URL o sin ninguna URL, no.
    assert.equal((await put({ servers: ['http://user:clave@nuevo.example'] })).status, 400);
    assert.equal((await put({ servers: [] })).status, 400);
    assert.equal((await put({ servers: ['ftp://nuevo.example'] })).status, 400);
    assert.equal((await put({ servers: ['http://nuevo.example:8080'] }, 'otra-clave')).status, 401);
    // Texto con una URL por línea (la web lo manda como lista) o separado por espacios y comas.
    const res = await put({ servers: 'http://nuevo.example:8080\nhttps://respaldo.example, http://tercero.example' });
    assert.deepEqual(await res.json(), { ok: true, servers: ['http://nuevo.example:8080', 'https://respaldo.example', 'http://tercero.example'] });
    await t.settle();
    const cfg = await (await handle(req(`/api/cfg/${t.cfgId}`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { provider: { servers: string[] }; channels: object };
    assert.deepEqual(cfg.provider.servers, ['http://nuevo.example:8080', 'https://respaldo.example', 'http://tercero.example']);
    assert.ok(Object.keys(cfg.channels).length > 0, 'las ediciones de canales se conservan');
    // La lista la baja el relay (ver el test del relay): GitHub ya no baja listas.
    assert.deepEqual(gh, []);
    // Los links siguen siendo los mismos y el redirect usa el servidor nuevo.
    const after = await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { playlistUrl: string }[] };
    assert.deepEqual(after.devices.map((d) => d.playlistUrl), before.devices.map((d) => d.playlistUrl));
  } finally {
    globalThis.fetch = real;
  }
  // Una configuración M3U no tiene servidores: se cambia la URL en los datos del proveedor.
  const m3u = makeEnv();
  const created = await (await handle(req('/api/cfg', { method: 'POST', headers: { 'CF-Connecting-IP': 'm3u-1' }, body: JSON.stringify({ ...CONFIG, provider: { type: 'm3u' } }) }), m3u.env, m3u.ctx, m3u.cache)).json() as { cfgId: string; editKey: string };
  const res = await handle(req(`/api/cfg/${created.cfgId}/servers`, { method: 'PUT', key: created.editKey, body: JSON.stringify({ servers: ['http://x.example'] }) }), m3u.env, m3u.ctx, m3u.cache);
  assert.equal(res.status, 400);
});

test('alias de fuente: el mismo que source_alias.py', async () => {
  assert.equal(await sourceAlias('epgshare-us2'), 's4b1fdd7b');
  assert.equal(await sourceAlias('programadorx-cl'), 's04f30b9c');
});

test('logos: /logo/<clave> baja la imagen una vez, la guarda en R2 y no muestra de dónde viene', async () => {
  resetMediaMaps();
  const t = makeEnv();
  const ICON = 'http://x/t.png';
  assert.equal(await mediaKey(ICON), 'b4009f79b7b3189c', 'misma clave que logo_key en source_alias.py');
  await t.env.BUCKET.put('logo/map/b.json', JSON.stringify({ b4009f79b7b3189c: ICON }));
  await t.env.BUCKET.put('logo/map/0.json', JSON.stringify({ '0000000000000000': 'http://x/page.html' }));
  await t.env.BUCKET.put('img/map/b4.json', JSON.stringify({ b4009f79b7b3189c: ICON }));
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input) === ICON) return new Response('PNG', { headers: { 'Content-Type': 'image/png' } });
    return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch;
  restore = () => void (globalThis.fetch = original);

  const get = (key: string) => handle(req(`/logo/${key}`), t.env, t.ctx, t.cache);
  const first = await get('b4009f79b7b3189c');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Content-Type'), 'image/png');
  assert.match(first.headers.get('Cache-Control')!, /immutable/);
  assert.equal(await first.text(), 'PNG');
  const again = await get('b4009f79b7b3189c');
  assert.equal(await again.text(), 'PNG');
  assert.deepEqual(calls, [ICON], 'el segundo pedido sale de R2');
  // Lo que no es imagen no se guarda ni se sirve; claves desconocidas o mal formadas, 404.
  assert.equal((await get('0000000000000000')).status, 502);
  assert.equal(await t.env.BUCKET.get('logo/img/0000000000000000'), null);
  assert.equal((await get('ffffffffffffffff')).status, 404);
  assert.equal((await get('..%2Fmap.json')).status, 404);
  // Imagen de programa: se entrega de paso, sin guardarla en R2.
  const img = await handle(req('/img/b4009f79b7b3189c'), t.env, t.ctx, t.cache);
  assert.equal(img.status, 200);
  assert.equal(await img.text(), 'PNG');
  assert.equal(calls.length, 3, 'la imagen de programa se baja cada vez (no se guarda)');
  assert.match(img.headers.get('Content-Security-Policy')!, /sandbox/);
  assert.equal((await handle(req('/img/0000000000000000'), t.env, t.ctx, t.cache)).status, 404);
});

test('logos: un mapa que todavía no subió se vuelve a buscar al minuto, no a la hora', async () => {
  resetMediaMaps();
  const t = makeEnv();
  const original = { fetch: globalThis.fetch, now: Date.now };
  let now = original.now();
  Date.now = () => now;
  globalThis.fetch = (async () => new Response('PNG', { headers: { 'Content-Type': 'image/png' } })) as typeof fetch;
  restore = () => { globalThis.fetch = original.fetch; Date.now = original.now; };
  const get = () => handle(req('/logo/b4009f79b7b3189c'), t.env, t.ctx, t.cache);
  assert.equal((await get()).status, 404, 'sin mapa en R2');
  await t.env.BUCKET.put('logo/map/b.json', JSON.stringify({ b4009f79b7b3189c: 'http://x/t.png' }));
  assert.equal((await get()).status, 404, 'el faltante queda guardado un rato');
  now += 61 * 1000;
  assert.equal((await get()).status, 200, 'pasado el minuto encuentra el mapa nuevo');
});

test('playlist: los logos de la guía salen por el Worker; los propios, tal cual', async () => {
  resetMediaMaps();
  const t = await setup({ channels: {
    'AR| Telefe HD': { epg: 'Telefe.ar', logo: '/logo/b4009f79b7b3189c', name: 'Telefe' },
    ESPN: { epg: 'ESPN.ar', logo: 'http://x/espn.png', customLogo: 'https://mi.logo/espn.png' },
    'Canal oculto': { epg: 'Oculto.ar', logo: 'http://x/t.png' },
  } } as Partial<typeof CONFIG>);
  await t.env.BUCKET.put('logo/map/b.json', JSON.stringify({ b4009f79b7b3189c: 'http://x/t.png' }));
  const text = await (await handle(new Request(t.playlistUrl), t.env, t.ctx, t.cache)).text();
  assert.match(text, /tvg-name="Telefe" tvg-logo="https:\/\/grilla\.example\/logo\/b4009f79b7b3189c"/);
  assert.match(text, /tvg-logo="https:\/\/mi\.logo\/espn\.png"/);
  assert.match(text, /tvg-name="Canal oculto" tvg-logo="https:\/\/grilla\.example\/logo\/b4009f79b7b3189c"/);
});

test('mover un link: a otro perfil o a otro proveedor, con la misma dirección', async () => {
  const t = await setup();
  const code = (url: string) => /\/l\/([^.]+)\.m3u8$/.exec(url)![1];
  const main = code(t.playlistUrl);
  const post = (cfgId: string, key: string, body: Record<string, unknown>) => handle(req(`/api/cfg/${cfgId}/token`, { method: 'POST', key, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  const tv = (await (await post(t.cfgId, t.editKey, { username: 'mama', password: 'b', account: 'Mamá', name: 'TV de Mamá' })).json() as { code: string }).code;
  const move = (cfgId: string, key: string, c: string, body: Record<string, unknown>) => handle(req(`/api/cfg/${cfgId}/devices/${c}/move`, { method: 'POST', key, body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  const rec = async (c: string) => JSON.parse(await (await t.env.BUCKET.get(`short/${c}.json`))!.text()) as { cfgId: string; token: string; account?: string; key?: string; name: string };
  const devices = async (cfgId: string, key: string) => (await (await handle(req(`/api/cfg/${cfgId}/devices`, { key }), t.env, t.ctx, t.cache)).json() as { devices: { code: string; account?: string; playlistUrl: string }[] }).devices;
  // Mismo proveedor: «TV de Mamá» pasa a la cuenta principal; mismo código, credenciales de la principal.
  assert.deepEqual(await (await move(t.cfgId, t.editKey, tv, {})).json(), { ok: true });
  let r = await rec(tv);
  assert.equal(r.account, undefined);
  assert.equal(r.key, await accountKey('user', 'pa ss'));
  assert.deepEqual(await decryptToken(t.env.TOKEN_KEY, t.cfgId, r.token), { u: 'user', p: 'pa ss' });
  // A un perfil sin links: hacen falta su usuario y contraseña.
  assert.equal((await move(t.cfgId, t.editKey, tv, { account: 'Paola' })).status, 400);
  assert.equal((await move(t.cfgId, t.editKey, tv, { account: 'Paola', username: 'pao', password: 'p' })).status, 200);
  assert.equal((await rec(tv)).account, 'Paola');
  // Otro proveedor: otra configuración, con su clave de edición.
  const other = await (await handle(req('/api/cfg', { method: 'POST', headers: { 'CF-Connecting-IP': 'move-2' }, body: JSON.stringify(CONFIG) }), t.env, t.ctx, t.cache)).json() as { cfgId: string; editKey: string };
  await post(other.cfgId, other.editKey, { username: 'user', password: 'pa ss', name: 'Celu' });
  assert.equal((await move(t.cfgId, t.editKey, tv, { to: other.cfgId, toKey: 'mala' })).status, 401);
  assert.equal((await move(t.cfgId, t.editKey, tv, { to: 'NoExisteNoExiste1234' , toKey: other.editKey })).status, 404);
  assert.equal((await move(t.cfgId, t.editKey, tv, { to: other.cfgId, toKey: other.editKey })).status, 200);
  r = await rec(tv);
  assert.equal(r.cfgId, other.cfgId);
  assert.equal(r.name, 'TV de Mamá');
  assert.deepEqual(await decryptToken(t.env.TOKEN_KEY, other.cfgId, r.token), { u: 'user', p: 'pa ss' });
  assert.equal(await decryptToken(t.env.TOKEN_KEY, t.cfgId, r.token), null);
  assert.deepEqual((await devices(t.cfgId, t.editKey)).map((d) => d.code), [main]);
  const moved = (await devices(other.cfgId, other.editKey)).find((d) => d.code === tv)!;
  assert.equal(moved.playlistUrl, `${BASE}/l/${tv}.m3u8`);
  // La dirección de siempre sirve la playlist del proveedor nuevo; la configuración de antes ya no puede tocarlo.
  assert.equal((await handle(req(`/l/${tv}.m3u8`), t.env, t.ctx, t.cache)).status, 200);
  assert.equal((await move(t.cfgId, t.editKey, tv, {})).status, 400);
});

test('cambiar el nombre de un perfil: los links no cambian', async () => {
  const t = await setup();
  const call = (path: string, init: RequestInit = {}) => handle(req(`/api/cfg/${t.cfgId}${path}`, { key: t.editKey, ...init }), t.env, t.ctx, t.cache);
  const rename = (body: Record<string, unknown>) => call('/account-name', { method: 'PUT', body: JSON.stringify(body) });
  const tv = (await (await call('/token', { method: 'POST', body: JSON.stringify({ username: 'mama', password: 'b', account: 'Mamá', name: 'TV de Mamá' }) })).json() as { code: string }).code;
  await call('/active', { method: 'PUT', body: JSON.stringify({ account: 'Mamá' }) });
  const before = JSON.parse(await (await t.env.BUCKET.get(`short/${tv}.json`))!.text()) as { token: string; key: string };
  const list = async () => await (await call('/devices')).json() as { devices: { code: string; account?: string }[]; activeAccount: string; mainName: string };
  // La principal: el nombre se guarda en la configuración y sobrevive a guardarla desde la web sin ese dato.
  assert.equal((await rename({ from: '', to: 'Luis' })).status, 200);
  assert.equal((await list()).mainName, 'Luis');
  const cfg = await (await call('')).json() as Record<string, unknown>;
  const { mainName: _m, activeAccount: _a, profiles: _p, ...rest } = cfg;
  assert.equal((await call('', { method: 'PUT', body: JSON.stringify(rest) })).status, 200);
  assert.equal((await list()).mainName, 'Luis');
  // Un perfil adicional: cambia su `account` (y el activo, si era ese), no el código, el token ni la huella.
  assert.equal((await rename({ from: 'Mamá', to: '' })).status, 400);
  assert.equal((await rename({ from: 'Nadie', to: 'Otro' })).status, 404);
  assert.deepEqual(await (await rename({ from: 'Mamá', to: 'Mami' })).json(), { ok: true, renamed: 1 });
  const after = JSON.parse(await (await t.env.BUCKET.get(`short/${tv}.json`))!.text()) as { token: string; key: string; account: string };
  assert.equal(after.account, 'Mami');
  assert.equal(after.token, before.token);
  assert.equal(after.key, before.key);
  const l = await list();
  assert.equal(l.activeAccount, 'Mami');
  assert.equal(l.devices.find((d) => d.code === tv)!.account, 'Mami');
  // No se puede repetir un nombre de cuenta.
  await call('/token', { method: 'POST', body: JSON.stringify({ username: 'pao', password: 'p', account: 'Paola', name: 'Celu' }) });
  assert.equal((await rename({ from: 'Mami', to: 'Paola' })).status, 400);
  // Un dispositivo nuevo de la principal sin volver a pedir sus datos: usa los de otro link suyo.
  assert.equal((await call('/token', { method: 'POST', body: JSON.stringify({ name: 'Tablet' }) })).status, 200);
});

test('perfiles: los links de antes pasan a uno, el filtro se cambia en un lugar y borrar mueve los links', async () => {
  const t = await setup();
  const call = (path: string, init: RequestInit = {}) => handle(req(`/api/cfg/${t.cfgId}${path}`, { key: t.editKey, ...init }), t.env, t.ctx, t.cache);
  const body = (v: unknown) => JSON.stringify(v);
  const rec = async (c: string) => JSON.parse(await (await t.env.BUCKET.get(`short/${c}.json`))!.text()) as { token: string; account?: string; profile?: string; filter?: unknown };
  const main = /\/l\/([^.]+)\.m3u8$/.exec(t.playlistUrl)![1];
  const kids = { groups: ['Deportes'], channels: [], only: true };
  // Un link con filtro y otro de otra cuenta, como antes (sin perfil).
  const tv = (await (await call('/token', { method: 'POST', body: body({ name: 'TV chicos', filter: kids }) })).json() as { code: string }).code;
  const mama = (await (await call('/token', { method: 'POST', body: body({ username: 'mama', password: 'b', account: 'Mamá', name: 'TV de Mamá' }) })).json() as { code: string }).code;
  const before = await rec(main);
  type List = { devices: { code: string; profile?: string }[]; profiles: { id: string; name: string; account?: string; filter?: unknown }[] };
  const list = async () => await (await call('/devices')).json() as List;
  let l = await list();
  assert.equal(l.profiles.length, 3);
  const pOf = (code: string) => l.profiles.find((p) => p.id === l.devices.find((d) => d.code === code)!.profile)!;
  assert.equal(pOf(main).name, 'Todo');
  assert.equal(pOf(tv).name, 'TV chicos');
  assert.deepEqual(pOf(tv).filter, kids);
  assert.equal(pOf(mama).account, 'Mamá');
  // La migración no toca el token ni la dirección.
  assert.equal((await rec(main)).token, before.token);
  assert.equal((await list()).profiles.length, 3); // no se repite
  // Guardar la config desde la web no pisa los perfiles.
  const cfg = await (await call('')).json() as Record<string, unknown>;
  await call('', { method: 'PUT', body: body({ ...cfg, profiles: [] }) });
  assert.equal((await list()).profiles.length, 3);
  // Un link nuevo en el perfil de los chicos toma su filtro; cambiar el filtro del perfil llega a todos sus links.
  const chicos = pOf(tv).id;
  const tab = (await (await call('/token', { method: 'POST', body: body({ name: 'Tablet', profile: chicos }) })).json() as { code: string }).code;
  assert.deepEqual((await rec(tab)).filter, kids);
  const newer = { groups: ['Argentina'], channels: [], only: true };
  assert.equal((await call(`/profiles/${chicos}`, { method: 'PUT', body: body({ filter: newer, name: 'Chicos' }) })).status, 200);
  assert.deepEqual((await rec(tv)).filter, newer);
  assert.deepEqual((await rec(tab)).filter, newer);
  // Un perfil nuevo y vacío de la cuenta principal; borrar «Chicos» pasa sus links ahí, con la misma dirección.
  const created = await (await call('/profiles', { method: 'POST', body: body({ name: 'Papás' }) })).json() as { profile: { id: string } };
  assert.equal((await call(`/profiles/${chicos}`, { method: 'DELETE', body: body({}) })).status, 400);
  assert.equal((await call(`/profiles/${chicos}`, { method: 'DELETE', body: body({ to: created.profile.id }) })).status, 200);
  assert.equal((await rec(tv)).profile, created.profile.id);
  assert.equal((await rec(tv)).filter, undefined);
  l = await list();
  assert.ok(!l.profiles.some((p) => p.id === chicos));
  assert.ok(l.devices.some((d) => d.code === tv) && l.devices.some((d) => d.code === tab));
  // Pasar el perfil de Mamá a la cuenta principal: sus links toman el token de la principal.
  const pm = pOf(mama).id;
  assert.equal((await call(`/profiles/${pm}`, { method: 'PUT', body: body({ account: '' }) })).status, 200);
  assert.equal((await rec(mama)).account, undefined);
  assert.equal((await rec(mama)).token, before.token);
  // Mover un link a un perfil (de la misma configuración) toma su cuenta y su filtro.
  const filtered = await (await call('/profiles', { method: 'POST', body: body({ name: 'Solo AR', filter: newer }) })).json() as { profile: { id: string } };
  assert.equal((await call(`/devices/${main}/move`, { method: 'POST', body: body({ profile: filtered.profile.id }) })).status, 200);
  assert.equal((await rec(main)).profile, filtered.profile.id);
  assert.deepEqual((await rec(main)).filter, newer);
  assert.equal((await handle(req(`/l/${main}.m3u8`), t.env, t.ctx, t.cache)).status, 200);
});

test('hogar: guarda solo lo que cifra el navegador, con su clave', async () => {
  const t = makeEnv();
  const call = (path: string, init: RequestInit & { key?: string } = {}) => handle(req(path, { headers: { 'CF-Connecting-IP': 'home' }, ...init }), t.env, t.ctx, t.cache);
  assert.equal((await call('/api/home', { method: 'POST', body: JSON.stringify({ data: 'no es base64 <>' }) })).status, 400);
  const created = await (await call('/api/home', { method: 'POST', body: JSON.stringify({ v: 1, data: 'abc_DEF-123' }) })).json() as { homeId: string; homeKey: string };
  assert.equal((await call(`/api/home/${created.homeId}`)).status, 401);
  assert.equal((await call(`/api/home/${created.homeId}`, { key: 'mala' })).status, 401);
  assert.deepEqual(await (await call(`/api/home/${created.homeId}`, { key: created.homeKey })).json(), { v: 1, data: 'abc_DEF-123' });
  assert.equal((await call(`/api/home/${created.homeId}`, { method: 'PUT', key: created.homeKey, body: JSON.stringify({ v: 1, data: 'xyz' }) })).status, 200);
  assert.deepEqual(await (await call(`/api/home/${created.homeId}`, { key: created.homeKey })).json(), { v: 1, data: 'xyz' });
  assert.ok(!(await (await t.env.BUCKET.get(`home/${created.homeId}.json`))!.text()).includes(created.homeKey));
  assert.equal((await call(`/api/home/${created.homeId}`, { method: 'DELETE', key: created.homeKey })).status, 200);
  assert.equal((await call(`/api/home/${created.homeId}`, { key: created.homeKey })).status, 404);
});

test('links de antes sin huella de cuenta: la reciben al listar, sin cambiar código ni token', async () => {
  const t = await setup();
  const code = new URL(t.playlistUrl).pathname.split('/').pop()!.replace(/\.m3u8$/, '');
  const before = JSON.parse(await (await t.env.BUCKET.get(`short/${code}.json`))!.text());
  const { key: _k, ...old } = before;
  await t.env.BUCKET.put(`short/${code}.json`, JSON.stringify(old));
  const r = await (await handle(req(`/api/cfg/${t.cfgId}/devices`, { key: t.editKey }), t.env, t.ctx, t.cache)).json() as { devices: { code: string; accountKey?: string }[] };
  assert.equal(r.devices[0].accountKey, await accountKey('user', 'pa ss'));
  const after = JSON.parse(await (await t.env.BUCKET.get(`short/${code}.json`))!.text());
  assert.equal(after.token, before.token);
  assert.equal(after.key, await accountKey('user', 'pa ss'));
});
