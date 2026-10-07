// La lista del proveedor la baja GitHub (refresh-lists.yml: el proveedor bloquea a Cloudflare), cada 3 horas. Un canal que el
// proveedor agrega de golpe (un partido en PPV) tardaba hasta 3 horas en llegar. Ahora, cuando alguien pide la playlist y la
// lista guardada tiene más de STALE_AFTER_MS, el Worker lanza la corrida con ese umbral: la playlist de este pedido sale con
// lo que hay y la próxima ya viene al día. Solo gasta minutos de Actions cuando alguien usa la lista, y con topes:
// una vez cada STALE_AFTER_MS por configuración y MAX_PER_DAY por día en total.
import type { Env, SimpleCache } from './env.ts';
import { dispatchWorkflow } from './github.ts';
import { relayConfigured, relayList } from './relay.ts';

export const STALE_AFTER_MS = 10 * 60 * 1000;
export const MAX_PER_DAY = 12;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

/** Lanza el refresco si hace falta. Devuelve true si lo lanzó. `uploaded` = cuándo se subió la lista guardada. */
export async function refreshOnDemand(env: Env, cache: SimpleCache, cfgId: string, uploaded: Date | undefined, now = new Date()): Promise<boolean> {
  if (!env.GITHUB_TOKEN || !uploaded || now.getTime() - uploaded.getTime() < STALE_AFTER_MS) return false;
  const key = `https://grilla.internal/ondemand-refresh/${cfgId}`;
  if (await cache.match(key)) return false;
  await cache.put(key, new Response('1', { headers: { 'Cache-Control': `max-age=${STALE_AFTER_MS / 1000}` } }));
  const day = now.toISOString().slice(0, 10);
  const counterKey = `ondemand/${day}.json`;
  let n = 0;
  const obj = await env.BUCKET.get(counterKey);
  if (obj) {
    try {
      n = Number((JSON.parse(await obj.text()) as { n?: unknown }).n) || 0;
    } catch { /* contador ilegible: se empieza de cero */ }
  }
  if (n >= MAX_PER_DAY) return false;
  await env.BUCKET.put(counterKey, JSON.stringify({ n: n + 1 }), JSON_TYPE);
  return dispatchWorkflow(env, 'refresh-lists.yml', { fresh_minutes: String(STALE_AFTER_MS / 60000) });
}

/** La lista de la configuración, bajada por el relay y guardada en R2 (la playlist de esta persona sale con la lista
 *  vieja y la próxima ya viene al día). Una vez cada STALE_AFTER_MS por configuración. Devuelve true si la renovó. */
export async function refreshViaRelay(env: Env, cache: SimpleCache, cfgId: string, servers: string[], username: string, password: string,
  uploaded: Date | undefined, now = new Date(), force = false): Promise<boolean> {
  if (!relayConfigured(env)) return false;
  if (!force && uploaded && now.getTime() - uploaded.getTime() < STALE_AFTER_MS) return false;
  const key = `https://grilla.internal/relay-refresh/${cfgId}`;
  if (!force && await cache.match(key)) return false;
  await cache.put(key, new Response('1', { headers: { 'Cache-Control': `max-age=${STALE_AFTER_MS / 1000}` } }));
  try {
    const list = await relayList(env, servers, username, password);
    if (!list.channels.length) return false;
    await env.BUCKET.put(`list/${cfgId}.json`, JSON.stringify(list), JSON_TYPE);
    return true;
  } catch (e) {
    console.error('relay refresh', (e as Error).message);
    return false;
  }
}
