// Ids de canal de la guía enmascarados: lo que sale del repo (guía de la web, XML de los reproductores,
// playlist) no muestra los ids de las fuentes ("I9.101373.schedulesdirect.org"), sino un alias opaco y
// estable. El sufijo de país (".ar") se conserva porque el matcher lo usa. Misma fórmula que
// channel_alias / fold_key en source_alias.py (hash cyrb53 sobre unidades UTF-16, sin dependencias, sincrónico).

const ALIAS_RE = /^g[0-9a-f]{14}(\.[a-z]{2})?$/;
const SUFFIX_RE = /\.([a-z]{2})$/;

/** cyrb53: hash de 53 bits, igual en JS y en Python. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const hex14 = (s: string) => cyrb53(`grilla-canal\n${s}`).toString(16).padStart(14, '0');

export const isChannelAlias = (id: string) => ALIAS_RE.test(id);

/** Alias de un id de canal de la guía (si ya es un alias, el mismo). */
export function channelAlias(id: string): string {
  if (isChannelAlias(id)) return id;
  const m = SUFFIX_RE.exec(id);
  return `g${hex14(id)}${m ? `.${m[1]}` : ''}`;
}

/** Id sin espacios ni mayúsculas: así se compara el id de EPG que trae la lista del proveedor. */
export const foldId = (id: string) => id.replace(/\s+/g, '').toLowerCase();

/** Clave del id plegado, para encontrar en la guía enmascarada el id de EPG de la lista ("telefe.ar@SD"). */
export const foldKey = (id: string) => hex14(foldId(id));
