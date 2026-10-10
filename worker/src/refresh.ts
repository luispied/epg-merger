// La lista del proveedor la baja el relay (el proveedor bloquea a Cloudflare). Un canal que el proveedor agrega de golpe (un
// partido en PPV) tiene que llegar enseguida: cuando alguien pide la playlist y la lista guardada tiene más de
// STALE_AFTER_MS, el relay baja una nueva. La playlist de este pedido sale con lo que hay y la próxima ya viene al día.
import type { Env, SimpleCache } from './env.ts';
import { relayConfigured, relayList } from './relay.ts';

export const STALE_AFTER_MS = 10 * 60 * 1000;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

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
    await noteRelayList(env, cfgId, 'okAt', now);
    return true;
  } catch (e) {
    console.error('relay refresh', (e as Error).message);
    await noteRelayList(env, cfgId, 'failAt', now).catch(() => {});
    return false;
  }
}

/** Cuándo el relay bajó la lista por última vez y cuándo falló (`relaylist/<cfgId>.json`): la web avisa si la lista
 *  se queda vieja porque el relay no responde. */
export interface RelayListState { okAt?: string; failAt?: string }
async function noteRelayList(env: Env, cfgId: string, field: keyof RelayListState, now: Date) {
  const key = `relaylist/${cfgId}.json`;
  let prev: RelayListState = {};
  try {
    const obj = await env.BUCKET.get(key);
    if (obj) prev = JSON.parse(await obj.text()) as RelayListState;
  } catch { /* ilegible: se empieza de cero */ }
  await env.BUCKET.put(key, JSON.stringify({ ...prev, [field]: now.toISOString() }), JSON_TYPE);
}
