// La vista «Por género» de las categorías (planes/categorias-por-genero.md). Lo usan la web (al armar la vista) y los
// tests. El género de cada canal sale de ui/genres/channels.json (tools/xmltv_genres.py): {alias: [género, n, total]}.

/** Género de Grilla → nombre de la categoría. Dos géneros pueden compartir categoría (Reality va con Entretenimiento). */
export const GENRE_CATEGORY: Record<string, string> = {
  'Película': 'Películas', 'Serie': 'Series', 'Telenovela': 'Telenovelas', 'Deportes': 'Deportes', 'Noticias': 'Noticias',
  'Documental': 'Documentales', 'Infantil': 'Infantil', 'Entretenimiento': 'Entretenimiento', 'Reality': 'Entretenimiento',
  'Humor': 'Entretenimiento', 'Música': 'Música', 'Cocina': 'Cocina y estilo de vida', 'Estilo de vida': 'Cocina y estilo de vida',
  'Religión': 'Religión', 'Educativo': 'Educativos', 'Publicidad': 'Televentas', 'Otro': 'Generalistas y mixtos',
};

/** Categorías que no son un género: sin género claro y las de venta. */
export const MIXED = 'Generalistas y mixtos';
export const SALES = 'Televentas';

/** Orden de las categorías de la vista: el de la lista de géneros, y al final las de respaldo. */
export const GENRE_ORDER = ['Películas', 'Series', 'Telenovelas', 'Deportes', 'Noticias', 'Documentales', 'Infantil',
  'Entretenimiento', 'Música', 'Cocina y estilo de vida', 'Religión', 'Educativos', MIXED, SALES];

/** Cuántos programas con género hacen falta y qué parte de ellos tiene que ser el mismo género. */
export const MIN_PROGRAMS = 20;
export const MIN_SHARE = 0.5;

/** El género más frecuente de un canal: [género, programas con ese género, programas]. */
export type ChannelGenre = [string, number, number];

/** Categoría por género de un canal. Sin datos de programación (`info` vacío) → null: se queda en la del proveedor.
 *  Con datos pero sin un género claro → «Generalistas y mixtos». */
export function genreCategory(info: ChannelGenre | undefined): string | null {
  if (!info) return null;
  const [genre, n, total] = info;
  if (total >= MIN_PROGRAMS && n / total >= MIN_SHARE) return GENRE_CATEGORY[genre] ?? MIXED;
  return MIXED;
}
