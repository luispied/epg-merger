// Vínculo con la corrida de GitHub, para proveedores que bloquean al Worker: si GitHub ya tiene
// una cuenta con el mismo usuario y contraseña (en XTREAM_PROFILES), es GitHub el que baja la
// lista y la deja en R2. Se identifica por una huella de usuario y contraseña, sin guardarlos:
//   known/<huella>        lo escribe GitHub en cada corrida (tools/push_lists.py)
//   links/<huella>.json   lo escribe el Worker: {"cfgIds": [...], "pending": true}
import { sha256Hex } from './crypto.ts';
import type { R2Bucket } from './env.ts';

export const linkHash = (username: string, password: string) => sha256Hex(`grilla-link\n${username}\n${password}`);

export async function knownToGithub(bucket: R2Bucket, hash: string): Promise<boolean> {
  return (await bucket.get(`known/${hash}`)) !== null;
}

/** Anota la configuración para que la próxima corrida de GitHub le suba la lista. */
export async function linkConfig(bucket: R2Bucket, hash: string, cfgId: string): Promise<void> {
  const key = `links/${hash}.json`;
  const current = await bucket.get(key);
  let cfgIds: string[] = [];
  if (current) {
    try {
      cfgIds = (JSON.parse(await current.text()) as { cfgIds?: string[] }).cfgIds ?? [];
    } catch { /* se rehace */ }
  }
  if (!cfgIds.includes(cfgId)) cfgIds.push(cfgId);
  await bucket.put(key, JSON.stringify({ cfgIds: cfgIds.slice(-20), pending: true }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** Huella corta de una cuenta: identifica sus datos (vencimiento, conexiones) en health/<cfgId>.json (la misma que arma tools/check_streams.py). */
export const ACCOUNT_KEY_LEN = 12;
export const accountKey = async (username: string, password: string) => (await linkHash(username, password)).slice(0, ACCOUNT_KEY_LEN);

/** ¿La configuración ya está anotada para esa cuenta? */
export async function isLinked(bucket: R2Bucket, hash: string, cfgId: string): Promise<boolean> {
  const current = await bucket.get(`links/${hash}.json`);
  if (!current) return false;
  try {
    return ((JSON.parse(await current.text()) as { cfgIds?: string[] }).cfgIds ?? []).includes(cfgId);
  } catch {
    return false;
  }
}
