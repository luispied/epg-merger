// Hábitos para «Tu noche»: qué canales se miran y a qué hora, y qué programas, aprendido de los links que se abren
// (cada vez que notePlay anota un canal). Más lo que la persona pide en la guía: «No me interesa» y «Más como esto».
// Se guarda por configuración y, adentro, por perfil (el de los links; sin perfil = ''), en habits/<cfgId>.json.
// Solo canales con guía: la clave es su epg y el título sale de la programación de ese momento (ui/schedule/).
import type { R2Bucket } from './env.ts';
import { GENERIC, norm, scheduleFile } from './again.ts';

export interface ChannelHabit { n: number; h: number[]; at: string }
export interface TitleHabit { n: number; title: string; at: string; s?: number }
export interface Habits {
  /** Por epg del canal: cuántas veces se abrió, por hora UTC (24) y la última. */
  ch: Record<string, ChannelHabit>;
  /** Por título normalizado: cuántas emisiones distintas se miraron. */
  t: Record<string, TitleHabit>;
  /** «No me interesa» y «Más como esto», por título normalizado: cuándo se pidió. */
  no: Record<string, string>;
  more: Record<string, string>;
}
type Store = Record<string, Habits>;
type Entry = [number, number, string, string?];

const MAX_CH = 300;
const MAX_T = 500;
const MAX_FB = 200;
const FORGET_MS = 90 * 24 * 3600 * 1000; // lo que no se mira hace tres meses ya no es un hábito
const key = (cfgId: string) => `habits/${cfgId}.json`;
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

export const emptyHabits = (): Habits => ({ ch: {}, t: {}, no: {}, more: {} });

async function readStore(bucket: R2Bucket, cfgId: string): Promise<Store> {
  try {
    const obj = await bucket.get(key(cfgId));
    const v = obj ? JSON.parse(await obj.text()) as unknown : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Store : {};
  } catch {
    return {};
  }
}

const fix = (h: Partial<Habits> | undefined): Habits => ({ ch: h?.ch ?? {}, t: h?.t ?? {}, no: h?.no ?? {}, more: h?.more ?? {} });

/** Se queda con lo más visto y reciente, y olvida lo viejo. */
function prune(h: Habits, now: number): Habits {
  const fresh = <T extends { n: number; at: string }>(rec: Record<string, T>, max: number) => Object.fromEntries(
    Object.entries(rec).filter(([, v]) => now - Date.parse(v.at) < FORGET_MS).sort((a, b) => b[1].n - a[1].n).slice(0, max));
  const recent = (rec: Record<string, string>) => Object.fromEntries(Object.entries(rec).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_FB));
  return { ch: fresh(h.ch, MAX_CH), t: fresh(h.t, MAX_T), no: recent(h.no), more: recent(h.more) };
}

/** Lo que vale para la guía de un perfil. Sin perfil (el editor): todos juntos, con los pedidos del editor. */
export async function readHabits(bucket: R2Bucket, cfgId: string, profile?: string): Promise<Habits> {
  const store = await readStore(bucket, cfgId);
  if (profile !== undefined) return fix(store[profile]);
  const all = emptyHabits();
  for (const [p, raw] of Object.entries(store)) {
    const h = fix(raw);
    for (const [k, v] of Object.entries(h.ch)) {
      const cur = all.ch[k] ??= { n: 0, h: Array(24).fill(0) as number[], at: v.at };
      cur.n += v.n;
      cur.h = cur.h.map((x, i) => x + (v.h[i] ?? 0));
      if (v.at > cur.at) cur.at = v.at;
    }
    for (const [k, v] of Object.entries(h.t)) {
      const cur = all.t[k] ??= { n: 0, title: v.title, at: v.at };
      cur.n += v.n;
      if (v.at > cur.at) cur.at = v.at;
    }
    if (p === '') Object.assign(all, { no: h.no, more: h.more });
  }
  return all;
}

/** El título que pasaba en un canal (por su epg) en un momento, si no es genérico. */
async function titleAt(bucket: R2Bucket, epg: string, t: number): Promise<{ title: string; s: number } | null> {
  try {
    const obj = await bucket.get(`ui/schedule/${await scheduleFile(epg)}.json`);
    if (!obj) return null;
    const e = (JSON.parse(await obj.text()) as Entry[]).find(([s, end]) => s <= t && t < end);
    return e && e[2] && !GENERIC.has(norm(e[2])) ? { title: e[2], s: e[0] } : null;
  } catch {
    return null;
  }
}

/** Anota que un perfil abrió un canal (el id de la lista): su canal a esa hora y el programa que pasaba. */
export async function noteHabit(bucket: R2Bucket, cfgId: string, profile: string, epg: string, now = new Date()): Promise<void> {
  const t = Math.floor(now.getTime() / 1000);
  const prog = await titleAt(bucket, epg, t);
  const store = await readStore(bucket, cfgId);
  const h = fix(store[profile]);
  const at = now.toISOString();
  const c = h.ch[epg] ??= { n: 0, h: Array(24).fill(0) as number[], at };
  c.n++;
  c.h[now.getUTCHours()]++;
  c.at = at;
  if (prog) {
    const k = norm(prog.title);
    const rec = h.t[k] ??= { n: 0, title: prog.title, at };
    // La misma emisión cuenta una vez, aunque se vuelva a abrir el canal.
    if (rec.s !== prog.s) rec.n++;
    Object.assign(rec, { title: prog.title, at, s: prog.s });
  }
  store[profile] = prune(h, now.getTime());
  await bucket.put(key(cfgId), JSON.stringify(store), JSON_TYPE);
}

export type Feedback = 'no' | 'more' | 'clear';

/** «No me interesa», «Más como esto» o deshacer, para un título. */
export async function feedbackHabit(bucket: R2Bucket, cfgId: string, profile: string, title: string, kind: Feedback, now = new Date()): Promise<Habits> {
  const store = await readStore(bucket, cfgId);
  const h = fix(store[profile]);
  const k = norm(title);
  delete h.no[k];
  delete h.more[k];
  if (kind !== 'clear') h[kind][k] = now.toISOString();
  store[profile] = prune(h, now.getTime());
  await bucket.put(key(cfgId), JSON.stringify(store), JSON_TYPE);
  return store[profile];
}

export const validFeedback = (body: Record<string, unknown>): body is { title: string; kind: Feedback } =>
  typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 200 &&
  (body.kind === 'no' || body.kind === 'more' || body.kind === 'clear');

export const deleteHabits = (bucket: R2Bucket, cfgId: string) => bucket.delete(key(cfgId));
