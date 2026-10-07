// Worker de Grilla (Etapa 1, ver planes/etapa-1-web-sin-github.md).
//
//   POST   /api/provider/list            lista del proveedor, de paso (nada se guarda)
//   POST   /api/cfg                      nueva configuración → {cfgId, editKey}
//   GET    /api/cfg/<cfgId>              (Bearer editKey) la configuración
//   PUT    /api/cfg/<cfgId>              (Bearer editKey) guardarla
//   DELETE /api/cfg/<cfgId>              (Bearer editKey) borrarla
//   POST   /api/cfg/<cfgId>/token        (Bearer editKey) credenciales → token y links
//   PUT    /api/cfg/<cfgId>/list         (Bearer editKey) subir la lista (proveedores que bloquean Cloudflare)
//   GET    /api/cfg/<cfgId>/list         (Bearer editKey) la última lista guardada (para editar en la web)
//   GET    /api/cfg/<cfgId>/status       (Bearer editKey) si la guía ya tiene los últimos cambios
//   POST   /api/cfg/<cfgId>/refresh      (Bearer editKey) aplicar ahora (lanza la corrida de GitHub)
//   GET    /api/push/key                 clave pública VAPID de los avisos push (404 si no están activados)
//   POST   /api/cfg/<cfgId>/push         (Bearer editKey) suscribir este navegador a los avisos · DELETE: darlo de baja
//   POST   /api/cfg/<cfgId>/push/test    (Bearer editKey) mandar un aviso de prueba
//   GET    /api/guide/index.json         índice de la guía para @grilla/core (R2)
//   GET    /api/ui/<archivo>             catálogo, logos y programación para la interfaz (R2)
//   GET    /p/<cfgId>/<token>/playlist.m3u8   playlist en vivo con las ediciones
//   GET    /p/<cfgId>/epg.xml.gz              guía de la configuración (la arma la corrida diaria)
//   GET    /s/<cfgId>/<token>/<id>.<ext>      302 al primer servidor sano del balanceador
//   GET    /l/<código>.m3u8 · /g/<código>.xml.gz · /s/<código>/<id>.<ext>
//                                              lo mismo con links cortos (short/<código>.json en R2)
import { authorized, ConfigError, createConfig, isId, loadConfig, MAX_CONFIG_BYTES, parseConfig, parseServers, saveConfig,
  type Config } from './config.ts';
import { addDevice, anyToken, cleanAccount, listDevices, rekeyDevices, readShort, tokenOfAccount, removeAllDevices, removeDevice, SHORT_RE, touchDevice, updateDevice } from './devices.ts';
import { decryptToken, encryptToken, randomId, type Credentials } from './crypto.ts';
import type { Ctx, Env, SimpleCache } from './env.ts';
import { dispatchRefresh, dispatchWorkflow } from './github.ts';
import { healthyServer } from './health.ts';
import { accountKey, isLinked, knownToGithub, linkConfig, linkHash } from './link.ts';
import { buildPlaylist, type DeviceFilter } from './playlist.ts';
import { refreshOnDemand, refreshViaRelay } from './refresh.ts';
import { relayConfigured, relayList } from './relay.ts';
import { checkAllHealth } from './streamcheck.ts';
import { addReminder, parseReminder, readReminders, removeReminder } from './remind.ts';
import { addSub, checkAllPush, currentNames, parseSubscription, pushConfigured, pushToConfig, removeSub } from './push.ts';
import { type Channel, loadM3u, loadXtream, normalizeServer, parseUploadedList, ProviderError, streamUrl } from './provider.ts';

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

/** Si GitHub ya conoce esta cuenta (está en XTREAM_PROFILES), anota la configuración para que baje su lista y pruebe sus datos. */
async function linkWithGithub(env: Env, ctx: Ctx, cache: SimpleCache, cfgId: string, username: string, password: string): Promise<void> {
  const hash = await linkHash(username, password);
  if (!(await knownToGithub(env.BUCKET, hash)) || (await isLinked(env.BUCKET, hash, cfgId))) return;
  await linkConfig(env.BUCKET, hash, cfgId);
  ctx.waitUntil(dispatchRefresh(env, cache));
}

/** Baja la lista ahora por el relay (credenciales de un dispositivo principal de la configuración); sin relay o sin dispositivo, lanza la corrida de GitHub. */
async function refreshNow(env: Env, cache: SimpleCache, cfgId: string, servers: string[]): Promise<void> {
  if (relayConfigured(env)) {
    const token = await anyToken(env.BUCKET, cfgId);
    const creds = token ? await decryptToken(env.TOKEN_KEY, cfgId, token) : null;
    if (creds && 'u' in creds && await refreshViaRelay(env, cache, cfgId, servers, creds.u, creds.p, undefined, new Date(), true)) return;
  }
  await dispatchRefresh(env, cache, { fresh_minutes: '5' });
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
    // La sube otro (GitHub o la app): el Worker no le pide nada al proveedor.
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
async function resolveShort(env: Env, ctx: Ctx, code: string): Promise<{ cfgId: string; token: string; off: boolean; filter?: DeviceFilter } | null> {
  const rec = await readShort(env.BUCKET, code);
  if (!rec) return null;
  const off = rec.active === false;
  if (!off) ctx.waitUntil(touchDevice(env.BUCKET, code, rec).catch(() => {}));
  return { cfgId: rec.cfgId, token: rec.token, off, filter: rec.filter };
}

/** Playlist de un link desactivado: un solo canal con el aviso, así el reproductor lo muestra (un error HTTP
 *  casi nunca llega a la pantalla). La guía y los streams siguen respondiendo 403. */
function disabledPlaylist(origin: string, code: string): Response {
  const text = `#EXTM3U\n#EXTINF:-1 tvg-id="" group-title="Grilla",⚠ Link desactivado: reactivalo en Grilla\n${origin}/s/${code}/desactivado.ts\n`;
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
    // Lista que baja GitHub: si tiene unos minutos, se pide una nueva para el próximo pedido (ver refresh.ts).
    if (cfg.provider.type === 'xtream' && cfg.provider.list === 'upload') {
      const provider = cfg.provider;
      ctx.waitUntil(env.BUCKET.head(r2ListKey(cfgId)).then((h) => relayConfigured(env) && 'u' in creds
        ? refreshViaRelay(env, cache, cfgId, provider.servers, creds.u, creds.p, h?.uploaded)
        : refreshOnDemand(env, cache, cfgId, h?.uploaded)).catch(() => false));
    }
  } catch (e) {
    return new Response(`El proveedor no respondió: ${(e as Error).message}`, { status: 502 });
  }
  let direct: string | null = null;
  if (cfg.provider.type === 'xtream' && 'u' in creds && cfg.directUrls) {
    direct = await healthyServer(cfg.provider.servers.map(normalizeServer), creds.u, creds.p, cache, (p) => ctx.waitUntil(p));
  }
  const text = buildPlaylist(list.channels, cfg, {
    filter,
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
      // Si el proveedor bloquea al Worker pero GitHub tiene esta cuenta, la lista la baja GitHub.
      // Si el proveedor bloquea al Worker pero hay un relay, la lista la baja el relay.
      if (body.type === 'xtream' && relayConfigured(env) && Array.isArray(body.servers)) {
        try {
          const { server, channels } = await relayList(env, body.servers.map(String), String(body.username), String(body.password));
          return json({ server, channels, viaRelay: true });
        } catch (re) {
          if (!(re instanceof ProviderError)) throw re;
        }
      }
      const github = body.type === 'xtream' && await knownToGithub(env.BUCKET, await linkHash(String(body.username), String(body.password)));
      return json({ error: e.message, github }, 502);
    }
    return fail(400, 'pedido inválido');
  }

  if (section === 'push' && cfgId === 'key' && method === 'GET') {
    return pushConfigured(env) ? json({ key: env.VAPID_PUBLIC_KEY }, 200, { 'Cache-Control': 'public, max-age=3600' }) : fail(404, 'avisos no activados');
  }

  if (section === 'cfg' && !cfgId && method === 'POST') {
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    const raw = await readJson(request) as Record<string, unknown>;
    const created = await createConfig(env.BUCKET, parseConfig(raw));
    // "link": usuario y contraseña, solo para la huella que conecta con GitHub (no se guardan).
    const link = raw.link as { username?: unknown; password?: unknown } | undefined;
    let github = false;
    if (link && typeof link.username === 'string' && typeof link.password === 'string') {
      const hash = await linkHash(link.username, link.password);
      if (await knownToGithub(env.BUCKET, hash)) {
        await linkConfig(env.BUCKET, hash, created.cfgId);
        github = true;
        ctx.waitUntil(dispatchRefresh(env, cache));
      }
    }
    return json({ ...created, github }, 201);
  }

  if (section === 'cfg' && cfgId) {
    const stored = await loadConfig(env.BUCKET, cfgId);
    if (!stored) return fail(404, 'configuración inexistente');
    if (!(await authorized(request, stored.keyHash))) return fail(401, 'clave de edición inválida');
    if (!action && method === 'GET') return json(stored.config);
    if (!action && method === 'PUT') {
      await saveConfig(env.BUCKET, cfgId, parseConfig(await readJson(request)), stored.keyHash);
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
      await env.BUCKET.delete(`remind/${cfgId}.json`);
      await removeAllDevices(env.BUCKET, cfgId);
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
      // Probar los canales a mano (corre en GitHub, tarda unos minutos): una vez por día, igual que la corrida de la madrugada.
      const { checked, requested } = await healthTimes(env.BUCKET, cfgId);
      const last = Math.max(checked ?? 0, requested ?? 0);
      const nowMs = Date.now();
      if (nowMs - last < HEALTH_EVERY_MS) {
        return json({ started: false, reason: 'recent', last: new Date(last).toISOString(), nextAt: new Date(last + HEALTH_EVERY_MS).toISOString() });
      }
      // Con relay, la prueba la hace el cron del Worker (healthreq/ es el pedido); sin relay, la corrida de GitHub.
      if (!relayConfigured(env) && !(await dispatchWorkflow(env, 'check-streams.yml'))) return json({ started: false, reason: env.GITHUB_TOKEN ? 'github' : 'no-token' });
      await env.BUCKET.put(`healthreq/${cfgId}.json`, JSON.stringify({ at: new Date(nowMs).toISOString() }), { httpMetadata: { contentType: 'application/json' } });
      return json({ started: true, requested: new Date(nowMs).toISOString() });
    }
    if (action === 'health' && method === 'GET') {
      // Canales caídos: lo deja la corrida diaria de GitHub (tools/check_streams.py). Sin corrida todavía, vacío.
      const saved = await env.BUCKET.get(`health/${cfgId}.json`);
      let data: Record<string, unknown> = { channels: {} };
      try {
        if (saved) data = JSON.parse(await saved.text()) as Record<string, unknown>;
      } catch { /* archivo ilegible: como si no hubiera */ }
      const { requested } = await healthTimes(env.BUCKET, cfgId);
      return json({ ...data, ...(requested ? { requested: new Date(requested).toISOString() } : {}) }, 200, { 'Cache-Control': 'no-store' });
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
        const devices = (await listDevices(env.BUCKET, cfgId)).map((d) => ({
          ...d, playlistUrl: `${origin}/l/${d.code}.m3u8`, epgUrl: `${origin}/g/${d.code}.xml.gz`,
        }));
        return json({ devices }, 200, { 'Cache-Control': 'no-store' });
      }
      if (code && SHORT_RE.test(code) && method === 'PATCH') {
        const body = await readJson(request, 4 * 1024) as Record<string, unknown>;
        return (await updateDevice(env.BUCKET, cfgId, code, { name: body.name, active: body.active, ...('filter' in body ? { filter: body.filter } : {}) })) ? json({ ok: true }) : fail(404, 'dispositivo inexistente');
      }
      if (code && SHORT_RE.test(code) && method === 'DELETE') {
        return (await removeDevice(env.BUCKET, cfgId, code)) ? json({ ok: true }) : fail(404, 'dispositivo inexistente');
      }
    }
    if (action === 'servers' && method === 'PUT') {
      // Cambió la dirección del servicio de IPTV (o falló): los links no cambian; los streams y la lista pasan a usar la nueva.
      if (stored.config.provider.type !== 'xtream') return fail(400, 'esta configuración usa una lista M3U: la dirección se cambia en «¿Cambiaron tus datos del proveedor?»');
      const body = await readJson(request, 4 * 1024) as { servers?: unknown };
      const servers = parseServers(typeof body.servers === 'string' ? body.servers.split(/[\s,]+/) : body.servers);
      await saveConfig(env.BUCKET, cfgId, { ...stored.config, provider: { ...stored.config.provider, servers } }, stored.keyHash);
      // La lista se vuelve a bajar enseguida, con los servidores nuevos: por el relay si hay uno (con las credenciales de
      // un dispositivo de la cuenta principal) y, si no, por la corrida de GitHub.
      ctx.waitUntil(refreshNow(env, cache, cfgId, servers));
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
      if ('u' in creds) {
        await linkWithGithub(env, ctx, cache, cfgId, creds.u, creds.p);
        if (!cleanAccount(raw.account) && stored.config.provider.type === 'xtream') ctx.waitUntil(refreshViaRelay(env, cache, cfgId, stored.config.provider.servers, creds.u, creds.p, undefined, new Date(), true));
      }
      return json({ ok: true, updated });
    }
    if (action === 'token' && method === 'POST') {
      const raw = await readJson(request, 16 * 1024) as Record<string, unknown>;
      // `account`: cuenta adicional (por ejemplo, la de un familiar). Sin datos del proveedor se reutiliza
      // la de un dispositivo que ya la tiene, así no hay que pedir usuario y contraseña de nuevo.
      const account = cleanAccount(raw.account);
      const hasCreds = raw.username !== undefined || raw.password !== undefined || raw.url !== undefined;
      let token: string;
      let key: string | undefined;
      if (account && !hasCreds) {
        const found = await tokenOfAccount(env.BUCKET, cfgId, account);
        if (!found) return fail(400, `no hay una cuenta «${account}»: cargá su usuario y contraseña`);
        ({ token, key } = found);
      } else {
        const creds = credentialsFrom(raw, stored.config);
        token = await encryptToken(env.TOKEN_KEY, cfgId, creds);
        if ('u' in creds) {
          key = await accountKey(creds.u, creds.p);
          await linkWithGithub(env, ctx, cache, cfgId, creds.u, creds.p);
        }
      }
      const origin = new URL(request.url).origin;
      const code = randomId(8);
      if (!(await addDevice(env.BUCKET, cfgId, token, raw.name, code, new Date(), raw.filter, account, key))) return fail(400, 'ya hay demasiados dispositivos: quitá alguno');
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

  if (section === 'guide' && cfgId === 'index.json' && method === 'GET') {
    return serveR2(env, 'guide/index.json', 'application/json', 3600);
  }
  if (section === 'ui' && method === 'GET') {
    const path = parts.slice(2).join('/');
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.json$/.test(path)) return fail(404, 'no encontrado');
    return serveR2(env, `ui/${path}`, 'application/json', 900);
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
      return new Response('Separador de sección de Grilla: no es un canal.\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (request.method === 'GET' && parts[0] === 'p' && isId(parts[1] ?? '')) {
      if (parts.length === 3 && parts[2] === 'epg.xml.gz') {
        return await serveR2(env, `epg/${parts[1]}.xml.gz`, 'application/gzip', 3600);
      }
      if (parts.length === 4 && parts[3] === 'playlist.m3u8') return await servePlaylist(parts[1], parts[2], url, env, ctx, cache);
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
      return await serveStream(short.cfgId, short.token, parts[2], env, ctx, cache);
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
