// Logos de la guía servidos por el Worker (/logo/<clave>): quien mira la web o el reproductor no ve de qué sitio
// vienen. La corrida diaria deja en R2 `logo/map.json` ({clave: url}, privado, ver source_alias.py); el primer
// pedido de cada logo lo baja de su sitio y lo guarda en `logo/img/<clave>`, los siguientes salen de R2.
import { sha256Hex } from './crypto.ts';
import type { Env } from './env.ts';

export const LOGO_RE = /^[0-9a-f]{16}$/;
const MAP_TTL_MS = 3600 * 1000;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;
const CACHE = 'public, max-age=2592000, immutable';
// Un SVG abierto directo no puede correr scripts en el dominio del Worker.
const imageHeaders = (type: string) => ({
  'Content-Type': type, 'Cache-Control': CACHE, 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
});

/** La misma clave que logo_key en source_alias.py. */
export const logoKey = async (url: string) => (await sha256Hex(`grilla-logo\n${url}`)).slice(0, 16);

let mapCache: { at: number; map: Promise<Record<string, string>> } | null = null;

/** {clave: url} de la corrida diaria, guardado una hora por instancia del Worker. */
export function logoMap(env: Env, now = Date.now()): Promise<Record<string, string>> {
  if (!mapCache || now - mapCache.at > MAP_TTL_MS) {
    const map = env.BUCKET.get('logo/map.json')
      .then(async (o) => (o ? JSON.parse(await o.text()) as Record<string, string> : {}))
      .catch(() => ({}));
    mapCache = { at: now, map };
  }
  return mapCache.map;
}

/** Para los tests. */
export const resetLogoMap = () => void (mapCache = null);

/** Traduce los logos de la guía a su dirección en el Worker. Los que ya vienen como /logo/… (los guarda así la web)
 *  pasan a absolutos; los que no son de la guía (uno propio, el del proveedor) quedan como están. */
export async function logoResolver(env: Env, origin: string, urls: Iterable<string>): Promise<(url: string) => string> {
  const map = await logoMap(env);
  const out = new Map<string, string>();
  await Promise.all([...new Set(urls)].map(async (u) => {
    if (u.startsWith('/logo/')) out.set(u, origin + u);
    else if (/^https?:\/\//.test(u)) {
      const key = await logoKey(u);
      if (map[key] === u) out.set(u, `${origin}/logo/${key}`);
    }
  }));
  return (u) => out.get(u) ?? u;
}

export async function serveLogo(env: Env, key: string): Promise<Response> {
  if (!LOGO_RE.test(key)) return new Response('No encontrado', { status: 404 });
  const saved = await env.BUCKET.get(`logo/img/${key}`);
  if (saved) {
    return new Response(saved.body, { headers: imageHeaders(saved.customMetadata?.type || 'image/png') });
  }
  const url = (await logoMap(env))[key];
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
  if (body.byteLength > MAX_BYTES) return new Response('Demasiado grande', { status: 502 });
  await env.BUCKET.put(`logo/img/${key}`, body, { customMetadata: { type } });
  return new Response(body, { headers: imageHeaders(type) });
}
