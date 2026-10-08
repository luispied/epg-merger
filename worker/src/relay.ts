// Relay de Grilla (ver ../relay/README.md): el proveedor bloquea los pedidos que salen de Cloudflare, así que, si hay un
// relay configurado (RELAY_URL y RELAY_SECRET), el Worker le manda las credenciales de la persona (las descifra de su
// link) y el relay hace el pedido desde otra IP. No guarda nada. Sin relay, la lista la sube la persona (navegador o
// tools/grilla_home.py) y no hay prueba de canales.
import type { Env } from './env.ts';
import { type Channel, parseUploadedList, ProviderError } from './provider.ts';

const TIMEOUT_MS = 25_000;

export const relayConfigured = (env: Env): boolean => !!env.RELAY_URL && !!env.RELAY_SECRET;

/** Un pedido al relay. Lanza ProviderError (sin datos de la cuenta) si no contesta o rechaza. */
export async function relayPost<T>(env: Env, path: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (!relayConfigured(env)) throw new ProviderError('no hay relay configurado');
  let res: Response;
  try {
    res = await fetch(`${env.RELAY_URL!.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RELAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError('el relay no respondió');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(((await res.json()) as { error?: unknown }).error ?? '').slice(0, 120);
    } catch { /* sin detalle */ }
    throw new ProviderError(`el relay respondió ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return await res.json() as T;
}

/** La lista del proveedor, bajada por el relay. */
export async function relayList(env: Env, servers: string[], username: string, password: string): Promise<{ server?: string; channels: Channel[] }> {
  return parseUploadedList(await relayPost(env, '/v1/list', { servers, username, password }));
}
