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
  /** Elegido a mano (el EPG no se recalcula al volver a cruzar con la guía). */
  manual?: boolean;
  /** Logo propio (URL http/https): manda sobre el de la guía, también sin EPG. */
  customLogo?: string;
}

export interface Config {
  version: 1;
  /** `list: 'upload'`: la lista no la baja el Worker (el proveedor bloquea Cloudflare) sino que
   *  la sube otro (la corrida de GitHub o la app) con PUT /api/cfg/<cfgId>/list. */
  provider: { type: 'xtream'; servers: string[]; list?: 'upload' } | { type: 'm3u' };
  /** Streams directo al servidor sano del momento, sin pasar por el redirect del Worker. */
  directUrls?: boolean;
  channels: Record<string, ChannelEdit>;
  /** `noEpg`: categorías que no necesitan guía (solo para la interfaz: no cuentan en "A revisar"). */
  /** `channels`: orden propio de los canales dentro de una categoría ({categoría: [nombres]});
   *  los que no están en la lista van después, en el orden del proveedor. */
  groups?: { order?: string[]; hidden?: string[]; noEpg?: string[]; channels?: Record<string, string[]> };
  /** Cómo elegir la guía (importado de la corrida de GitHub): umbral, señal horaria preferida y
   *  país/fuentes preferidas por categoría cruda del proveedor. Solo lo usa la interfaz. */
  matching?: Matching;
}

export interface Matching {
  minScore?: number;
  feed?: string | null;
  categories?: Record<string, { country?: string | null; prefer_sources?: string[] }>;
}

function parseMatching(v: unknown): Matching | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const out: Matching = {};
  if (typeof m.minScore === 'number' && m.minScore >= 0 && m.minScore <= 1) out.minScore = m.minScore;
  if (m.feed === null) out.feed = null;
  else if (str(m.feed, 20)) out.feed = str(m.feed, 20);
  if (m.categories && typeof m.categories === 'object') {
    const cats: NonNullable<Matching['categories']> = {};
    for (const [cat, raw] of Object.entries(m.categories as Record<string, unknown>).slice(0, 3000)) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const cfg: { country?: string | null; prefer_sources?: string[] } = {};
      if (c.country === null) cfg.country = null;
      else if (str(c.country, 10)) cfg.country = str(c.country, 10);
      const prefer = strList(c.prefer_sources, 50).map((x) => x.slice(0, 100));
      if (prefer.length) cfg.prefer_sources = prefer;
      if (Object.keys(cfg).length) cats[cat.slice(0, 500)] = cfg;
    }
    if (Object.keys(cats).length) out.categories = cats;
  }
  return Object.keys(out).length ? out : undefined;
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
    if (e.manual === true) edit.manual = true;
    const logo = str(e.customLogo, 2000);
    if (logo && /^https?:\/\/[^\s"]+$/i.test(logo)) edit.customLogo = logo;
    if (Object.keys(edit).length) channels[name.slice(0, 500)] = edit;
  }
  const g = (r.groups ?? {}) as Record<string, unknown>;
  const channelOrder: Record<string, string[]> = {};
  if (g.channels && typeof g.channels === 'object') {
    for (const [group, names] of Object.entries(g.channels as Record<string, unknown>).slice(0, 2000)) {
      const list = strList(names, 5000);
      if (list.length) channelOrder[group.slice(0, 500)] = list;
    }
  }
  const matching = parseMatching(r.matching);
  return {
    version: 1,
    provider,
    ...(r.directUrls === true ? { directUrls: true } : {}),
    ...(matching ? { matching } : {}),
    channels,
    groups: {
      order: strList(g.order, 5000),
      hidden: strList(g.hidden, 5000),
      ...(strList(g.noEpg, 5000).length ? { noEpg: strList(g.noEpg, 5000) } : {}),
      ...(Object.keys(channelOrder).length ? { channels: channelOrder } : {}),
    },
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
