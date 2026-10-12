// Perfil infantil (ver planes/perfil-infantil.md): un perfil con `kids` solo muestra programas de los géneros aptos y
// nunca publicidad. La regla vive acá, en el Worker: las rutas del modo ver de ese perfil devuelven la programación ya
// filtrada (el título y la descripción de lo que no es apto salen vacíos, con su hora para dibujar el hueco), así que
// mirar la red no sirve para esquivarla. Lo que la IA no clasificó tampoco se muestra.
import type { Entry } from './schedule.ts';

/** Entran siempre y no se pueden sacar. */
export const KIDS_ALWAYS = ['Infantil', 'Educativo'];
/** Opcionales, apagados al activar el perfil. Ni Película/Serie (el género no dice la edad) ni Publicidad (nunca). */
export const KIDS_OPTIONAL = ['Documental', 'Cocina', 'Música', 'Deportes', 'Estilo de vida'];
const NEVER = 'Publicidad';

export interface Kids { genres: string[] }

/** El `kids` de un perfil: siempre los géneros fijos más los opcionales pedidos, sin repetir y sin nada fuera de la lista.
 *  Sin objeto (o algo que no es un objeto) no hay perfil infantil. */
export function parseKids(v: unknown): Kids | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const asked = (v as { genres?: unknown }).genres;
  const want = new Set(Array.isArray(asked) ? asked.filter((g): g is string => typeof g === 'string') : []);
  return { genres: [...KIDS_ALWAYS, ...KIDS_OPTIONAL.filter((g) => want.has(g))] };
}

/** ¿Un programa de este género se muestra? Sin género (la IA no lo clasificó) o publicidad: no. */
export const isApt = (genre: string | null | undefined, kids: Kids): boolean =>
  !!genre && genre !== NEVER && kids.genres.includes(genre);

export interface HourShape { h: number; t: string[]; g?: string[]; c: Record<string, [number, number, number][]> }

/** El índice de una hora sin los títulos no aptos: quedan en '' (y sin género), con su hora. */
export function maskHour(idx: HourShape, kids: Kids): HourShape {
  const t = Array.isArray(idx.t) ? idx.t : [];
  const g = t.map((_, i) => (isApt(idx.g?.[i], kids) ? idx.g![i] : ''));
  return { h: idx.h, t: t.map((title, i) => (g[i] ? title : '')), g, c: idx.c ?? {} };
}

/** La programación de un canal sin título, descripción ni género en lo que no es apto. */
export function maskEntries(entries: Entry[], kids: Kids): Entry[] {
  return entries.map((e) => (isApt(e[4], kids) ? e : [e[0], e[1], ''] as Entry));
}

/** Los hábitos de un perfil infantil sin lo que no es apto: los programas vistos y los «Más como esto» de otros géneros. */
export function maskHabits<H extends { t: Record<string, { g?: string }>; more: Record<string, string>; mg: Record<string, string> }>(h: H, kids: Kids): H {
  const t = Object.fromEntries(Object.entries(h.t).filter(([, v]) => isApt(v.g, kids)));
  const mg = Object.fromEntries(Object.entries(h.mg).filter(([, g]) => isApt(g, kids)));
  const more = Object.fromEntries(Object.entries(h.more).filter(([k]) => k in mg));
  return { ...h, t, mg, more };
}

export interface KidsReport {
  /** Cuántas horas mira (desde la actual). */
  hours: number;
  /** Programas distintos que se ven, y los que no. */
  shown: number;
  hidden: number;
  /** Lo que se oculta, por género ('' = sin clasificar): cuántos y hasta tres ejemplos. */
  by: { genre: string; n: number; sample: string[] }[];
}

const norm = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Qué se ve y qué se oculta en las próximas horas de los canales de un perfil (títulos distintos). `idxs` son los
 *  índices por hora sin filtrar y `epgs` los canales del perfil. */
export function kidsReport(idxs: (HourShape | null)[], epgs: Set<string>, kids: Kids): KidsReport {
  const seen = new Map<string, { genre: string; title: string }>();
  for (const idx of idxs) {
    if (!idx) continue;
    for (const [epg, rows] of Object.entries(idx.c ?? {})) {
      if (!epgs.has(epg)) continue;
      for (const [, , t] of rows) {
        const title = idx.t[t];
        if (!title) continue;
        const k = norm(title);
        if (!seen.has(k)) seen.set(k, { genre: idx.g?.[t] ?? '', title });
      }
    }
  }
  let shown = 0;
  const by = new Map<string, { genre: string; n: number; sample: string[] }>();
  for (const { genre, title } of seen.values()) {
    if (isApt(genre, kids)) { shown++; continue; }
    const row = by.get(genre) ?? { genre, n: 0, sample: [] };
    row.n++;
    if (row.sample.length < 3) row.sample.push(title);
    by.set(genre, row);
  }
  const list = [...by.values()].sort((a, b) => b.n - a.n || a.genre.localeCompare(b.genre, 'es'));
  return { hours: idxs.length, shown, hidden: list.reduce((n, r) => n + r.n, 0), by: list };
}
