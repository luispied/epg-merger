// Buscar por tema: «Mundial» o «cocina» también encuentra programas cuyo título no lo dice. El índice
// (ui/schedule/topics.json, lo arma tools/pack_schedule.py con los géneros y temas que la IA le puso a cada título) es
// aparte de la programación y se baja recién la primera vez que se busca. Sin él (todavía no hay, o no llegó) la
// búsqueda sigue como siempre, por nombre y por lo que dan los canales.
interface RawIndex { g: string[]; v: string[]; t: string[]; r: number[][] }

const fold = (s: string) => s.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
const hasWords = (text: string, q: string) => q.split(/\s+/).every((w) => text.includes(w));

/** La clave de un título en el índice: como `norm` de tools/measure_titles.py (espacios juntos y minúsculas). */
export const titleKey = (title: string) => title.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

export interface TopicSearch {
  /** Títulos (por `titleKey`) cuyo género o temas tienen todas las palabras de `q` (ya con `fold`). */
  match(q: string): Set<string>;
}

function prepare(raw: RawIndex): TopicSearch {
  const texts = raw.t.map((_, i) => {
    const [g, ...topics] = raw.r[i] ?? [-1];
    return fold([raw.g[g] ?? '', ...topics.map((t) => raw.v[t] ?? '')].join(' '));
  });
  const cache = new Map<string, Set<string>>();
  return {
    match(q) {
      let hit = cache.get(q);
      if (!hit) {
        hit = new Set();
        if (q) texts.forEach((text, i) => { if (hasWords(text, q)) hit!.add(raw.t[i]); });
        cache.set(q, hit);
      }
      return hit;
    },
  };
}

let loaded: Promise<TopicSearch | null> | null = null;
let failedAt = 0;
/** El índice de temas, una sola vez por sesión; null si no hay o no llegó (vuelve a probar a los 60 s, no en cada letra). */
export function loadTopics(): Promise<TopicSearch | null> {
  if (!loaded && Date.now() - failedAt > 60_000) {
    loaded = fetch('/api/ui/schedule/topics.json', { signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.json() as Promise<RawIndex> : null))
      .then((raw) => (raw && Array.isArray(raw.t) && Array.isArray(raw.r) ? prepare(raw) : null))
      .catch(() => null)
      .then((idx) => { if (!idx) { loaded = null; failedAt = Date.now(); } return idx; });
  }
  return loaded ?? Promise.resolve(null);
}
