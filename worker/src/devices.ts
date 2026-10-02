// Dispositivos: cada link corto (short/<código>.json) es un dispositivo con nombre. Lo que se
// guarda por configuración es solo la lista de códigos (devices/<cfgId>.json); el nombre, la
// fecha y el último uso van en el registro del link. Quitar un dispositivo borra su link: deja
// de funcionar al instante y los demás siguen igual.
import type { R2Bucket } from './env.ts';

export interface ShortRecord {
  cfgId: string;
  token: string;
  name?: string;
  created?: string;
  lastUsed?: string;
}
export interface Device {
  code: string;
  name: string;
  created?: string;
  lastUsed?: string;
}

export const SHORT_RE = /^[A-Za-z0-9_-]{8,16}$/;
const MAX_DEVICES = 20;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
const idxKey = (cfgId: string) => `devices/${cfgId}.json`;
const shortKey = (code: string) => `short/${code}.json`;

export const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 40) : '') || 'Sin nombre';

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
export async function addDevice(bucket: R2Bucket, cfgId: string, token: string, name: unknown, code: string, now = new Date()): Promise<boolean> {
  const codes = await codesOf(bucket, cfgId);
  if (codes.length >= MAX_DEVICES) return false;
  const rec: ShortRecord = { cfgId, token, name: cleanName(name), created: now.toISOString() };
  await bucket.put(shortKey(code), JSON.stringify(rec), JSON_TYPE);
  await bucket.put(idxKey(cfgId), JSON.stringify({ codes: [...codes, code] }), JSON_TYPE);
  return true;
}

export async function listDevices(bucket: R2Bucket, cfgId: string): Promise<Device[]> {
  const out: Device[] = [];
  for (const code of await codesOf(bucket, cfgId)) {
    const rec = await readShort(bucket, code);
    if (rec && rec.cfgId === cfgId) out.push({ code, name: rec.name || 'Sin nombre', created: rec.created, lastUsed: rec.lastUsed });
  }
  return out;
}

export async function renameDevice(bucket: R2Bucket, cfgId: string, code: string, name: unknown): Promise<boolean> {
  const rec = await readShort(bucket, code);
  if (!rec || rec.cfgId !== cfgId) return false;
  await bucket.put(shortKey(code), JSON.stringify({ ...rec, name: cleanName(name) }), JSON_TYPE);
  return true;
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
