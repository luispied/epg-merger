// Prueba de canales caídos y datos de cada cuenta (vencimiento, conexiones) por el relay. Lo hace el cron del Worker
// (cada 30 minutos): una vez por día por configuración, o cuando alguien tocó «Probar ahora» (health/run deja un pedido
// en healthreq/). El resultado queda en health/<cfgId>.json. Los canales los prueba el perfil activo de la configuración
// (`activeAccount`); de las demás cuentas solo se traen sus datos.
import { decryptToken } from './crypto.ts';
import { type Config, loadConfig } from './config.ts';
import { accountTokens } from './devices.ts';
import type { Env } from './env.ts';
import { accountKey } from './account.ts';
import type { Channel } from './provider.ts';
import { relayConfigured, relayPost } from './relay.ts';

/** Una sola prueba por día (la de la madrugada o una lanzada a mano). */
export const CHECK_EVERY_MS = 20 * 3600 * 1000;
export const CHUNK = 50; // canales por pedido al relay
export const MAX_CHUNKS = 4; // 200 canales por corrida
const MAX_CONFIGS_PER_TICK = 5;
const DIVIDER_RE = /[▀-▟]{2,}/;
// Eventos sueltos (PPV, partidos): la mayor parte del día no emiten y no es que estén caídos.
const EVENT_RE = /ppv|event/i;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

interface Entry { t: string; ok: boolean; fails: number }
export interface HealthState {
  checked?: string;
  attempted?: string;
  tested?: number;
  total?: number;
  channels?: Record<string, Entry>;
  account?: unknown;
  accounts?: Record<string, unknown>;
  /** Huella de la cuenta que probó los canales (el perfil activo de ese momento). */
  probedBy?: string;
  [k: string]: unknown;
}

/** Canales que vale la pena probar: no ocultos, ni separadores ni eventos sueltos. */
export function visibleChannels(channels: Channel[], cfg: Config | null): Channel[] {
  const edits = cfg?.channels ?? {};
  const hiddenGroups = new Set(cfg?.groups?.hidden ?? []);
  return channels.filter((ch) => {
    const edit = edits[ch.name] ?? {};
    const group = edit.group || ch.category;
    if (edit.hidden || hiddenGroups.has(group)) return false;
    return !(DIVIDER_RE.test(ch.category) || EVENT_RE.test(ch.category) || EVENT_RE.test(group));
  });
}

/** Los n canales que hace más que no se prueban (los que nunca se probaron, primero). */
export function pickBatch(channels: Channel[], seen: Record<string, Entry>, n: number): Channel[] {
  const key = (ch: Channel) => seen[ch.id]?.t ?? '';
  return [...channels].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, n);
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

/** ¿Toca probar esta configuración? Cada 20 horas o si hay un pedido a mano más nuevo que la última prueba. */
export function isDue(state: HealthState | null, requestedAt: string | undefined, now: Date): boolean {
  const last = Math.max(Date.parse(state?.checked ?? '') || 0, Date.parse(state?.attempted ?? '') || 0);
  if (!last) return true;
  if (requestedAt && Date.parse(requestedAt) > last) return true;
  return now.getTime() - last >= CHECK_EVERY_MS;
}

interface ProbeResponse { account?: unknown; results?: Record<string, string>; aborted?: boolean }
type Creds = { u: string; p: string };

/** Prueba una configuración con el relay y deja health/<cfgId>.json. Devuelve false si no hacía falta o no se pudo. */
export async function runHealthCheck(env: Env, cfgId: string, now = new Date(), force = false): Promise<boolean> {
  if (!relayConfigured(env)) return false;
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored || stored.config.provider.type !== 'xtream') return false;
  const prev = await readJson<HealthState>(env, `health/${cfgId}.json`);
  const req = await readJson<{ at?: string }>(env, `healthreq/${cfgId}.json`);
  if (!force && !isDue(prev, req?.at, now)) return false;
  const tokens = await accountTokens(env.BUCKET, cfgId, stored.config.activeAccount);
  if (!tokens.length) return false;
  const servers = stored.config.provider.servers;
  const state: HealthState = { ...(prev ?? {}), attempted: now.toISOString() };
  const accounts: Record<string, unknown> = { ...(prev?.accounts ?? {}) };
  let primaryAccount: unknown;
  let tested = 0;
  const list = await readJson<{ channels?: Channel[] }>(env, `list/${cfgId}.json`);
  const channels = visibleChannels(list?.channels ?? [], stored.config);
  const known = new Set(channels.map((c) => c.id));
  let seen: Record<string, Entry> = Object.fromEntries(Object.entries(prev?.channels ?? {}).filter(([id]) => known.has(id)));
  let probedBy = prev?.probedBy;
  let first = true;
  for (const t of tokens) {
    const creds = await decryptToken(env.TOKEN_KEY, cfgId, t.token);
    if (!creds || !('u' in creds)) continue;
    const { u, p } = creds as Creds;
    const key = await accountKey(u, p);
    try {
      if (first && channels.length) {
        // El perfil activo prueba los canales (en tandas) y, de paso, trae sus datos. Si cambió de perfil, lo que probó
        // la cuenta anterior no vale para esta: se empieza de cero.
        if (probedBy !== key) { seen = {}; probedBy = key; }
        const batch = pickBatch(channels, seen, CHUNK * MAX_CHUNKS);
        for (let i = 0; i < batch.length; i += CHUNK) {
          const res = await relayPost<ProbeResponse>(env, '/v1/probe', {
            servers, username: u, password: p, channels: batch.slice(i, i + CHUNK).map((c) => ({ id: c.id, ext: c.ext })),
          }, 60_000);
          if (res.account) { accounts[key] = res.account; primaryAccount ??= res.account; }
          if (res.aborted) break; // la cuenta rechaza: no es el canal, no se anota nada de esta tanda
          for (const [id, r] of Object.entries(res.results ?? {})) {
            const ok = r === 'up';
            seen[id] = { t: now.toISOString(), ok, fails: ok ? 0 : (seen[id]?.fails ?? 0) + 1 };
            tested++;
          }
        }
      } else {
        const res = await relayPost<{ account?: unknown }>(env, '/v1/account', { servers, username: u, password: p });
        if (res.account) { accounts[key] = res.account; if (first) primaryAccount ??= res.account; }
      }
    } catch (e) {
      console.error('streamcheck', cfgId, (e as Error).message); // sin datos de la cuenta
    }
    first = false;
  }
  const out: HealthState = { ...state, channels: seen, total: channels.length, accounts, ...(probedBy ? { probedBy } : {}) };
  if (tested) { out.checked = now.toISOString(); out.tested = tested; }
  if (primaryAccount) out.account = primaryAccount;
  await env.BUCKET.put(`health/${cfgId}.json`, JSON.stringify(out), JSON_TYPE);
  return true;
}

/** El cron: prueba las configuraciones con dispositivos a las que les toca, unas pocas por vez. */
export async function checkAllHealth(env: Env, now = new Date()): Promise<number> {
  if (!relayConfigured(env)) return 0;
  let done = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: 'devices/', cursor });
    for (const obj of page.objects) {
      if (done >= MAX_CONFIGS_PER_TICK) return done;
      const cfgId = obj.key.slice('devices/'.length).replace(/\.json$/, '');
      try {
        if (await runHealthCheck(env, cfgId, now)) done++;
      } catch { /* una configuración no frena a las demás */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return done;
}
