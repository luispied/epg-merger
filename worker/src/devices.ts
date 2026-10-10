// Dispositivos: cada link corto (short/<código>.json) es un dispositivo con nombre. Lo que se
// guarda por configuración es solo la lista de códigos (devices/<cfgId>.json); el nombre, la
// fecha y el último uso van en el registro del link. Desactivar un dispositivo corta su link sin
// borrarlo (se reactiva cuando se quiera); quitarlo lo borra. En los dos casos los demás siguen igual.
import type { R2Bucket } from './env.ts';
import { parseFilter, type DeviceFilter } from './playlist.ts';

export interface ShortRecord {
  cfgId: string;
  token: string;
  name?: string;
  created?: string;
  lastUsed?: string;
  /** false = desactivado: el link no responde, pero se puede volver a activar. Sin dato = activo. */
  active?: boolean;
  /** Perfil del dispositivo: qué categorías y canales ve (sin dato = todo). */
  filter?: DeviceFilter;
  /** Cuenta del proveedor con la que reproduce (por ejemplo, la de un familiar). Sin dato = la cuenta principal. */
  account?: string;
  /** Huella de la cuenta del proveedor (ver account.ts): para mostrar su vencimiento. */
  key?: string;
  /** Perfil al que pertenece (id en config.profiles); `filter` es la copia del filtro de ese perfil. */
  profile?: string;
}
export interface Device {
  code: string;
  name: string;
  created?: string;
  lastUsed?: string;
  active: boolean;
  filter?: DeviceFilter;
  account?: string;
  accountKey?: string;
  profile?: string;
}

export const SHORT_RE = /^[A-Za-z0-9_-]{8,16}$/;
const MAX_DEVICES = 20;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
const idxKey = (cfgId: string) => `devices/${cfgId}.json`;
const shortKey = (code: string) => `short/${code}.json`;
const playKey = (code: string) => `play/${code}.json`;

export const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 40) : '') || 'Sin nombre';

/** Nombre de una cuenta adicional; vacío = la cuenta principal. */
export const cleanAccount = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 30) : '') || undefined;

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

async function codesOf(bucket: R2Bucket, cfgId: string): Promise<string[]> {
  const v = await readJson<{ codes?: unknown }>(bucket, idxKey(cfgId));
  return Array.isArray(v?.codes) ? v!.codes.filter((c): c is string => typeof c === 'string' && SHORT_RE.test(c)) : [];
}

export async function readShort(bucket: R2Bucket, code: string): Promise<ShortRecord | null> {
  if (!SHORT_RE.test(code)) return null;
  const v = await readJson<ShortRecord>(bucket, shortKey(code));
  return v && v.cfgId && v.token ? v : null;
}

/** Los registros de los links de una configuración, leídos en paralelo (uno por uno tardaba un pedido a R2 por link). */
async function recordsOf(bucket: R2Bucket, cfgId: string): Promise<[string, ShortRecord | null][]> {
  const codes = await codesOf(bucket, cfgId);
  return Promise.all(codes.map(async (code) => [code, await readShort(bucket, code)] as [string, ShortRecord | null]));
}

/** Crea el link corto de un dispositivo nuevo. Devuelve null si ya hay demasiados. */
export async function addDevice(bucket: R2Bucket, cfgId: string, token: string, name: unknown, code: string, now = new Date(), filter?: unknown, account?: unknown, key?: string, profile?: string): Promise<boolean> {
  const codes = await codesOf(bucket, cfgId);
  if (codes.length >= MAX_DEVICES) return false;
  const f = parseFilter(filter);
  const acc = cleanAccount(account);
  const rec: ShortRecord = { cfgId, token, name: cleanName(name), created: now.toISOString(), ...(f ? { filter: f } : {}), ...(acc ? { account: acc } : {}), ...(key ? { key } : {}), ...(profile ? { profile } : {}) };
  await bucket.put(shortKey(code), JSON.stringify(rec), JSON_TYPE);
  await bucket.put(idxKey(cfgId), JSON.stringify({ codes: [...codes, code] }), JSON_TYPE);
  return true;
}

export async function listDevices(bucket: R2Bucket, cfgId: string): Promise<Device[]> {
  const out: Device[] = [];
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (rec && rec.cfgId === cfgId) out.push({ code, name: rec.name || 'Sin nombre', created: rec.created, lastUsed: rec.lastUsed, active: rec.active !== false, ...(rec.filter ? { filter: rec.filter } : {}), ...(rec.account ? { account: rec.account } : {}), ...(rec.key ? { accountKey: rec.key } : {}), ...(rec.profile ? { profile: rec.profile } : {}) });
  }
  return out;
}

/** Cambia el nombre y/o activa o desactiva el link de un dispositivo. */
export async function updateDevice(bucket: R2Bucket, cfgId: string, code: string, change: { name?: unknown; active?: unknown; filter?: unknown }): Promise<boolean> {
  const rec = await readShort(bucket, code);
  if (!rec || rec.cfgId !== cfgId) return false;
  const next: ShortRecord = { ...rec };
  if (change.name !== undefined) next.name = cleanName(change.name);
  if (typeof change.active === 'boolean') next.active = change.active ? undefined : false;
  if ('filter' in change) {
    const f = parseFilter(change.filter);
    if (f) next.filter = f;
    else delete next.filter;
  }
  await bucket.put(shortKey(code), JSON.stringify(next), JSON_TYPE);
  return true;
}

/** El token (credenciales cifradas) de otro dispositivo de la misma cuenta (sin `account`: la principal), para dar de alta uno nuevo sin pedirlas de nuevo. */
export async function tokenOfAccount(bucket: R2Bucket, cfgId: string, account?: string): Promise<{ token: string; key?: string } | null> {
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (rec && rec.cfgId === cfgId && rec.account === account) return { token: rec.token, key: rec.key };
  }
  return null;
}

/** Reescribe los registros de la configuración que `change` devuelva cambiados (null = no tocar). Nunca cambia el código
 *  ni borra un registro: los links siguen con la misma dirección. Devuelve cuántos cambió. */
export async function updateRecords(bucket: R2Bucket, cfgId: string, change: (rec: ShortRecord, code: string) => ShortRecord | null | Promise<ShortRecord | null>): Promise<number> {
  let n = 0;
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (!rec || rec.cfgId !== cfgId) continue;
    const next = await change(rec, code);
    if (!next) continue;
    await bucket.put(shortKey(code), JSON.stringify({ ...next, cfgId: rec.cfgId }), JSON_TYPE);
    n++;
  }
  return n;
}

/** Cambia el nombre de un perfil adicional (`account` de sus links): mismo token, misma huella, mismo código. */
export async function renameAccount(bucket: R2Bucket, cfgId: string, from: string, to: string): Promise<number> {
  let n = 0;
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (!rec || rec.cfgId !== cfgId || rec.account !== from) continue;
    await bucket.put(shortKey(code), JSON.stringify({ ...rec, account: to }), JSON_TYPE);
    n++;
  }
  return n;
}

/** Cambia las credenciales de los links de una cuenta (sin `account`: la principal) sin tocar sus
 *  códigos: las URLs cortas siguen siendo las mismas y los reproductores no hay que reconfigurarlos. */
export async function rekeyDevices(bucket: R2Bucket, cfgId: string, token: string, account?: string, key?: string): Promise<number> {
  let n = 0;
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (!rec || rec.cfgId !== cfgId || rec.account !== account) continue;
    await bucket.put(shortKey(code), JSON.stringify({ ...rec, token, ...(key ? { key } : {}) }), JSON_TYPE);
    n++;
  }
  return n;
}

export async function removeDevice(bucket: R2Bucket, cfgId: string, code: string): Promise<boolean> {
  const rec = await readShort(bucket, code);
  if (!rec || rec.cfgId !== cfgId) return false;
  await bucket.delete(shortKey(code));
  await bucket.delete(playKey(code));
  await bucket.put(idxKey(cfgId), JSON.stringify({ codes: (await codesOf(bucket, cfgId)).filter((c) => c !== code) }), JSON_TYPE);
  return true;
}

export async function removeAllDevices(bucket: R2Bucket, cfgId: string): Promise<void> {
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (rec && rec.cfgId === cfgId) {
      await bucket.delete(shortKey(code));
      await bucket.delete(playKey(code));
    }
  }
  await bucket.delete(idxKey(cfgId));
}

/** Anota el último uso, como mucho una vez por hora, para no escribir en cada pedido. */
export async function touchDevice(bucket: R2Bucket, code: string, rec: ShortRecord, now = new Date()): Promise<void> {
  if (rec.lastUsed && now.getTime() - Date.parse(rec.lastUsed) < TOUCH_EVERY_MS) return;
  await bucket.put(shortKey(code), JSON.stringify({ ...rec, lastUsed: now.toISOString() }), JSON_TYPE);
}

/** Último canal que abrió un link (sus streams pasan por el Worker: /s/<código>/…). El proveedor dice cuántas
 *  conexiones hay, no cuáles: con esto la web muestra qué links están mirando algo. Va aparte del link (play/), así
 *  cambiar de canal no reescribe short/. */
export interface LastPlay { t: string; ch: string }
const PLAY_EVERY_MS = 5 * 60 * 1000;

export async function readPlay(bucket: R2Bucket, code: string): Promise<LastPlay | null> {
  const obj = await bucket.get(playKey(code));
  if (!obj) return null;
  try {
    const v = JSON.parse(await obj.text()) as LastPlay;
    return typeof v?.t === 'string' && typeof v.ch === 'string' ? { t: v.t, ch: v.ch } : null;
  } catch {
    return null;
  }
}

/** Anota el canal que abrió un link; el mismo canal, como mucho cada 5 minutos (hay reproductores que lo vuelven a pedir).
 *  Devuelve si lo anotó. */
export async function notePlay(bucket: R2Bucket, code: string, ch: string, now = new Date()): Promise<boolean> {
  const prev = await readPlay(bucket, code);
  if (prev && prev.ch === ch && now.getTime() - Date.parse(prev.t) < PLAY_EVERY_MS) return false;
  await bucket.put(playKey(code), JSON.stringify({ t: now.toISOString(), ch }), JSON_TYPE);
  return true;
}

/** El token de algún dispositivo activo de la configuración (para tareas en segundo plano que necesitan la cuenta): del
 *  perfil activo (`active`, sin dato = la cuenta principal) o, si ese perfil no tiene links activos, de la principal. */
export async function anyToken(bucket: R2Bucket, cfgId: string, active?: string): Promise<string | null> {
  return (await accountTokens(bucket, cfgId, active))[0]?.token ?? null;
}

/** Un token activo por cuenta del proveedor de la configuración (la principal y las de familiares), para tareas en
 *  segundo plano que necesitan hablar con el proveedor en nombre de cada una. Va primero el perfil activo (`active`, sin
 *  dato = la principal); si no tiene links activos, la principal. */
export async function accountTokens(bucket: R2Bucket, cfgId: string, active?: string): Promise<{ account?: string; token: string }[]> {
  const seen = new Map<string, { account?: string; token: string }>();
  for (const [code, rec] of await recordsOf(bucket, cfgId)) {
    if (!rec || rec.cfgId !== cfgId || rec.active === false) continue;
    const id = rec.account ?? '';
    if (!seen.has(id)) seen.set(id, { ...(rec.account ? { account: rec.account } : {}), token: rec.token });
  }
  const rank = (t: { account?: string }) => ((t.account ?? '') === (active ?? '') ? 0 : t.account ? 2 : 1);
  return [...seen.values()].sort((a, b) => rank(a) - rank(b));
}

/** Pasa el link de un dispositivo a otro perfil (cuenta) de la misma configuración o a otra configuración (otro
 *  proveedor), con el token de su destino. El código no cambia: la dirección del link sigue siendo la misma y el
 *  reproductor no hay que tocarlo. Devuelve false si el link no es de `from` o si el destino ya tiene demasiados. */
export async function moveDevice(bucket: R2Bucket, code: string, from: string, to: string, token: string, account?: string, key?: string,
  profile?: { id: string; filter?: DeviceFilter }): Promise<boolean> {
  const rec = await readShort(bucket, code);
  if (!rec || rec.cfgId !== from) return false;
  const target = from === to ? null : await codesOf(bucket, to);
  if (target && target.length >= MAX_DEVICES) return false;
  const { account: _a, key: _k, profile: _p, ...rest } = rec;
  // Con perfil de destino, el link toma su filtro; sin perfil (otra configuración vieja) queda el suyo.
  if (profile) delete rest.filter;
  const next: ShortRecord = { ...rest, cfgId: to, token, ...(account ? { account } : {}), ...(key ? { key } : {}),
    ...(profile ? { profile: profile.id, ...(profile.filter ? { filter: profile.filter } : {}) } : {}) };
  if (target) {
    await bucket.put(idxKey(to), JSON.stringify({ codes: [...target.filter((c) => c !== code), code] }), JSON_TYPE);
  }
  await bucket.put(shortKey(code), JSON.stringify(next), JSON_TYPE);
  if (target) await bucket.put(idxKey(from), JSON.stringify({ codes: (await codesOf(bucket, from)).filter((c) => c !== code) }), JSON_TYPE);
  return true;
}
