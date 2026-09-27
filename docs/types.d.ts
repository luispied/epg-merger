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
}

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
