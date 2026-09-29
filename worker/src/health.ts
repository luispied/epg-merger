// Balanceador del proveedor: el primer servidor sano, con su estado guardado un par de
// minutos en la caché del Worker para que cambiar de canal no sume demoras.
import type { SimpleCache } from './env.ts';
import { playerApiUrl } from './provider.ts';

const HEALTH_TTL_S = 120;
const PROBE_TIMEOUT_MS = 4_000;

const healthKey = (server: string) => `https://grilla.internal/health/${encodeURIComponent(server)}`;

/** Sano = responde algo. Un 403 cuenta como sano: hay proveedores que bloquean los pedidos
 *  que salen de Cloudflare pero atienden igual al reproductor, que es el que se conecta. Caído
 *  = no contesta (timeout o conexión rechazada) o error del servidor (5xx). */
async function probe(server: string, u: string, p: string): Promise<boolean> {
  try {
    const res = await fetch(playerApiUrl(server, u, p), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** El primer servidor sano, en el orden de la configuración (si ninguno responde, el primero). */
export async function healthyServer(servers: string[], u: string, p: string, cache: SimpleCache,
  waitUntil: (p: Promise<unknown>) => void): Promise<string> {
  for (const server of servers) {
    const cached = await cache.match(healthKey(server));
    let ok: boolean;
    if (cached) ok = (await cached.text()) === 'up';
    else {
      ok = await probe(server, u, p);
      waitUntil(cache.put(healthKey(server), new Response(ok ? 'up' : 'down', {
        headers: { 'Cache-Control': `max-age=${HEALTH_TTL_S}` },
      })));
    }
    if (ok) return server;
  }
  return servers[0];
}
