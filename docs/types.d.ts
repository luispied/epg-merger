// Tipos de los datos que lee la interfaz (docs/app.js). Los generan generate_playlist.py
// (match_report-<perfil>.json, epg_catalog.json, schedule/) y la propia interfaz
// (xtream_channel_map.json). Solo se usan para el chequeo de tipos con tsc; no se sirven.

interface Window {
  /** Íconos de Lucide: nombre -> contenido del <svg viewBox="0 0 24 24"> (icons.js). */
  ICONS: Record<string, string>;
}

/** Un canal de Xtream en match_report-<perfil>.json. */
interface ReportChannel {
  xtream_name: string;
  category: string;
  section: string | null;
  chosen: string | null;
  reason: string | null;
  score: number;
  alternatives?: { channel_id: string; score: number; source?: string | null }[];
}

/** Un canal del EPG en epg_catalog.json. */
interface CatalogEntry {
  id: string;
  name: string;
  country: string | null;
  source: string | null;
  /** Nombre del archivo de programación en schedule/ (sin .json), si tiene. */
  sched?: string | null;
}

/** xtream_channel_map.json: todo por nombre crudo del canal en Xtream. */
interface ChannelMap {
  _comment?: string;
  /** channel_id elegido a mano, o null = "dejar sin EPG". */
  overrides: Record<string, string | null>;
  renames?: Record<string, string>;
  categories?: Record<string, string>;
  hidden?: Record<string, boolean>;
  /** Categorías enteras fuera de la playlist, por nombre en Xtream. */
  hidden_categories?: Record<string, boolean>;
  /** Categorías que no necesitan guía (no cuentan en "A revisar" ni "Sin EPG"). */
  no_epg_categories?: Record<string, boolean>;
}

/** Una fuente de epg_urls.json: con url propia o solo el id de epg_sources_catalog.json. */
interface SourceEntry {
  id?: string;
  url?: string;
  country?: string | null;
  priority?: number;
  active?: boolean;
  inactive_reason?: string;
}

/** epg_urls.json */
interface EpgUrlsDoc {
  _comment?: string;
  sources?: SourceEntry[];
}

/** Uso de una fuente del usuario en sources_report.json (tools/source_coverage.py). */
interface SourceUsage {
  id: string;
  url: string | null;
  active: boolean;
  inactive_reason?: string | null;
  country: string | null;
  provider: string | null;
  /** fresh | stale | down, del catálogo (null si no está en el catálogo). */
  status: string | null;
  catalog_id?: string | null;
  used_by: number;
  alt_by: number;
}

/** Fuente del catálogo sugerida, con los canales sin guía que ganaría. */
interface SourceSuggestion {
  id: string;
  url: string;
  country: string | null;
  provider: string | null;
  live_channels?: number | null;
  new_channels?: number | null;
  measured: boolean;
  firm: number;
  doubtful: number;
  examples: { channel: string; epg: string; score: number }[];
}

/** sources_report.json */
interface SourcesReport {
  generated_at: string;
  summary: Record<string, number>;
  sources: SourceUsage[];
  unused_active: string[];
  countries: { country: string; missing: number; matched: number }[];
  suggestions: SourceSuggestion[];
}

/** provider_rules.json ya compilado (ver compileRules en app.js). */
interface ProviderRules {
  dividerRe: RegExp | null;
  eventSections: Set<string | null | undefined>;
  eventEditable: Set<string>;
  noEpgCategories: Set<string>;
  noEpgSections: Set<string>;
  noEpgPatterns: RegExp[];
}

/** schedule/<sched>.json: [inicio, fin, título, descripción?] con inicio/fin en epoch s. */
type ScheduleEntry = [number, number, string, string?];

/** schedule/hour/<AAAAMMDDHH>.json: h = inicio de la hora (epoch s), t = títulos,
 *  c = channel_id -> [[inicio_min, fin_min, índice_título], ...] relativos a h. */
interface HourIndex {
  h: number;
  t: string[];
  c: Record<string, [number, number, number][]>;
}

/** Lo que está dando un canal ahora. */
interface NowPlaying {
  title: string;
  /** Inicio del programa, epoch en segundos (para ubicar su descripción en schedule/). */
  start: number;
  /** Fin del programa, epoch en segundos. */
  stop: number;
}

/** Corrida de un workflow (API de GitHub Actions, solo los campos que se usan). */
interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  html_url: string;
}

/** Error de gh() con el status HTTP. */
interface GitHubError extends Error {
  status?: number;
}
