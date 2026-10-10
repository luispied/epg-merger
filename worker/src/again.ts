// «Llegás desde el principio»: para lo que está en el aire (o por empezar) en los canales de una
// configuración, cuándo vuelve a empezar el mismo programa, en ese canal o en otro de la lista.
// Lee los archivos por canal que deja la corrida diaria (ui/schedule/<sha1 del id, 16>.json:
// [inicio, fin, título, descripción?]) y compara título, duración y descripción.
import type { R2Bucket } from './env.ts';

export const MAX_AGAIN_IDS = 400;
const ALIAS_RE = /^g[0-9a-f]{14}(\.[a-z]{2})?$/;
const MIN_LEN = 20 * 60;      // lo más corto que vale la pena esperar para ver desde el principio
const MAX_PER_CHANNEL = 4;    // más veces en un mismo canal = relleno, noticiero o tira diaria
const MAX_LATER = 3;
const SYNOPSIS = 40;         // desde este largo, la descripción distingue un capítulo de otro
// Títulos genéricos que no dicen qué es (las fuentes los usan para cualquier cosa).
const GENERIC = new Set(['paid programming', 'programa pagado', 'programación pagada', 'no data', 'sin información',
  'movie', 'película', 'pelicula', 'to be announced', 'tba', 'off air', 'fuera del aire', 'programación', 'programacion']);

type Entry = [number, number, string, string?];
interface Airing { i: number; s: number; e: number; d?: string }
/** Para cada emisión con repetición: [índice del canal, inicio, [[índice del canal, inicio], …]]. */
export type Again = [number, number, [number, number][]][];

export const validAgainIds = (ids: unknown): ids is string[] =>
  Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_AGAIN_IDS && ids.every((id) => typeof id === 'string' && ALIAS_RE.test(id));

async function scheduleFile(id: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const norm = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Dos emisiones son el mismo programa si duran lo mismo (±5 min o 10 %) y las sinopsis no dicen
 *  lo contrario: dos sinopsis largas distintas son capítulos distintos. En el mismo canal además
 *  hace falta algo más que el título: una línea corta en las dos («Fútbol», «Noticias») es la
 *  de un programa de liga o una tira con contenido nuevo, y si el canal pasa el título en tanda
 *  (una emisión pegada a otra) son capítulos seguidos aunque la sinopsis sea la misma. */
function same(a: Airing, b: Airing, runs: Set<number>): boolean {
  const da = a.e - a.s;
  const db = b.e - b.s;
  if (Math.abs(da - db) > Math.max(300, da * 0.1)) return false;
  const long = (d?: string) => !!d && d.length >= SYNOPSIS;
  // Tanda: muchos canales repiten la sinopsis de la serie en cada capítulo, así que ni eso alcanza.
  if (a.i === b.i && runs.has(a.i)) return false;
  if (long(a.d) && long(b.d)) return a.d === b.d;
  if (a.i !== b.i || !a.d || !b.d) return true;
  return long(a.d) || long(b.d);
}

export function findAgain(schedules: (Entry[] | null)[], now: number): Again {
  const byTitle = new Map<string, Airing[]>();
  schedules.forEach((entries, i) => {
    for (const [s, e, t, d] of entries ?? []) {
      if (e <= now || e - s < MIN_LEN) continue;
      const k = norm(t);
      if (!k || GENERIC.has(k)) continue;
      let list = byTitle.get(k);
      if (!list) byTitle.set(k, (list = []));
      list.push({ i, s, e, d: d?.trim() || undefined });
    }
  });
  const out: Again = [];
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    const perChannel = new Map<number, number>();
    for (const a of list) perChannel.set(a.i, (perChannel.get(a.i) ?? 0) + 1);
    if ([...perChannel.values()].some((n) => n > MAX_PER_CHANNEL)) continue;
    list.sort((a, b) => a.s - b.s || a.i - b.i);
    const runs = new Set(list.filter((a) => list.some((b) => b.i === a.i && b.s === a.e)).map((a) => a.i));
    for (const a of list) {
      const later = list.filter((b) => b.s > a.s && b.s > now && same(a, b, runs)).slice(0, MAX_LATER);
      if (later.length) out.push([a.i, a.s, later.map((b) => [b.i, b.s])]);
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Lee la programación de cada canal (de a tandas, para no abrir cientos de lecturas juntas). */
export async function againFor(bucket: R2Bucket, ids: string[], now: number): Promise<Again> {
  const schedules: (Entry[] | null)[] = [];
  for (let k = 0; k < ids.length; k += 25) {
    schedules.push(...await Promise.all(ids.slice(k, k + 25).map(async (id) => {
      const obj = await bucket.get(`ui/schedule/${await scheduleFile(id)}.json`);
      if (!obj) return null;
      try {
        const data = JSON.parse(await obj.text());
        return Array.isArray(data) ? data as Entry[] : null;
      } catch {
        return null;
      }
    })));
  }
  return findAgain(schedules, now);
}
