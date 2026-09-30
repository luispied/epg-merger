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
//   GET    /api/guide/index.json         índice de la guía para @grilla/core (R2)
//   GET    /api/ui/<archivo>             catálogo, logos y programación para la interfaz (R2)
//   GET    /p/<cfgId>/<token>/playlist.m3u8   playlist en vivo con las ediciones
//   GET    /p/<cfgId>/epg.xml.gz              guía de la configuración (la arma la corrida diaria)
//   GET    /s/<cfgId>/<token>/<id>.<ext>      302 al primer servidor sano del balanceador
import { authorized, ConfigError, createConfig, isId, loadConfig, MAX_CONFIG_BYTES, parseConfig, saveConfig,
  type Config } from './config.ts';
import { decryptToken, encryptToken, type Credentials } from './crypto.ts';
import type { Ctx, Env, SimpleCache } from './env.ts';
import { healthyServer } from './health.ts';
import { buildPlaylist } from './playlist.ts';
import { type Channel, loadM3u, loadXtream, normalizeServer, parseUploadedList, ProviderError, streamUrl } from './provider.ts';

const LIST_TTL_S = 3 * 3600;
const RATE_LIMIT = 20; // pedidos por minuto y por IP a lo que baja listas o crea configuraciones
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
    if (!uploaded) throw new ProviderError('la lista todavía no se subió');
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

async function servePlaylist(cfgId: string, token: string, url: URL, env: Env, ctx: Ctx, cache: SimpleCache): Promise<Response> {
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored) return new Response('Configuración inexistente', { status: 404 });
  const creds = await decryptToken(env.TOKEN_KEY, cfgId, token);
  if (!creds) return new Response('Link inválido', { status: 403 });
  const cfg = stored.config;
  let list: LiveList;
  try {
    list = await liveList(cfgId, cfg, creds, env, ctx, cache);
  } catch (e) {
    return new Response(`El proveedor no respondió: ${(e as Error).message}`, { status: 502 });
  }
  let direct: string | null = null;
  if (cfg.provider.type === 'xtream' && 'u' in creds && cfg.directUrls) {
    direct = await healthyServer(cfg.provider.servers.map(normalizeServer), creds.u, creds.p, cache, (p) => ctx.waitUntil(p));
  }
  const text = buildPlaylist(list.channels, cfg, {
    epgUrl: `${url.origin}/p/${cfgId}/epg.xml.gz`,
    streamUrl: (ch) => {
      if (ch.url) return ch.url;
      if (direct && 'u' in creds) return streamUrl(direct, creds.u, creds.p, ch.id, ch.ext);
      return `${url.origin}/s/${cfgId}/${token}/${ch.id}.${ch.ext || 'm3u8'}`;
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

async function api(request: Request, parts: string[], env: Env, ip: string): Promise<Response> {
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
      if (e instanceof ProviderError) return fail(502, e.message);
      throw e;
    }
    return fail(400, 'pedido inválido');
  }

  if (section === 'cfg' && !cfgId && method === 'POST') {
    if (rateLimited(ip)) return fail(429, 'demasiados pedidos, probá en un minuto');
    return json(await createConfig(env.BUCKET, parseConfig(await readJson(request))), 201);
  }

  if (section === 'cfg' && cfgId) {
    const stored = await loadConfig(env.BUCKET, cfgId);
    if (!stored) return fail(404, 'configuración inexistente');
    if (!(await authorized(request, stored.keyHash))) return fail(401, 'clave de edición inválida');
    if (!action && method === 'GET') return json(stored.config);
    if (!action && method === 'PUT') {
      await saveConfig(env.BUCKET, cfgId, parseConfig(await readJson(request)), stored.keyHash);
      return json({ ok: true });
    }
    if (!action && method === 'DELETE') {
      await env.BUCKET.delete(`cfg/${cfgId}.json`);
      await env.BUCKET.delete(`list/${cfgId}.json`);
      await env.BUCKET.delete(`epg/${cfgId}.xml.gz`);
      return json({ ok: true });
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
    if (action === 'token' && method === 'POST') {
      const creds = credentialsFrom(await readJson(request, 16 * 1024) as Record<string, unknown>, stored.config);
      const token = await encryptToken(env.TOKEN_KEY, cfgId, creds);
      const origin = new URL(request.url).origin;
      return json({ token, playlistUrl: `${origin}/p/${cfgId}/${token}/playlist.m3u8`, epgUrl: `${origin}/p/${cfgId}/epg.xml.gz` });
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
    if (parts[0] === 'api') return await api(request, parts, env, ip);
    if (request.method === 'GET' && parts[0] === 'p' && isId(parts[1] ?? '')) {
      if (parts.length === 3 && parts[2] === 'epg.xml.gz') {
        return await serveR2(env, `epg/${parts[1]}.xml.gz`, 'application/gzip', 3600);
      }
      if (parts.length === 4 && parts[3] === 'playlist.m3u8') return await servePlaylist(parts[1], parts[2], url, env, ctx, cache);
    }
    if (request.method === 'GET' && parts[0] === 's' && parts.length === 4 && isId(parts[1])) {
      return await serveStream(parts[1], parts[2], parts[3], env, ctx, cache);
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
};
