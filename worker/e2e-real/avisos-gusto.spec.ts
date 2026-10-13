// Avisos por gusto de cada perfil, contra el Worker real (wrangler dev, R2 local): la corrida programada (cron) manda el
// programa de gusto a los dispositivos suscritos a ese perfil, cifrado de verdad (RFC 8291), con el tope de 1 por día y
// 3 por semana, la franja y el silencio, «No avisarme de…» y «Menos así». El servicio de push es un servidor local de
// mentira (127.0.0.1): nunca sale nada a un servicio real. Las suscripciones se siembran en R2 local (https no pasa por
// la API en local) y el resto va por la API, como la web.
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test as base, type APIRequestContext } from '@playwright/test';

const STATE = resolve('test-results/wrangler-state');
const DAY_MS = 86_400_000;

interface Push { url: string; hits: { headers: IncomingHttpHeaders; body: Buffer }[]; ua: ReturnType<typeof createECDH>; auth: Buffer }

const test = base.extend<{ api: APIRequestContext; push: Push }>({
  api: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'CF-Connecting-IP': `avisos-${randomUUID()}` } });
    await use(api);
    await api.dispose();
  },
  // Un servicio de push de mentira: recibe lo que el Worker manda y guarda cada envío para mirarlo.
  push: async ({}, use) => {
    const hits: Push['hits'] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    // Las claves del navegador (p256dh y auth) que el Worker usa para cifrar: las tenemos para descifrar el envío.
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    await use({ url: `http://127.0.0.1:${port}/push`, hits, ua, auth: randomBytes(16) });
    await new Promise<void>((r) => server.close(() => r()));
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

/** Una zona horaria (IANA) en la que sea `hora` ahora mismo: Etc/GMT±n, con horas enteras. */
function zonaA(hora: number): string {
  const off = ((hora - new Date().getUTCHours() + 12) % 24 + 24) % 24 - 12; // entre -12 y 11
  return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}

/** Descifra un aviso de Web Push (RFC 8291, aes128gcm) con la clave del navegador de prueba. */
function descifrar(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): { title: string; body: string; url?: string } {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const cipher = body.subarray(21 + idLen);
  const shared = ua.computeSecret(asPublic);
  const uaPublic = ua.getPublicKey(null, 'uncompressed');
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(0x02)).toString('utf8'));
}

interface Casa { cfgId: string; auth: Record<string, string>; pA: string; pB: string; epg: string }

/** Una casa con un canal (ESPN, Deportes) con su guía, y dos perfiles: «Chicos» (el principal) y «Papá». */
async function casa(api: APIRequestContext): Promise<Casa> {
  // Un id de guía con el formato del alias (g + 14 hex + sufijo de país), para que el Worker lea la misma programación.
  const epg = `g${randomBytes(7).toString('hex')}.uy`;
  const r = await api.post('/api/cfg', {
    data: { provider: { type: 'xtream', servers: ['http://proveedor.test:8080'], list: 'upload' }, channels: { ESPN: { epg } }, mainName: 'Prueba' },
  });
  expect(r.ok()).toBe(true);
  const { cfgId, editKey } = await r.json() as { cfgId: string; editKey: string };
  const auth = { Authorization: `Bearer ${editKey}` };
  expect((await api.put(`/api/cfg/${cfgId}/list`, { headers: auth, data: { channels: [
    { id: '1', name: 'ESPN', category: 'Deportes', ext: 'ts', icon: '', epgId: null },
  ] } })).ok()).toBe(true);
  const pA = (await (await api.post(`/api/cfg/${cfgId}/profiles`, { headers: auth, data: { name: 'Chicos' } })).json() as { profile: { id: string } }).profile.id;
  const pB = (await (await api.post(`/api/cfg/${cfgId}/profiles`, { headers: auth, data: { name: 'Papá' } })).json() as { profile: { id: string } }).profile.id;
  return { cfgId, auth, pA, pB, epg };
}

/** El alias del canal (el que usa la programación en R2), como lo ve el perfil. */
async function aliasDe(api: APIRequestContext, c: Casa): Promise<string> {
  const code = (await (await api.post(`/api/cfg/${c.cfgId}/profiles/${c.pA}/view`, { headers: c.auth, data: {} })).json() as { code: string }).code;
  const view = await (await api.get(`/api/view/${code}`)).json() as { channels: { name: string; epg: string }[] };
  return view.channels.find((x) => x.name === 'ESPN')!.epg;
}

/** Siembra la programación del canal: un programa de gusto (Deportes, 2 horas) que empieza en una hora. */
function programa(alias: string, titulo: string) {
  const start = Math.floor(Date.now() / 1000) + 3600;
  sembrar(`ui/schedule/${archivoDe(alias)}.json`, [[start, start + 7200, titulo, '', 'Deportes']]);
}

/** Suscribe el dispositivo de prueba (con su endpoint local) a un perfil. Como la API no acepta un endpoint http, la
 *  suscripción (y, si hace falta, el estado de otro perfil) se escribe directo en R2 local. */
function suscribir(c: Casa, push: Push, perfiles: string[], extra: Record<string, unknown> = {}) {
  sembrar(`push/${c.cfgId}.json`, {
    subs: [{
      endpoint: push.url,
      keys: { p256dh: push.ua.getPublicKey(null, 'uncompressed').toString('base64url'), auth: push.auth.toString('base64url') },
      created: new Date().toISOString(),
      profiles: perfiles,
    }],
    ...extra,
  });
}

/** Prende el aviso por gusto de un perfil en este dispositivo, con su zona y su franja. */
async function prender(api: APIRequestContext, c: Casa, push: Push, profile: string, tz: string, when: string) {
  const r = await api.post(`/api/cfg/${c.cfgId}/push/taste`, {
    headers: c.auth, data: { profile, endpoint: push.url, on: true, tz, when },
  });
  expect(r.ok()).toBe(true);
  // El perfil de prueba tiene un género de gusto prendido a mano (sin hábitos): Deportes.
  expect((await api.post(`/api/cfg/${c.cfgId}/push/taste`, { headers: c.auth, data: { profile, genre: 'Deportes', genreOn: true } })).ok()).toBe(true);
}

/** Corre la corrida programada del Worker (como el cron de Cloudflare). */
async function correrCron(api: APIRequestContext) {
  expect((await api.get('/cdn-cgi/local/scheduled')).ok()).toBe(true);
}

/** Para comprobar que NO llegó nada: la corrida corre en segundo plano (waitUntil), así que se le da un momento. */
const esperarCron = () => new Promise((r) => setTimeout(r, 1500));

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'escritorio', 'los avisos no dependen del viewport: corren una vez, en escritorio');
});

test('avisa en la franja: el programa de gusto llega cifrado solo a los dispositivos del perfil, y no repite el mismo día', async ({ api, push }) => {
  const c = await casa(api);
  const alias = await aliasDe(api, c);
  const titulo = 'Final de la liga';
  programa(alias, titulo);
  // Papá también tiene su aviso prendido, pero este dispositivo no está suscrito a Papá: no le llega nada.
  suscribir(c, push, [c.pA], { tastes: { [c.pB]: { on: true, off: [], plus: ['Deportes'], tz: zonaA(15), when: 'tarde', sent: [] } } });
  await prender(api, c, push, c.pA, zonaA(15), 'tarde');

  await correrCron(api);
  await expect.poll(() => push.hits.length, { timeout: 15_000 }).toBe(1);
  const aviso = descifrar(push.hits[0].body, push.ua, push.auth);
  expect(push.hits[0].headers['content-encoding']).toBe('aes128gcm');
  expect(aviso.title).toMatch(/^Hoy a las \d{2}:\d{2}: Final de la liga$/);
  expect(aviso.body).toBe('Deportes en ESPN. Es de lo que más mirás.');

  const estado = await (await api.get(`/api/cfg/${c.cfgId}/push/taste?profile=${c.pA}&endpoint=${encodeURIComponent(push.url)}`, { headers: c.auth })).json() as { sent: { title: string }[] };
  expect(estado.sent.map((s) => s.title)).toEqual([titulo]);

  // Ya salió uno hoy: el tope de 1 por día no deja mandar otro, aunque el programa siga siendo bueno.
  await correrCron(api);
  await esperarCron();
  expect(push.hits.length).toBe(1);
});

test('el tope de 3 por semana: con tres avisos en los últimos días, no llega otro', async ({ api, push }) => {
  const c = await casa(api);
  const alias = await aliasDe(api, c);
  programa(alias, 'Clásico del domingo');
  const sent = [1, 2, 3].map((d) => ({ title: `Aviso ${d}`, genre: 'Deportes', at: new Date(Date.now() - d * DAY_MS).toISOString(), epg: alias, name: 'ESPN', start: 1 }));
  suscribir(c, push, [c.pA], {
    tastes: { [c.pA]: { on: true, off: [], plus: ['Deportes'], tz: zonaA(15), when: 'tarde', sent } },
  });

  await correrCron(api);
  await esperarCron();
  expect(push.hits.length).toBe(0);
});

test('en silencio (fuera de la franja) no manda nada, aunque el programa sea bueno', async ({ api, push }) => {
  const c = await casa(api);
  const alias = await aliasDe(api, c);
  programa(alias, 'Partido de la noche');
  suscribir(c, push, [c.pA]);
  // Son las 23 en la zona de la persona y su franja es de mañana (9 a 13): no hay envío.
  await prender(api, c, push, c.pA, zonaA(23), 'manana');

  await correrCron(api);
  await esperarCron();
  expect(push.hits.length).toBe(0);
});

test('«No avisarme de…»: con el género apagado en el perfil, no llega ningún programa de ese género', async ({ api, push }) => {
  const c = await casa(api);
  const alias = await aliasDe(api, c);
  programa(alias, 'Partido sin aviso');
  suscribir(c, push, [c.pA]);
  await prender(api, c, push, c.pA, zonaA(15), 'tarde');
  const apagado = await api.post(`/api/cfg/${c.cfgId}/push/taste`, { headers: c.auth, data: { profile: c.pA, genre: 'Deportes', genreOn: false } });
  const vista = await apagado.json() as { genres: { name: string; on: boolean }[] };
  expect(vista.genres.filter((g) => g.on)).toEqual([]);

  await correrCron(api);
  await esperarCron();
  expect(push.hits.length).toBe(0);
});

test('«Menos así» sobre un aviso anterior apaga el género; «Deshacer» lo vuelve a prender y el aviso sale otra vez', async ({ api, push }) => {
  const c = await casa(api);
  const alias = await aliasDe(api, c);
  programa(alias, 'Partido de la semana');
  // Un aviso de hace dos días (no pega en el tope de hoy); la hoja del perfil lo muestra con «Menos así».
  const anterior = { title: 'Partido de antes', genre: 'Deportes', at: new Date(Date.now() - 2 * DAY_MS).toISOString(), epg: alias, name: 'ESPN', start: 1 };
  suscribir(c, push, [c.pA], {
    tastes: { [c.pA]: { on: true, off: [], plus: ['Deportes'], tz: zonaA(15), when: 'tarde', sent: [anterior] } },
  });
  const genero = (on: boolean) => api.post(`/api/cfg/${c.cfgId}/push/taste`, { headers: c.auth, data: { profile: c.pA, genre: 'Deportes', genreOn: on } });

  expect((await genero(false)).ok()).toBe(true);
  await correrCron(api);
  await esperarCron();
  expect(push.hits.length).toBe(0);

  expect((await genero(true)).ok()).toBe(true);
  await correrCron(api);
  await expect.poll(() => push.hits.length, { timeout: 15_000 }).toBe(1);
  expect(descifrar(push.hits[0].body, push.ua, push.auth).body).toBe('Deportes en ESPN. Es de lo que más mirás.');
});
