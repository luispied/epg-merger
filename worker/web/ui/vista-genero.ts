// La vista «Por género» de las categorías (planes/categorias-por-genero.md): cada canal va a la categoría de su género,
// según ui/genres/channels.json (la guía). Acá se baja ese dato y se arman las categorías; la app las guarda en
// app.ts (setView). La regla del género está en worker/src/genre-views.ts, la misma que los tests.
import { channelAlias } from '../../../core/src/index.ts';
import { GENRE_ORDER, SALES, genreCategory, type ChannelGenre } from '../../src/genre-views.ts';

type GenreData = Record<string, ChannelGenre>;

let loaded: Promise<GenreData | null> | null = null;

/** El género de cada canal, bajado una vez por sesión. Sin datos o sin conexión, null: la vista no se arma. */
export function loadChannelGenres(): Promise<GenreData | null> {
  loaded ??= fetch('/api/ui/genres/channels.json', { signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? (r.json() as Promise<GenreData>) : null))
    .catch(() => null)
    .then((data) => {
      if (!data) loaded = null; // la próxima vez se vuelve a pedir
      return data;
    });
  return loaded;
}

/** La categoría por género de cada canal que tiene programación clasificada: {nombre del canal: categoría}. Los que no
 *  tienen datos no entran y siguen en la categoría del proveedor. */
export function genreAssign(channels: { name: string; epg: string | null }[], data: GenreData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, epg } of channels) {
    if (!epg) continue;
    const category = genreCategory(data[channelAlias(epg)]);
    if (category) out[name] = category;
  }
  return out;
}

/** Las categorías de la vista por género: las que tienen canales, en el orden de los géneros; Televentas, oculta. */
export function genreGroups(assign: Record<string, string>): { order: string[]; hidden: string[] } {
  const present = new Set(Object.values(assign));
  return { order: GENRE_ORDER.filter((g) => present.has(g)), hidden: present.has(SALES) ? [SALES] : [] };
}
