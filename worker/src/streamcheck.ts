// Prueba de canales caídos y datos de cada cuenta (vencimiento, conexiones) por el relay. Lo hace el cron del Worker
// (cada 30 minutos): una vez por día por configuración, o cuando alguien tocó «Probar ahora» (health/run deja un pedido
// en healthreq/). El resultado queda en health/<cfgId>.json. Los canales los prueba el perfil activo de la configuración
// (`activeAccount`); de las demás cuentas solo se traen sus datos.
// De paso, el relay mide la resolución real (ancho × alto del video) de los canales que andan, con el mismo pedido de la
// prueba: cada canal una vez por semana (si no se pudo saber, se reintenta en la próxima prueba), hasta RES_PER_CHUNK por
// tanda para no comerse el tiempo de la prueba. Queda en `res` del mismo archivo.
// Barrido: mientras haya canales sin medir, de 1 a 9 h (hora de Montevideo, con pocas conexiones en uso) cada corrida del
// cron prueba y mide hasta SWEEP_CHUNKS tandas, así que la primera medida completa llega en unos días.
// Mientras prueba, deja el avance en healthprog/<cfgId>.json después de cada tanda (la web muestra «Probando 50 de 180»
// arriba de la lista) y mira healthstop/<cfgId>.json, que deja «Detener»: si está, corta y guarda lo que alcanzó a probar.
import { decryptToken } from './crypto.ts';
import { type Config, loadConfig } from './config.ts';
import { accountTokens } from './devices.ts';
import type { Env } from './env.ts';
import { accountKey } from './account.ts';
import type { Channel } from './provider.ts';
import { relayConfigured, relayPost } from './relay.ts';

/** Una sola prueba por día (la de la madrugada o una lanzada a mano). */
export const CHECK_EVERY_MS = 20 * 3600 * 1000;
/** Los caídos se vuelven a probar cada 3 horas, entre las pruebas del día. */
export const RECHECK_DOWN_MS = 3 * 3600 * 1000;
export const CHUNK = 50; // canales por pedido al relay
export const MAX_CHUNKS = 4; // 200 canales por corrida
const MAX_CONFIGS_PER_TICK = 5;
export const RES_EVERY_MS = 7 * 24 * 3600 * 1000;
export const RES_PER_CHUNK = 25; // ~100 por día: va en el mismo pedido de la prueba; el relay deja de medir si se queda sin tiempo
export const SWEEP_CHUNKS = 8; // barrido: 400 canales por corrida, con todas las tandas midiendo
export const SWEEP_EVERY_MS = 25 * 60 * 1000; // el cron corre cada 30 min: una corrida del barrido por tick
const SWEEP_HOURS = [1, 9]; // de 1 a 9 h, hora de Montevideo
const LOCAL_TZ = 'America/Montevideo';
const DIVIDER_RE = /[▀-▟]{2,}/;
// Eventos sueltos (PPV, partidos): la mayor parte del día no emiten y no es que estén caídos.
const EVENT_RE = /ppv|event/i;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

/** Fallas seguidas para contar un canal como caído (igual que la web). */
const DOWN_AFTER = 2;
export const progressKey = (cfgId: string) => `healthprog/${cfgId}.json`;
export const stopKey = (cfgId: string) => `healthstop/${cfgId}.json`;
/** El avance de la prueba en curso: cuántos lleva de cuántos y cuántos cayeron hasta ahora. */
export interface Progress { started: string; done: number; total: number; down: number; at?: string }
async function putProgress(env: Env, cfgId: string, p: Progress) {
  await env.BUCKET.put(progressKey(cfgId), JSON.stringify({ ...p, at: new Date().toISOString() }), JSON_TYPE);
}

interface Entry { t: string; ok: boolean; fails: number }
/** Resolución medida: sin w/h es que se intentó y no se pudo saber (se reintenta en la próxima prueba). */
export interface Res { t: string; w?: number; h?: number }
export interface HealthState {
  checked?: string;
  /** Canales que ocultó el sistema por caídos (aparte de lo que ocultó la persona a mano). */
  autoHidden?: string[];
  /** Ocultos a mano que respondieron en la última prueba: la lista los muestra igual, a pedido de la persona. */
  manualOpen?: string[];
  attempted?: string;
  tested?: number;
  total?: number;
  channels?: Record<string, Entry>;
  res?: Record<string, Res>;
  account?: unknown;
  accounts?: Record<string, unknown>;
  /** Huella de la cuenta que probó los canales (el perfil activo de ese momento). */
  probedBy?: string;
  /** Última vez que el relay respondió y última vez que falló (la web avisa si deja de responder). */
  relayOk?: string;
  relayFail?: string;
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

/** Qué ocultar y qué desocultar según la última prueba. Un canal caído (dos fallas seguidas) se oculta solo; uno que
 *  responde se desoculta, sea que lo ocultó el sistema o a mano. Lo que ya está como corresponde no aparece. */
export function autoHideDiff(seen: Record<string, Entry>, autoHidden: ReadonlySet<string>, manualHidden: ReadonlySet<string>): { hide: string[]; unhide: string[] } {
  const hide = Object.entries(seen).filter(([id, e]) => !e.ok && e.fails >= DOWN_AFTER && !autoHidden.has(id) && !manualHidden.has(id)).map(([id]) => id);
  const unhide = [...autoHidden, ...manualHidden].filter((id) => seen[id]?.ok === true);
  return { hide, unhide: [...new Set(unhide)] };
}

/** Canales ocultos a mano que valen la pena probar: solo para saber si responden (y desocultarlos si la persona lo pidió). */
/** Lo que decidió la última prueba sobre los ocultos: lo que oculta el sistema y lo ocultado a mano que responde. */
export async function healthHidden(env: Env, cfgId: string): Promise<{ autoHidden: Set<string> }> {
  const h = await readJson<HealthState>(env, `health/${cfgId}.json`);
  return { autoHidden: new Set(h?.autoHidden ?? []) };
}

export function manualHiddenChannels(channels: Channel[], cfg: Config | null): Channel[] {
  const edits = cfg?.channels ?? {};
  const hiddenGroups = new Set(cfg?.groups?.hidden ?? []);
  return channels.filter((ch) => {
    const edit = edits[ch.name] ?? {};
    const group = edit.group || ch.category;
    if (!(edit.hidden || hiddenGroups.has(group))) return false;
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

/** Los canales de la tanda a los que toca medirles la resolución: los que no están caídos y no se midieron en la semana
 *  (o no se pudo saber en la última prueba). */
export function needsRes(chunk: Channel[], seen: Record<string, Entry>, res: Record<string, Res>, now: Date, n = RES_PER_CHUNK): Set<string> {
  const due = (id: string) => !res[id] || now.getTime() - (Date.parse(res[id].t) || 0) >= (res[id].w ? RES_EVERY_MS : CHECK_EVERY_MS);
  return new Set(chunk.filter((c) => seen[c.id]?.ok !== false && due(c.id)).slice(0, n).map((c) => c.id));
}

/** Canales que todavía no tienen medida de resolución. Los caídos no cuentan: no se miden. */
export function unmeasuredCount(channels: Channel[], seen: Record<string, Entry>, res: Record<string, Res>): number {
  return channels.filter((c) => !res[c.id] && seen[c.id]?.ok !== false).length;
}

/** ¿Es hora del barrido? De 1 a 9 de la mañana en Montevideo: madrugada y mañana, cuando menos conexiones se usan. */
export function inSweepWindow(now: Date): boolean {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: LOCAL_TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return h >= SWEEP_HOURS[0] && h < SWEEP_HOURS[1];
}

const size = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 64 && x <= 8192) ? [v[0], v[1]] : null;

/** ¿Toca probar esta configuración? Cada 20 horas o si hay un pedido a mano más nuevo que la última prueba. */
export function isDue(state: HealthState | null, requestedAt: string | undefined, now: Date): boolean {
  const last = Math.max(Date.parse(state?.checked ?? '') || 0, Date.parse(state?.attempted ?? '') || 0);
  if (!last) return true;
  if (requestedAt && Date.parse(requestedAt) > last) return true;
  return now.getTime() - last >= CHECK_EVERY_MS;
}

interface ProbeResponse { account?: unknown; results?: Record<string, string>; res?: Record<string, unknown>; aborted?: boolean }
type Creds = { u: string; p: string };

/** Prueba una configuración con el relay y deja health/<cfgId>.json. Devuelve false si no hacía falta o no se pudo. */
export async function runHealthCheck(env: Env, cfgId: string, now = new Date(), force = false): Promise<boolean> {
  if (!relayConfigured(env)) return false;
  const stored = await loadConfig(env.BUCKET, cfgId);
  if (!stored || stored.config.provider.type !== 'xtream') return false;
  const prev = await readJson<HealthState>(env, `health/${cfgId}.json`);
  const req = await readJson<{ at?: string }>(env, `healthreq/${cfgId}.json`);
  const dueNow = force || isDue(prev, req?.at, now);
  // En la ventana del barrido se vuelve a mirar en cada tanda (aunque la prueba diaria ya haya corrido), si quedan canales sin medir.
  const inWindow = inSweepWindow(now);
  const sweepAgain = inWindow && now.getTime() - (Date.parse(prev?.attempted ?? '') || 0) >= SWEEP_EVERY_MS;
  // Entre pruebas, los caídos se vuelven a probar cada 3 horas (solo ellos, en una tanda chica).
  const hadDown = Object.values(prev?.channels ?? {}).some((e) => !e.ok);
  const recheck = hadDown && now.getTime() - (Date.parse(prev?.attempted ?? '') || 0) >= RECHECK_DOWN_MS;
  if (!dueNow && !sweepAgain && !recheck) return false;
  const tokens = await accountTokens(env.BUCKET, cfgId, stored.config.activeAccount);
  if (!tokens.length) return false;
  const servers = stored.config.provider.servers;
  const state: HealthState = { ...(prev ?? {}), attempted: now.toISOString() };
  const accounts: Record<string, unknown> = { ...(prev?.accounts ?? {}) };
  let primaryAccount: unknown;
  let tested = 0;
  const list = await readJson<{ channels?: Channel[] }>(env, `list/${cfgId}.json`);
  const channels = visibleChannels(list?.channels ?? [], stored.config);
  // Los ocultos a mano se prueban también (sin medir su resolución) para saber si responden.
  const manual = manualHiddenChannels(list?.channels ?? [], stored.config);
  const probeList = [...channels, ...manual];
  const known = new Set(probeList.map((c) => c.id));
  const manualIds = new Set(manual.map((c) => c.id));
  let seen: Record<string, Entry> = Object.fromEntries(Object.entries(prev?.channels ?? {}).filter(([id]) => known.has(id)));
  const res: Record<string, Res> = Object.fromEntries(Object.entries(prev?.res ?? {}).filter(([id]) => known.has(id)));
  // Barrido: en la ventana, si quedan canales sin medir, esta corrida prueba y mide todo lo que alcance.
  const sweep = inWindow && unmeasuredCount(channels, seen, res) > 0;
  const onlyDown = !dueNow && !sweep;
  if (onlyDown && !recheck) return false;
  let probedBy = prev?.probedBy;
  let first = true;
  let relayOk = false;
  let relayFail = false;
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
        const pool = onlyDown ? probeList.filter((c) => seen[c.id] && !seen[c.id].ok) : probeList;
        const batch = pickBatch(pool, seen, CHUNK * (sweep ? SWEEP_CHUNKS : MAX_CHUNKS));
        // Un «Detener» de antes de empezar no vale para esta prueba.
        await env.BUCKET.delete(stopKey(cfgId));
        await putProgress(env, cfgId, { started: now.toISOString(), done: 0, total: batch.length, down: 0 });
        let down = 0;
        for (let i = 0; i < batch.length; i += CHUNK) {
          if (i && await env.BUCKET.head(stopKey(cfgId))) break;
          const chunk = batch.slice(i, i + CHUNK);
          const measure = needsRes(chunk.filter((c) => !manualIds.has(c.id)), seen, res, now, sweep ? CHUNK : RES_PER_CHUNK);
          const reply = await relayPost<ProbeResponse>(env, '/v1/probe', {
            servers, username: u, password: p, channels: chunk.map((c) => ({ id: c.id, ext: c.ext, ...(measure.has(c.id) ? { res: true } : {}) })),
          }, 60_000);
          relayOk = true;
          if (reply.account) { accounts[key] = reply.account; primaryAccount ??= reply.account; }
          if (reply.aborted) break; // la cuenta rechaza: no es el canal, no se anota nada de esta tanda
          // Un corte de red no es un canal caído: los que dieron «down» se piden otra vez, una sola vez, en un pedido aparte.
          const again = Object.keys(reply.results ?? {}).filter((id) => reply.results?.[id] === 'down');
          if (again.length) {
            const retry = await relayPost<ProbeResponse>(env, '/v1/probe', {
              servers, username: u, password: p, channels: chunk.filter((c) => again.includes(c.id)).map((c) => ({ id: c.id, ext: c.ext })),
            }, 60_000);
            if (!retry.aborted) reply.results = { ...reply.results, ...retry.results };
          }
          for (const [id, r] of Object.entries(reply.results ?? {})) {
            const ok = r === 'up';
            seen[id] = { t: now.toISOString(), ok, fails: ok ? 0 : (seen[id]?.fails ?? 0) + 1 };
            if (seen[id].fails >= DOWN_AFTER) down++;
            tested++;
          }
          for (const [id, v] of Object.entries(reply.res ?? {})) {
            if (!measure.has(id)) continue;
            const wh = size(v);
            res[id] = wh ? { t: now.toISOString(), w: wh[0], h: wh[1] } : { t: now.toISOString() };
          }
          if (i + CHUNK < batch.length) {
            await putProgress(env, cfgId, { started: now.toISOString(), done: Math.min(i + CHUNK, batch.length), total: batch.length, down });
          }
        }
      } else {
        const reply = await relayPost<{ account?: unknown }>(env, '/v1/account', { servers, username: u, password: p });
        relayOk = true;
        if (reply.account) { accounts[key] = reply.account; if (first) primaryAccount ??= reply.account; }
      }
    } catch (e) {
      console.error('streamcheck', cfgId, (e as Error).message); // sin datos de la cuenta
      relayFail = true;
    }
    first = false;
  }
  const out: HealthState = { ...state, channels: seen, res, total: channels.length, accounts, ...(probedBy ? { probedBy } : {}) };
  if (tested) { out.checked = now.toISOString(); out.tested = tested; }
  if (primaryAccount) out.account = primaryAccount;
  if (relayOk) out.relayOk = now.toISOString();
  else if (relayFail) out.relayFail = now.toISOString();
  // Ocultado automático: lo que cayó se oculta; lo que responde se desoculta (también lo ocultado a mano, a pedido de la persona).
  const diff = autoHideDiff(seen, new Set(prev?.autoHidden ?? []), manualIds);
  const autoHidden = new Set([...(prev?.autoHidden ?? []), ...diff.hide]);
  for (const id of diff.unhide) autoHidden.delete(id);
  if (autoHidden.size) out.autoHidden = [...autoHidden]; else delete out.autoHidden;
  const manualOpen = manual.map((c) => c.id).filter((id) => seen[id]?.ok === true);
  if (manualOpen.length) out.manualOpen = manualOpen; else delete out.manualOpen;
  await env.BUCKET.put(`health/${cfgId}.json`, JSON.stringify(out), JSON_TYPE);
  await env.BUCKET.delete(progressKey(cfgId));
  await env.BUCKET.delete(stopKey(cfgId));
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

/** Datos de cada cuenta de la configuración ahora mismo (vencimiento, conexiones en uso), por el relay: para la pantalla
 *  de Perfiles. Por huella de cuenta; una cuenta que no contesta no aparece. Sin relay o sin cuentas, vacío. */
export async function liveAccounts(env: Env, cfgId: string, config: Config): Promise<Record<string, unknown>> {
  if (!relayConfigured(env) || config.provider.type !== 'xtream') return {};
  const servers = config.provider.servers;
  const out: Record<string, unknown> = {};
  await Promise.all((await accountTokens(env.BUCKET, cfgId, config.activeAccount)).map(async (t) => {
    const creds = await decryptToken(env.TOKEN_KEY, cfgId, t.token);
    if (!creds || !('u' in creds)) return;
    const { u, p } = creds as Creds;
    try {
      const res = await relayPost<{ account?: unknown }>(env, '/v1/account', { servers, username: u, password: p }, 12_000);
      if (res.account) out[await accountKey(u, p)] = res.account;
    } catch { /* sin datos de esa cuenta */ }
  }));
  return out;
}

/** Resolución medida por el relay, por canal (lo que usa la playlist para poner la calidad en el nombre). */
export async function healthRes(env: Env, cfgId: string): Promise<Record<string, Res>> {
  const h = await readJson<HealthState>(env, `health/${cfgId}.json`);
  return h?.res ?? {};
}
