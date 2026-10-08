// Perfiles: dentro de una cuenta del proveedor, un nombre y qué ve (ver planes/perfiles.md). Viven en la configuración
// (config.profiles); cada link guarda el id de su perfil y una copia del filtro, así la playlist se sirve igual que
// siempre. Nada de esto cambia la dirección de un link ni borra uno.
import { PROFILE_ID_RE, saveConfig, type Config, type ProfileDef } from './config.ts';
import { randomId } from './crypto.ts';
import { updateRecords, listDevices, type ShortRecord } from './devices.ts';
import type { R2Bucket } from './env.ts';

const sameAccount = (a?: string, b?: string) => (a ?? '') === (b ?? '');
const filterKey = (f: unknown) => (f ? JSON.stringify(f) : '');

export const newProfileId = () => randomId(6);

/** Los links sin perfil (los de antes) pasan a uno: uno por cuenta y filtro. Sin filtro, el perfil se llama como la cuenta;
 *  con filtro, como el primer dispositivo que lo tenía. Solo agrega el id de perfil a los registros. Devuelve la config
 *  (cambiada si hizo falta). */
export async function ensureProfiles(bucket: R2Bucket, cfgId: string, config: Config, keyHash: string): Promise<Config> {
  const profiles = [...(config.profiles ?? [])];
  const devices = await listDevices(bucket, cfgId);
  const valid = (d: { profile?: string; account?: string }) => {
    const p = profiles.find((x) => x.id === d.profile);
    return !!p && sameAccount(p.account, d.account);
  };
  const orphans = devices.filter((d) => !valid(d));
  if (!orphans.length) return config;
  const assign = new Map<string, ProfileDef>();
  for (const d of orphans) {
    const k = `${d.account ?? ''}\u0000${filterKey(d.filter)}`;
    if (assign.has(k)) continue;
    // Si ya hay un perfil de esa cuenta con ese mismo filtro, va ahí.
    const same = profiles.find((p) => sameAccount(p.account, d.account) && filterKey(p.filter) === filterKey(d.filter));
    const name = d.filter ? d.name : (d.account || config.mainName || 'Todo');
    const p = same ?? { id: newProfileId(), name: name.slice(0, 30), ...(d.account ? { account: d.account } : {}), ...(d.filter ? { filter: d.filter } : {}) };
    if (!same) profiles.push(p);
    assign.set(k, p);
  }
  await updateRecords(bucket, cfgId, (rec: ShortRecord) => {
    if (valid({ profile: rec.profile, account: rec.account })) return null;
    const p = assign.get(`${rec.account ?? ''}\u0000${filterKey(rec.filter)}`);
    return p ? { ...rec, profile: p.id } : null;
  });
  const next = { ...config, profiles };
  await saveConfig(bucket, cfgId, next, keyHash);
  return next;
}

export const findProfile = (config: Config, id: unknown): ProfileDef | undefined =>
  typeof id === 'string' && PROFILE_ID_RE.test(id) ? config.profiles?.find((p) => p.id === id) : undefined;
