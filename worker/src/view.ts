// Modo «solo ver»: un link por perfil (/ver#<código>) para que otra persona mire la grilla y la Guía de ese perfil sin
// poder cambiar nada. El código apunta a la configuración y al perfil (view/<código>.json en R2); con él se leen los
// canales del perfil y nada más: ni la configuración, ni las cuentas, ni los links de reproducción. Quitar el acceso
// borra solo este registro: los links de reproducción no cambian.
import { randomId } from './crypto.ts';
import type { R2Bucket } from './env.ts';

export const VIEW_RE = /^[A-Za-z0-9_-]{20,32}$/;
export interface ViewRecord { cfgId: string; profile: string; created: string }

const key = (code: string) => `view/${code}.json`;

export async function readView(bucket: R2Bucket, code: string): Promise<ViewRecord | null> {
  if (!VIEW_RE.test(code)) return null;
  const obj = await bucket.get(key(code));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as ViewRecord;
  } catch {
    return null;
  }
}

export async function createView(bucket: R2Bucket, cfgId: string, profile: string): Promise<string> {
  const code = randomId(16);
  const rec: ViewRecord = { cfgId, profile, created: new Date().toISOString() };
  await bucket.put(key(code), JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
  return code;
}

export async function deleteView(bucket: R2Bucket, code: string | undefined): Promise<void> {
  if (code && VIEW_RE.test(code)) await bucket.delete(key(code));
}
