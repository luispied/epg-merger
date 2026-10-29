// Muestra de conexiones en uso por cuenta: lo que dice el proveedor (`active_cons`, por el relay), cada 10 minutos, desde
// el cron de 5 minutos. Guarda solo el número y la hora (nada de códigos, usuarios ni IPs) en conn/<cfgId>/<cuenta>.json,
// las últimas 24 h. Sirve para cruzar con play/: cuando sube el número, qué link abrió un canal justo antes. No toca los
// links de reproducción.
import { decryptToken } from './crypto.ts';
import { loadConfig } from './config.ts';
import { accountKey } from './account.ts';
import { accountTokens } from './devices.ts';
import type { Env } from './env.ts';
import { relayConfigured, relayPost } from './relay.ts';

export const CONN_EVERY_MS = 10 * 60 * 1000;
export const CONN_KEEP = 144; // 24 h a 10 min
const MAX_CONFIGS_PER_TICK = 20;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

export type { ConnPoint } from './connhist.ts';
import type { ConnPoint } from './connhist.ts';
import type { R2Bucket } from './env.ts';
export const connKey = (cfgId: string, account: string) => `conn/${cfgId}/${account}.json`;

/** Agrega un punto si el último tiene más de CONN_EVERY_MS; si no, null (no se escribe). Se queda con los últimos CONN_KEEP. */
export function appendPoint(points: ConnPoint[], p: ConnPoint, now: Date): ConnPoint[] | null {
  const last = points[points.length - 1];
  if (last && now.getTime() - Date.parse(last.t) < CONN_EVERY_MS) return null;
  return [...points, p].slice(-CONN_KEEP);
}

/** Las muestras guardadas de una cuenta (`account` es su huella, accountKey). */
export async function readPoints(bucket: R2Bucket, key: string): Promise<ConnPoint[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  try {
    const v = JSON.parse(await obj.text()) as unknown;
    return Array.isArray(v) ? v.filter((x): x is ConnPoint => typeof x?.t === 'string' && typeof x?.n === 'number') : [];
  } catch {
    return [];
  }
}

/** Toma una muestra de cada cuenta de la configuración que tenga links. Devuelve cuántas cuentas se muestrearon. */
export async function sampleConnections(env: Env, cfgId: string, now = new Date()): Promise<number> {
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored || stored.config.provider.type !== 'xtream') return 0;
  const servers = stored.config.provider.servers;
  let n = 0;
  await Promise.all((await accountTokens(env.BUCKET, cfgId)).map(async (t) => {
    const creds = await decryptToken(env.TOKEN_KEY, cfgId, t.token);
    if (!creds || !('u' in creds)) return;
    const { u, p } = creds as { u: string; p: string };
    const key = connKey(cfgId, await accountKey(u, p));
    const points = await readPoints(env.BUCKET, key);
    if (appendPoint(points, { t: now.toISOString(), n: 0 }, now) === null) return;
    try {
      const res = await relayPost<{ account?: { activeConnections?: unknown; maxConnections?: unknown } }>(env, '/v1/account',
        { servers, username: u, password: p }, 12_000);
      const active = res.account?.activeConnections;
      if (typeof active !== 'number') return;
      const max = res.account?.maxConnections;
      const next = appendPoint(points, { t: now.toISOString(), n: active, ...(typeof max === 'number' ? { max } : {}) }, now);
      if (!next) return;
      await env.BUCKET.put(key, JSON.stringify(next), JSON_TYPE);
      n++;
    } catch { /* el relay no contestó: queda para la próxima corrida */ }
  }));
  return n;
}

/** Muestrea las configuraciones con links (corrida de cada 5 minutos). Una configuración que falla no frena a las demás. */
export async function checkAllConnections(env: Env, now = new Date()): Promise<number> {
  if (!relayConfigured(env)) return 0;
  let done = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: 'devices/', cursor });
    for (const obj of page.objects) {
      if (done >= MAX_CONFIGS_PER_TICK) return done;
      const cfgId = obj.key.slice('devices/'.length).replace(/\.json$/, '');
      try {
        await sampleConnections(env, cfgId, now);
        done++;
      } catch { /* una configuración no frena a las demás */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return done;
}
