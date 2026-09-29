// Lista de canales del proveedor, de paso: Xtream (player_api, con failover entre los
// servidores del balanceador) o M3U. Misma forma que providers.py, en el orden del proveedor.
// Nada de esto se guarda: las credenciales llegan en el pedido o en el token del link.

export interface Channel {
  name: string;
  category: string;
  /** Xtream: stream_id. M3U: vacío (el stream va por `url`). */
  id: string;
  ext: string;
  icon: string;
  epgId: string | null;
  /** Solo M3U: la URL del stream tal cual viene en la lista. */
  url?: string;
}

export class ProviderError extends Error {}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_LIST_BYTES = 30 * 1024 * 1024;
const USER_AGENT = 'Grilla/1.0';

/** "http://host:8080/" → "http://host:8080" (y rechaza lo que no sea http/https). */
export function normalizeServer(server: string): string {
  const url = new URL(server.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProviderError(`servidor inválido: ${server}`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return '?';
  }
}

/** El cuerpo como texto, cortando si pasa el límite (una lista no debería pesar tanto). */
async function readLimited(res: Response, limit = MAX_LIST_BYTES): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ProviderError('la lista es demasiado grande');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Un pedazo del cuerpo de una respuesta inesperada, para diagnosticar (sin HTML). */
async function snippet(res: Response): Promise<string> {
  try {
    const text = (await readLimited(res, 64 * 1024)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? `: ${text.slice(0, 120)}` : '';
  } catch {
    return '';
  }
}

async function getJson(url: string, userAgent = USER_AGENT, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  const server = res.headers.get('Server') ?? '';
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}${server ? ` (${server})` : ''}${await snippet(res)}`);
  const text = await readLimited(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`no respondió JSON (¿no es un servidor Xtream?)${await snippet(new Response(text))}`);
  }
}

export function playerApiUrl(server: string, u: string, p: string, action?: string): string {
  const q = new URLSearchParams({ username: u, password: p });
  if (action) q.set('action', action);
  return `${server}/player_api.php?${q}`;
}

export function streamUrl(server: string, u: string, p: string, id: string, ext: string): string {
  return `${server}/live/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${id}.${ext || 'm3u8'}`;
}

interface XtreamStream {
  name?: string;
  stream_id?: number | string;
  category_id?: number | string;
  stream_icon?: string;
  epg_channel_id?: string | null;
  container_extension?: string;
}

/** Prueba cada servidor en orden (como xtream_client.py). Devuelve el que respondió y la lista. */
export async function loadXtream(servers: string[], u: string, p: string, userAgent = USER_AGENT): Promise<{ server: string; channels: Channel[] }> {
  const errors: string[] = [];
  for (const raw of servers) {
    let server: string;
    try {
      server = normalizeServer(raw);
    } catch (e) {
      errors.push(String((e as Error).message));
      continue;
    }
    try {
      const streams = await getJson(playerApiUrl(server, u, p, 'get_live_streams'), userAgent);
      if (!Array.isArray(streams)) throw new ProviderError('respuesta inesperada');
      let categories: Record<string, string> = {};
      try {
        const cats = await getJson(playerApiUrl(server, u, p, 'get_live_categories'), userAgent);
        if (Array.isArray(cats)) {
          categories = Object.fromEntries(cats.map((c: { category_id: unknown; category_name: string }) =>
            [String(c.category_id), c.category_name]));
        }
      } catch {
        // Sin categorías la lista sirve igual (todo queda en "General").
      }
      const channels = (streams as XtreamStream[]).map((s) => ({
        name: s.name ?? '',
        category: categories[String(s.category_id)] ?? 'General',
        id: String(s.stream_id ?? ''),
        ext: s.container_extension || 'm3u8',
        icon: s.stream_icon ?? '',
        epgId: s.epg_channel_id || null,
      }));
      return { server, channels };
    } catch (e) {
      // Sin la URL: lleva las credenciales.
      errors.push(`${hostOf(server)}: ${(e as Error).message}`);
    }
  }
  throw new ProviderError(`ningún servidor respondió (${errors.join('; ')})`);
}

const EXTINF_RE = /^#EXTINF:\s*-?\d+((?:\s+[\w-]+="[^"]*")*)[^,]*,(.*)$/;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/** Canales de un M3U extendido (port de providers.parse_m3u). */
export function parseM3u(text: string): Channel[] {
  const channels: Channel[] = [];
  let pending: { name: string; category: string | undefined; icon: string; epgId: string | null } | null = null;
  let group: string | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const m = EXTINF_RE.exec(line);
      if (!m) {
        pending = null;
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[1] ?? '').matchAll(ATTR_RE)) attrs[a[1]] = a[2];
      pending = { name: m[2].trim() || attrs['tvg-name'] || '', category: attrs['group-title'],
        icon: attrs['tvg-logo'] ?? '', epgId: attrs['tvg-id'] || null };
      group = null;
    } else if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim();
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending) {
      channels.push({ name: pending.name, category: pending.category || group || 'General', id: '', ext: '',
        icon: pending.icon, epgId: pending.epgId, url: line });
      pending = null;
      group = null;
    }
  }
  return channels;
}

const MAX_UPLOADED_CHANNELS = 30_000;

/** Valida una lista subida (sin credenciales ni URLs de stream: solo lo que usa la playlist). */
export function parseUploadedList(raw: unknown): { server?: string; channels: Channel[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.channels)) throw new ProviderError('lista inválida');
  const s = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
  const channels = r.channels.slice(0, MAX_UPLOADED_CHANNELS).flatMap((c): Channel[] => {
    if (!c || typeof c !== 'object') return [];
    const ch = c as Record<string, unknown>;
    const id = s(ch.id, 20);
    if (!/^\d+$/.test(id)) return [];
    const ext = /^[A-Za-z0-9]{1,6}$/.test(s(ch.ext)) ? s(ch.ext) : 'm3u8';
    return [{ name: s(ch.name), category: s(ch.category) || 'General', id, ext, icon: s(ch.icon, 2000),
      epgId: s(ch.epgId) || null }];
  });
  if (!channels.length) throw new ProviderError('la lista no tiene canales');
  return { channels };
}

export async function loadM3u(url: string): Promise<Channel[]> {
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    throw new ProviderError('URL inválida');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new ProviderError('URL inválida');
  const res = await fetch(target.toString(), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
  const channels = parseM3u(await readLimited(res));
  if (!channels.length) throw new ProviderError('la lista no tiene canales');
  return channels;
}
