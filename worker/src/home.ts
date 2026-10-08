// Hogar: todas las configuraciones (proveedores) de una persona bajo una sola clave, para abrir Grilla en otro
// dispositivo y encontrar todo sin importar un respaldo por cada una. Las claves de edición viajan cifradas por el
// navegador (con una clave que sale de la del hogar y nunca llega al Worker): acá se guarda solo ese texto cifrado,
// en home/<homeId>.json, con el hash de la clave del hogar para autorizar.
import { randomId, sha256Hex } from './crypto.ts';
import type { R2Bucket } from './env.ts';
import { ConfigError } from './config.ts';

export const MAX_HOME_BYTES = 64 * 1024;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Lo que guarda el navegador: `v` (versión del formato) y `data` (cifrado, base64url). */
export interface HomeData { v: number; data: string }

export function parseHome(raw: unknown): HomeData {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.data !== 'string' || !r.data || r.data.length > MAX_HOME_BYTES || !B64URL_RE.test(r.data)) throw new ConfigError('hogar inválido');
  return { v: typeof r.v === 'number' && Number.isInteger(r.v) && r.v > 0 && r.v < 100 ? r.v : 1, data: r.data };
}

const key = (homeId: string) => `home/${homeId}.json`;

export async function loadHome(bucket: R2Bucket, homeId: string): Promise<{ data: HomeData; keyHash: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(homeId)) return null;
  const obj = await bucket.get(key(homeId));
  if (!obj) return null;
  try {
    return { data: JSON.parse(await obj.text()) as HomeData, keyHash: obj.customMetadata?.keyHash ?? '' };
  } catch {
    return null;
  }
}

export async function saveHome(bucket: R2Bucket, homeId: string, data: HomeData, keyHash: string): Promise<void> {
  await bucket.put(key(homeId), JSON.stringify(data), { customMetadata: { keyHash }, httpMetadata: { contentType: 'application/json' } });
}

export async function createHome(bucket: R2Bucket, data: HomeData): Promise<{ homeId: string; homeKey: string }> {
  const homeId = randomId(16);
  const homeKey = randomId(32);
  await saveHome(bucket, homeId, data, await sha256Hex(homeKey));
  return { homeId, homeKey };
}
