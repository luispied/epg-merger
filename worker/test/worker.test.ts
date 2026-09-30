import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { b64urlDecode, decryptToken, encryptToken } from '../src/crypto.ts';
import { handle, rateLimited } from '../src/index.ts';
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

test('vínculo con GitHub: si GitHub conoce la cuenta, la configuración queda anotada para que suba la lista', async () => {
  const t = makeEnv();
  const mock = mockXtream({ down: [S1] });
  restore = mock.restore;
  const bucket = t.env.BUCKET as unknown as { data: Map<string, { value: string }> };
  const list = (u: string, p: string) => handle(req('/api/provider/list', { method: 'POST', headers: { 'CF-Connecting-IP': `ip-${Math.random()}` }, body: JSON.stringify({
    type: 'xtream', servers: [S1], username: u, password: p }) }), t.env, t.ctx, t.cache);
  assert.deepEqual(((await (await list('user', 'pa ss')).json()) as { github: boolean }).github, false);
  const { linkHash } = await import('../src/link.ts');
  const hash = await linkHash('user', 'pa ss');
  await t.env.BUCKET.put(`known/${hash}`, '');
  const r = await (await list('user', 'pa ss')).json() as { github: boolean; error: string };
  assert.equal(r.github, true);
  assert.equal(((await (await list('user', 'otra')).json()) as { github: boolean }).github, false, 'con otra clave no');
  const created = await (await handle(req('/api/cfg', { method: 'POST', headers: { 'CF-Connecting-IP': 'ip-cfg' }, body: JSON.stringify({
    provider: { type: 'xtream', servers: [S1], list: 'upload' }, channels: {}, link: { username: 'user', password: 'pa ss' } }) }), t.env, t.ctx, t.cache)).json() as { cfgId: string; github: boolean };
  assert.equal(created.github, true);
  assert.deepEqual(JSON.parse(bucket.data.get(`links/${hash}.json`)!.value), { cfgIds: [created.cfgId], pending: true });
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
