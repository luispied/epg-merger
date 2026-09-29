// Matching de un canal del proveedor contra la guía. Port de match_channel / match_stream de
// generate_playlist.py: es la lógica que la corrida y el banco de prueba usan.
import type { ChannelDb } from './channelDb.ts';
import { joinedVariant, PLAUSIBLE_MIN, type Candidate, type EpgIndex } from './epgIndex.ts';
import { parseChannelName, stripDisplayPrefix, type MatchingRules, type ParsedName } from './names.ts';

/** Config de EPG de la sección/categoría del canal (ver epg_config_for en Python). */
export interface EpgConfig {
  country?: string | null;
  prefer_sources?: string[];
}

/** Overrides a mano: nombre crudo del proveedor → channel_id (null = sin EPG a propósito). */
export type Overrides = Record<string, string | null>;

export interface MatchOptions {
  /** Umbral de asignación (provider_rules.json → min_assign_score). */
  minAssignScore?: number;
  /** Confiar en el id de EPG de la lista (M3U sí, Xtream no). */
  trustListIds?: boolean;
  channelDb?: ChannelDb | null;
}

export interface MatchResult {
  channelId: string | null;
  reason: string | null;
  score: number;
  ranked: Candidate[];
}

export interface StreamMatch extends MatchResult {
  /** Nombre sin el prefijo del proveedor ("AR| ", "EVENTS 3: "). */
  name: string;
}

export const GOOD_NAME_BASE = 0.75;
export const GOOD_SCORE = 0.8;
export const PARTIAL_NAME_CAP = 0.69;
export const DEFAULT_MIN_ASSIGN_SCORE = 0.7;
const TVG_ID_OVERRIDES_BELOW = 0.8;
const TVG_ID_STRONG_NAME = 0.5;
const TVG_ID_SCORE = 0.85;
const TVG_ID_COUNTRY_RE = /\.([a-z]{2})(?:@[^.]*)?$/i;

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** "Bien" (≥ 0,8) exige que el nombre coincida: un nombre a medias queda en 0,69. */
export function calibratedScore(c: Candidate): number {
  return c.nameScore < GOOD_NAME_BASE && c.score > PARTIAL_NAME_CAP ? PARTIAL_NAME_CAP : c.score;
}

/** País del sufijo del id de EPG de la lista ("Clan.es@SD" → "es"). */
export function tvgIdCountry(epgChannelId: string | null | undefined, rules?: MatchingRules): string | null {
  const m = TVG_ID_COUNTRY_RE.exec(epgChannelId ?? '');
  if (!m) return null;
  const code = m[1].toLowerCase();
  return rules?.countryCodeAliases.get(code) ?? code;
}

export function matchChannel(name: string, parsed: ParsedName, index: EpgIndex, overrides: Overrides,
  epgConfig: EpgConfig, fallbackCountry: string | null, minAssignScore = DEFAULT_MIN_ASSIGN_SCORE): MatchResult {
  if (hasOwn(overrides, name)) return { channelId: overrides[name], reason: 'override', score: 1, ranked: [] };
  const country = epgConfig.country || parsed.country || fallbackCountry;
  const ranked = index.rank(parsed, epgConfig.prefer_sources ?? [], country);
  if (ranked.length && calibratedScore(ranked[0]) >= minAssignScore) {
    const best = ranked[0];
    return { channelId: best.channelId, reason: best.reason, score: calibratedScore(best), ranked };
  }
  return { channelId: null, reason: null, score: 0, ranked };
}

function matchByAlias(db: ChannelDb, rawName: string, channelName: string, listId: string | null, index: EpgIndex,
  overrides: Overrides, epgConfig: EpgConfig, country: string | null, ranked: Candidate[], minAssignScore: number): MatchResult {
  for (const [alias, aliasCountry] of db.aliases(channelName, listId, country)) {
    const parsed = parseChannelName(alias, index.rules);
    const r = matchChannel(rawName, parsed, index, overrides, epgConfig, country || aliasCountry, minAssignScore);
    if (!r.channelId || r.score < GOOD_SCORE) continue;
    // País confirmado de los dos lados.
    const candCountry = index.country.get(r.channelId);
    if (!aliasCountry || !candCountry || !index.rules.countryMatches(aliasCountry, candCountry)) continue;
    return { ...r, reason: 'alias' };
  }
  return { channelId: null, reason: null, score: 0, ranked };
}

/** Todo el matching automático de un canal del proveedor (ver match_stream en Python). */
export function matchStream(rawName: string, epgChannelId: string | null | undefined, index: EpgIndex,
  overrides: Overrides, epgConfig: EpgConfig, categoryCountry: string | null, opts: MatchOptions = {}): StreamMatch {
  const trust = opts.trustListIds ?? true;
  const minAssign = opts.minAssignScore ?? DEFAULT_MIN_ASSIGN_SCORE;
  const [channelName, prefixCountry] = stripDisplayPrefix(rawName, index.rules);
  let parsed = parseChannelName(channelName, index.rules);
  const fallbackCountry = prefixCountry || categoryCountry || (trust ? tvgIdCountry(epgChannelId, index.rules) : null);
  let res = matchChannel(rawName, parsed, index, overrides, epgConfig, fallbackCountry, minAssign);

  // Si no quedó "Bien", probar con las palabras pegadas y quedarse con lo mejor.
  const joined = joinedVariant(parsed);
  if (joined && res.reason !== 'override' && res.score < GOOD_SCORE) {
    const alt = matchChannel(rawName, joined, index, overrides, epgConfig, fallbackCountry, minAssign);
    if (alt.channelId && alt.score > res.score) {
      res = alt;
      parsed = joined;
    }
  }

  if (!res.channelId && opts.channelDb) {
    res = matchByAlias(opts.channelDb, rawName, channelName, trust ? epgChannelId ?? null : null, index, overrides,
      epgConfig, parsed.country || fallbackCountry, res.ranked, minAssign);
  }

  // El id de EPG del proveedor: solo si existe en la guía y el nombre tiene algo que ver.
  const candidate = index.resolveId(epgChannelId);
  const beats = trust ? res.score < TVG_ID_OVERRIDES_BELOW : !res.channelId;
  if (candidate && candidate !== res.channelId && res.reason !== 'override' && beats) {
    const variants = [parsed, joinedVariant(parsed)].filter((p): p is ParsedName => !!p);
    const plausibility = Math.max(...variants.map((p) => index.bestNameScore(p, candidate)));
    if (plausibility >= PLAUSIBLE_MIN) {
      let score = plausibility;
      if (trust && plausibility >= TVG_ID_STRONG_NAME) score = Math.max(plausibility, TVG_ID_SCORE);
      res = { ...res, channelId: candidate, reason: 'xtream_epg_id', score };
    }
  }
  return { name: channelName, ...res };
}
