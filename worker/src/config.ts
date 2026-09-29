// Configuración anónima de una persona: sus ediciones sobre la lista del proveedor, sin
// credenciales ni URLs de stream. Se guarda en R2 (cfg/<cfgId>.json) con el hash de la clave
// de edición; quien tiene la clave la lee y la cambia, los links de reproducción no la llevan.
import { randomId, sha256Hex } from './crypto.ts';
import type { R2Bucket } from './env.ts';

/** Lo que la persona decidió para un canal, por su nombre crudo en el proveedor. */
export interface ChannelEdit {
  /** channel_id de la guía elegido (null = sin EPG a propósito). */
  epg?: string | null;
  /** Logo del canal de la guía elegido. */
  logo?: string;
  name?: string;
  group?: string;
  hidden?: boolean;
}

export interface Config {
  version: 1;
  /** `list: 'upload'`: la lista no la baja el Worker (el proveedor bloquea Cloudflare) sino que
   *  la sube otro (la corrida de GitHub o la app) con PUT /api/cfg/<cfgId>/list. */
  provider: { type: 'xtream'; servers: string[]; list?: 'upload' } | { type: 'm3u' };
  /** Streams directo al servidor sano del momento, sin pasar por el redirect del Worker. */
  directUrls?: boolean;
  channels: Record<string, ChannelEdit>;
  groups?: { order?: string[]; hidden?: string[] };
}

export class ConfigError extends Error {}

export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_SERVERS = 20;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const isId = (id: string) => ID_RE.test(id);

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;
const strList = (v: unknown, maxItems: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, 500)) : [];

/** Valida y normaliza una configuración que llega del navegador (solo los campos conocidos). */
export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new ConfigError('configuración inválida');
  const r = raw as Record<string, unknown>;
  const p = (r.provider ?? {}) as Record<string, unknown>;
  let provider: Config['provider'];
  if (p.type === 'm3u') provider = { type: 'm3u' };
  else if (p.type === 'xtream') {
    const servers = strList(p.servers, MAX_SERVERS);
    if (!servers.length) throw new ConfigError('faltan los servidores de Xtream');
    for (const s of servers) {
      let url: URL;
      try {
        url = new URL(s);
      } catch {
        throw new ConfigError(`servidor inválido: ${s}`);
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search) {
        // Las credenciales nunca van en la configuración: solo en el token del link.
        throw new ConfigError(`servidor inválido (sin usuario ni parámetros): ${url.host}`);
      }
    }
    provider = { type: 'xtream', servers, ...(p.list === 'upload' ? { list: 'upload' as const } : {}) };
  } else throw new ConfigError('proveedor inválido');

  const channels: Record<string, ChannelEdit> = {};
  const rawChannels = r.channels && typeof r.channels === 'object' ? r.channels as Record<string, unknown> : {};
  for (const [name, v] of Object.entries(rawChannels)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const edit: ChannelEdit = {};
    if (e.epg === null) edit.epg = null;
    else if (str(e.epg)) edit.epg = str(e.epg);
    if (str(e.logo, 2000)) edit.logo = str(e.logo, 2000);
    if (str(e.name)) edit.name = str(e.name);
    if (str(e.group)) edit.group = str(e.group);
    if (e.hidden === true) edit.hidden = true;
    if (Object.keys(edit).length) channels[name.slice(0, 500)] = edit;
  }
  const g = (r.groups ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    provider,
    ...(r.directUrls === true ? { directUrls: true } : {}),
    channels,
    groups: { order: strList(g.order, 5000), hidden: strList(g.hidden, 5000) },
  };
}

const key = (cfgId: string) => `cfg/${cfgId}.json`;

export async function loadConfig(bucket: R2Bucket, cfgId: string): Promise<{ config: Config; keyHash: string } | null> {
  if (!isId(cfgId)) return null;
  const obj = await bucket.get(key(cfgId));
  if (!obj) return null;
  return { config: JSON.parse(await obj.text()) as Config, keyHash: obj.customMetadata?.keyHash ?? '' };
}

export async function saveConfig(bucket: R2Bucket, cfgId: string, config: Config, keyHash: string): Promise<void> {
  await bucket.put(key(cfgId), JSON.stringify(config), {
    customMetadata: { keyHash }, httpMetadata: { contentType: 'application/json' },
  });
}

export async function createConfig(bucket: R2Bucket, config: Config): Promise<{ cfgId: string; editKey: string }> {
  const cfgId = randomId(16);
  const editKey = randomId(32);
  await saveConfig(bucket, cfgId, config, await sha256Hex(editKey));
  return { cfgId, editKey };
}

/** La clave de edición del pedido (`Authorization: Bearer …`) coincide con la guardada. */
export async function authorized(request: Request, keyHash: string): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('Authorization') ?? '');
  return !!m && !!keyHash && (await sha256Hex(m[1])) === keyHash;
}
