// Worker de Grilla (Etapa 1, ver planes/etapa-1-web-sin-github.md).
//
//   POST   /api/provider/list            lista del proveedor, de paso (nada se guarda)
//   POST   /api/cfg                      nueva configuración → {cfgId, editKey}
//   GET    /api/cfg/<cfgId>              (Bearer editKey) la configuración
//   PUT    /api/cfg/<cfgId>              (Bearer editKey) guardarla
//   DELETE /api/cfg/<cfgId>              (Bearer editKey) borrarla
//   POST   /api/cfg/<cfgId>/token        (Bearer editKey) credenciales → token y links
//   GET    /api/cfg/<cfgId>/accounts     (Bearer editKey) vencimiento y conexiones en uso de cada perfil, al momento (relay)
//   PUT    /api/cfg/<cfgId>/active       (Bearer editKey) perfil activo: con qué cuenta se prueban canales y se baja la lista
//   POST   /api/cfg/<cfgId>/devices/<código>/move  (Bearer editKey) pasar un link a otro perfil o proveedor (mismo código)
//   POST   /api/home                     nuevo hogar → {homeId, homeKey} · GET/PUT/DELETE /api/home/<homeId> (Bearer homeKey)
//   PUT    /api/cfg/<cfgId>/list         (Bearer editKey) subir la lista (proveedores que bloquean Cloudflare)
//   GET    /api/cfg/<cfgId>/list         (Bearer editKey) la última lista guardada (para editar en la web)
//   GET    /api/cfg/<cfgId>/status       (Bearer editKey) si la guía ya tiene los últimos cambios
//   POST   /api/cfg/<cfgId>/refresh      (Bearer editKey) aplicar ahora (lanza la corrida de GitHub)
//   GET    /api/push/key                 clave pública VAPID de los avisos push (404 si no están activados)
//   POST   /api/cfg/<cfgId>/push         (Bearer editKey) suscribir este navegador a los avisos · DELETE: darlo de baja
//   POST   /api/cfg/<cfgId>/push/test    (Bearer editKey) mandar un aviso de prueba
//   POST   /api/cfg/<cfgId>/profiles/<id>/view  (Bearer editKey) link «solo ver» del perfil → {code} · DELETE: quitarlo
//   GET    /api/view/<código>            canales del perfil para el modo «solo ver» (view.ts)
//   GET    /api/view/<código>/connections  conexiones en uso de su cuenta y qué está mirando cada link
//   POST   /api/view/<código>/report     {id, epg, title} «la guía no coincide» en un canal
//   GET    /api/cfg/<cfgId>/habits       (Bearer editKey) hábitos para «Tu noche» · POST {title, kind: no|more|clear}
//   GET    /api/view/<código>/habits     los del perfil · POST {title, kind} (habits.ts)
//   GET    /api/cfg/<cfgId>/reports      (Bearer editKey) los canales marcados · DELETE …/reports/<id>: ya está
//   GET    /api/guide/index.json         índice de la guía para @grilla/core (R2)
//   GET    /api/ui/schedule/<archivo>    programación para la interfaz (R2)
//   POST   /api/ui/again                 {ids} → cuándo vuelve a empezar lo que está en el aire (again.ts)
//   GET    /p/<cfgId>/<token>/playlist.m3u8   playlist en vivo con las ediciones
//   GET    /p/<cfgId>/epg.xml.gz              guía de la configuración (la arma la corrida diaria)
//   GET    /s/<cfgId>/<token>/<id>.<ext>      302 al primer servidor sano del balanceador
//   GET    /logo/<clave> · /img/<clave>       logo de canal o imagen de programa, sin mostrar el sitio (logos.ts)
//   GET    /l/<código>.m3u8 · /g/<código>.xml.gz · /s/<código>/<id>.<ext>
//                                              lo mismo con links cortos (short/<código>.json en R2)
import { authorized, ConfigError, createConfig, isId, loadConfig, MAX_CONFIG_BYTES, parseConfig, parseServers, saveConfig,
  type Config, type ProfileDef } from './config.ts';
import { ensureAccountKeys, ensureProfiles, findProfile, newProfileId } from './profiles.ts';
import { accountTokens, addDevice, anyToken, cleanAccount, listDevices, moveDevice, rekeyDevices, readShort, renameAccount, updateRecords, tokenOfAccount, removeAllDevices, removeDevice, SHORT_RE, touchDevice, notePlay, readPlay, updateDevice } from './devices.ts';
import { decryptToken, encryptToken, randomId, sha256Hex, type Credentials } from './crypto.ts';
import type { Ctx, Env, SimpleCache } from './env.ts';
import { dispatchRefresh } from './github.ts';
import { healthyServer } from './health.ts';
import { accountKey } from './account.ts';
import { logoResolver, serveMedia } from './logos.ts';
import { buildPlaylist, parseFilter, playlistRows, type DeviceFilter } from './playlist.ts';
import { addReport, createView, deleteReports, deleteView, readReports, readView, removeReport } from './view.ts';
import { refreshViaRelay } from './refresh.ts';
import { relayConfigured, relayList, relayPost } from './relay.ts';
import { checkAllHealth, liveAccounts } from './streamcheck.ts';
import { deleteHabits, feedbackHabit, noteHabit, readHabits, validFeedback } from './habits.ts';
import { createHome, loadHome, MAX_HOME_BYTES, parseHome, saveHome } from './home.ts';
import { againFor, validAgainIds } from './again.ts';
import { type Raw, readStored, scheduleReader } from './schedule.ts';
import { addReminder, parseReminder, readReminders, removeReminder } from './remind.ts';
import { addSub, checkAllPush, currentNames, parseSubscription, pushConfigured, pushToConfig, removeSub } from './push.ts';
import { type Channel, loadM3u, loadXtream, normalizeServer, parseUploadedList, ProviderError, streamUrl } from './provider.ts';

/** Misma cuenta del proveedor (vacío o sin dato = la principal). */
const sameAcc = (a: unknown, b: unknown) => (typeof a === 'string' ? a.trim() : '') === (typeof b === 'string' ? b.trim() : '');
const LIST_TTL_S = 3 * 3600;
const RATE_LIMIT = 20; // pedidos por minuto y por IP a lo que baja listas o crea configuraciones
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status: number, error: string) => json({ error }, status);

// Límite por IP en memoria del isolate: no es exacto (cada ubicación tiene el suyo), pero
// alcanza para que el Worker no sirva de proxy abierto para bajar listas.
const hits = new Map<string, number[]>();
export function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > RATE_LIMIT;
}

async function readJson(request: Request, limit = MAX_CONFIG_BYTES): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw new ConfigError('demasiado grande');
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError('JSON inválido');
  }
}

function credentialsFrom(body: Record<string, unknown>, cfg: Config): Credentials {
  if (cfg.provider.type === 'm3u') {
    if (typeof body.url !== 'string' || !body.url) throw new ConfigError('falta la URL de la lista');
    return { url: body.url };
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username) {
    throw new ConfigError('faltan usuario y contraseña');
  }
  return { u: body.username, p: body.password };
}

/** Baja la lista ahora por el relay, con las credenciales de un dispositivo del perfil activo (`active`) o de la principal. Sin relay o
 *  sin dispositivo no hace nada: la lista la vuelve a subir la persona (navegador o tools/grilla_home.py). */
async function refreshNow(env: Env, cache: SimpleCache, cfgId: string, servers: string[], active?: string): Promise<void> {
  if (!relayConfigured(env)) return;
  const token = await anyToken(env.BUCKET, cfgId, active);
  const creds = token ? await decryptToken(env.TOKEN_KEY, cfgId, token) : null;
  if (creds && 'u' in creds) await refreshViaRelay(env, cache, cfgId, servers, creds.u, creds.p, undefined, new Date(), true);
}

const listKey = (cfgId: string) => `https://grilla.internal/list/${cfgId}`;
const r2ListKey = (cfgId: string) => `list/${cfgId}.json`;

interface LiveList {
  server?: string;
  channels: Channel[];
}

/** La lista en vivo del proveedor. Xtream: guardada unas horas (sin credenciales ni URLs) y, si
 *  el proveedor no responde, la última que se pudo bajar. */
async function liveList(cfgId: string, cfg: Config, creds: Credentials, env: Env, ctx: Ctx, cache: SimpleCache): Promise<LiveList> {
  if (cfg.provider.type === 'm3u' || 'url' in creds) {
    // Las URLs de una lista M3U pueden llevar credenciales: no se guarda en ningún lado.
    return { channels: await loadM3u((creds as { url: string }).url) };
  }
  if (cfg.provider.list === 'upload') {
    // La baja el relay o la sube la persona (navegador o tools/grilla_home.py): el Worker no le pide nada al proveedor.
    const uploaded = await env.BUCKET.get(r2ListKey(cfgId));
    if (!uploaded) {
      // Todavía no hay lista: con relay se baja en este mismo pedido.
      if (relayConfigured(env)) {
        const fresh = await relayList(env, cfg.provider.servers, creds.u, creds.p);
        await env.BUCKET.put(r2ListKey(cfgId), JSON.stringify(fresh), { httpMetadata: { contentType: 'application/json' } });
        return fresh;
      }
      throw new ProviderError('la lista todavía no se subió');
    }
    return JSON.parse(await uploaded.text()) as LiveList;
  }
  const hit = await cache.match(listKey(cfgId));
  if (hit) return await hit.json() as LiveList;
  try {
    const fresh = await loadXtream(cfg.provider.servers, creds.u, creds.p);
    const body = JSON.stringify(fresh);
    ctx.waitUntil(cache.put(listKey(cfgId), new Response(body, { headers: { 'Cache-Control': `max-age=${LIST_TTL_S}` } })));
    ctx.waitUntil(env.BUCKET.put(r2ListKey(cfgId), body, { httpMetadata: { contentType: 'application/json' } }));
    return fresh;
  } catch (e) {
    const last = await env.BUCKET.get(r2ListKey(cfgId));
    if (last) return JSON.parse(await last.text()) as LiveList;
    throw e;
  }
}

// Links cortos: un código al azar que apunta a la configuración y al token. El token (las
// credenciales cifradas con la clave del Worker) queda guardado en R2 a cambio de links que
// no muestran nada: ni la configuración ni el token.
/** Resuelve un link corto y, ya que lo leyó, anota el último uso del dispositivo. */
async function resolveShort(env: Env, ctx: Ctx, code: string): Promise<{ cfgId: string; token: string; off: boolean; filter?: DeviceFilter; profile?: string } | null> {
  const rec = await readShort(env.BUCKET, code);
  if (!rec) return null;
  const off = rec.active === false;
  if (!off) ctx.waitUntil(touchDevice(env.BUCKET, code, rec).catch(() => {}));
  return { cfgId: rec.cfgId, token: rec.token, off, filter: rec.filter, profile: rec.profile };
}

/** Playlist de un link desactivado: un solo canal con el aviso, así el reproductor lo muestra (un error HTTP
 *  casi nunca llega a la pantalla). La guía y los streams siguen respondiendo 403. */
function disabledPlaylist(origin: string, code: string): Response {
  const text = `#EXTM3U\n#EXTINF:-1 tvg-id="" group-title="Nowline",⚠ Link desactivado: reactivalo en Nowline\n${origin}/s/${code}/desactivado.ts\n`;
  return new Response(text, { headers: { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function servePlaylist(cfgId: string, token: string, url: URL, env: Env, ctx: Ctx, cache: SimpleCache, short?: string, filter?: DeviceFilter): Promise<Response> {
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored) return new Response('Configuración inexistente', { status: 404 });
  const creds = await decryptToken(env.TOKEN_KEY, cfgId, token);
  if (!creds) return new Response('Link inválido', { status: 403 });
  const cfg = stored.config;
  let list: LiveList;
  try {
    list = await liveList(cfgId, cfg, creds, env, ctx, cache);
    // Lista guardada: si tiene unos minutos, el relay baja una nueva para el próximo pedido (ver refresh.ts).
    if (cfg.provider.type === 'xtream' && cfg.provider.list === 'upload' && relayConfigured(env) && 'u' in creds) {
      const provider = cfg.provider;
      ctx.waitUntil(env.BUCKET.head(r2ListKey(cfgId))
        .then((h) => refreshViaRelay(env, cache, cfgId, provider.servers, creds.u, creds.p, h?.uploaded)).catch(() => false));
    }
  } catch (e) {
    return new Response(`El proveedor no respondió: ${(e as Error).message}`, { status: 502 });
  }
  let direct: string | null = null;
  if (cfg.provider.type === 'xtream' && 'u' in creds && cfg.directUrls) {
    direct = await healthyServer(cfg.provider.servers.map(normalizeServer), creds.u, creds.p, cache, (p) => ctx.waitUntil(p));
  }
  const logos = Object.values(cfg.channels).map((e) => e.logo).filter((u): u is string => !!u);
  const logoUrl = await logoResolver(env, url.origin, logos);
  const text = buildPlaylist(list.channels, cfg, {
    filter,
    logoUrl,
    separatorUrl: `${url.origin}/sep`,
    epgUrl: short ? `${url.origin}/g/${short}.xml.gz` : `${url.origin}/p/${cfgId}/epg.xml.gz`,
    streamUrl: (ch) => {
      if (ch.url) return ch.url;
      if (direct && 'u' in creds) return streamUrl(direct, creds.u, creds.p, ch.id, ch.ext);
      return short ? `${url.origin}/s/${short}/${ch.id}.${ch.ext || 'm3u8'}` : `${url.origin}/s/${cfgId}/${token}/${ch.id}.${ch.ext || 'm3u8'}`;
    },
  });
  return new Response(text, { headers: { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Hábitos de «Tu noche» (habits.ts): el canal abierto, por su guía; sin guía no hay qué sugerir. */
async function playHabit(env: Env, cfgId: string, profile: string, ch: string): Promise<void> {
  const [list, stored] = await Promise.all([env.BUCKET.get(r2ListKey(cfgId)), loadConfig(env.BUCKET, cfgId)]);
  const found = list && stored ? (JSON.parse(await list.text()) as LiveList).channels.find((c) => c.id === ch) : undefined;
  const epg = found ? stored!.config.channels[found.name]?.epg : undefined;
  if (epg) await noteHabit(env.BUCKET, cfgId, profile, epg);
}

// Canales de proveedores que separan secciones (▀▀▀ DEPORTES ▀▀▀): no se miran.
const DIVIDER_RE = /[\u2580-\u259F]{2,}/;

/** El perfil de un código para ver (null si no existe o se quitó). */
async function viewProfile(env: Env, code: string): Promise<{ cfgId: string; cfg: Config; profile: ProfileDef } | null> {
  const rec = await readView(env.BUCKET, code);
  const stored = rec ? await loadConfig(env.BUCKET, rec.cfgId) : null;
  const profile = stored ? findProfile(stored.config, rec!.profile) : undefined;
  return stored && profile && profile.view === code ? { cfgId: rec!.cfgId, cfg: stored.config, profile } : null;
}

/** Modo «solo ver»: el nombre del perfil y sus canales (nombre, categoría, guía y logo por el Worker), en el orden de
 *  la playlist. Sin credenciales, cuentas ni links. Si el código se quitó, 404. */
async function serveView(code: string, url: URL, env: Env): Promise<Response> {
  const v = await viewProfile(env, code);
  if (!v) return fail(404, 'este código para ver ya no existe');
  const { cfg, profile } = v;
  const list = await env.BUCKET.get(r2ListKey(v.cfgId));
  if (!list) return fail(409, 'todavía no hay canales para mostrar');
  const logos = Object.values(cfg.channels).map((e) => e.logo).filter((u): u is string => !!u);
  const rows = playlistRows((JSON.parse(await list.text()) as LiveList).channels, cfg,
    { filter: profile.filter, logoUrl: await logoResolver(env, url.origin, logos), providerLogos: false });
  // Como en la web: una categoría decorativa, o una con un solo canal que se llama igual, es un separador.
  const rawGroup = (r: (typeof rows)[number]) => cfg.channels[r.ch!.name]?.group || r.ch!.category;
  const size = new Map<string, number>();
  for (const r of rows) if (r.ch) size.set(rawGroup(r), (size.get(rawGroup(r)) ?? 0) + 1);
  const channels = rows
    .filter((r) => r.ch && !DIVIDER_RE.test(rawGroup(r)) && !(size.get(rawGroup(r)) === 1 && (cfg.channels[r.ch.name]?.name || r.ch.name) === rawGroup(r)))
    .map((r) => ({ id: r.ch!.id, name: r.name, cat: r.group, epg: r.epg, logo: r.logo, ...(r.quiet ? { quiet: true } : {}) }));
  return json({ name: profile.name, channels }, 200, { 'Cache-Control': 'private, max-age=60' });
}

/** Un link «mira» si abrió un canal en las últimas 3 horas (como en Conexiones de la web). */
const WATCHING_MS = 3 * 3600 * 1000;

/** Modo «solo ver»: conexiones en uso de la cuenta del perfil (por el relay, si hay) y qué está mirando cada link de esa
 *  cuenta. Solo el nombre del link, el canal y cuándo lo abrió: ni códigos ni direcciones. */
async function serveViewConnections(code: string, env: Env, ctx: Ctx, cache: SimpleCache): Promise<Response> {
  const key = `https://grilla.internal/view-conn/${code}`;
  const hit = await cache.match(key);
  if (hit) return json(JSON.parse(await hit.text()), 200, { 'Cache-Control': 'no-store' });
  const v = await viewProfile(env, code);
  if (!v) return fail(404, 'este código para ver ya no existe');
  const { cfgId, cfg, profile } = v;
  const devices = (await listDevices(env.BUCKET, cfgId)).filter((d) => d.active && sameAcc(d.account, profile.account));
  const plays = await Promise.all(devices.map((d) => readPlay(env.BUCKET, d.code).catch(() => null)));
  const list = await env.BUCKET.get(r2ListKey(cfgId));
  const names = new Map<string, string>();
  if (list) for (const ch of (JSON.parse(await list.text()) as LiveList).channels) names.set(ch.id, cfg.channels[ch.name]?.name || ch.name);
  const now = Date.now();
  const watching = devices.map((d, i) => ({ d, p: plays[i] }))
    .filter(({ p }) => p && now - Date.parse(p.t) < WATCHING_MS)
    .sort((a, b) => b.p!.t.localeCompare(a.p!.t))
    .map(({ d, p }) => ({ name: d.name, channel: names.get(p!.ch) ?? 'Un canal', t: p!.t }));
  let inUse: number | undefined;
  let max: number | undefined;
  if (relayConfigured(env) && cfg.provider.type === 'xtream') {
    const t = (await accountTokens(env.BUCKET, cfgId, profile.account)).find((x) => sameAcc(x.account, profile.account));
    const creds = t ? await decryptToken(env.TOKEN_KEY, cfgId, t.token) : null;
    if (creds && 'u' in creds) {
      try {
        const res = await relayPost<{ account?: { activeConnections?: unknown; maxConnections?: unknown } }>(env, '/v1/account',
          { servers: cfg.provider.servers, username: creds.u, password: creds.p }, 12_000);
        if (typeof res.account?.activeConnections === 'number') inUse = res.account.activeConnections;
        if (typeof res.account?.maxConnections === 'number') max = res.account.maxConnections;
      } catch { /* sin datos del proveedor: quedan los links */ }
    }
  }
  const body = { ...(inUse !== undefined ? { inUse } : {}), ...(max ? { max } : {}), watching };
  // Se pide cada minuto mientras la página está abierta: un minuto de caché para no ir al proveedor de más.
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=60' } })));
  return json(body, 200, { 'Cache-Control': 'no-store' });
}

async function serveStream(cfgId: string, token: string, file: string, env: Env, ctx: Ctx, cache: SimpleCache): Promise<Response> {
  const m = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{1,6})$/.exec(file);
  if (!m) return new Response('No encontrado', { status: 404 });
  const creds = await decryptToken(env.TOKEN_KEY, cfgId, token);
  if (!creds || !('u' in creds)) return new Response('Link inválido', { status: 403 });
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored || stored.config.provider.type !== 'xtream') return new Response('Configuración inexistente', { status: 404 });
  const server = await healthyServer(stored.config.provider.servers.map(normalizeServer), creds.u, creds.p, cache,
    (p) => ctx.waitUntil(p));
  return new Response(null, { status: 302, headers: { Location: streamUrl(server, creds.u, creds.p, m[1], m[2]), 'Cache-Control': 'no-store' } });
}

/** JSON de R2 que la corrida puede guardar en gzip: viaja así, sin descomprimirlo acá (src/schedule.ts). */
function storedResponse(raw: Raw | null, maxAge: number): Response {
  if (!raw) return fail(404, 'no encontrado');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}`, ...CORS };
  if (raw.gz) headers['Content-Encoding'] = 'gzip';
  return new Response(raw.bytes, { headers, encodeBody: 'manual' } as ResponseInit);
}

async function serveR2(env: Env, key: string, contentType: string, maxAge: number): Promise<Response> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return fail(404, 'no encontrado');
  return new Response(obj.body, { headers: { 'Content-Type': contentType, 'Cache-Control': `public, max-age=${maxAge}`, ...CORS } });
}

/** La prueba de canales corre como mucho una vez cada 20 horas (cron de la madrugada y a mano). */
const HEALTH_EVERY_MS = 20 * 3600 * 1000;
async function healthTimes(bucket: Env['BUCKET'], cfgId: string): Promise<{ checked?: number; requested?: number }> {
  const time = async (key: string, field: string) => {
    const obj = await bucket.get(key);
    if (!obj) return undefined;
    try {
      const t = Date.parse(String((JSON.parse(await obj.text()) as Record<string, unknown>)[field] ?? ''));
      return Number.isNaN(t) ? undefined : t;
    } catch {
      return undefined;
    }
  };
  return { checked: await time(`health/${cfgId}.json`, 'checked'), requested: await time(`healthreq/${cfgId}.json`, 'at') };
}

async function api(request: Request, parts: string[], env: Env, ip: string, ctx: Ctx, cache: SimpleCache): Promise<Response> {
  const method = request.method;
  const [, section, cfgId, action] = parts; // ['api', section, …]

  if (section === 'provider' && cfgId === 'list' && method === 'POST') {
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const body = await readJson(request, 64 * 1024) as Record<string, unknown>;
    try {
      if (body.type === 'm3u' && typeof body.url === 'string') {
        return json({ channels: (await loadM3u(body.url)).map(({ url: _url, ...ch }) => ch) });
      }
      if (body.type === 'xtream' && Array.isArray(body.servers) && typeof body.username === 'string' && typeof body.password === 'string') {
        // User-Agent opcional: para diagnosticar proveedores que filtran por él (worker_smoke.py).
        const ua = typeof body.userAgent === 'string' && body.userAgent ? body.userAgent.slice(0, 120) : undefined;
        const { server, channels } = await loadXtream(body.servers.map(String), body.username, body.password, ua);
        return json({ server, channels });
      }
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      // Si el proveedor bloquea al Worker pero hay un relay, la lista la baja el relay.
      if (body.type === 'xtream' && relayConfigured(env) && Array.isArray(body.servers)) {
        try {
          const { server, channels } = await relayList(env, body.servers.map(String), String(body.username), String(body.password));
          return json({ server, channels, viaRelay: true });
        } catch (re) {
          if (!(re instanceof ProviderError)) throw re;
        }
      }
      return json({ error: e.message }, 502);
    }
    return fail(400, 'pedido inválido');
  }

  if (section === 'push' && cfgId === 'key' && method === 'GET') {
    return pushConfigured(env) ? json({ key: env.VAPID_PUBLIC_KEY }, 200, { 'Cache-Control': 'public, max-age=3600' }) : fail(404, 'avisos no activados');
  }

  if (section === 'cfg' && !cfgId && method === 'POST') {
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const raw = await readJson(request) as Record<string, unknown>;
    return json(await createConfig(env.BUCKET, parseConfig(raw)), 201);
  }

  if (section === 'home') {
    // Hogar: todas las configuraciones de una persona bajo una clave. El Worker guarda solo lo que cifra el navegador.
    if (!cfgId && method === 'POST') {
      if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
      return json(await createHome(env.BUCKET, parseHome(await readJson(request, MAX_HOME_BYTES))), 201);
    }
    if (cfgId && !action) {
      const home = await loadHome(env.BUCKET, cfgId);
      if (!home) return fail(404, 'hogar inexistente');
      if (!(await authorized(request, home.keyHash))) return fail(401, 'clave del hogar inválida');
      if (method === 'GET') return json(home.data, 200, { 'Cache-Control': 'no-store' });
      if (method === 'PUT') {
        await saveHome(env.BUCKET, cfgId, parseHome(await readJson(request, MAX_HOME_BYTES)), home.keyHash);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.BUCKET.delete(`home/${cfgId}.json`);
        return json({ ok: true });
      }
    }
  }

  if (section === 'cfg' && cfgId) {
    const stored = await loadConfig(env.BUCKET, cfgId);
    if (!stored) return fail(404, 'configuración inexistente');
    if (!(await authorized(request, stored.keyHash))) return fail(401, 'clave de edición inválida');
    if (!action && method === 'GET') return json(stored.config);
    if (!action && method === 'PUT') {
      const raw = await readJson(request) as Record<string, unknown>;
      // El perfil activo se cambia con PUT …/active; una web que no lo conoce no lo borra.
      // El perfil activo y el nombre del principal se cambian con sus propias rutas: si la web no los manda, se conservan.
      const keep = Object.fromEntries((['activeAccount', 'mainName'] as const).filter((k) => !(k in raw) && stored.config[k]).map((k) => [k, stored.config[k]]));
      // Los perfiles los maneja el Worker (rutas …/profiles): siempre quedan los guardados.
      const config = parseConfig({ ...raw, ...keep, profiles: stored.config.profiles });
      await saveConfig(env.BUCKET, cfgId, config, stored.keyHash);
      // La guía de esta configuración se vuelve a armar con los cambios.
      ctx.waitUntil(dispatchRefresh(env, cache));
      return json({ ok: true });
    }
    if (!action && method === 'DELETE') {
      await env.BUCKET.delete(`cfg/${cfgId}.json`);
      await env.BUCKET.delete(`list/${cfgId}.json`);
      await env.BUCKET.delete(`epg/${cfgId}.xml.gz`);
      await env.BUCKET.delete(`health/${cfgId}.json`);
      await env.BUCKET.delete(`healthreq/${cfgId}.json`);
      await env.BUCKET.delete(`relaylist/${cfgId}.json`);
      await env.BUCKET.delete(`remind/${cfgId}.json`);
      await deleteHabits(env.BUCKET, cfgId);
      await removeAllDevices(env.BUCKET, cfgId);
      for (const pr of stored.config.profiles ?? []) await deleteView(env.BUCKET, pr.view);
      await deleteReports(env.BUCKET, cfgId);
      return json({ ok: true });
    }
    if (action === 'status' && method === 'GET') {
      // La playlist usa la configuración al instante; la guía la arma la corrida de GitHub.
      const [cfgObj, epgObj, listObj] = await Promise.all([
        env.BUCKET.head(`cfg/${cfgId}.json`), env.BUCKET.head(`epg/${cfgId}.xml.gz`), env.BUCKET.head(`list/${cfgId}.json`),
      ]);
      const iso = (o: { uploaded: Date } | null) => (o ? o.uploaded.toISOString() : null);
      return json({
        config: iso(cfgObj), guide: iso(epgObj), list: iso(listObj),
        guideUpToDate: !!(cfgObj && epgObj && epgObj.uploaded >= cfgObj.uploaded),
        autoRefresh: !!env.GITHUB_TOKEN,
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'refresh' && method === 'POST') {
      return json({ started: await dispatchRefresh(env, cache), autoRefresh: !!env.GITHUB_TOKEN });
    }
    if (action === 'health' && parts[4] === 'run' && method === 'POST') {
      // Probar los canales a mano (lo hace el cron del Worker por el relay): una vez por día, igual que la prueba de la madrugada.
      const { checked, requested } = await healthTimes(env.BUCKET, cfgId);
      const last = Math.max(checked ?? 0, requested ?? 0);
      const nowMs = Date.now();
      if (nowMs - last < HEALTH_EVERY_MS) {
        return json({ started: false, reason: 'recent', last: new Date(last).toISOString(), nextAt: new Date(last + HEALTH_EVERY_MS).toISOString() });
      }
      // La prueba la hace el cron del Worker (healthreq/ es el pedido). Sin relay no hay cómo.
      if (!relayConfigured(env)) return json({ started: false, reason: 'no-relay' });
      await env.BUCKET.put(`healthreq/${cfgId}.json`, JSON.stringify({ at: new Date(nowMs).toISOString() }), { httpMetadata: { contentType: 'application/json' } });
      return json({ started: true, requested: new Date(nowMs).toISOString() });
    }
    if (action === 'health' && method === 'GET') {
      // Canales caídos: lo deja la prueba diaria del cron del Worker (streamcheck.ts). Sin prueba todavía, vacío.
      const saved = await env.BUCKET.get(`health/${cfgId}.json`);
      let data: Record<string, unknown> = { channels: {} };
      try {
        if (saved) data = JSON.parse(await saved.text()) as Record<string, unknown>;
      } catch { /* archivo ilegible: como si no hubiera */ }
      const { requested } = await healthTimes(env.BUCKET, cfgId);
      // La lista: cuándo se guardó y cómo le fue al relay al bajarla (para avisar si se queda vieja).
      const listHead = await env.BUCKET.head(r2ListKey(cfgId));
      let relayList: Record<string, unknown> = {};
      try {
        const rl = await env.BUCKET.get(`relaylist/${cfgId}.json`);
        if (rl) relayList = JSON.parse(await rl.text()) as Record<string, unknown>;
      } catch { /* ilegible: sin datos */ }
      return json({
        ...data, ...(requested ? { requested: new Date(requested).toISOString() } : {}),
        ...(listHead?.uploaded ? { listAt: listHead.uploaded.toISOString() } : {}),
        ...(relayList.okAt ? { listOkAt: relayList.okAt } : {}), ...(relayList.failAt ? { listFailAt: relayList.failAt } : {}),
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'list' && method === 'GET') {
      const saved = await env.BUCKET.get(r2ListKey(cfgId));
      if (!saved) return fail(404, 'todavía no hay lista guardada');
      return new Response(saved.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
    }
    if (action === 'list' && method === 'PUT') {
      let list: LiveList;
      try {
        list = parseUploadedList(await readJson(request, 16 * 1024 * 1024));
      } catch (e) {
        if (e instanceof ProviderError) return fail(400, e.message);
        throw e;
      }
      await env.BUCKET.put(r2ListKey(cfgId), JSON.stringify(list), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, channels: list.channels.length });
    }
    if (action === 'push') {
      if (!pushConfigured(env)) return fail(404, 'avisos no activados');
      const sub = parts[4];
      if (!sub && method === 'POST') {
        const parsed = parseSubscription(await readJson(request, 8 * 1024));
        if (!parsed) return fail(400, 'suscripción inválida');
        await addSub(env.BUCKET, cfgId, parsed, await currentNames(env.BUCKET, cfgId));
        return json({ ok: true });
      }
      if (!sub && method === 'DELETE') {
        const body = await readJson(request, 8 * 1024) as { endpoint?: unknown };
        if (typeof body.endpoint === 'string') await removeSub(env.BUCKET, cfgId, body.endpoint);
        return json({ ok: true });
      }
      if (sub === 'test' && method === 'POST') {
        return json({ sent: await pushToConfig(env, cfgId, { title: 'Avisos activados', body: 'Te avisamos cuando haya canales nuevos en tu lista.', url: '/' }) });
      }
    }
    if (action === 'habits') {
      // Hábitos de «Tu noche» (habits.ts): los de la casa, y los pedidos del editor.
      if (method === 'GET') return json(await readHabits(env.BUCKET, cfgId), 200, { 'Cache-Control': 'no-store' });
      if (method === 'POST') {
        const body = await readJson(request, 4 * 1024) as Record<string, unknown>;
        if (!validFeedback(body)) return fail(400, 'pedido inválido');
        await feedbackHabit(env.BUCKET, cfgId, '', body.title, body.kind);
        return json(await readHabits(env.BUCKET, cfgId));
      }
    }
    if (action === 'reports') {
      // «La guía no coincide», marcado desde el modo ver: se listan y se dan por resueltos (view.ts).
      if (method === 'GET') return json({ items: await readReports(env.BUCKET, cfgId) }, 200, { 'Cache-Control': 'no-store' });
      if (method === 'DELETE' && parts[4]) {
        await removeReport(env.BUCKET, cfgId, parts[4]);
        return json({ ok: true });
      }
    }
    if (action === 'remind') {
      if (!pushConfigured(env)) return fail(404, 'avisos no activados');
      const nowS = Math.floor(Date.now() / 1000);
      if (method === 'GET') {
        const items = (await readReminders(env.BUCKET, cfgId)).filter((r) => r.start > nowS);
        return json({ items }, 200, { 'Cache-Control': 'no-store' });
      }
      if (method === 'POST') {
        const item = parseReminder(await readJson(request, 4 * 1024), nowS);
        if (!item) return fail(400, 'recordatorio inválido (el programa ya empezó o falta demasiado)');
        return (await addReminder(env.BUCKET, cfgId, item, nowS)) ? json({ ok: true }) : fail(400, 'ya hay demasiados recordatorios: esperá a que pasen algunos');
      }
      if (method === 'DELETE') {
        const body = await readJson(request, 4 * 1024) as { epg?: unknown; start?: unknown };
        if (typeof body.epg === 'string' && typeof body.start === 'number') await removeReminder(env.BUCKET, cfgId, body.epg, Math.floor(body.start));
        return json({ ok: true });
      }
    }
    if (action === 'devices') {
      const origin = new URL(request.url).origin;
      const code = parts[4];
      if (!code && method === 'GET') {
        // Los links de antes (sin perfil) pasan a uno, según su cuenta y su filtro.
        // Una sola lectura de los links; se vuelve a leer solo si alguno de los dos pasos los cambió.
        let list = await listDevices(env.BUCKET, cfgId);
        const config = await ensureProfiles(env.BUCKET, cfgId, stored.config, stored.keyHash, list);
        // Y los que no tenían la huella de su cuenta la reciben (para ver su vencimiento y sus conexiones).
        const keyed = await ensureAccountKeys(env.BUCKET, env.TOKEN_KEY, cfgId, config, list);
        if (keyed || config !== stored.config) list = await listDevices(env.BUCKET, cfgId);
        const plays = await Promise.all(list.map((d) => readPlay(env.BUCKET, d.code).catch(() => null)));
        const devices = list.map((d, i) => ({
          ...d, ...(plays[i] ? { lastPlay: plays[i] } : {}), playlistUrl: `${origin}/l/${d.code}.m3u8`, epgUrl: `${origin}/g/${d.code}.xml.gz`,
        }));
        return json({ devices, profiles: config.profiles ?? [], activeAccount: config.activeAccount ?? '', mainName: config.mainName ?? '' }, 200, { 'Cache-Control': 'no-store' });
      }
      if (code && SHORT_RE.test(code) && method === 'PATCH') {
        const body = await readJson(request, 4 * 1024) as Record<string, unknown>;
        return (await updateDevice(env.BUCKET, cfgId, code, { name: body.name, active: body.active, ...('filter' in body ? { filter: body.filter } : {}) })) ? json({ ok: true }) : fail(404, 'dispositivo inexistente');
      }
      if (code && SHORT_RE.test(code) && method === 'DELETE') {
        return (await removeDevice(env.BUCKET, cfgId, code)) ? json({ ok: true }) : fail(404, 'dispositivo inexistente');
      }
      if (code && SHORT_RE.test(code) && parts[5] === 'move' && method === 'POST') {
        // Pasar el link a otro perfil de esta configuración o a otra configuración (otro proveedor, con su clave de
        // edición en `toKey`). El código no cambia: la dirección del link es la misma y el reproductor no se toca.
        const raw = await readJson(request, 16 * 1024) as Record<string, unknown>;
        const to = typeof raw.to === 'string' && raw.to ? raw.to : cfgId;
        let target = stored;
        if (to !== cfgId) {
          const other = await loadConfig(env.BUCKET, to);
          if (!other) return fail(404, 'la configuración de destino no existe');
          if (typeof raw.toKey !== 'string' || (await sha256Hex(raw.toKey)) !== other.keyHash) return fail(401, 'clave de edición del destino inválida');
          target = other;
        }
        // Con `profile` (un perfil del destino), la cuenta y el filtro salen de ese perfil.
        const prof = 'profile' in raw ? findProfile(target.config, raw.profile) : undefined;
        if ('profile' in raw && !prof) return fail(404, 'el perfil de destino no existe');
        const account = prof ? prof.account : cleanAccount(raw.account);
        const hasCreds = raw.username !== undefined || raw.password !== undefined || raw.url !== undefined;
        // El token está atado a su configuración: el de un link del perfil de destino o, si no tiene, las credenciales.
        let found = hasCreds ? null : await tokenOfAccount(env.BUCKET, to, account);
        if (!found) {
          if (!hasCreds) return fail(400, `${account ? `el perfil «${account}»` : 'la cuenta principal'} no tiene links: cargá su usuario y contraseña`);
          const creds = credentialsFrom(raw, target.config);
          found = { token: await encryptToken(env.TOKEN_KEY, to, creds), ...('u' in creds ? { key: await accountKey(creds.u, creds.p) } : {}) };
        }
        return (await moveDevice(env.BUCKET, code, cfgId, to, found.token, account, found.key, prof ? { id: prof.id, filter: prof.filter } : undefined))
          ? json({ ok: true }) : fail(400, 'no se pudo mover: el link no es de esta configuración o el destino ya tiene demasiados dispositivos');
      }
    }
    if (action === 'accounts' && method === 'GET') {
      // Vencimiento y conexiones en uso de cada perfil, al momento (por el relay); `live: false` = sin relay.
      return json({ live: relayConfigured(env), accounts: await liveAccounts(env, cfgId, stored.config) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'active' && method === 'PUT') {
      // Cambiar el perfil activo: la lista y la prueba de canales caídos pasan a hacerse con esa cuenta. La prueba se
      // pide enseguida (la toma el cron), aunque ya se haya hecho hoy con el perfil anterior.
      const raw = await readJson(request, 4 * 1024) as Record<string, unknown>;
      const account = cleanAccount(raw.account);
      if (account && !(await tokenOfAccount(env.BUCKET, cfgId, account))) return fail(400, `no hay un perfil «${account}»`);
      const { activeAccount: _prev, ...rest } = stored.config;
      const config = { ...rest, ...(account ? { activeAccount: account } : {}) };
      await saveConfig(env.BUCKET, cfgId, config, stored.keyHash);
      if ((_prev ?? '') !== (account ?? '')) {
        if (relayConfigured(env)) {
          await env.BUCKET.put(`healthreq/${cfgId}.json`, JSON.stringify({ at: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
        }
        if (config.provider.type === 'xtream') ctx.waitUntil(refreshNow(env, cache, cfgId, config.provider.servers, account));
      }
      return json({ ok: true, activeAccount: account ?? '' });
    }
    if (action === 'account-name' && method === 'PUT') {
      // Cambiar el nombre de una cuenta. `from` vacío = la principal (se guarda en la configuración); otro = el
      // `account` de sus links y perfiles, que se reescribe sin tocar el código ni el token: los links no cambian.
      const raw = await readJson(request, 4 * 1024) as Record<string, unknown>;
      const from = cleanAccount(raw.from);
      const to = cleanAccount(raw.to);
      if (to && to !== from && (await tokenOfAccount(env.BUCKET, cfgId, to))) return fail(400, `ya hay un perfil «${to}»`);
      if (!from) {
        const { mainName: _m, ...rest } = stored.config;
        await saveConfig(env.BUCKET, cfgId, { ...rest, ...(to ? { mainName: to } : {}) }, stored.keyHash);
        return json({ ok: true, renamed: 0 });
      }
      if (!to) return fail(400, 'falta el nombre nuevo');
      const inProfiles = (stored.config.profiles ?? []).some((p) => p.account === from);
      const renamed = await renameAccount(env.BUCKET, cfgId, from, to);
      if (!renamed && !inProfiles) return fail(404, `no hay una cuenta «${from}»`);
      const profiles = stored.config.profiles?.map((p) => (p.account === from ? { ...p, account: to } : p));
      await saveConfig(env.BUCKET, cfgId, { ...stored.config, ...(profiles ? { profiles } : {}), ...(stored.config.activeAccount === from ? { activeAccount: to } : {}) }, stored.keyHash);
      return json({ ok: true, renamed });
    }
    if (action === 'profiles') {
      // Perfiles: dentro de una cuenta, un nombre y qué ve. Sus links llevan una copia del filtro, que se reescribe al
      // cambiarlo. Borrar un perfil pasa sus links a otro: nunca se borra un link.
      const config = await ensureProfiles(env.BUCKET, cfgId, stored.config, stored.keyHash);
      const profiles = [...(config.profiles ?? [])];
      const save = (list: ProfileDef[]) => saveConfig(env.BUCKET, cfgId, { ...config, profiles: list }, stored.keyHash);
      const raw = method === 'GET' ? {} : await readJson(request, 64 * 1024) as Record<string, unknown>;
      const pid = parts[4];
      const cleanProfileName = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 30) : '');
      if (!pid && method === 'POST') {
        const name = cleanProfileName(raw.name);
        if (!name) return fail(400, 'falta el nombre del perfil');
        if (profiles.length >= 50) return fail(400, 'ya hay demasiados perfiles');
        const account = cleanAccount(raw.account);
        const filter = parseFilter(raw.filter);
        const p: ProfileDef = { id: newProfileId(), name, ...(account ? { account } : {}), ...(filter ? { filter } : {}) };
        await save([...profiles, p]);
        return json({ ok: true, profile: p });
      }
      const p = findProfile(config, pid);
      if (!p) return fail(404, 'perfil inexistente');
      if (parts[5] === 'view') {
        // Link «solo ver»: uno por perfil. Crearlo de nuevo devuelve el mismo; quitarlo lo invalida (los links de
        // reproducción no cambian).
        if (method === 'POST') {
          if (p.view && await readView(env.BUCKET, p.view)) return json({ code: p.view });
          const code = await createView(env.BUCKET, cfgId, p.id);
          await save(profiles.map((x) => (x.id === p.id ? { ...x, view: code } : x)));
          return json({ code });
        }
        if (method === 'DELETE') {
          await deleteView(env.BUCKET, p.view);
          await save(profiles.map((x) => (x.id === p.id ? (({ view: _v, ...rest }) => rest)(x) : x)));
          return json({ ok: true });
        }
        return fail(405, 'método no permitido');
      }
      if (method === 'PUT') {
        const next: ProfileDef = { ...p };
        if ('name' in raw) next.name = cleanProfileName(raw.name) || p.name;
        if ('filter' in raw) {
          const f = parseFilter(raw.filter);
          if (f) next.filter = f;
          else delete next.filter;
        }
        let moved = 0;
        if ('account' in raw && !sameAcc(raw.account, p.account)) {
          // Pasar el perfil (y sus links) a otra cuenta: los links toman el token de esa cuenta; su dirección no cambia.
          const account = cleanAccount(raw.account);
          const found = await tokenOfAccount(env.BUCKET, cfgId, account);
          if (!found) return fail(400, `${account ? `la cuenta «${account}»` : 'la cuenta principal'} no tiene links: no hay con qué reproducir`);
          if (account) next.account = account;
          else delete next.account;
          moved = await updateRecords(env.BUCKET, cfgId, (rec) => {
            if (rec.profile !== p.id) return null;
            const { account: _a, key: _k, ...rest } = rec;
            return { ...rest, token: found.token, ...(account ? { account } : {}), ...(found.key ? { key: found.key } : {}) };
          });
        }
        if ('filter' in raw) {
          await updateRecords(env.BUCKET, cfgId, (rec) => {
            if (rec.profile !== p.id) return null;
            const { filter: _f, ...rest } = rec;
            return { ...rest, ...(next.filter ? { filter: next.filter } : {}) };
          });
        }
        await save(profiles.map((x) => (x.id === p.id ? next : x)));
        return json({ ok: true, profile: next, moved });
      }
      if (method === 'DELETE') {
        // Sus links pasan a `to` (otro perfil; si es de otra cuenta, con el token de esa cuenta).
        const dest = findProfile(config, raw.to);
        const links = (await listDevices(env.BUCKET, cfgId)).filter((d) => d.profile === p.id);
        if (links.length) {
          if (!dest || dest.id === p.id) return fail(400, 'elegí a qué perfil pasan sus links');
          const found = sameAcc(dest.account, p.account) ? null : await tokenOfAccount(env.BUCKET, cfgId, dest.account);
          if (!sameAcc(dest.account, p.account) && !found) return fail(400, 'la cuenta de ese perfil no tiene links: no hay con qué reproducir');
          await updateRecords(env.BUCKET, cfgId, (rec) => {
            if (rec.profile !== p.id) return null;
            const { filter: _f, profile: _p, ...rest } = rec;
            const base = found ? (({ account: _a, key: _k, ...r }) => ({ ...r, token: found.token, ...(dest.account ? { account: dest.account } : {}), ...(found.key ? { key: found.key } : {}) }))(rest) : rest;
            return { ...base, profile: dest.id, ...(dest.filter ? { filter: dest.filter } : {}) };
          });
        }
        await deleteView(env.BUCKET, p.view);
        await save(profiles.filter((x) => x.id !== p.id));
        return json({ ok: true, moved: links.length });
      }
    }
    if (action === 'servers' && method === 'PUT') {
      // Cambió la dirección del servicio de IPTV (o falló): los links no cambian; los streams y la lista pasan a usar la nueva.
      if (stored.config.provider.type !== 'xtream') return fail(400, 'esta configuración usa una lista M3U: la dirección se cambia en «¿Cambiaron tus datos del proveedor?»');
      const body = await readJson(request, 4 * 1024) as { servers?: unknown };
      const servers = parseServers(typeof body.servers === 'string' ? body.servers.split(/[\s,]+/) : body.servers);
      await saveConfig(env.BUCKET, cfgId, { ...stored.config, provider: { ...stored.config.provider, servers } }, stored.keyHash);
      // La lista se vuelve a bajar enseguida, con los servidores nuevos, por el relay (con las credenciales de un
      // dispositivo de la cuenta principal).
      ctx.waitUntil(refreshNow(env, cache, cfgId, servers, stored.config.activeAccount));
      return json({ ok: true, servers });
    }
    if (action === 'credentials' && method === 'PUT') {
      // Cambió el usuario, la contraseña o la URL de la lista: los links ya creados siguen con
      // el mismo código y pasan a usar los datos nuevos.
      // Con `account`, solo los de esa cuenta adicional; sin eso, los de la cuenta principal.
      const raw = await readJson(request, 16 * 1024) as Record<string, unknown>;
      const creds = credentialsFrom(raw, stored.config);
      const key = 'u' in creds ? await accountKey(creds.u, creds.p) : undefined;
      const updated = await rekeyDevices(env.BUCKET, cfgId, await encryptToken(env.TOKEN_KEY, cfgId, creds), cleanAccount(raw.account), key);
      if ('u' in creds && (cleanAccount(raw.account) ?? '') === (stored.config.activeAccount ?? '') && stored.config.provider.type === 'xtream') {
        ctx.waitUntil(refreshViaRelay(env, cache, cfgId, stored.config.provider.servers, creds.u, creds.p, undefined, new Date(), true));
      }
      return json({ ok: true, updated });
    }
    if (action === 'token' && method === 'POST') {
      const raw = await readJson(request, 16 * 1024) as Record<string, unknown>;
      // `account`: cuenta adicional (por ejemplo, la de un familiar). Sin datos del proveedor se reutiliza
      // la de un dispositivo que ya la tiene, así no hay que pedir usuario y contraseña de nuevo.
      // `profile`: el link nuevo va a ese perfil (su cuenta y su filtro).
      const prof = 'profile' in raw ? findProfile(stored.config, raw.profile) : undefined;
      if ('profile' in raw && !prof) return fail(404, 'perfil inexistente');
      const account = prof ? prof.account : cleanAccount(raw.account);
      const hasCreds = raw.username !== undefined || raw.password !== undefined || raw.url !== undefined;
      let token: string;
      let key: string | undefined;
      if (!hasCreds) {
        // Sin datos: los de otro link del mismo perfil (también de la principal, si ya tiene alguno).
        const found = await tokenOfAccount(env.BUCKET, cfgId, account);
        if (!found) return fail(400, account ? `no hay una cuenta «${account}»: cargá su usuario y contraseña` : 'cargá el usuario y la contraseña de tu cuenta');
        ({ token, key } = found);
      } else {
        const creds = credentialsFrom(raw, stored.config);
        token = await encryptToken(env.TOKEN_KEY, cfgId, creds);
        if ('u' in creds) key = await accountKey(creds.u, creds.p);
      }
      const origin = new URL(request.url).origin;
      const code = randomId(8);
      if (!(await addDevice(env.BUCKET, cfgId, token, raw.name, code, new Date(), prof ? prof.filter : raw.filter, account, key, prof?.id))) return fail(400, 'ya hay demasiados dispositivos: quitá alguno');
      return json({
        token,
        code,
        playlistUrl: `${origin}/l/${code}.m3u8`,
        epgUrl: `${origin}/g/${code}.xml.gz`,
        longPlaylistUrl: `${origin}/p/${cfgId}/${token}/playlist.m3u8`,
        longEpgUrl: `${origin}/p/${cfgId}/epg.xml.gz`,
      });
    }
  }

  if (section === 'view' && cfgId && !action && method === 'GET') return await serveView(cfgId, new URL(request.url), env);
  if (section === 'view' && cfgId && action === 'connections' && method === 'GET') return await serveViewConnections(cfgId, env, ctx, cache);
  if (section === 'view' && cfgId && action === 'habits') {
    // Hábitos del perfil para «Tu noche» y sus «No me interesa» / «Más como esto» (habits.ts).
    if (method === 'POST' && rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const v = await viewProfile(env, cfgId);
    if (!v) return fail(404, 'este código para ver ya no existe');
    if (method === 'GET') return json(await readHabits(env.BUCKET, v.cfgId, v.profile.id), 200, { 'Cache-Control': 'no-store' });
    if (method === 'POST') {
      const body = await readJson(request, 4 * 1024) as Record<string, unknown>;
      if (!validFeedback(body)) return fail(400, 'pedido inválido');
      return json(await feedbackHabit(env.BUCKET, v.cfgId, v.profile.id, body.title, body.kind));
    }
  }
  if (section === 'view' && cfgId && action === 'report' && method === 'POST') {
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const v = await viewProfile(env, cfgId);
    if (!v) return fail(404, 'este código para ver ya no existe');
    const body = await readJson(request, 4 * 1024) as Record<string, unknown>;
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) return fail(400, 'canal inválido');
    const list = await env.BUCKET.get(r2ListKey(v.cfgId));
    const ch = list ? (JSON.parse(await list.text()) as LiveList).channels.find((c) => c.id === body.id) : undefined;
    if (!ch) return fail(404, 'ese canal no está en la lista');
    const edit = v.cfg.channels[ch.name] ?? {};
    await addReport(env.BUCKET, v.cfgId, {
      id: ch.id, name: edit.name || ch.name, epg: edit.epg ?? null, by: v.profile.name, at: new Date().toISOString(),
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim().slice(0, 120) } : {}),
    });
    return json({ ok: true });
  }
  if (section === 'guide' && cfgId === 'index.json' && method === 'GET') {
    return storedResponse(await readStored(env.BUCKET, 'guide/index.json'), 3600);
  }
  if (section === 'ui' && cfgId === 'again' && method === 'POST') {
    const body = await readJson(request, 32 * 1024) as Record<string, unknown>;
    if (!validAgainIds(body?.ids)) return fail(400, 'ids inválidos');
    const ids = [...new Set(body.ids)].sort();
    const now = Math.floor(Date.now() / 1000);
    // Cambia poco: la misma lista de canales comparte la respuesta por 15 minutos.
    const key = `https://grilla.internal/again/${await sha256Hex(ids.join(','))}/${Math.floor(now / 900)}`;
    const hit = await cache.match(key);
    if (hit) return json({ ids, r: JSON.parse(await hit.text()) });
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const r = await againFor(env.BUCKET, ids, now);
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(r), { headers: { 'Cache-Control': 'max-age=900' } })));
    return json({ ids, r });
  }
  if (section === 'ui' && method === 'GET') {
    // Solo la programación: lo demás que quedó en ui/ (catálogo, uso de fuentes) nombra las fuentes y la web no lo usa.
    const path = parts.slice(2).join('/');
    const hour = /^schedule\/hour\/[0-9]{10}(-d)?\.json$/.test(path);
    const channel = /^schedule\/([0-9a-f]{16})\.json$/.exec(path)?.[1];
    if (!hour && !channel) return fail(404, 'no encontrado');
    return storedResponse(hour ? await readStored(env.BUCKET, `ui/${path}`) : await scheduleReader(env.BUCKET)(channel!), 900);
  }
  return fail(404, 'no encontrado');
}

export async function handle(request: Request, env: Env, ctx: Ctx, cache: SimpleCache): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.TOKEN_KEY) {
    // Sin la clave no se pueden armar ni leer links (ver worker/README.md → TOKEN_KEY).
    return fail(503, 'falta configurar TOKEN_KEY (tipo Secret) en el Worker');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  try {
    if (parts[0] === 'api') return await api(request, parts, env, ip, ctx, cache);
    // Lo que apunta el canal de aviso de un separador: no hay nada para reproducir.
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'sep') {
      return new Response('Separador de sección de Nowline: no es un canal.\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (request.method === 'GET' && parts[0] === 'p' && isId(parts[1] ?? '')) {
      if (parts.length === 3 && parts[2] === 'epg.xml.gz') {
        return await serveR2(env, `epg/${parts[1]}.xml.gz`, 'application/gzip', 3600);
      }
      if (parts.length === 4 && parts[3] === 'playlist.m3u8') return await servePlaylist(parts[1], parts[2], url, env, ctx, cache);
    }
    if (request.method === 'GET' && (parts[0] === 'logo' || parts[0] === 'img') && parts.length === 2) {
      return await serveMedia(env, parts[0], parts[1]);
    }
    if (request.method === 'GET' && parts[0] === 's' && parts.length === 4 && isId(parts[1])) {
      return await serveStream(parts[1], parts[2], parts[3], env, ctx, cache);
    }
    if (request.method === 'GET' && parts.length === 2 && ['l', 'g'].includes(parts[0])) {
      const m = /^([^.]+)\.(m3u8|xml\.gz)$/.exec(parts[1]);
      const short = m && ((parts[0] === 'l') === (m[2] === 'm3u8')) ? await resolveShort(env, ctx, m[1]) : null;
      if (!short) return fail(404, 'no encontrado');
      if (short.off) return parts[0] === 'l' ? disabledPlaylist(url.origin, m![1]) : fail(403, 'link desactivado');
      if (parts[0] === 'g') return await serveR2(env, `epg/${short.cfgId}.xml.gz`, 'application/gzip', 3600);
      return await servePlaylist(short.cfgId, short.token, url, env, ctx, cache, m![1], short.filter);
    }
    if (request.method === 'GET' && parts[0] === 's' && parts.length === 3) {
      const short = await resolveShort(env, ctx, parts[1]);
      if (!short) return new Response('No encontrado', { status: 404 });
      if (short.off) return new Response('Link desactivado', { status: 403 });
      const res = await serveStream(short.cfgId, short.token, parts[2], env, ctx, cache);
      const ch = /^([A-Za-z0-9_-]{1,64})\./.exec(parts[2])?.[1];
      if (res.status === 302 && ch) {
        ctx.waitUntil(notePlay(env.BUCKET, parts[1], ch)
          .then((noted) => (noted ? playHabit(env, short.cfgId, short.profile ?? '', ch) : undefined)).catch(() => {}));
      }
      return res;
    }
    return fail(404, 'no encontrado');
  } catch (e) {
    if (e instanceof ConfigError) return fail(400, e.message);
    // Sin detalles: un error inesperado podría arrastrar datos del pedido.
    console.error('error', (e as Error)?.name);
    return fail(500, 'error interno');
  }
}

declare const caches: { default: SimpleCache };

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(request, env, ctx, caches.default);
  },
  // Corrida programada (wrangler.toml → [triggers]): avisa los canales nuevos de las listas.
  scheduled(_event: unknown, env: Env, ctx: Ctx): void {
    ctx.waitUntil(checkAllPush(env).catch(() => {}).then(() => checkAllHealth(env)));
  },
};
