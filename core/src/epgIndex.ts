// Índice de canales de la guía y puntaje de coincidencia. Port de epg_index.py: solapamiento
// de tokens pesado por IDF, ajustado por fuente preferida, país, idioma y región.
import { parseChannelName, type MatchingRules, type ParsedName } from './names.ts';

export interface Candidate {
  channelId: string;
  score: number;
  nameScore: number;
  reason: string;
}

/** Un canal de la guía, tal como lo exporta tools/core_parity.py (y el servicio, más adelante). */
export interface GuideChannel {
  id: string;
  source?: string | null;
  names: string[];
  icon?: string | null;
  /** Posición en la guía (desempate estable). Si falta, la del array. */
  pos?: number;
}

export interface SourceInfo {
  country?: string | null;
  priority?: number;
}

const CHANNEL_ID_SUFFIX_RE = /\.([a-z]{2})$/;
const RECALL_WEIGHT = 0.75;
const PRECISION_WEIGHT = 0.25;
const PREFER_SOURCE_BOOST = 1.6;
const COUNTRY_MATCH_BOOST = 1.25;
const COUNTRY_MISMATCH_PENALTY = 0.35;
const LANGUAGE_HINT_BOOST = 1.15;
const REGION_MATCH_BOOST = 1.15;
const REGION_MISMATCH_PENALTY = 0.8;
const FEED_REGIONS = new Set(['east', 'west', 'pacific', 'mountain', 'central']);
const FEED_ALIASES: Record<string, string> = { west: 'pacific' };
const OTHER_FEED_PENALTY = 0.97;
export const DEFAULT_FEED = 'east';

export const MIN_SCORE = 0.45;
export const PLAUSIBLE_MIN = 0.3;
const CANDIDATE_CAP = 3000;
const CANDIDATE_TOKENS = 3;
const JOIN_MAX_TOKENS = 3;
const JOIN_MAX_LENGTH = 16;
const NO_PRIORITY = 10 ** 6;

// isdigit() de Python acepta también superíndices/subíndices.
const ALL_DIGITS_RE = /^[\p{Nd}²³¹⁰-⁹₀-₉]+$/u;
const cpLength = (s: string) => Array.from(s).length;

/** El display-name más descriptivo (sin las variantes con el número de canal adelante). */
export function pickDisplayName(displayNames: string[]): string | null {
  const real = displayNames.filter((t) => t && !ALL_DIGITS_RE.test(t.trim())).map((t) => t.trim());
  if (!real.length) return null;
  const realSet = new Set(real);
  const clean = real.filter((name) => {
    const m = /^\p{Nd}+\s+(.+)$/u.exec(name);
    return !m || !realSet.has(m[1]);
  });
  let best: string | null = null;
  for (const name of clean.length ? clean : real) {
    if (best === null || cpLength(name) > cpLength(best)) best = name;
  }
  return best;
}

/** El mismo nombre con las palabras del núcleo pegadas ("rtl zwei" -> "rtlzwei"). */
export function joinedVariant(parsed: ParsedName): ParsedName | null {
  const core = parsed.core;
  if (core.length < 2 || core.length > JOIN_MAX_TOKENS) return null;
  const joined = core.join('');
  if (joined.length > JOIN_MAX_LENGTH) return null;
  return { ...parsed, core: [joined] };
}

/** Tokens y peso de un nombre de la guía, calculados una sola vez (el peso depende del IDF). */
interface Target {
  tokens: Set<string>;
  weight: number;
}

/** Todo lo que rank() consulta de un canal, en un solo objeto (es el camino caliente). */
interface Meta {
  targets: Target[];
  source: string;
  country: string | null;
  region: string | null;
  prio: number;
  order: number;
}

const foldId = (id: string) => id.replace(/\s+/g, '').toLowerCase();
const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];

export class EpgIndex {
  readonly rules: MatchingRules;
  readonly icon = new Map<string, string>();
  readonly source = new Map<string, string | null>();
  readonly country = new Map<string, string | null>();
  readonly region = new Map<string, string | null>();
  readonly displayName = new Map<string, string>();
  readonly parsed = new Map<string, ParsedName[]>();
  readonly postings = new Map<string, string[]>();
  preferredFeed: string | null = DEFAULT_FEED;
  private readonly idfs = new Map<string, number>();
  private readonly order = new Map<string, number>();
  private readonly sourcePriority = new Map<string, number>();
  private byFoldedId: Map<string, string> | null = null;
  private readonly meta = new Map<string, Meta>();

  constructor(channels: GuideChannel[], rules: MatchingRules, sources: Record<string, SourceInfo> = {}) {
    this.rules = rules;
    for (const [sid, s] of Object.entries(sources)) this.sourcePriority.set(sid, s.priority ?? 0);

    channels.forEach((channel, i) => {
      const id = channel.id;
      if (!id) return;
      const sourceId = channel.source ?? null;
      this.icon.set(id, channel.icon ?? '');
      this.source.set(id, sourceId);
      this.order.set(id, channel.pos ?? i);

      const names = (channel.names ?? []).filter(Boolean);
      const pick = pickDisplayName(names);
      if (pick) this.displayName.set(id, pick);

      const parsedNames = names.map((n) => parseChannelName(n, rules));
      for (const p of [...parsedNames]) {
        const v = joinedVariant(p);
        if (v) parsedNames.push(v);
      }
      this.parsed.set(id, parsedNames);

      const suffix = CHANNEL_ID_SUFFIX_RE.exec(id);
      let country: string | null = suffix ? suffix[1] : null;
      if (!country) country = parsedNames.find((p) => p.country)?.country ?? null;
      if (!country && sourceId) country = sources[sourceId]?.country ?? null;
      this.country.set(id, country);

      this.region.set(id, parsedNames.find((p) => p.region)?.region ?? parseChannelName(id, rules).region);

      for (const p of parsedNames) {
        for (const token of uniq(p.core)) {
          let ids = this.postings.get(token);
          if (!ids) this.postings.set(token, (ids = []));
          if (!ids.length || ids[ids.length - 1] !== id) ids.push(id);
        }
      }
    });

    const total = Math.max(this.parsed.size, 1);
    for (const [token, ids] of this.postings) this.idfs.set(token, Math.log(1 + total / ids.length));
  }

  has(channelId: string): boolean {
    return this.parsed.has(channelId);
  }

  /** channel_id de la guía para un id de EPG de una lista: exacto o sin "@SD" y sin mayúsculas. */
  resolveId(rawId: string | null | undefined): string | null {
    if (!rawId) return null;
    if (this.parsed.has(rawId)) return rawId;
    if (!this.byFoldedId) {
      this.byFoldedId = new Map();
      for (const id of this.parsed.keys()) if (!this.byFoldedId.has(foldId(id))) this.byFoldedId.set(foldId(id), id);
    }
    return this.byFoldedId.get(foldId(rawId.split('@')[0])) ?? null;
  }

  idf(token: string): number {
    return this.idfs.get(token) ?? Math.log(1 + Math.max(this.parsed.size, 1));
  }

  /** Suma en orden fijo (alfabético), igual que Python, para dar exactamente lo mismo. */
  private weight(tokens: Iterable<string>): number {
    let sum = 0;
    for (const t of [...tokens].sort()) sum += this.idf(t);
    return sum;
  }

  private metaOf(channelId: string): Meta {
    let m = this.meta.get(channelId);
    if (!m) {
      const source = this.source.get(channelId) ?? '';
      m = {
        targets: (this.parsed.get(channelId) ?? []).map((p) => {
          const tokens = new Set(p.core);
          return { tokens, weight: this.weight(tokens) };
        }),
        source,
        country: this.country.get(channelId) ?? null,
        region: this.region.get(channelId) ?? null,
        prio: this.sourcePriority.get(source) ?? NO_PRIORITY,
        order: this.order.get(channelId) ?? 0,
      };
      this.meta.set(channelId, m);
    }
    return m;
  }

  private scoreAgainst(qTokens: Set<string>, qWeight: number, target: Target): number {
    const { tokens: t, weight: tWeight } = target;
    if (!t.size) return 0;
    const common: string[] = [];
    for (const x of qTokens) if (t.has(x)) common.push(x);
    if (!common.length) return 0;
    const shared = this.weight(common);
    if (!shared) return 0;
    const recall = shared / qWeight;
    const precision = shared / tWeight;
    return recall * (RECALL_WEIGHT + PRECISION_WEIGHT * precision);
  }

  /** Mejor puntaje de nombre entre las variantes de display-name del canal, en [0, 1]. */
  bestNameScore(query: ParsedName, channelId: string, qTokens?: Set<string>, qWeight?: number): number {
    if (!qTokens) {
      qTokens = new Set(query.core);
      qWeight = this.weight(qTokens);
    }
    if (!qWeight) return 0;
    return this.bestTargetScore(qTokens, qWeight, this.metaOf(channelId).targets);
  }

  private bestTargetScore(qTokens: Set<string>, qWeight: number, targets: Target[]): number {
    let best = 0;
    for (const target of targets) {
      const s = this.scoreAgainst(qTokens, qWeight, target);
      if (s > best) best = s;
    }
    return best;
  }

  private candidateIds(query: ParsedName): string[] {
    const tokens = uniq(query.core)
      .map((t) => [t, this.idf(t)] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, CANDIDATE_TOKENS)
      .map(([t]) => t);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      for (const id of this.postings.get(token) ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (ids.length >= CANDIDATE_CAP) break;
    }
    return ids;
  }

  private otherFeed(candRegion: string | null | undefined): boolean {
    const want = FEED_ALIASES[this.preferredFeed ?? ''] ?? this.preferredFeed;
    const have = candRegion ? FEED_ALIASES[candRegion] ?? candRegion : candRegion;
    if (want === DEFAULT_FEED) return !!have && FEED_REGIONS.has(have) && have !== DEFAULT_FEED;
    return have !== want;
  }

  /** Candidatos ordenados por confianza. */
  rank(query: ParsedName, preferSources: string[] = [], country: string | null = null, region: string | null = null): Candidate[] {
    const prefer = new Set(preferSources);
    country = country || query.country;
    const hintCountries = new Set(query.language ? this.rules.countriesForLanguage(query.language) : []);
    region = region || query.region;

    const qTokens = new Set(query.core);
    const qWeight = this.weight(qTokens);
    if (!qWeight) return [];

    const keyed: { c: Candidate; prio: number; order: number }[] = [];
    for (const id of this.candidateIds(query)) {
      const m = this.metaOf(id);
      const base = this.bestTargetScore(qTokens, qWeight, m.targets);
      if (!base) continue;
      let score = base;
      let reason = 'name';
      if (prefer.has(m.source)) {
        score *= PREFER_SOURCE_BOOST;
        reason = 'prefer_source';
      }
      const candCountry = m.country;
      if (country && candCountry) {
        if (this.rules.countryMatches(country, candCountry)) {
          score *= COUNTRY_MATCH_BOOST;
          if (reason === 'name') reason = 'country';
        } else {
          score *= COUNTRY_MISMATCH_PENALTY;
        }
      } else if (hintCountries.size && candCountry && hintCountries.has(candCountry)) {
        score *= LANGUAGE_HINT_BOOST;
        if (reason === 'name') reason = 'language';
      }
      const candRegion = m.region;
      if (region && candRegion) {
        score *= candRegion === region ? REGION_MATCH_BOOST : REGION_MISMATCH_PENALTY;
      } else if (!region && this.preferredFeed && this.otherFeed(candRegion)) {
        score *= OTHER_FEED_PENALTY;
      }
      keyed.push({ c: { channelId: id, score, nameScore: base, reason }, prio: m.prio, order: m.order });
    }
    keyed.sort((a, b) => b.c.score - a.c.score || a.prio - b.prio || a.order - b.order);
    return keyed.map((k) => k.c);
  }
}
