// Lo que el Worker recibe de Cloudflare (ver wrangler.toml). R2 con una interfaz mínima: solo
// lo que se usa, así no hace falta @cloudflare/workers-types (y los tests usan un R2 en memoria).

export interface R2ObjectBody {
  body: ReadableStream;
  text(): Promise<string>;
  customMetadata?: Record<string, string>;
  httpEtag?: string;
  uploaded?: Date;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | ArrayBuffer | ReadableStream,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
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
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}
