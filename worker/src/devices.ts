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
  /** Huella de la cuenta del proveedor (ver link.ts → accountKey): para mostrar su vencimiento. */
  key?: string;
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
}

export const SHORT_RE = /^[A-Za-z0-9_-]{8,16}$/;
const MAX_DEVICES = 20;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
const idxKey = (cfgId: string) => `devices/${cfgId}.json`;
const shortKey = (code: string) => `short/${code}.json`;

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

/** Crea el link corto de un dispositivo nuevo. Devuelve null si ya hay demasiados. */
export async function addDevice(bucket: R2Bucket, cfgId: string, token: string, name: unknown, code: string, now = new Date(), filter?: unknown, account?: unknown, key?: string): Promise<boolean> {
  const codes = await codesOf(bucket, cfgId);
  if (codes.length >= MAX_DEVICES) return false;
  const f = parseFilter(filter);
  const acc = cleanAccount(account);
  const rec: ShortRecord = { cfgId, token, name: cleanName(name), created: now.toISOString(), ...(f ? { filter: f } : {}), ...(acc ? { account: acc } : {}), ...(key ? { key } : {}) };
  await bucket.put(shortKey(code), JSON.stringify(rec), JSON_TYPE);
  await bucket.put(idxKey(cfgId), JSON.stringify({ codes: [...codes, code] }), JSON_TYPE);
  return true;
}

export async function listDevices(bucket: R2Bucket, cfgId: string): Promise<Device[]> {
  const out: Device[] = [];
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (rec && rec.cfgId === cfgId) out.push({ code, name: rec.name || 'Sin nombre', created: rec.created, lastUsed: rec.lastUsed, active: rec.active !== false, ...(rec.filter ? { filter: rec.filter } : {}), ...(rec.account ? { account: rec.account } : {}), ...(rec.key ? { accountKey: rec.key } : {}) });
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

/** El token (credenciales cifradas) de otro dispositivo de la misma cuenta, para dar de alta uno nuevo sin pedirlas de nuevo. */
export async function tokenOfAccount(bucket: R2Bucket, cfgId: string, account: string): Promise<{ token: string; key?: string } | null> {
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (rec && rec.cfgId === cfgId && rec.account === account) return { token: rec.token, key: rec.key };
  }
  return null;
}

/** Cambia las credenciales de los links de una cuenta (sin `account`: la principal) sin tocar sus
 *  códigos: las URLs cortas siguen siendo las mismas y los reproductores no hay que reconfigurarlos. */
export async function rekeyDevices(bucket: R2Bucket, cfgId: string, token: string, account?: string, key?: string): Promise<number> {
  let n = 0;
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
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
  await bucket.put(idxKey(cfgId), JSON.stringify({ codes: (await codesOf(bucket, cfgId)).filter((c) => c !== code) }), JSON_TYPE);
  return true;
}

export async function removeAllDevices(bucket: R2Bucket, cfgId: string): Promise<void> {
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (rec && rec.cfgId === cfgId) await bucket.delete(shortKey(code));
  }
  await bucket.delete(idxKey(cfgId));
}

/** Anota el último uso, como mucho una vez por hora, para no escribir en cada pedido. */
export async function touchDevice(bucket: R2Bucket, code: string, rec: ShortRecord, now = new Date()): Promise<void> {
  if (rec.lastUsed && now.getTime() - Date.parse(rec.lastUsed) < TOUCH_EVERY_MS) return;
  await bucket.put(shortKey(code), JSON.stringify({ ...rec, lastUsed: now.toISOString() }), JSON_TYPE);
}

/** El token de algún dispositivo activo de la configuración (para tareas en segundo plano que necesitan la cuenta). */
export async function anyToken(bucket: R2Bucket, cfgId: string): Promise<string | null> {
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (rec && rec.cfgId === cfgId && rec.active !== false && !rec.account) return rec.token;
  }
  return null;
}

/** Un token activo por cuenta del proveedor de la configuración (la principal y las de familiares), para tareas en
 *  segundo plano que necesitan hablar con el proveedor en nombre de cada una. La principal va primero. */
export async function accountTokens(bucket: R2Bucket, cfgId: string): Promise<{ account?: string; token: string }[]> {
  const seen = new Map<string, { account?: string; token: string }>();
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (!rec || rec.cfgId !== cfgId || rec.active === false) continue;
    const id = rec.account ?? '';
    if (!seen.has(id)) seen.set(id, { ...(rec.account ? { account: rec.account } : {}), token: rec.token });
  }
  return [...seen.values()].sort((a, b) => Number(!!a.account) - Number(!!b.account));
}
