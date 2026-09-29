// Parseo de nombres de canal. Port de channel_names.py: cada señal (país, idioma, región,
// calidad) se saca del núcleo del nombre pero se conserva como dato para puntuar con ella.

export interface ParsedName {
  core: string[];
  country: string | null;
  language: string | null;
  region: string | null;
  quality: string[];
  raw: string;
}

/** Contenido de matching_rules.json. */
export interface MatchingRulesData {
  country_code_aliases?: Record<string, string>;
  country_tokens?: Record<string, string>;
  language_tokens?: Record<string, string>;
  language_countries?: Record<string, string[]>;
  quality_tokens?: string[];
  region_tokens?: string[];
  country_groups?: Record<string, string[]>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class MatchingRules {
  readonly countryCodeAliases: Map<string, string>;
  readonly countryTokens: Map<string, string>;
  readonly languageTokens: Map<string, string>;
  readonly languageCountries: Map<string, string[]>;
  readonly qualityTokens: Set<string>;
  readonly regionTokens: Set<string>;
  readonly countryGroups: Map<string, Set<string>>;
  readonly multiCountryRe: RegExp | null;

  constructor(data: MatchingRulesData) {
    this.countryCodeAliases = new Map(Object.entries(data.country_code_aliases ?? {}));
    this.countryTokens = new Map(Object.entries(data.country_tokens ?? {}));
    this.languageTokens = new Map(Object.entries(data.language_tokens ?? {}));
    this.languageCountries = new Map(Object.entries(data.language_countries ?? {}));
    this.qualityTokens = new Set(data.quality_tokens ?? []);
    this.regionTokens = new Set(data.region_tokens ?? []);
    this.countryGroups = new Map(Object.entries(data.country_groups ?? {}).map(([k, v]) => [k, new Set(v)]));
    // Países de varias palabras ("costa rica"), tolerando cualquier separación en el texto.
    const multi = [...this.countryTokens.keys()].filter((k) => k.includes(' '))
      .sort((a, b) => b.length - a.length);
    this.multiCountryRe = multi.length
      ? new RegExp('\\b(' + multi.map((k) => escapeRe(k).replace(/ /g, '\\s+')).join('|') + ')\\b')
      : null;
  }

  countryOf(token: string): string | null {
    return this.countryTokens.get(token) ?? null;
  }

  /** El país del candidato cumple con el pedido: el mismo código, o uno del grupo ('latam'). */
  countryMatches(wanted: string, candidate: string): boolean {
    const group = this.countryGroups.get(wanted);
    return group ? group.has(candidate) : candidate === wanted;
  }

  countriesForLanguage(language: string): string[] {
    return this.languageCountries.get(language) ?? [];
  }
}

const COUNTRY_PREFIX_RE = /^[A-Za-z]{1,3}\s*\|\s*/;
const DISPLAY_PREFIX_RE = /^(?:EVENTS\s+\d+\s*:\s*|24[A-Za-z]\s+|(?<code>UY|PT|ES|CL|BR|AR|USA|E|S|D|Y)\s*[|:]\s*)/i;
const RESOLUTION_RE = /^\d{3,4}[pi]$/;
const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const DIGITS_RE = /^\d+$/;

/** Sin acentos (NFKD sin marcas combinantes), como unicodedata en Python. */
export function stripAccents(text: string): string {
  return text.normalize('NFKD').replace(/\p{Mn}/gu, '');
}

export function parseChannelName(raw: string | null | undefined, r: MatchingRules): ParsedName {
  if (!raw) return { core: [], country: null, language: null, region: null, quality: [], raw: raw ?? '' };

  let country: string | null = null;
  let language: string | null = null;
  let region: string | null = null;
  const quality: string[] = [];

  let text = stripAccents(raw);
  const prefix = COUNTRY_PREFIX_RE.exec(text);
  if (prefix) {
    const code = prefix[0].replace(/^[ |]+|[ |]+$/g, '').toLowerCase();
    country = r.countryOf(code);
    text = text.slice(prefix[0].length);
  }
  text = text.toLowerCase();

  if (r.multiCountryRe) {
    const m = r.multiCountryRe.exec(text);
    if (m) {
      country = country ?? r.countryOf(m[1]);
      text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    }
  }

  // "[Geo-blocked]", "[Not 24/7]": del stream, no del canal. El "+" distingue canales.
  text = text.replace(BRACKET_TAG_RE, ' ').split('+').join(' plus ');

  let tokens = text.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  // "DAZN 01" = "DAZN 1"; "Dazn F 1" = "DAZN F1".
  tokens = tokens.map((t) => (DIGITS_RE.test(t) ? t.replace(/^0+/, '') || '0' : t));
  const joined: string[] = [];
  for (const t of tokens) {
    if (joined.length && DIGITS_RE.test(t) && joined[joined.length - 1] === 'f') joined[joined.length - 1] += t;
    else joined.push(t);
  }
  tokens = joined;

  // La calidad del final no cuenta para ubicar el sufijo de idioma ("TLC -EN ᵁᴴᴰ").
  const trailing: string[] = [];
  while (tokens.length && (r.qualityTokens.has(tokens[tokens.length - 1]) || RESOLUTION_RE.test(tokens[tokens.length - 1]))) {
    trailing.unshift(tokens.pop() as string);
  }
  quality.push(...trailing);

  const last = tokens[tokens.length - 1];
  if (tokens.length && r.languageTokens.has(last) && !r.countryTokens.has(last)) {
    language = r.languageTokens.get(last) as string;
    tokens = tokens.slice(0, -1);
  }

  const core: string[] = [];
  for (const token of tokens) {
    if (r.qualityTokens.has(token) || RESOLUTION_RE.test(token)) quality.push(token);
    else if (r.regionTokens.has(token)) region = region ?? token;
    else if (r.countryTokens.has(token)) {
      // Un país concreto le gana a una región ("AXN Latin America Mexico").
      if (!country || r.countryGroups.has(country)) country = r.countryOf(token);
    } else core.push(token);
  }
  return { core, country, language, region, quality, raw };
}

/** Saca el prefijo del proveedor del nombre visible. Devuelve [nombre, país del prefijo]. */
export function stripDisplayPrefix(name: string, r: MatchingRules): [string, string | null] {
  if (!name) return [name, null];
  const m = DISPLAY_PREFIX_RE.exec(name);
  if (!m) return [name, null];
  const code = m.groups?.code;
  const country = code ? r.countryOf(code.toLowerCase()) : null;
  const clean = name.slice(m[0].length).trim();
  return [clean || name, country];
}

/** Código de país del emoji de bandera ("🇦🇷" -> "ar"). */
export function flagToCountryCode(text: string | null | undefined, r: MatchingRules): string | null {
  const cps = Array.from(text ?? '', (c) => c.codePointAt(0) as number);
  for (let i = 0; i < cps.length - 1; i++) {
    const [a, b] = [cps[i], cps[i + 1]];
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code = String.fromCharCode(a - 0x1f1e6 + 97) + String.fromCharCode(b - 0x1f1e6 + 97);
      return r.countryCodeAliases.get(code) ?? code;
    }
  }
  return null;
}
