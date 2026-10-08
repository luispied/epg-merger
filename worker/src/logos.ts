// Imágenes de la guía servidas por el Worker: quien mira la web o el reproductor no ve de qué sitio vienen.
//   /logo/<clave>  logo de canal: el primer pedido lo baja de su sitio y lo guarda en R2 (`logo/img/<clave>`).
//   /img/<clave>   imagen de programa: se baja y se entrega de paso, sin guardarla (son muchas y cambian a diario).
// La corrida diaria deja en R2 los mapas privados {clave: url} (`logo/map/<x>.json`, `img/map/<xx>.json`,
// ver source_alias.py); el Worker lee solo el archivo de la clave que le piden.
import { sha256Hex } from './crypto.ts';
import type { Env } from './env.ts';

export type MediaKind = 'logo' | 'img';
export const MEDIA_RE = /^[0-9a-f]{16}$/;
const SHARD: Record<MediaKind, number> = { logo: 1, img: 2 };
const MAX_BYTES: Record<MediaKind, number> = { logo: 512 * 1024, img: 2 * 1024 * 1024 };
const MAP_TTL_MS = 3600 * 1000;
// Un mapa que todavía no está en R2 se vuelve a buscar enseguida: si no, un logo pedido antes de que
// suba quedaba en 404 una hora entera.
const MISSING_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 8000;
const CACHE = 'public, max-age=2592000, immutable';
// Un SVG abierto directo no puede correr scripts en el dominio del Worker.
const imageHeaders = (type: string) => ({
  'Content-Type': type, 'Cache-Control': CACHE, 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
});

/** La misma clave que logo_key en source_alias.py. */
export const mediaKey = async (url: string) => (await sha256Hex(`grilla-logo\n${url}`)).slice(0, 16);

const shards = new Map<string, { at: number; ttl: number; map: Promise<Record<string, string>> }>();

/** {clave: url} del archivo del mapa de esa clave, guardado una hora por instancia del Worker. */
function mapFor(env: Env, kind: MediaKind, key: string, now = Date.now()): Promise<Record<string, string>> {
  const name = `${kind}/map/${key.slice(0, SHARD[kind])}.json`;
  let hit = shards.get(name);
  if (!hit || now - hit.at > hit.ttl) {
    const entry = { at: now, ttl: MAP_TTL_MS, map: Promise.resolve({}) as Promise<Record<string, string>> };
    entry.map = env.BUCKET.get(name)
      .then(async (o) => {
        if (!o) entry.ttl = MISSING_TTL_MS;
        return o ? JSON.parse(await o.text()) as Record<string, string> : {};
      })
      .catch(() => { entry.ttl = MISSING_TTL_MS; return {}; });
    hit = entry;
    shards.set(name, hit);
  }
  return hit.map;
}

/** Para los tests. */
export const resetMediaMaps = () => shards.clear();

/** Traduce los logos de canal que eligió la guía a su dirección en el Worker. Los que ya vienen como /logo/… (los
 *  guarda así la web) pasan a absolutos; una URL vieja, si está en el mapa. Lo demás queda como está. */
export async function logoResolver(env: Env, origin: string, urls: Iterable<string>): Promise<(url: string) => string> {
  const out = new Map<string, string>();
  await Promise.all([...new Set(urls)].map(async (u) => {
    if (/^\/logo\/[0-9a-f]{16}$/.test(u)) out.set(u, origin + u);
    else if (/^https?:\/\//.test(u)) {
      const key = await mediaKey(u);
      if ((await mapFor(env, 'logo', key))[key] === u) out.set(u, `${origin}/logo/${key}`);
    }
  }));
  return (u) => out.get(u) ?? u;
}

export async function serveMedia(env: Env, kind: MediaKind, key: string): Promise<Response> {
  if (!MEDIA_RE.test(key)) return new Response('No encontrado', { status: 404 });
  const stored = `logo/img/${key}`;
  if (kind === 'logo') {
    const saved = await env.BUCKET.get(stored);
    if (saved) return new Response(saved.body, { headers: imageHeaders(saved.customMetadata?.type || 'image/png') });
  }
  const url = (await mapFor(env, kind, key))[key];
  if (!url) return new Response('No encontrado', { status: 404 });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return new Response('No disponible', { status: 502 });
  }
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !type.startsWith('image/')) return new Response('No disponible', { status: 502 });
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES[kind]) return new Response('Demasiado grande', { status: 502 });
  if (kind === 'logo') await env.BUCKET.put(stored, body, { customMetadata: { type } });
  return new Response(body, { headers: imageHeaders(type) });
}
