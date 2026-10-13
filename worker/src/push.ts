// Avisos push (Web Push, RFC 8030) para el navegador y la PWA: el Worker le manda al servicio de
// push del navegador (Google, Mozilla, Apple) un mensaje cifrado (RFC 8291, aes128gcm) y firmado con
// una clave VAPID (RFC 8292). Los datos de cada suscripción (dirección del servicio y claves
// públicas) están en push/<cfgId>.json; no llevan credenciales del proveedor.
//
// Claves: VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (secreto) del Worker; las genera tools/gen_vapid.mjs.
// Sin ellas la función no existe: /api/push/key responde 404 y la web no muestra el interruptor.
import { b64urlDecode, b64urlEncode } from './crypto.ts';
import type { Env, R2Bucket } from './env.ts';
import { channelAlias } from '../../core/src/alias.ts';
import { readReminders, REMIND_AHEAD_S, REMIND_GRACE_S, writeReminders } from './remind.ts';
import { readHabits } from './habits.ts';
import { type Habits, noStreak, NO_STREAK_OFF } from '../../core/src/taste.ts';
import { scheduleFile } from './again.ts';
import { readEntries, scheduleReader } from './schedule.ts';
import { playlistRows, type DeviceFilter } from './playlist.ts';
import { parseConfig, parseProfiles, type Config, type ProfileDef } from './config.ts';
import type { Channel } from './provider.ts';
import {
  allowedGenres, emptyTaste, hasQuota, inWindow, localHm, MAX_SENT, parseTaste, pickProgram, seenGenres, setGenre, validTz,
  WHENS, type TasteChannel, type TasteState, type TasteWhen,
} from './taste.ts';

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  created: string;
  /** Perfiles que reciben sus avisos por gusto en este dispositivo (ver taste.ts). */
  profiles?: string[];
}
export interface PushState {
  subs: PushSub[];
  /** Nombres de canales que ya se conocían la última vez (para avisar solo los nuevos). */
  known?: string[];
  /** Último aviso de vencimiento de la suscripción del proveedor (para avisar una vez por umbral). */
  expiry?: { expires: string; threshold: number };
  /** Avisos por gusto de cada perfil (taste.ts): interruptor, géneros, horario y los últimos avisos. */
  tastes?: Record<string, TasteState>;
  /** Antes eran de la configuración entera; migrateTaste los pasa al perfil principal. */
  taste?: TasteState;
}

const MAX_SUBS = 10;
const enc = new TextEncoder();
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
export const pushKey = (cfgId: string) => `push/${cfgId}.json`;
const cfgKey = (cfgId: string) => `cfg/${cfgId}.json`;

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
    const e = v.expiry;
    const tastes = Object.fromEntries(Object.entries(v.tastes ?? {}).flatMap(([id, t]) => {
      const p = parseTaste(t);
      return p ? [[id, p]] : [];
    }));
    return {
      subs: Array.isArray(v.subs) ? v.subs.map((s) => ({ ...s, profiles: Array.isArray(s.profiles) ? s.profiles.filter((x) => typeof x === 'string') : undefined })) : [],
      known: Array.isArray(v.known) ? v.known : undefined,
      ...(Object.keys(tastes).length ? { tastes } : {}),
      ...(parseTaste(v.taste) ? { taste: parseTaste(v.taste) } : {}),
      ...(e && typeof e.expires === 'string' && typeof e.threshold === 'number' ? { expiry: { expires: e.expires, threshold: e.threshold } } : {}),
    };
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
  const old = st.subs.find((s) => s.endpoint === sub.endpoint);
  const subs = [...st.subs.filter((s) => s.endpoint !== sub.endpoint), { ...sub, ...(old?.profiles ? { profiles: old.profiles } : {}) }];
  if (subs.length > MAX_SUBS) subs.shift();
  await writeState(bucket, cfgId, { ...st, subs, known: st.known ?? known });
  return true;
}

export async function removeSub(bucket: R2Bucket, cfgId: string, endpoint: string): Promise<void> {
  const st = await readState(bucket, cfgId);
  await writeState(bucket, cfgId, { ...st, subs: st.subs.filter((s) => s.endpoint !== endpoint) });
}

export const pushToConfig = (env: Env, cfgId: string, message: PushMessage) => pushTo(env, cfgId, () => true, message);

type PushMessage = { title: string; body: string; url?: string };

/** Manda a los dispositivos que cumplen `pick`; quita los que el servicio dio de baja. */
export async function pushTo(env: Env, cfgId: string, pick: (s: PushSub) => boolean, message: PushMessage): Promise<number> {
  const st = await readState(env.BUCKET, cfgId);
  let sent = 0;
  const alive: PushSub[] = [];
  for (const sub of st.subs) {
    if (!pick(sub)) {
      alive.push(sub);
      continue;
    }
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

/** Días antes del vencimiento en que se avisa (0 = hoy o ya vencida). */
export const EXPIRY_THRESHOLDS = [7, 3, 1, 0];
const DAY_MS = 86_400_000;

/** El umbral que corresponde a `days` días para vencer (el más chico que ya se cruzó), o null si falta mucho. */
export function expiryThreshold(days: number): number | null {
  const t = EXPIRY_THRESHOLDS.filter((x) => days <= x);
  return t.length ? Math.min(...t) : null;
}

/** Vencimiento de la suscripción del proveedor (lo anota la corrida diaria de GitHub en health/<cfgId>.json):
 *  avisa al cruzar 7, 3 y 1 día, y el día que vence; un vencimiento nuevo (renovó) vuelve a empezar. */
export async function notifyExpiry(env: Env, cfgId: string, now = new Date()): Promise<number> {
  const st = await readState(env.BUCKET, cfgId);
  if (!st.subs.length) return 0;
  const obj = await env.BUCKET.get(`health/${cfgId}.json`);
  if (!obj) return 0;
  let expires: string | null | undefined;
  try {
    expires = (JSON.parse(await obj.text()) as { account?: { expires?: string | null } }).account?.expires;
  } catch {
    return 0;
  }
  const at = expires ? Date.parse(expires) : NaN;
  if (!expires || Number.isNaN(at)) return 0;
  const days = Math.floor((at - now.getTime()) / DAY_MS);
  const t = expiryThreshold(days);
  if (t === null) return 0;
  if (st.expiry && st.expiry.expires === expires && t >= st.expiry.threshold) return 0;
  const date = new Date(at).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
  const body = days < 0 ? `Tu suscripción del proveedor venció el ${date}.`
    : days === 0 ? `Tu suscripción del proveedor vence hoy (${date}).`
    : `Tu suscripción del proveedor vence el ${date}: ${days === 1 ? 'falta 1 día' : `faltan ${days} días`}.`;
  const sent = await pushToConfig(env, cfgId, { title: days < 0 ? 'Suscripción vencida' : 'Tu suscripción está por vencer', body, url: '/' });
  const after = await readState(env.BUCKET, cfgId); // pudo cambiar (suscripciones caídas)
  if (after.subs.length) await writeState(env.BUCKET, cfgId, { ...after, expiry: { expires, threshold: t } });
  return sent;
}

/** Recordatorios de programas («Avisarme»): manda los que empiezan en los próximos 30 minutos (la corrida es cada 30:
 *  el aviso llega entre 0 y 30 minutos antes) y descarta los que ya pasaron sin poder avisarse. */
export async function notifyReminders(env: Env, cfgId: string, now = new Date()): Promise<number> {
  const items = await readReminders(env.BUCKET, cfgId);
  if (!items.length) return 0;
  const nowS = Math.floor(now.getTime() / 1000);
  const st = await readState(env.BUCKET, cfgId);
  const expired = items.filter((r) => r.start < nowS - REMIND_GRACE_S);
  // Sin dispositivos suscritos no se puede avisar: se espera (o vencen solos).
  const due = st.subs.length ? items.filter((r) => r.start <= nowS + REMIND_AHEAD_S && r.start >= nowS - REMIND_GRACE_S) : [];
  let sent = 0;
  for (const r of due) {
    sent += await pushToConfig(env, cfgId, { title: `Empieza pronto: ${r.title}`, body: r.name ? `${r.name} · en unos minutos` : 'En unos minutos', url: '/' });
  }
  const gone = new Set([...expired, ...due]);
  if (gone.size) await writeReminders(env.BUCKET, cfgId, items.filter((r) => !gone.has(r)));
  return sent;
}

/** Los canales visibles de la lista con su guía (el epg que les asignó el editor); sin guía no hay qué avisar. */
export function visibleGuideChannels(list: { channels?: { name?: string; category?: string }[] }, cfg: Parameters<typeof visibleNames>[1]): TasteChannel[] {
  const out = new Map<string, TasteChannel>();
  for (const name of visibleNames(list, cfg)) {
    const edit = cfg?.channels?.[name] as { epg?: string | null; group?: string } | undefined;
    if (!edit?.epg) continue;
    const epg = channelAlias(edit.epg);
    if (!out.has(epg)) out.set(epg, { epg, name, cat: edit.group || list.channels?.find((c) => c.name === name)?.category || '' });
  }
  return [...out.values()];
}

/** Canales que ve un perfil (con su filtro «Qué ve», las ediciones y la guía elegida), como la playlist. */
export function profileGuideChannels(list: { channels?: Channel[] }, cfg: Config, filter?: DeviceFilter): TasteChannel[] {
  const out = new Map<string, TasteChannel>();
  for (const r of playlistRows(list.channels ?? [], cfg, { filter, providerLogos: false })) {
    if (!r.epg || r.separator) continue;
    const epg = channelAlias(r.epg);
    if (!out.has(epg)) out.set(epg, { epg, name: r.name, cat: r.group });
  }
  return [...out.values()];
}

/** Los perfiles de la configuración (el primero es el principal). */
async function readProfiles(bucket: R2Bucket, cfgId: string): Promise<ProfileDef[]> {
  const obj = await bucket.get(cfgKey(cfgId));
  if (!obj) return [];
  try {
    return parseProfiles((JSON.parse(await obj.text()) as { profiles?: unknown }).profiles);
  } catch {
    return [];
  }
}

/** Antes los avisos por gusto eran de la configuración entera: lo que había pasa al perfil principal, con sus
 *  dispositivos. Se hace al leer, y se guarda la próxima vez que cambie algo. */
function migrateTaste(st: PushState, profiles: ProfileDef[]): PushState {
  const main = profiles[0]?.id;
  if (!st.taste || !main) return st;
  const { taste, ...rest } = st;
  return {
    ...rest,
    tastes: { [main]: taste, ...st.tastes },
    subs: st.subs.map((s) => (s.profiles ? s : { ...s, profiles: [main] })),
  };
}

async function loadTastes(bucket: R2Bucket, cfgId: string): Promise<{ st: PushState; profiles: ProfileDef[] }> {
  const [st, profiles] = await Promise.all([readState(bucket, cfgId), readProfiles(bucket, cfgId)]);
  return { st: migrateTaste(st, profiles), profiles };
}

const tasteOf = (st: PushState, profile: string): TasteState => st.tastes?.[profile] ?? emptyTaste();

/** Aviso por gusto de un perfil (taste.ts): con el interruptor prendido, dentro de la ventana y con cupo, el mejor
 *  programa de sus canales y de su gusto que empieza pronto; si ninguno es bueno, no manda nada. Solo a los
 *  dispositivos suscritos a ese perfil. */
export async function notifyTaste(env: Env, cfgId: string, now = new Date()): Promise<number> {
  const { st, profiles } = await loadTastes(env.BUCKET, cfgId);
  if (!st.tastes || !st.subs.some((s) => s.profiles?.length)) return 0;
  const [listObj, cfgObj] = await Promise.all([env.BUCKET.get(`list/${cfgId}.json`), env.BUCKET.get(cfgKey(cfgId))]);
  if (!listObj) return 0;
  let list: { channels?: Channel[] };
  let cfg: Config;
  try {
    list = JSON.parse(await listObj.text());
    cfg = parseConfig(cfgObj ? JSON.parse(await cfgObj.text()) : {});
  } catch {
    return 0;
  }
  let sent = 0;
  for (const p of profiles) {
    if (!tasteOf(st, p.id).on) continue;
    sent += await notifyProfileTaste(env, cfgId, p, st, list, cfg, now);
  }
  return sent;
}

async function notifyProfileTaste(env: Env, cfgId: string, p: ProfileDef, st: PushState, list: { channels?: Channel[] }, cfg: Config, now: Date): Promise<number> {
  const bucket = env.BUCKET;
  const t = tasteOf(st, p.id);
  const member = (s: PushSub) => !!s.profiles?.includes(p.id);
  if (!st.subs.some(member) || !inWindow(now.getTime(), t) || !hasQuota(t, now.getTime())) return 0;
  const habits = await readHabits(bucket, cfgId, p.id);
  const kids = p.kids ? new Set(p.kids.genres) : null;
  const genres = allowedGenres(habits, t, now.getTime()).filter((g) => !kids || kids.has(g));
  if (!genres.length) return 0;
  const channels = profileGuideChannels(list, cfg, p.filter);
  const read = scheduleReader(bucket);
  const schedules = new Map<string, Awaited<ReturnType<typeof readEntries>>>();
  const files = await Promise.all(channels.map((c) => scheduleFile(c.epg)));
  for (let k = 0; k < channels.length; k += 25) {
    const part = await Promise.all(files.slice(k, k + 25).map((f) => readEntries(read, f)));
    part.forEach((e, i) => schedules.set(channels[k + i].epg, e));
  }
  const marks = new Set((await readReminders(bucket, cfgId)).map((r) => `${channelAlias(r.epg)}|${r.start}`));
  const pick = pickProgram(channels, { habits, marks, schedules, genres, sent: t.sent, nowMs: now.getTime() });
  if (!pick) return 0;
  const [start, , title] = pick.entry;
  const sent = await pushTo(env, cfgId, member, {
    title: `Hoy a las ${localHm(start * 1000, t.tz)}: ${title}`,
    body: `${pick.genre} en ${pick.ch.name}. Es de lo que más mirás.`,
    url: `/?programa=${encodeURIComponent(pick.ch.epg)}&inicio=${start}`,
  });
  if (!sent) return 0;
  const after = (await loadTastes(bucket, cfgId)).st; // pudo cambiar (suscripciones caídas, o la persona tocó algo)
  const cur = after.tastes?.[p.id];
  if (after.subs.length && cur) {
    const sentList = [...cur.sent, { title, genre: pick.genre, at: now.toISOString(), epg: pick.ch.epg, name: pick.ch.name, start }].slice(-MAX_SENT);
    await writeState(bucket, cfgId, { ...after, tastes: { ...after.tastes, [p.id]: { ...cur, sent: sentList } } });
  }
  return sent;
}

export interface TasteView {
  on: boolean;
  when: TasteWhen;
  tz: string;
  /** Este dispositivo recibe los avisos de este perfil. */
  here: boolean;
  /** Los géneros del perfil. `on`: se avisa de ellos. */
  genres: { name: string; on: boolean }[];
  sent: { title: string; genre: string; at: string; name: string }[];
}

/** Lo que muestra la hoja de un perfil. Null si el perfil no existe. */
export async function getTaste(bucket: R2Bucket, cfgId: string, profile: string, endpoint = '', now = new Date()): Promise<TasteView | null> {
  const { st, profiles } = await loadTastes(bucket, cfgId);
  if (!profiles.some((p) => p.id === profile)) return null;
  return tasteView(bucket, cfgId, st, profile, endpoint, now);
}

async function tasteView(bucket: R2Bucket, cfgId: string, st: PushState, profile: string, endpoint: string, now: Date): Promise<TasteView> {
  const t = tasteOf(st, profile);
  const h = await readHabits(bucket, cfgId, profile);
  const allowed = new Set(allowedGenres(h, t, now.getTime()));
  return {
    on: t.on, when: t.when, tz: t.tz,
    here: st.subs.some((s) => s.endpoint === endpoint && !!s.profiles?.includes(profile)),
    genres: seenGenres(h, t).map((name) => ({ name, on: allowed.has(name) })),
    sent: t.sent.slice(-5).reverse().map(({ title, genre, at, name }) => ({ title, genre, at, name })),
  };
}

/** Tres «No me interesa» seguidos de un mismo género (noStreak, core/src/taste.ts) apagan ese género en los avisos de
 *  este perfil. Devuelve el género apagado ahora, o null si no hizo falta. */
export async function autoOffGenre(bucket: R2Bucket, cfgId: string, profile: string, h: Habits, now = new Date()): Promise<string | null> {
  const s = noStreak(h);
  if (!s || s.n < NO_STREAK_OFF) return null;
  const { st, profiles } = await loadTastes(bucket, cfgId);
  if (!profiles.some((p) => p.id === profile)) return null;
  const t = tasteOf(st, profile);
  if (!allowedGenres(h, t, now.getTime()).includes(s.genre)) return null;
  await writeState(bucket, cfgId, { ...st, tastes: { ...st.tastes, [profile]: setGenre(t, h, now.getTime(), s.genre, false) } });
  return s.genre;
}

/** Cambia los avisos por gusto de un perfil. Prender pide que este dispositivo (`endpoint`) ya esté suscrito a los
 *  avisos, y lo deja recibiendo los de este perfil. Devuelve el estado, o el motivo por el que no se pudo. */
export async function setTaste(bucket: R2Bucket, cfgId: string, body: Record<string, unknown>, now = new Date()):
  Promise<TasteView | 'sin-perfil' | 'sin-dispositivo'> {
  const { st, profiles } = await loadTastes(bucket, cfgId);
  const profile = typeof body.profile === 'string' ? body.profile : '';
  if (!profiles.some((p) => p.id === profile)) return 'sin-perfil';
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  let t: TasteState = { ...tasteOf(st, profile) };
  let subs = st.subs;
  if (body.on === true) {
    if (!st.subs.some((s) => s.endpoint === endpoint)) return 'sin-dispositivo';
    t.on = true;
    subs = st.subs.map((s) => (s.endpoint === endpoint ? { ...s, profiles: [...new Set([...(s.profiles ?? []), profile])] } : s));
  } else if (body.on === false) {
    t.on = false;
  }
  if (validTz(body.tz)) t.tz = body.tz;
  if (WHENS.includes(body.when as TasteWhen)) t.when = body.when as TasteWhen;
  if (typeof body.genre === 'string' && body.genre.length <= 40 && typeof body.genreOn === 'boolean') {
    t = setGenre(t, await readHabits(bucket, cfgId, profile), now.getTime(), body.genre, body.genreOn);
  }
  const next: PushState = { ...st, subs, tastes: { ...st.tastes, [profile]: t } };
  await writeState(bucket, cfgId, next);
  return tasteView(bucket, cfgId, next, profile, endpoint, now);
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
      try { await notifyExpiry(env, cfgId); } catch { /* idem */ }
      try { await notifyReminders(env, cfgId); } catch { /* idem */ }
      try { await notifyTaste(env, cfgId); } catch { /* idem */ }
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
