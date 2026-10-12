// Avisos por gusto: las reglas, sin entrada ni salida (la lectura de R2 y el push están en push.ts → notifyTaste).
// Una vez por corrida (cada 30 minutos) y solo con el interruptor prendido, dentro de la ventana de envío y con cupo,
// se elige UN programa de los canales de la lista que sea del gusto de la casa; si no hay uno bueno, no se manda nada.
// El puntaje de gustos es el de Tu noche (core/src/taste.ts), el mismo que usa la web.
import { habitAffinity, type Habits, NEVER_NOTIFY, normTitle, planScore, RERUN, tasteGenres } from '../../core/src/taste.ts';
import type { Entry } from './schedule.ts';

export type TasteWhen = 'tarde' | 'noche';
export type TastePer = 'dia' | 'semana';
export interface TasteSent { title: string; genre: string; /** ISO del envío. */ at: string; epg: string; name: string; start: number }
export interface TasteState {
  on: boolean;
  /** Géneros apagados por la persona. */
  off: string[];
  /** Zona horaria del dispositivo que lo prendió (IANA). */
  tz: string;
  when: TasteWhen;
  per: TastePer;
  /** Los últimos avisos (el más nuevo al final). */
  sent: TasteSent[];
}

export const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
/** Ventana de envío en hora de la persona [desde, hasta): nunca entre las 22 y las 9. */
export const WINDOWS: Record<TasteWhen, [number, number]> = { tarde: [18, 20], noche: [20, 22] };
export const MAX_PER_DAY = 1;
export const MAX_PER_WEEK = 3;
export const MAX_SENT = 20;
export const NO_REPEAT_DAYS = 14;
/** El programa tiene que empezar entre 30 minutos y 4 horas después del envío, y durar 40 minutos o más. */
export const AHEAD_MIN_S = 30 * 60;
export const AHEAD_MAX_S = 4 * 3600;
export const MIN_LEN_S = 40 * 60;
/** Puntaje mínimo (largo + hábitos) para que valga un aviso. */
export const MIN_SCORE = 3;
const DAY_MS = 86_400_000;

export const emptyTaste = (tz = DEFAULT_TZ): TasteState => ({ on: false, off: [], tz, when: 'tarde', per: 'semana', sent: [] });

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Hora y día (AAAA-MM-DD) de un instante en una zona; con una zona inválida, Buenos Aires. */
export function localParts(ms: number, tz: string): { hour: number; minute: number; day: string } {
  const zone = validTz(tz) ? tz : DEFAULT_TZ;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
}

/** «20:30» en la zona de la persona. */
export const localHm = (ms: number, tz: string) => {
  const { hour, minute } = localParts(ms, tz);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

export function inWindow(ms: number, t: TasteState): boolean {
  const { hour } = localParts(ms, t.tz);
  const [from, to] = WINDOWS[t.when];
  return hour >= from && hour < to;
}

/** ¿Queda cupo? Uno por día (el día de la persona) y, con «3 por semana», tres en los últimos 7 días. */
export function hasQuota(t: TasteState, ms: number): boolean {
  const today = localParts(ms, t.tz).day;
  if (t.sent.some((s) => localParts(Date.parse(s.at), t.tz).day === today)) return false;
  if (t.per === 'semana' && t.sent.filter((s) => ms - Date.parse(s.at) < 7 * DAY_MS).length >= MAX_PER_WEEK) return false;
  return true;
}

/** Los géneros de los que hoy se puede avisar: el gusto de la casa menos los apagados. */
export function allowedGenres(h: Habits | null, t: TasteState, ms: number): string[] {
  const off = new Set(t.off);
  return tasteGenres(h, ms).filter((g) => !off.has(g));
}

export interface TasteChannel { epg: string; name: string; cat: string }
export interface TasteContext {
  habits: Habits;
  /** Claves `epg|inicio` de los recordatorios que ya hay. */
  marks: Set<string>;
  /** Programación por epg del canal. */
  schedules: Map<string, Entry[] | null>;
  genres: string[];
  sent: TasteSent[];
  nowMs: number;
}

/** El mejor programa para avisar, o null si ninguno es bueno. */
export function pickProgram(channels: TasteChannel[], c: TasteContext): { ch: TasteChannel; entry: Entry; genre: string } | null {
  const nowS = Math.floor(c.nowMs / 1000);
  const aff = habitAffinity(c.habits, c.marks);
  const genres = new Set(c.genres);
  const recent = new Set(c.sent.filter((s) => c.nowMs - Date.parse(s.at) < NO_REPEAT_DAYS * DAY_MS).map((s) => normTitle(s.title)));
  let best: { ch: TasteChannel; entry: Entry; genre: string; score: number } | null = null;
  for (const ch of channels) {
    for (const entry of c.schedules.get(ch.epg) ?? []) {
      const [s, e, title, , genre] = entry;
      if (!genre || NEVER_NOTIFY.has(genre) || !genres.has(genre)) continue;
      if (s < nowS + AHEAD_MIN_S || s > nowS + AHEAD_MAX_S || e - s < MIN_LEN_S) continue;
      const k = normTitle(title);
      if (RERUN.test(title) || recent.has(k) || c.habits.t[k] || c.marks.has(`${ch.epg}|${s}`)) continue;
      const base = planScore(title, e - s, ch.cat);
      const a = aff({ ch: { epg: ch.epg, cat: ch.cat }, p: { s, t: title, g: genre } });
      if (base === null || !a) continue;
      const score = base + a.bonus;
      if (score >= MIN_SCORE && (!best || score > best.score)) best = { ch, entry, genre, score };
    }
  }
  return best && { ch: best.ch, entry: best.entry, genre: best.genre };
}

/** Lee lo guardado con cuidado: lo que no cuadra se descarta. */
export function parseTaste(raw: unknown): TasteState | undefined {
  const v = raw as Partial<TasteState> | null;
  if (!v || typeof v !== 'object') return undefined;
  const str = (x: unknown): x is string => typeof x === 'string';
  return {
    on: v.on === true,
    off: Array.isArray(v.off) ? v.off.filter((g): g is string => str(g) && g.length <= 40).slice(0, 40) : [],
    tz: validTz(v.tz) ? v.tz : DEFAULT_TZ,
    when: v.when === 'noche' ? 'noche' : 'tarde',
    per: v.per === 'dia' ? 'dia' : 'semana',
    sent: Array.isArray(v.sent)
      ? v.sent.filter((s) => s && str(s.title) && str(s.genre) && str(s.at) && str(s.epg) && str(s.name) && typeof s.start === 'number').slice(-MAX_SENT)
      : [],
  };
}
