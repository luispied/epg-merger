// Diccionario de canales de iptv-org (dominio público). Port de channel_db.py: último recurso
// para un canal que no encontró guía por su nombre, probando con los otros nombres del canal.
import { parseChannelName, type MatchingRules } from './names.ts';

/** Un canal de https://iptv-org.github.io/api/channels.json (solo lo que se usa). */
export interface IptvChannel {
  id?: string;
  name?: string | null;
  alt_names?: string[] | null;
  country?: string | null;
  closed?: string | null;
}

interface Entry {
  id: string;
  names: string[];
  country: string | null;
}

const MAX_ENTRIES_BY_NAME = 3; // un nombre compartido por más canales que esto no sirve para decidir

export class ChannelDb {
  private readonly byId = new Map<string, Entry>();
  private readonly byName = new Map<string, Entry[]>();
  private readonly rules: MatchingRules;

  constructor(channels: IptvChannel[], rules: MatchingRules) {
    this.rules = rules;
    for (const ch of channels) {
      if (!ch || typeof ch !== 'object' || !ch.id || ch.closed) continue;
      const entry: Entry = {
        id: ch.id,
        names: [ch.name, ...(ch.alt_names ?? [])].filter((n): n is string => !!n),
        country: (ch.country ?? '').toLowerCase() || null,
      };
      this.byId.set(entry.id.toLowerCase(), entry);
      for (const name of entry.names) {
        const key = this.key(name);
        if (!key) continue;
        let list = this.byName.get(key);
        if (!list) this.byName.set(key, (list = []));
        if (!list.includes(entry)) list.push(entry);
      }
    }
  }

  get size(): number {
    return this.byId.size;
  }

  private key(name: string | null | undefined): string {
    return parseChannelName(name ?? '', this.rules).core.join('');
  }

  /** Por el id de la lista (tvg-id sin "@SD") o por nombre exacto, filtrado por país si hay. */
  entriesFor(name: string, tvgId: string | null = null, country: string | null = null): Entry[] {
    if (tvgId) {
      const entry = this.byId.get(tvgId.split('@')[0].trim().toLowerCase());
      if (entry) return [entry];
    }
    let entries = this.byName.get(this.key(name)) ?? [];
    if (country) entries = entries.filter((e) => e.country === country);
    return entries.length <= MAX_ENTRIES_BY_NAME ? entries : [];
  }

  /** [otro_nombre, país] del mismo canal, sin el propio nombre ni los que son un recorte de él. */
  aliases(name: string, tvgId: string | null = null, country: string | null = null): [string, string | null][] {
    const ownCore = parseChannelName(name ?? '', this.rules).core;
    const own = new Set(ownCore);
    const ownKey = ownCore.join('');
    const out: [string, string | null][] = [];
    for (const entry of this.entriesFor(name, tvgId, country)) {
      for (const alias of entry.names) {
        const core = parseChannelName(alias, this.rules).core;
        const key = core.join('');
        if (!key || key === ownKey) continue;
        const set = new Set(core);
        const properSubset = own.size > 0 && set.size < own.size && [...set].every((t) => own.has(t));
        if (properSubset) continue;
        if (!out.some(([a, c]) => a === alias && c === entry.country)) out.push([alias, entry.country]);
      }
    }
    return out;
  }
}
