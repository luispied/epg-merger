// Gustos: qué se mira, qué género pesa y qué le conviene a la casa. Lo usan la web (Tu noche, en worker/web/ui/guide.tsx)
// y el Worker (avisos por gusto, worker/src/taste.ts), así que es una sola cuenta, sin DOM ni nada de la plataforma.

/** Por epg: veces que se abrió el canal y por hora UTC; por título normalizado: emisiones vistas; y los pedidos. */
export interface Habits {
  ch: Record<string, { n: number; h: number[] }>;
  /** `at`: cuándo se miró por última vez (ISO); el Worker lo guarda, la web no lo necesita. */
  t: Record<string, { n: number; g?: string; at?: string }>;
  no: Record<string, string>;
  more: Record<string, string>;
  /** El género de cada «Más como esto» (por título normalizado): sube ese género en el plan. */
  mg?: Record<string, string>;
  /** El género de cada «No me interesa» (por título normalizado): tres seguidos del mismo apagan ese género en avisos. */
  ng?: Record<string, string>;
}

/** Lo mínimo de un canal y de un programa para puntuarlos. */
export interface TasteCand { ch: { epg: string | null; cat: string }; p: { s: number; t: string; g?: string } }
/** Lo que suma un programa por los gustos de la casa, y por qué; null = «No me interesa». */
export type Affinity = (c: TasteCand) => { bonus: number; why?: string } | null;

/** La publicidad (infomerciales, televenta) que la IA reconoce nunca se sugiere. */
export const NEVER_SUGGEST = 'Publicidad';
/** Géneros que nunca se avisan: la publicidad, y lo que no dice qué es o se mira por costumbre. */
export const NEVER_NOTIFY = new Set([NEVER_SUGGEST, 'Noticias', 'Otro']);

export const FILLER = /canal no disponible|se[ñn]al no disponible|paid programming|programa pagado|programación pagada|no data|sin información|infomercial|televenta|fuera del aire|off air|cierre de emisi/i;
export const LIVE = /\b(en vivo|vivo|live|vs\.?|final|semifinal|cl[aá]sico|gran premio|grand prix)\b/i;
export const RERUN = /(-\s*rep\.?\s*$|\(r\)|\brepetici[oó]n\b|\bresumen\b)/i;
export const NEWS = /\b(noticias|noticiero|news|sportscenter|informativo|el tiempo)\b/i;
export const MOVIE_CAT = /pel[ií]cul|cine|movie|film/i;

/** Como el Worker (again.ts): el mismo programa aunque cambien mayúsculas o espacios. */
export const normTitle = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Afinidad por hábitos: el programa que se mira seguido, el canal a esa hora (±1 h) y en general, la campana y lo
 *  pedido. Pesa como mucho lo que un partido en vivo: lo de siempre sube, pero no tapa todo lo demás. */
export function habitAffinity(h: Habits | null, marks: Set<string> | null): Affinity {
  const taste = genreTaste(h);
  const asked = moreGenres(h);
  return ({ ch, p }) => {
    const k = normTitle(p.t);
    if (h?.no[k]) return null;
    const reasons: [number, string][] = [];
    let bonus = 0;
    const add = (v: number, why: string, min = 0) => { bonus += v; if (v > min) reasons.push([v, why]); };
    if (h?.more[k]) add(3, 'Pediste más como esto');
    if (p.g && asked.has(p.g) && !h?.more[k]) add(2, `Pediste más de ${p.g.toLowerCase()}`, 0.9);
    if (marks?.has(`${ch.epg}|${p.s}`)) add(3, 'Le pusiste la campana');
    const tn = h?.t[k]?.n ?? 0;
    if (tn) add(Math.min(4, 1.5 * Math.log2(1 + tn)), tn >= 3 ? 'Lo mirás seguido' : 'Ya lo miraste', 1);
    const c = ch.epg ? h?.ch[ch.epg] : undefined;
    if (c) {
      const hr = new Date(p.s * 1000).getUTCHours();
      const at = [-1, 0, 1].reduce((n, d) => n + (c.h[(hr + d + 24) % 24] ?? 0), 0);
      add(Math.min(3, 0.75 * at), 'Tu canal a esta hora', 1.4);
      add(Math.min(1.5, 0.5 * Math.log2(1 + c.n)), 'De tus canales', 0.9);
    }
    const gs = p.g ? taste.get(p.g) ?? 0 : 0;
    if (gs) add(gs, `Como lo que mirás: ${p.g!.toLowerCase()}`, 0.9);
    reasons.sort((a, b) => b[0] - a[0]);
    return { bonus, why: reasons[0]?.[1] };
  };
}

/** Géneros que ya se pueden sugerir y cuánto pesan en la casa: el género de los programas que se miraron (la
 *  corrida lo anota en los hábitos cuando la IA ya lo clasificó). Hasta +2,5 según qué parte de lo mirado es de ese
 *  género; con menos de dos veces no cuenta. */
export function genreTaste(h: Habits | null): Map<string, number> {
  const n = new Map<string, number>();
  let total = 0;
  for (const v of Object.values(h?.t ?? {})) {
    if (!v.g || v.g === NEVER_SUGGEST) continue;
    n.set(v.g, (n.get(v.g) ?? 0) + v.n);
    total += v.n;
  }
  const out = new Map<string, number>();
  for (const [g, c] of n) if (c >= 2) out.set(g, Math.min(2.5, (6 * c) / total));
  return out;
}

/** Los géneros de los «Más como esto» que siguen vigentes: sube todo lo de ese género, no solo el mismo título. */
export function moreGenres(h: Habits | null): Set<string> {
  const out = new Set<string>();
  for (const [k, g] of Object.entries(h?.mg ?? {})) if (h?.more[k] && g !== NEVER_SUGGEST) out.add(g);
  return out;
}

/** Cuántos «No me interesa» seguidos del mismo género hacen falta para apagar ese género en avisos. */
export const NO_STREAK_OFF = 3;

/** Los últimos pedidos del perfil, del más nuevo al más viejo: «No me interesa» (con su género, si lo tenía) y
 *  «Más como esto». La racha es cuántos «No me interesa» seguidos son del mismo género; un «Más como esto», un
 *  «No me interesa» sin género o de otro género la corta. Null si no hay racha. */
export function noStreak(h: Habits | null): { genre: string; n: number } | null {
  const events = [
    ...Object.entries(h?.no ?? {}).map(([k, at]) => ({ k, at, no: true })),
    ...Object.entries(h?.more ?? {}).map(([k, at]) => ({ k, at, no: false })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  let genre = '';
  let n = 0;
  for (const e of events) {
    const g = e.no ? h?.ng?.[e.k] : undefined;
    if (!e.no || !g || (genre && g !== genre)) break;
    genre = g;
    n++;
  }
  return n ? { genre, n } : null;
}

/** Puntaje de un programa para el plan (más es mejor); null si no va. */
export function planScore(t: string, len: number, cat: string): number | null {
  if (len < 25 * 60 || FILLER.test(t)) return null;
  let sc = Math.min(len, 150 * 60) / 1800;
  if (LIVE.test(t)) sc += 4;
  if (MOVIE_CAT.test(cat) && len >= 80 * 60) sc += 2;
  if (RERUN.test(t)) sc -= 3;
  if (NEWS.test(t)) sc -= 2;
  return sc;
}

/** Los géneros que son un gusto de la casa para avisar: el que ocupa al menos el 25 % de lo mirado en los últimos
 *  30 días (con 3 emisiones o más), o el de un «Más como esto» vigente. Nunca publicidad, noticias ni «Otro». */
export function tasteGenres(h: Habits | null, nowMs: number): string[] {
  const since = nowMs - 30 * 86_400_000;
  const n = new Map<string, number>();
  let total = 0;
  for (const v of Object.values(h?.t ?? {})) {
    if (!v.g || NEVER_NOTIFY.has(v.g)) continue;
    if (v.at && Date.parse(v.at) < since) continue;
    n.set(v.g, (n.get(v.g) ?? 0) + v.n);
    total += v.n;
  }
  const out = new Set<string>();
  for (const [g, c] of n) if (c >= 3 && c / total >= 0.25) out.add(g);
  for (const g of moreGenres(h)) if (!NEVER_NOTIFY.has(g)) out.add(g);
  return [...out].sort((a, b) => a.localeCompare(b, 'es'));
}
