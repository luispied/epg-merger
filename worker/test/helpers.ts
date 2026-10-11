// R2, caché y proveedor Xtream simulados para probar el Worker sin red.
import type { Ctx, Env, R2Bucket, R2ObjectBody, SimpleCache } from '../src/env.ts';
import { b64urlEncode } from '../src/crypto.ts';

export class MemoryBucket implements R2Bucket {
  data = new Map<string, { value: string; bytes?: Uint8Array; meta?: Record<string, string>; encoding?: string; uploaded?: Date }>();
  async head(key: string) {
    const item = this.data.get(key);
    return item ? { uploaded: item.uploaded ?? new Date(0) } : null;
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null> {
    const item = this.data.get(key);
    if (!item) return null;
    let bytes = item.bytes ?? new TextEncoder().encode(item.value);
    if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
    return {
      body: new Response(bytes).body as ReadableStream,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
      uploaded: item.uploaded,
      customMetadata: item.meta,
      httpMetadata: item.encoding ? { contentEncoding: item.encoding } : undefined,
    };
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentEncoding?: string } }) {
    const bytes = typeof value === 'string' ? undefined : new Uint8Array(await new Response(value).arrayBuffer());
    this.data.set(key, {
      value: typeof value === 'string' ? value : new TextDecoder().decode(bytes), bytes,
      meta: options?.customMetadata, encoding: options?.httpMetadata?.contentEncoding, uploaded: new Date(),
    });
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(options?: { prefix?: string }) {
    return { objects: [...this.data.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).map((key) => ({ key })), truncated: false };
  }
}

export class MemoryCache implements SimpleCache {
  data = new Map<string, string>();
  async match(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : new Response(v);
  }
  async put(key: string, response: Response) {
    this.data.set(key, await response.text());
  }
}

export function makeEnv() {
  const pending: Promise<unknown>[] = [];
  const env: Env = { BUCKET: new MemoryBucket(), TOKEN_KEY: b64urlEncode(new Uint8Array(32).fill(7)) };
  const ctx: Ctx = { waitUntil: (p) => void pending.push(p) };
  return { env, ctx, cache: new MemoryCache(), settle: () => Promise.all(pending) };
}

/** Proveedor Xtream simulado: servidores caídos o sanos, y lo que devuelve player_api. */
export function mockXtream(opts: { down?: string[]; streams?: unknown[]; categories?: unknown[] }) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (opts.down?.includes(url.origin)) throw new TypeError('connection refused');
    if (url.pathname.endsWith('/player_api.php')) {
      const action = url.searchParams.get('action');
      if (url.searchParams.get('username') !== 'user' || url.searchParams.get('password') !== 'pa ss') {
        return new Response(JSON.stringify({ user_info: { auth: 0 } }));
      }
      if (action === 'get_live_streams') return new Response(JSON.stringify(opts.streams ?? []));
      if (action === 'get_live_categories') return new Response(JSON.stringify(opts.categories ?? []));
      return new Response(JSON.stringify({ user_info: { auth: 1 } }));
    }
    if (url.pathname.endsWith('.m3u')) {
      return new Response('#EXTM3U\n#EXTINF:-1 tvg-id="Clan.es@SD" group-title="Kids",Clan (1080p)\nhttp://cdn/clan.m3u8\n');
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

export const STREAMS = [
  { name: 'AR| Telefe HD', stream_id: 10, category_id: '1', stream_icon: 'http://p/telefe.png', epg_channel_id: 'telefe.ar' },
  { name: 'ESPN', stream_id: 11, category_id: '2', stream_icon: '', epg_channel_id: null },
  { name: 'Evento del día', stream_id: 12, category_id: '3', container_extension: 'ts' },
  { name: 'Canal oculto', stream_id: 13, category_id: '1' },
];
export const CATEGORIES = [
  { category_id: '1', category_name: '🇦🇷 Argentina' },
  { category_id: '2', category_name: 'Deportes' },
  { category_id: '3', category_name: 'PPV / Eventos' },
];
