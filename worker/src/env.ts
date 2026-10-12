// Lo que el Worker recibe de Cloudflare (ver wrangler.toml). R2 con una interfaz mínima: solo
// lo que se usa, así no hace falta @cloudflare/workers-types (y los tests usan un R2 en memoria).

export interface R2ObjectBody {
  body: ReadableStream;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string; contentEncoding?: string };
  httpEtag?: string;
  uploaded?: Date;
}

export interface R2Bucket {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ uploaded: Date } | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string; contentEncoding?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Caché del Worker (Cache API de Cloudflare). En los tests, una en memoria. */
export interface SimpleCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface Env {
  BUCKET: R2Bucket;
  /** Clave AES-256 en base64 para cifrar las credenciales dentro de los links. */
  TOKEN_KEY: string;
  /** Opcional: token de GitHub (permiso Actions: escritura en el repo) para lanzar la corrida
   *  que sube listas y arma guías apenas hace falta, sin esperar el cron (ver src/github.ts). */
  GITHUB_TOKEN?: string;
  /** Opcional: "dueño/repo" (por defecto luispied/epg-merger). */
  GITHUB_REPO?: string;
  /** Opcionales: el relay que pide al proveedor lo que Cloudflare no puede (ver src/relay.ts y ../relay/README.md). */
  RELAY_URL?: string;
  RELAY_SECRET?: string;
  /** Opcionales: claves VAPID para los avisos push (ver src/push.ts y tools/gen_vapid.mjs). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}
