// Recordatorios de programas: «Avisarme» en la programación de un canal. Se guardan por configuración en
// remind/<cfgId>.json (sin credenciales: la guía del canal, su nombre, el título y la hora de inicio) y la
// corrida programada de avisos (push.ts → notifyReminders) manda el push poco antes de que empiecen.
import { channelAlias } from '../../core/src/alias.ts';
import type { R2Bucket } from './env.ts';

export interface Reminder {
  /** Id del canal en la guía (para reconocer el recordatorio en la lista de programas). */
  epg: string;
  /** Nombre del canal, tal como se ve. */
  name: string;
  title: string;
  /** Inicio del programa, en segundos desde 1970. */
  start: number;
}

export const MAX_REMINDERS = 30;
/** Cuánto antes se avisa: la corrida es cada 30 minutos, así que el aviso llega entre 0 y 30 minutos antes. */
export const REMIND_AHEAD_S = 30 * 60;
/** Pasada esta demora desde el inicio, un recordatorio que no se mandó ya no sirve y se descarta. */
export const REMIND_GRACE_S = 15 * 60;
const MAX_AHEAD_S = 72 * 3600;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };
export const remindKey = (cfgId: string) => `remind/${cfgId}.json`;

export async function readReminders(bucket: R2Bucket, cfgId: string): Promise<Reminder[]> {
  const obj = await bucket.get(remindKey(cfgId));
  if (!obj) return [];
  try {
    const v = JSON.parse(await obj.text()) as { items?: unknown };
    return Array.isArray(v.items) ? v.items.map((x) => parseReminder(x)).filter((r): r is Reminder => !!r) : [];
  } catch {
    return [];
  }
}

export async function writeReminders(bucket: R2Bucket, cfgId: string, items: Reminder[]): Promise<void> {
  if (items.length) await bucket.put(remindKey(cfgId), JSON.stringify({ items }), JSON_TYPE);
  else await bucket.delete(remindKey(cfgId));
}

/** Valida lo que llega del navegador. `now` en segundos: no se aceptan programas que ya empezaron ni a más de 3 días. */
export function parseReminder(raw: unknown, now?: number): Reminder | null {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v.epg !== 'string' || typeof v.title !== 'string' || typeof v.start !== 'number' || !Number.isFinite(v.start)) return null;
  if (!v.epg || v.epg.length > 200 || !v.title.trim()) return null;
  const start = Math.floor(v.start);
  if (now !== undefined && (start <= now || start > now + MAX_AHEAD_S)) return null;
  return { epg: v.epg, name: (typeof v.name === 'string' ? v.name : '').slice(0, 80), title: v.title.trim().slice(0, 120), start };
}

/** Los guardados antes con el id real de la guía y los nuevos con su alias son el mismo canal. */
const sameChannel = (a: string, b: string) => channelAlias(a) === channelAlias(b);

/** Agrega un recordatorio (o lo deja igual si ya estaba). Devuelve false si se llegó al tope. */
export async function addReminder(bucket: R2Bucket, cfgId: string, item: Reminder, nowS: number): Promise<boolean> {
  const live = (await readReminders(bucket, cfgId)).filter((r) => r.start > nowS - REMIND_GRACE_S);
  if (live.some((r) => sameChannel(r.epg, item.epg) && r.start === item.start)) return true;
  if (live.length >= MAX_REMINDERS) return false;
  await writeReminders(bucket, cfgId, [...live, item].sort((a, b) => a.start - b.start));
  return true;
}

export async function removeReminder(bucket: R2Bucket, cfgId: string, epg: string, start: number): Promise<void> {
  const items = await readReminders(bucket, cfgId);
  await writeReminders(bucket, cfgId, items.filter((r) => !(sameChannel(r.epg, epg) && r.start === start)));
}
