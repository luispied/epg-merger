// La playlist de una configuración: la lista en vivo del proveedor con las ediciones guardadas.
// Canales conocidos → su EPG, nombre, categoría y ocultos; canales nuevos (los eventos del
// día) → tal cual, sin EPG; los que ya no están, no salen.
import type { Config } from './config.ts';
import type { Channel } from './provider.ts';

// Sin mecanismo de escape en M3U: un '"' literal rompería el atributo (ver _m3u_attr).
const attr = (v: string | null | undefined) => (v ?? '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
// TiviMate no muestra un group-title con '/' (lo toma como subcategoría).
const groupTitle = (v: string) => attr(v).replace(/[/／∕⁄]/g, '-');

export interface PlaylistOptions {
  /** URL de la guía de esta configuración (va en el encabezado como url-tvg). */
  epgUrl: string;
  /** URL del stream de un canal (redirect del Worker o directo al servidor). */
  streamUrl: (ch: Channel) => string;
}

export function buildPlaylist(channels: Channel[], cfg: Config, opts: PlaylistOptions): string {
  const hiddenGroups = new Set(cfg.groups?.hidden ?? []);
  const order = new Map((cfg.groups?.order ?? []).map((g, i) => [g, i]));
  const rows: { group: number; pos: number; text: string }[] = [];
  channels.forEach((ch, pos) => {
    const edit = cfg.channels[ch.name] ?? {};
    const group = edit.group || ch.category;
    if (edit.hidden || hiddenGroups.has(group)) return;
    const name = edit.name || ch.name;
    const epg = edit.epg ?? null;
    // Sin EPG elegido, sin logo: el del proveedor suele ser genérico o de otro canal.
    const logo = epg ? edit.logo || ch.icon : '';
    rows.push({
      group: order.get(group) ?? order.size,
      pos,
      text: `#EXTINF:-1 tvg-id="${attr(epg ?? name)}" tvg-name="${attr(name)}" tvg-logo="${attr(logo)}" ` +
        `group-title="${groupTitle(group)}",${attr(name)}\n${opts.streamUrl(ch)}`,
    });
  });
  // Las categorías en el orden guardado; las nuevas, al final en el orden del proveedor.
  rows.sort((a, b) => a.group - b.group || a.pos - b.pos);
  return [`#EXTM3U url-tvg="${attr(opts.epgUrl)}"`, ...rows.map((r) => r.text)].join('\n') + '\n';
}
