// Lanza la corrida de GitHub que arma la guía de las configuraciones nuevas o cambiadas (refresh-lists.yml) apenas hace
// falta. El cron de GitHub la corre cada 3 horas; con GITHUB_TOKEN cargado en el Worker no hay que esperarlo. Sin el
// token no hace nada.
import type { Env } from './env.ts';

// Como mucho una corrida cada 15 minutos: la corrida hace todo lo pendiente de una vez. El momento de la última se guarda en
// R2 (no en el caché del edge, que es por datacenter y no frena las corridas repetidas desde otro). Un guardado dentro de la
// ventana no se pierde: queda pendiente y la corrida sale al cerrarla.
const THROTTLE_MS = 15 * 60 * 1000;
const KEY = 'gh/ultimo-disparo.json';
const PENDING = 'gh/pendiente.json';

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

async function lastDispatch(env: Env): Promise<number> {
  return Number(await (await env.BUCKET.get(KEY))?.text());
}

/** Lanza la corrida ahora. Si GitHub la aceptó, cuenta como la última y quita el pendiente. */
async function fireRefresh(env: Env): Promise<boolean> {
  const ok = await dispatchWorkflow(env, 'refresh-lists.yml');
  if (ok) {
    await env.BUCKET.put(KEY, String(Date.now()));
    await env.BUCKET.delete(PENDING);
  }
  return ok;
}

/** Un guardado: lanza la corrida si la ventana ya cerró. Si no, deja un pendiente y flushRefresh la lanza al cerrarla. */
export async function dispatchRefresh(env: Env): Promise<boolean> {
  if (!env.GITHUB_TOKEN) return false;
  if (Date.now() - await lastDispatch(env) < THROTTLE_MS) {
    await env.BUCKET.put(PENDING, '1');
    return false;
  }
  return fireRefresh(env);
}

/** La revisión de cada 5 minutos (wrangler.toml): si quedó un guardado pendiente y la ventana ya cerró, lanza la corrida. */
export async function flushRefresh(env: Env): Promise<boolean> {
  if (!env.GITHUB_TOKEN || !(await env.BUCKET.head(PENDING))) return false;
  if (Date.now() - await lastDispatch(env) < THROTTLE_MS) return false;
  return fireRefresh(env);
}
