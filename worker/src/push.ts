// Avisos push (Web Push, RFC 8030) para el navegador y la PWA: el Worker le manda al servicio de
// push del navegador (Google, Mozilla, Apple) un mensaje cifrado (RFC 8291, aes128gcm) y firmado con
// una clave VAPID (RFC 8292). Los datos de cada suscripción (dirección del servicio y claves
// públicas) están en push/<cfgId>.json; no llevan credenciales del proveedor.
//
// Claves: VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (secreto) del Worker; las genera tools/gen_vapid.mjs.
// Sin ellas la función no existe: /api/push/key responde 404 y la web no muestra el interruptor.
import { b64urlDecode, b64urlEncode } from './crypto.ts';
import type { Env, R2Bucket } from './env.ts';

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  created: string;
}
export interface PushState {
  subs: PushSub[];
  /** Nombres de canales que ya se conocían la última vez (para avisar solo los nuevos). */
  known?: string[];
}

const MAX_SUBS = 10;
const enc = new TextEncoder();
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
export const pushKey = (cfgId: string) => `push/${cfgId}.json`;

export const pushConfigured = (env: Env) => !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY;

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

const ecJwk = (pub: Uint8Array, d?: string): JsonWebKey => ({
  kty: 'EC', crv: 'P-256', ext: true, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ...(d ? { d } : {}),
});

/** Cifra `plain` para un navegador (RFC 8291). `opts` solo se usa en los tests (vector de la RFC). */
export async function encryptWebPush(plain: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
  opts: { salt?: Uint8Array; ephemeral?: { publicRaw: Uint8Array; d: string } } = {}): Promise<Uint8Array> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (opts.ephemeral) {
    asPublic = opts.ephemeral.publicRaw;
    asPrivate = await crypto.subtle.importKey('jwk', ecJwk(asPublic, opts.ephemeral.d), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(shared, authSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // Un solo registro: el texto y el delimitador 0x02 (el último registro).
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, concat(plain, new Uint8Array([2])) as BufferSource));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** Encabezado Authorization de VAPID (RFC 8292) para el servicio de push de `endpoint`. */
export async function vapidHeader(env: Env, endpoint: string, now = Date.now()): Promise<string> {
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey('jwk', ecJwk(pub, env.VAPID_PRIVATE_KEY!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://grilla.grilla.workers.dev',
  })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Manda un aviso a una suscripción. `gone`: el servicio dice que ya no existe (hay que borrarla). */
export async function sendPush(env: Env, sub: PushSub, message: { title: string; body: string; url?: string }): Promise<{ ok: boolean; gone: boolean }> {
  const body = await encryptWebPush(enc.encode(JSON.stringify(message)), b64urlDecode(sub.keys.p256dh), b64urlDecode(sub.keys.auth));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '86400', Urgency: 'normal',
    },
    body: body as BufferSource,
  });
  return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
}

async function readState(bucket: R2Bucket, cfgId: string): Promise<PushState> {
  const obj = await bucket.get(pushKey(cfgId));
  if (!obj) return { subs: [] };
  try {
    const v = JSON.parse(await obj.text()) as PushState;
    return { subs: Array.isArray(v.subs) ? v.subs : [], known: Array.isArray(v.known) ? v.known : undefined };
  } catch {
    return { subs: [] };
  }
}
const writeState = (bucket: R2Bucket, cfgId: string, st: PushState) =>
  st.subs.length ? bucket.put(pushKey(cfgId), JSON.stringify(st), JSON_TYPE) : bucket.delete(pushKey(cfgId));

/** Valida lo que manda el navegador (PushSubscription.toJSON()). */
export function parseSubscription(raw: unknown, now = new Date()): PushSub | null {
  const v = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!v || typeof v.endpoint !== 'string' || typeof v.keys?.p256dh !== 'string' || typeof v.keys?.auth !== 'string') return null;
  let url: URL;
  try { url = new URL(v.endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || v.endpoint.length > 1024) return null;
  if (b64urlDecode(v.keys.p256dh).length !== 65 || b64urlDecode(v.keys.auth).length !== 16) return null;
  return { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth }, created: now.toISOString() };
}

export async function addSub(bucket: R2Bucket, cfgId: string, sub: PushSub, known?: string[]): Promise<boolean> {
  const st = await readState(bucket, cfgId);
  const subs = [...st.subs.filter((s) => s.endpoint !== sub.endpoint), sub];
  if (subs.length > MAX_SUBS) subs.shift();
  await writeState(bucket, cfgId, { subs, known: st.known ?? known });
  return true;
}

export async function removeSub(bucket: R2Bucket, cfgId: string, endpoint: string): Promise<void> {
  const st = await readState(bucket, cfgId);
  await writeState(bucket, cfgId, { ...st, subs: st.subs.filter((s) => s.endpoint !== endpoint) });
}

export async function pushToConfig(env: Env, cfgId: string, message: { title: string; body: string; url?: string }): Promise<number> {
  const st = await readState(env.BUCKET, cfgId);
  let sent = 0;
  const alive: PushSub[] = [];
  for (const sub of st.subs) {
    try {
      const r = await sendPush(env, sub, message);
      if (r.ok) sent++;
      if (!r.gone) alive.push(sub);
    } catch {
      alive.push(sub); // sin red un momento: se reintenta en la próxima
    }
  }
  if (alive.length !== st.subs.length) await writeState(env.BUCKET, cfgId, { ...st, subs: alive });
  return sent;
}

const DIVIDER = /[▆░▒▓█]/;
/** Nombres de canales que cuentan para «nuevos»: sin separadores ni ocultos (por canal o por categoría). */
export function visibleNames(list: { channels?: { name?: string; category?: string }[] }, cfg: { channels?: Record<string, { hidden?: boolean; group?: string }>; groups?: { hidden?: string[] } } | null): string[] {
  const hiddenGroups = new Set(cfg?.groups?.hidden ?? []);
  const out = new Set<string>();
  for (const ch of list.channels ?? []) {
    if (!ch.name || DIVIDER.test(ch.name) || DIVIDER.test(ch.category ?? '')) continue;
    const edit = cfg?.channels?.[ch.name];
    if (edit?.hidden || hiddenGroups.has(edit?.group || ch.category || '')) continue;
    out.add(ch.name);
  }
  return [...out];
}

/** Lista guardada de una configuración con avisos: si trae canales que no estaban, los avisa. */
export async function notifyNewChannels(env: Env, cfgId: string): Promise<number> {
  const st = await readState(env.BUCKET, cfgId);
  if (!st.subs.length) return 0;
  const listObj = await env.BUCKET.get(`list/${cfgId}.json`);
  if (!listObj) return 0;
  const cfgObj = await env.BUCKET.get(`cfg/${cfgId}.json`);
  let list: { channels?: { name?: string; category?: string }[] };
  let cfg: Parameters<typeof visibleNames>[1] = null;
  try {
    list = JSON.parse(await listObj.text());
    cfg = cfgObj ? JSON.parse(await cfgObj.text()) : null;
  } catch {
    return 0;
  }
  const names = visibleNames(list, cfg);
  if (st.known === undefined) { // primera vez: todo lo que hay es conocido
    await writeState(env.BUCKET, cfgId, { ...st, known: names });
    return 0;
  }
  const known = new Set(st.known);
  const fresh = names.filter((n) => !known.has(n));
  if (!fresh.length) return 0;
  const sent = await pushToConfig(env, cfgId, {
    title: fresh.length === 1 ? 'Hay 1 canal nuevo' : `Hay ${fresh.length} canales nuevos`,
    body: `${fresh.slice(0, 3).join(', ')}${fresh.length > 3 ? ' y más' : ''} en tu lista.`, url: '/?filtro=nuevos',
  });
  const after = await readState(env.BUCKET, cfgId); // pudo cambiar (suscripciones caídas)
  if (after.subs.length) await writeState(env.BUCKET, cfgId, { ...after, known: [...new Set([...st.known, ...names])] });
  return sent;
}

/** Corrida programada: revisa cada configuración con avisos. */
export async function checkAllPush(env: Env): Promise<void> {
  if (!pushConfigured(env)) return;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: 'push/', cursor });
    for (const obj of page.objects) {
      const cfgId = obj.key.slice('push/'.length).replace(/\.json$/, '');
      try { await notifyNewChannels(env, cfgId); } catch { /* una configuración no frena a las demás */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Nombres actuales de la lista, para que el primer aviso no cuente lo que ya estaba. */
export async function currentNames(bucket: R2Bucket, cfgId: string): Promise<string[] | undefined> {
  const listObj = await bucket.get(`list/${cfgId}.json`);
  if (!listObj) return undefined;
  const cfgObj = await bucket.get(`cfg/${cfgId}.json`);
  try {
    return visibleNames(JSON.parse(await listObj.text()), cfgObj ? JSON.parse(await cfgObj.text()) : null);
  } catch {
    return undefined;
  }
}
