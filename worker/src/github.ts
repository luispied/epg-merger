// Lanza la corrida de GitHub que sube listas y arma guías (refresh-lists.yml) apenas hace
// falta: una configuración nueva que espera su lista o un cambio que necesita guía nueva. El
// cron de GitHub la corre cada 10 minutos, pero puede demorarse o saltearse; con GITHUB_TOKEN
// cargado en el Worker no hay que esperarlo. Sin el token no hace nada.
import type { Env, SimpleCache } from './env.ts';

const THROTTLE_S = 60; // como mucho una por minuto: la corrida hace todo lo pendiente de una vez
const KEY = 'https://grilla.internal/github-dispatch';

export async function dispatchRefresh(env: Env, cache: SimpleCache): Promise<boolean> {
  if (!env.GITHUB_TOKEN) return false;
  if (await cache.match(KEY)) return false;
  await cache.put(KEY, new Response('1', { headers: { 'Cache-Control': `max-age=${THROTTLE_S}` } }));
  const repo = env.GITHUB_REPO || 'luispied/epg-merger';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/refresh-lists.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'grilla-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!res.ok) console.error('github dispatch', res.status);
    return res.ok;
  } catch {
    return false;
  }
}
