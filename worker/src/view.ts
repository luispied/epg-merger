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

// «La guía no coincide»: desde el modo ver se marca un canal cuya programación no es la que se ve en la tele. Se
// guarda por configuración (reports/<cfgId>.json) y quien edita lo ve en Canales para corregirlo. Sin credenciales:
// el id del canal en la lista, su nombre, la guía que tenía, el programa que mostraba y quién lo marcó (el perfil).
export interface Report { id: string; name: string; epg: string | null; title?: string; by: string; at: string }
export const MAX_REPORTS = 50;
const reportsKey = (cfgId: string) => `reports/${cfgId}.json`;

export async function readReports(bucket: R2Bucket, cfgId: string): Promise<Report[]> {
  const obj = await bucket.get(reportsKey(cfgId));
  if (!obj) return [];
  try {
    const v = JSON.parse(await obj.text()) as { items?: Report[] };
    return Array.isArray(v.items) ? v.items : [];
  } catch {
    return [];
  }
}

async function writeReports(bucket: R2Bucket, cfgId: string, items: Report[]): Promise<void> {
  if (items.length) await bucket.put(reportsKey(cfgId), JSON.stringify({ items }), { httpMetadata: { contentType: 'application/json' } });
  else await bucket.delete(reportsKey(cfgId));
}

/** Agrega (o renueva) la marca de un canal. Las más viejas salen si se pasa del tope. */
export async function addReport(bucket: R2Bucket, cfgId: string, r: Report): Promise<void> {
  const items = (await readReports(bucket, cfgId)).filter((x) => x.id !== r.id);
  await writeReports(bucket, cfgId, [r, ...items].slice(0, MAX_REPORTS));
}

export async function removeReport(bucket: R2Bucket, cfgId: string, id: string): Promise<void> {
  const items = await readReports(bucket, cfgId);
  if (items.some((x) => x.id === id)) await writeReports(bucket, cfgId, items.filter((x) => x.id !== id));
}

export const deleteReports = (bucket: R2Bucket, cfgId: string) => bucket.delete(reportsKey(cfgId));

/** El manifest de la PWA del modo ver, con el código en su start_url: así «Agregar a inicio» abre iOS como una app (con
 *  la misma ventana que la del editor) y el ícono vuelve a /ver#<código>. Lo arma el Worker porque el código es de cada
 *  persona; no lee nada de R2 ni dice si el código existe. */
export function viewManifest(code: string): object | null {
  if (!VIEW_RE.test(code)) return null;
  const icon = (src: string, sizes: string, purpose?: string) => ({ src, sizes, type: 'image/png', ...(purpose ? { purpose } : {}) });
  return {
    name: 'nowline',
    short_name: 'nowline',
    description: 'Lo que dan ahora y la guía de tus canales.',
    lang: 'es',
    start_url: `/ver#${code}`,
    scope: '/',
    display: 'standalone',
    background_color: '#0c0d10',
    theme_color: '#0c0d10',
    icons: [
      icon('/img/ver/apple-touch-icon.png', '180x180'),
      icon('/img/ver/icon-192.png', '192x192'),
      icon('/img/ver/icon-512.png', '512x512'),
      icon('/img/ver/icon-maskable-512.png', '512x512', 'maskable'),
    ],
  };
}
