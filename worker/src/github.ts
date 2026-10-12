// Lanza la corrida de GitHub que arma la guía de las configuraciones nuevas o cambiadas (refresh-lists.yml) apenas hace
// falta. El cron de GitHub la corre cada 3 horas; con GITHUB_TOKEN cargado en el Worker no hay que esperarlo. Sin el
// token no hace nada.
import type { Env } from './env.ts';

// Como mucho una corrida cada 15 minutos: la corrida hace todo lo pendiente de una vez. El momento de la última se guarda en
// R2 (no en el caché del edge, que es por datacenter y no frena las corridas repetidas desde otro).
const THROTTLE_MS = 15 * 60 * 1000;
const KEY = 'gh/ultimo-disparo.json';

/** Lanza un workflow de GitHub Actions (workflow_dispatch) en la rama principal. */
async function dispatchWorkflow(env: Env, file: string): Promise<boolean> {
  if (!env.GITHUB_TOKEN) return false;
  const repo = env.GITHUB_REPO || 'luispied/epg-merger';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`, {
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

export async function dispatchRefresh(env: Env): Promise<boolean> {
  if (!env.GITHUB_TOKEN) return false;
  const last = Number(await (await env.BUCKET.get(KEY))?.text());
  if (Date.now() - last < THROTTLE_MS) return false;
  const ok = await dispatchWorkflow(env, 'refresh-lists.yml');
  if (ok) await env.BUCKET.put(KEY, String(Date.now()));
  return ok;
}
