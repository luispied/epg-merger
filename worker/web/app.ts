// Grilla web (Etapa 1, paso 4): la interfaz sobre el Worker. Conectar el proveedor, cruzar los
// canales con la guía en el navegador (@grilla/core, el mismo matcher que la corrida de
// Python), corregir y copiar los links para el reproductor. Sin cuenta: la configuración vive
// en el Worker y la clave para editarla, en este navegador (exportable como respaldo).
import {
  EpgIndex, flagToCountryCode, MatchingRules, matchStream, stripDisplayPrefix, type Candidate, type GuideChannel,
  type MatchingRulesData, type SourceInfo,
} from '../../core/src/index.ts';
import { placeNewGroups } from '../src/groups.ts';
import { m3uLineParser, xtreamLiveChannel } from '../src/provider.ts';

// ------------------------------------------------------------------ tipos (los del Worker)
type Provider = { type: 'xtream'; servers: string[]; list?: 'upload' } | { type: 'm3u' };
interface ChannelEdit { epg?: string | null; logo?: string; name?: string; group?: string; hidden?: boolean; manual?: boolean; customLogo?: string }
interface Config {
  version: 1;
  provider: Provider;
  directUrls?: boolean;
  channels: Record<string, ChannelEdit>;
  groups: { order: string[]; hidden: string[]; noEpg?: string[]; channels?: Record<string, string[]>; rename?: Record<string, string>; custom?: string[]; separators?: string[] };
  /** Cómo elige la guía la corrida de GitHub (importado): se usa igual para los canales nuevos. */
  matching?: { minScore?: number; feed?: string | null; categories?: Record<string, { country?: string | null; prefer_sources?: string[] }> };
}
interface Channel { name: string; category: string; id: string; ext: string; icon: string; epgId: string | null }
interface Local { cfgId: string; editKey: string }
type Creds = { username: string; password: string } | { url: string };
interface Auto { cid: string | null; score: number; ranked: Candidate[] }

const LOCAL_KEY = 'grilla_web_v1';
const LIST_KEY = (cfgId: string) => `grilla_list_${cfgId}`;
const GOOD = 0.8;
const PAGE = 80;

// Íconos extra (Lucide, ISC) además de los de icons.js.
declare global { interface Window { ICONS: Record<string, string>; qrcode?: (t: number, e: string) => QR } }
interface QR { addData(s: string): void; make(): void; createSvgTag(o: { cellSize: number; margin: number; scalable?: boolean }): string }
Object.assign(window.ICONS, {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sparkles: '<path d="M9.94 14.06 4 20"/><path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4"/><path d="M21 5h-4"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  'share-2': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  'list-ordered': '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  'user-check': '<path d="m16 11 2 2 4-4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  'rows-3': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>',
  'folder-plus': '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'separator-horizontal': '<line x1="3" x2="21" y1="12" y2="12"/><polyline points="8 8 12 4 16 8"/><polyline points="16 16 12 20 8 16"/>',
  'chevrons-down-up': '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
  'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'grip-vertical': '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
});

// ------------------------------------------------------------------ utilidades
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fold = (s: string) => s.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();

function icon(name: string, cls = ''): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`
    + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.ICONS[name] || ''}</svg>`;
}
function hydrateIcons(root: ParentNode = document) {
  $$('[data-icon]', root).forEach((el) => { el.outerHTML = icon((el as HTMLElement).dataset.icon!, el.className); });
}

/** `undo`: agrega "Deshacer" (el aviso dura más). */
function toast(text: string, kind: 'ok' | 'bad' | 'info' = 'info', ms = 3500, undo?: () => void) {
  ms = Math.max(ms, Math.min(12000, 2500 + text.length * 45)); // los largos se leen enteros
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'circle-check' : kind === 'bad' ? 'circle-x' : 'info')}<span class="msg">${esc(text)}</span>`
    + (undo ? '<button type="button" class="btn btn-plain">Deshacer</button>' : '');
  if (undo) {
    ms = Math.max(ms, 7000);
    $('button', el).onclick = () => {
      el.remove();
      undo();
    };
  }
  // Dentro del diálogo abierto, si hay uno: si no, queda tapado por el fondo del diálogo.
  const host = $$('dialog[open]').pop() ?? document.body;
  let box = $('.toasts', host);
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    host.appendChild(box);
  }
  // El mismo aviso no se repite (mover varias veces seguidas) y quedan como mucho 3.
  for (const old of $$('.toast', box)) if ($('.msg', old)?.textContent === text) old.remove();
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(() => el.remove(), ms);
}

// Confirmar y pedir un texto con el estilo de la página (en vez de confirm/prompt del
// navegador). Van en un <dialog> propio, que queda arriba de cualquier otro abierto.
interface AskOptions { title: string; text?: string; ok?: string; danger?: boolean; icon?: string; input?: { label: string; value?: string; placeholder?: string } }
function ask(o: AskOptions): Promise<string | null> {
  const dlg = $('#askDialog') as HTMLDialogElement;
  $('#askTitle').textContent = o.title;
  $('#askText').textContent = o.text ?? '';
  $('#askText').hidden = !o.text;
  const field = $('#askField');
  const input = $<HTMLInputElement>('#askInput');
  field.hidden = !o.input;
  // Pedir un texto: campo con ícono y la tilde para confirmar (sin botones con texto).
  // Confirmar: el texto y los dos botones.
  $('#askActions').hidden = !!o.input;
  $('#askIcon').innerHTML = icon(o.icon ?? 'text-cursor-input');
  input.value = o.input?.value ?? '';
  input.placeholder = o.input?.placeholder ?? o.input?.label ?? '';
  input.setAttribute('aria-label', o.input?.label ?? '');
  input.required = !!o.input;
  const ok = $<HTMLButtonElement>('#askOk');
  ok.textContent = o.ok ?? 'Aceptar';
  ok.className = `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`;
  $('#askCheck').setAttribute('aria-label', o.ok ?? 'Aceptar');
  dlg.returnValue = '';
  dlg.showModal();
  if (o.input) {
    input.focus();
    input.select();
  }
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? (o.input ? input.value.trim() || null : '') : null);
    }, { once: true });
  });
}
const confirmDialog = async (o: AskOptions) => (await ask(o)) !== null;
const promptDialog = (o: AskOptions & { input: NonNullable<AskOptions['input']> }) => ask(o);
const newCategoryName = () => promptDialog({
  title: 'Categoría nueva', ok: 'Crear', icon: 'folder-plus', input: { label: 'Nombre', placeholder: 'Nombre de la categoría' },
});

function status(el: HTMLElement, text: string | null, kind: 'busy' | 'ok' | 'bad' = 'busy') {
  el.hidden = !text;
  if (!text) return;
  el.className = `status-bar ${kind}`;
  el.innerHTML = `${icon(kind === 'busy' ? 'loader-circle' : kind === 'ok' ? 'circle-check' : 'triangle-alert', kind === 'busy' ? 'spin' : '')}`
    + `<span class="lead">${esc(text)}</span>`;
}

const loadLocal = (): Local | null => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
  } catch {
    return null;
  }
};
const saveLocal = (l: Local | null) => {
  try {
    if (l) localStorage.setItem(LOCAL_KEY, JSON.stringify(l));
    else localStorage.removeItem(LOCAL_KEY);
  } catch { /* sin storage */ }
};

async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false && state.local) headers.Authorization = `Bearer ${state.local.editKey}`;
  const res = await fetch(path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), { data });
  return data as T;
}

// Preferencias de este navegador (no viajan con la configuración).
const pref = (k: string, def: string) => {
  try {
    return localStorage.getItem(k) ?? def;
  } catch {
    return def;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch { /* sin storage */ }
};
const FILTERS = ['todos', 'revisar', 'sin-epg', 'manual', 'editados', 'ocultos'];
function startFilter() {
  const start = pref('grilla_start_filter', 'last');
  const f = start === 'last' ? pref('grilla_last_filter', 'todos') : start;
  return FILTERS.includes(f) ? f : 'todos';
}
const logosOn = () => pref('grilla_logos', '1') !== '0';

// ------------------------------------------------------------------ canales nuevos
// Los nombres ya vistos de cada configuración quedan en este navegador; los que aparecen después
// en la lista del proveedor (y no están ocultos) se marcan como nuevos hasta "Marcar como vistos".
const SEEN_KEY = (cfgId: string) => `grilla_seen_${cfgId}`;
function detectNew() {
  if (!state.local) return;
  let seen: Set<string> | null = null;
  try {
    const raw = localStorage.getItem(SEEN_KEY(state.local.cfgId));
    if (raw) seen = new Set(JSON.parse(raw) as string[]);
  } catch { /* sin storage */ }
  if (!seen) {
    // Primera vez: todo es conocido.
    markSeen();
    return;
  }
  state.newNames = new Set(state.channels.filter((c) => !seen!.has(c.name) && !info(c).hidden && !info(c).divider).map((c) => c.name));
}
function markSeen() {
  if (!state.local) return;
  try {
    localStorage.setItem(SEEN_KEY(state.local.cfgId), JSON.stringify([...new Set(state.channels.map((c) => c.name))]));
  } catch { /* sin storage */ }
  state.newNames = new Set();
}
function renderNewBanner() {
  const n = state.newNames.size;
  const el = $('#newBanner');
  el.hidden = !n;
  $('#filterTabs [data-filter="nuevos"]').hidden = !n;
  if (!n) {
    if (state.filter === 'nuevos') state.filter = 'todos';
    return;
  }
  el.innerHTML = `${icon('sparkles')}<span class="grow">${n === 1 ? 'Hay 1 canal nuevo' : `Hay ${n} canales nuevos`} en tu lista.</span>`
    + `${state.filter === 'nuevos' ? '' : '<button type="button" class="btn btn-tonal sm" data-new="show">Ver</button>'}`
    + '<button type="button" class="btn btn-plain sm" data-new="seen">Marcar como vistos</button>';
}

// ------------------------------------------------------------------ estado
const state = {
  local: loadLocal() as Local | null,
  cfg: null as Config | null,
  channels: [] as Channel[],
  index: null as EpgIndex | null,
  rules: null as MatchingRules | null,
  auto: new Map<string, Auto>(),
  creds: null as Creds | null, // de la pestaña (ver CREDS_KEY): para generar los links sin volver a pedirlos
  filter: startFilter(),
  search: '',
  shown: PAGE,
  reloading: false,
  newNames: new Set<string>(),
  newGroups: new Set<string>(), // categorías que el proveedor trajo en esta apertura
};

// Usuario y contraseña del proveedor: quedan solo en esta pestaña (sessionStorage; se borran al
// cerrarla, nunca viajan ni van a localStorage) para no volver a pedirlos al generar links si la
// página se recarga. Van atados a la configuración con la que se usaron.
const CREDS_KEY = 'grilla_creds';
{
  let mem: Creds | null = null;
  const read = (): { cfgId: string | null; creds: Creds } | null => {
    try {
      return JSON.parse(sessionStorage.getItem(CREDS_KEY) || 'null');
    } catch {
      return null;
    }
  };
  Object.defineProperty(state, 'creds', {
    get(): Creds | null {
      if (mem) return mem;
      const saved = read();
      if (!saved?.creds || (saved.cfgId && state.local && saved.cfgId !== state.local.cfgId)) return null;
      return saved.creds;
    },
    set(v: Creds | null) {
      mem = v;
      try {
        if (v) sessionStorage.setItem(CREDS_KEY, JSON.stringify({ cfgId: state.local?.cfgId ?? null, creds: v }));
        else sessionStorage.removeItem(CREDS_KEY);
      } catch { /* sin storage: queda en memoria */ }
    },
  });
}

/** Selección múltiple: índices de state.channels. */
const selection = { active: false, items: new Set<number>() };

// ------------------------------------------------------------------ guía y matching
async function loadGuide(onStatus: (t: string) => void) {
  if (state.index) return;
  onStatus('Bajando la guía de programación…');
  const guide = await (await fetch('/api/guide/index.json')).json() as {
    matching_rules: MatchingRulesData; sources: Record<string, SourceInfo>; channels: GuideChannel[];
  };
  onStatus('Preparando la guía…');
  await new Promise((r) => setTimeout(r));
  state.rules = new MatchingRules(guide.matching_rules);
  state.index = new EpgIndex(guide.channels, state.rules, guide.sources);
}

/** Cruza todos los canales con la guía (en tandas, para no congelar la página). Los EPG
 *  elegidos a mano no se tocan. Devuelve si cambió algo de la configuración. */
async function rematch(onStatus: (t: string) => void): Promise<boolean> {
  const { cfg, index, rules } = state;
  if (!cfg || !index || !rules) return false;
  const before = JSON.stringify(cfg.channels);
  const trust = cfg.provider.type === 'm3u';
  // Con las preferencias importadas de GitHub se elige igual que allá (su umbral, su señal
  // horaria y las fuentes/país de cada categoría); sin ellas, lo dudoso queda como sugerencia.
  const prefs = cfg.matching ?? {};
  const baseScore = prefs.minScore ?? 0.7;
  const minAssignScore = baseScore;
  if ('feed' in prefs) index.preferredFeed = prefs.feed ?? null;
  const names = [...new Set(state.channels.map((c) => c.name))];
  const byName = new Map(state.channels.map((c) => [c.name, c]));
  for (let i = 0; i < names.length; i++) {
    if (i % 150 === 0) {
      onStatus(`Buscando la guía de cada canal… ${Math.round((100 * i) / names.length)} %`);
      await new Promise((r) => setTimeout(r));
    }
    const ch = byName.get(names[i])!;
    // Los separadores de sección del proveedor no son canales: nunca llevan guía.
    if (DIVIDER_RE.test(ch.category)) {
      state.auto.set(ch.name, { cid: null, score: 0, ranked: [] });
      const edit = cfg.channels[ch.name] ?? {};
      if (!edit.manual) {
        delete edit.epg;
        delete edit.logo;
      }
      setEdit(ch.name, edit);
      continue;
    }
    const m = matchStream(ch.name, ch.epgId, index, {}, prefs.categories?.[ch.category] ?? {}, flagToCountryCode(ch.category, rules), { trustListIds: trust, minAssignScore });
    state.auto.set(ch.name, { cid: m.channelId, score: m.score, ranked: m.ranked.slice(0, 8) });
    const edit = cfg.channels[ch.name] ?? {};
    // Lo que trajo la importación de GitHub entra marcado "a mano" para no recalcularlo, pero si
    // coincide con lo que elige el cruce automático no es una elección propia: vuelve a ser
    // automático (muestra su porcentaje y sigue la guía del día, como en GitHub).
    if (cfg.matching && edit.manual && edit.epg && m.channelId === edit.epg) delete edit.manual;
    if (!edit.manual) {
      if (m.channelId) {
        edit.epg = m.channelId;
        const logo = index.icon.get(m.channelId);
        if (logo) edit.logo = logo;
        else delete edit.logo;
      } else {
        delete edit.epg;
        delete edit.logo;
      }
    }
    setEdit(ch.name, edit);
  }
  return JSON.stringify(cfg.channels) !== before;
}

function setEdit(name: string, edit: ChannelEdit) {
  const cfg = state.cfg!;
  for (const k of Object.keys(edit) as (keyof ChannelEdit)[]) if (edit[k] === undefined || edit[k] === '') delete edit[k];
  if (Object.keys(edit).length) cfg.channels[name] = edit;
  else delete cfg.channels[name];
}

// ------------------------------------------------------------------ guardar
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 700);
}
// Sin conexión, los cambios quedan en este navegador y se mandan solos cuando vuelve.
const PENDING_KEY = (cfgId: string) => `grilla_pending_${cfgId}`;
const offlineError = (e: unknown) => !navigator.onLine || e instanceof TypeError;

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.local || !state.cfg) return;
  const cfgId = state.local.cfgId;
  try {
    await api(`/api/cfg/${cfgId}`, { method: 'PUT', body: state.cfg });
    try {
      localStorage.removeItem(PENDING_KEY(cfgId));
    } catch { /* sin storage */ }
    $('#statusLine').dataset.saved = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    delete $('#statusLine').dataset.pending;
    renderStatusLine();
    refreshGuideStatus();
  } catch (e) {
    if (offlineError(e)) {
      try {
        localStorage.setItem(PENDING_KEY(cfgId), JSON.stringify(state.cfg));
      } catch { /* sin storage */ }
      $('#statusLine').dataset.pending = '1';
      renderStatusLine();
      return;
    }
    toast(`No se pudo guardar: ${(e as Error).message}`, 'bad', 6000);
  }
}
window.addEventListener('online', () => {
  if (state.local && state.cfg && $('#statusLine').dataset.pending) {
    saveNow().then(() => {
      if (!$('#statusLine').dataset.pending) toast('Volvió la conexión: tus cambios se guardaron', 'ok');
    });
  }
});

// ------------------------------------------------------------------ estado de los cambios
// La playlist toma los cambios al instante (el Worker la arma en cada pedido); la guía la
// vuelve a armar la corrida de GitHub. No hay un cartel fijo: al guardar se avisa una vez que
// la guía se está actualizando y otra cuando está lista. "Actualizar la guía ahora" está en
// Configuración (como el botón Workflow de la interfaz de GitHub).
interface GuideStatus { guideUpToDate: boolean; guide: string | null; autoRefresh: boolean }
let guideTimer = 0;
let guidePending = false; // ya se avisó que la guía se está actualizando

const guideTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

async function refreshGuideStatus() {
  clearTimeout(guideTimer);
  if (!state.local || $('#editor').hidden) return;
  let st: GuideStatus;
  try {
    st = await api<GuideStatus>(`/api/cfg/${state.local.cfgId}/status`);
  } catch {
    return;
  }
  if (st.guideUpToDate) {
    if (guidePending) {
      guidePending = false;
      toast(`La guía ya está lista con tus cambios (${guideTime(st.guide)})`, 'ok');
    }
    return;
  }
  if (!guidePending) {
    guidePending = true;
    toast(`La playlist ya tiene tus cambios; la guía se actualiza en ${st.autoRefresh ? 'un par de minutos' : 'unos 10 minutos'}`, 'info', 4500);
  }
  guideTimer = window.setTimeout(refreshGuideStatus, 30000);
}

async function storeList() {
  if (!state.local) return;
  try {
    localStorage.setItem(LIST_KEY(state.local.cfgId), JSON.stringify(state.channels));
  } catch { /* lista grande o sin storage: queda la del Worker */ }
  if (state.cfg?.provider.type === 'xtream') {
    // En el Worker también: con proveedores que lo bloquean, es la lista que usa la playlist.
    await api(`/api/cfg/${state.local.cfgId}/list`, { method: 'PUT', body: { channels: state.channels } });
  }
}

async function loadStoredList(): Promise<Channel[]> {
  // Primero la del Worker (la que se actualiza sola desde GitHub); si no hay, la de este navegador.
  if (state.cfg?.provider.type === 'xtream') {
    try {
      const list = (await api<{ channels: Channel[] }>(`/api/cfg/${state.local!.cfgId}/list`)).channels;
      if (list?.length) return list;
    } catch { /* sigue */ }
  }
  try {
    const cached = localStorage.getItem(LIST_KEY(state.local!.cfgId));
    if (cached) return JSON.parse(cached);
  } catch { /* sin storage */ }
  return [];
}

// ------------------------------------------------------------------ canales: vista
function groupOf(ch: Channel) {
  return state.cfg!.channels[ch.name]?.group || ch.category;
}

/** El nombre de una categoría o sección tal como se ve (el que le puso la persona, si lo cambió). */
const groupLabel = (g: string) => state.cfg?.groups.rename?.[g] || g;

/** Categorías en el orden guardado; las que no están en él, al final en el orden del proveedor. */
function groups(): string[] {
  const present: string[] = [];
  const seen = new Set<string>();
  for (const ch of state.channels) {
    const g = groupOf(ch);
    if (!seen.has(g)) {
      seen.add(g);
      present.push(g);
    }
  }
  // Las creadas a mano existen aunque todavía no tengan canales.
  for (const g of [...(state.cfg!.groups.custom ?? []), ...(state.cfg!.groups.separators ?? [])]) {
    if (!seen.has(g)) {
      seen.add(g);
      present.push(g);
    }
  }
  return placeNewGroups(state.cfg!.groups.order, present, new Set(state.cfg!.groups.separators ?? [])).filter((g) => seen.has(g));
}

/** Categorías que el proveedor trajo y todavía no estaban en el orden guardado: se ubican solas
 *  junto a las que se les parecen (igual que en la playlist) y se avisa, con "Deshacer". */
function placeNewCategories() {
  const gr = state.cfg!.groups;
  state.newGroups = new Set();
  if (!gr.order.length) return;
  const present = [...new Set(state.channels.map(groupOf))];
  const known = new Set(gr.order);
  const fresh = present.filter((g) => !known.has(g));
  if (!fresh.length) return;
  const placed = placeNewGroups(gr.order, present, new Set(gr.separators ?? []));
  state.newGroups = new Set(fresh);
  const where = (g: string) => {
    const prev = placed.slice(0, placed.indexOf(g)).reverse().find((h) => present.includes(h));
    return prev && !sectionHeaders().has(prev) ? `«${groupLabel(g)}» quedó después de «${groupLabel(prev)}»` : `«${groupLabel(g)}» quedó al final`;
  };
  const shown = fresh.slice(0, 3).map(where).join('; ');
  editGroups((g) => { g.order = placed; },
    `${fresh.length === 1 ? 'Categoría nueva del proveedor' : `${fresh.length} categorías nuevas del proveedor`}, ubicada${fresh.length === 1 ? '' : 's'} sola${fresh.length === 1 ? '' : 's'}: ${shown}${fresh.length > 3 ? ` y ${fresh.length - 3} más` : ''}. Podés moverla${fresh.length === 1 ? '' : 's'} en Categorías.`);
}

type Band = 'ok' | 'warn' | 'none' | 'manual' | 'purpose';
function info(ch: Channel) {
  const edit = state.cfg!.channels[ch.name] ?? {};
  const auto = state.auto.get(ch.name);
  const epg = edit.epg ?? null;
  const hidden = !!edit.hidden || state.cfg!.groups.hidden.includes(groupOf(ch));
  // "purpose": lo dejaste sin EPG a propósito (es una decisión tuya, no un canal sin resolver).
  const band: Band = edit.manual ? (epg ? 'manual' : 'purpose') : epg ? ((auto?.score ?? 0) >= GOOD ? 'ok' : 'warn') : 'none';
  // Categoría marcada "Sin guía" (Categorías): no cuenta en "A revisar" ni en "Sin EPG".
  const noGuide = !!state.cfg!.groups.noEpg?.includes(groupOf(ch));
  const divider = DIVIDER_RE.test(ch.category) || headersNow().has(groupOf(ch));
  const suggestion = !epg && !edit.manual && !divider ? auto?.ranked.find((c) => c.nameScore >= 0.3) ?? null : null;
  return { edit, auto, epg, hidden, band, suggestion, noGuide, divider };
}

function matchesFilter(ch: Channel, filter: string) {
  const i = info(ch);
  switch (filter) {
    case 'revisar': return !i.hidden && !i.noGuide && !i.divider && (i.band === 'warn' || (i.band === 'none' && !!i.suggestion));
    // "Sin EPG" = los que todavía no tienen guía; los que dejaste sin EPG a propósito están en
    // "Elegidos a mano", con lo demás que decidiste vos.
    case 'sin-epg': return !i.hidden && !i.noGuide && !i.divider && !i.epg && i.band !== 'purpose';
    case 'manual': return i.band === 'manual' || i.band === 'purpose';
    case 'nuevos': return state.newNames.has(ch.name);
    case 'editados': return !!(i.edit.name || i.edit.group || i.edit.hidden);
    case 'ocultos': return i.hidden;
    default: return !i.hidden;
  }
}

// Lo que está dando ahora cada canal (índice de la hora actual), para buscar por programa en
// la lista principal. Se carga al abrir el editor y al buscar; mientras no llega, se busca solo
// por nombre y categoría.
let hourNow: HourIndex | null = null;
function loadHourNow() {
  hourIndex().then((idx) => {
    if (!idx || idx === hourNow) return;
    hourNow = idx;
    if (state.search.trim()) render();
  });
}
/** El programa en el aire del EPG del canal, si coincide con la búsqueda. */
function programMatch(ch: Channel, q: string): NowPlaying | null {
  const epg = state.cfg!.channels[ch.name]?.epg;
  if (!q || !hourNow || !epg) return null;
  const cur = nowFromHour(hourNow, epg);
  return cur && fold(cur.title).includes(q) ? cur : null;
}

/** Posición de un canal dentro de su categoría: el orden propio primero, después el del proveedor. */
function withinPos(i: number): number {
  const ch = state.channels[i];
  const k = state.cfg!.groups.channels?.[groupOf(ch)]?.indexOf(ch.name) ?? -1;
  return k >= 0 ? k : state.channels.length + i;
}

function visibleChannels(): number[] {
  const q = fold(state.search.trim());
  const order = new Map(groups().map((g, i) => [g, i]));
  return state.channels
    .map((ch, i) => i)
    .filter((i) => {
      const ch = state.channels[i];
      if (!matchesFilter(ch, state.filter)) return false;
      if (!q) return true;
      const edit = state.cfg!.channels[ch.name] ?? {};
      const guideName = edit.epg ? state.index?.displayName.get(edit.epg) ?? edit.epg : '';
      return fold(`${ch.name} ${edit.name ?? ''} ${groupLabel(groupOf(ch))} ${groupOf(ch)} ${guideName}`).includes(q) || !!programMatch(ch, q);
    })
    .sort((a, b) => (order.get(groupOf(state.channels[a])) ?? 0) - (order.get(groupOf(state.channels[b])) ?? 0)
      || withinPos(a) - withinPos(b));
}

/** La etiqueta de estado de una tarjeta: el porcentaje de coincidencia (verde si es "Bien",
 *  naranja si es dudosa); "A mano" y "Sin EPG" no tienen porcentaje. */
function bandTag(band: Band, score?: number): string {
  const pct = score && score > 0 ? `${Math.round(Math.min(score, 1) * 100)} %` : '';
  switch (band) {
    case 'ok': return `<span class="tag ok" title="Coincidencia buena${pct ? `: ${pct}` : ''}">${pct || 'Bien'}</span>`;
    case 'warn': return `<span class="tag warn" title="Coincidencia dudosa${pct ? `: ${pct}` : ''}: conviene revisarla">${pct || 'Dudoso'}</span>`;
    case 'none': return '<span class="tag bad">Sin EPG</span>';
    case 'manual': return `<span class="tag manual with-icon" title="Elegida por vos: no cambia sola">${icon('user-check', 'sm')}</span>`;
    case 'purpose': return `<span class="tag muted with-icon" title="Sin guía a propósito">${icon('ban', 'sm')}</span>`;
  }
}

// ------------------------------------------------------------------ programación ("Ahora: …")
// La corrida diaria sube a R2 (ui/schedule/) un índice por hora UTC con lo que da toda la guía
// y un archivo por canal con títulos y descripciones (nombre: sha1 del id, 16 caracteres).
interface HourIndex { h: number; t: string[]; c: Record<string, [number, number, number][]> }
type ScheduleEntry = [number, number, string, string?];
interface NowPlaying { title: string; start: number; stop: number }

const hourCache = new Map<string, Promise<HourIndex | null>>();
function hourIndex(): Promise<HourIndex | null> {
  const key = new Date().toISOString().slice(0, 13).replace(/\D/g, '');
  if (!hourCache.has(key)) {
    hourCache.set(key, fetch(`/api/ui/schedule/hour/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return hourCache.get(key)!;
}

const scheduleCache = new Map<string, Promise<ScheduleEntry[] | null>>();
function schedule(id: string): Promise<ScheduleEntry[] | null> {
  if (!scheduleCache.has(id)) {
    scheduleCache.set(id, crypto.subtle.digest('SHA-1', new TextEncoder().encode(id))
      .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16))
      .then((f) => fetch(`/api/ui/schedule/${f}.json`))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return scheduleCache.get(id)!;
}

function nowFromHour(idx: HourIndex, id: string): NowPlaying | null {
  const now = Date.now() / 1000;
  for (const [s, e, t] of idx.c[id] ?? []) {
    if (idx.h + s * 60 <= now && now < idx.h + e * 60) return { title: idx.t[t], start: idx.h + s * 60, stop: idx.h + e * 60 };
  }
  return null;
}
function nowFromEntries(entries: ScheduleEntry[] | null): NowPlaying | null {
  const now = Date.now() / 1000;
  const cur = (entries ?? []).find(([s, e]) => s <= now && now < e);
  return cur ? { title: cur[2], start: cur[0], stop: cur[1] } : null;
}
async function nowPlaying(id: string): Promise<NowPlaying | null> {
  const idx = await hourIndex();
  return idx ? nowFromHour(idx, id) : nowFromEntries(await schedule(id));
}

const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** La línea "Ahora: …" es un botón que despliega la descripción del programa. */
function nowHtml(cur: NowPlaying | null, id: string, note = ''): string {
  const noteHtml = note ? ` <span class="note">${esc(note)}</span>` : '';
  if (!cur) return `<span>Sin programación para este horario${noteHtml}</span>`;
  return `<button type="button" class="now-btn" data-desc-for="${esc(id)}" data-start="${cur.start}" aria-expanded="false"`
    + ` title="Ver descripción del programa">${icon('tv', 'sm')}<span>Ahora: ${esc(cur.title)} · hasta ${hhmm(cur.stop)}${noteHtml}</span>`
    + `${icon('chevron-down', 'sm chev')}</button>`;
}

/** Completa las líneas "Ahora" pendientes y los logos de un bloque ya en la página. */
function fillEpgRows(root: ParentNode) {
  for (const el of $$('.epg-now[data-now-for]', root)) {
    const id = el.dataset.nowFor!;
    el.removeAttribute('data-now-for');
    if (el.dataset.compact) {
      nowPlaying(id).then((cur) => {
        el.textContent = cur ? cur.title : '';
        el.classList.toggle('on-air', !!cur);
      });
      continue;
    }
    nowPlaying(id).then((cur) => {
      el.innerHTML = nowHtml(cur, id, el.dataset.note ?? '');
      el.classList.toggle('on-air', !!cur);
    });
  }
  for (const img of $$<HTMLImageElement>('.logo img:not([data-wired])', root)) {
    img.dataset.wired = '1';
    const ok = () => img.parentElement?.classList.add('has-img');
    if (img.complete && img.naturalWidth) ok();
    else {
      img.addEventListener('load', ok);
      img.addEventListener('error', () => img.remove()); // queda el ícono genérico
    }
  }
}

/** Descripción del programa en el aire (del archivo del canal, que se baja recién acá). */
async function toggleDesc(btn: HTMLElement) {
  const box = btn.parentElement!;
  const open = $('.epg-desc', box);
  if (open) {
    open.remove();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  const p = document.createElement('p');
  p.className = 'epg-desc muted';
  p.textContent = 'Cargando descripción…';
  box.appendChild(p);
  const entries = (await schedule(btn.dataset.descFor!)) ?? [];
  const start = Number(btn.dataset.start);
  const now = Date.now() / 1000;
  const entry = entries.find((e) => e[0] === start) ?? entries.find(([s, e]) => s <= now && now < e);
  const i = entry ? entries.indexOf(entry) : -1;
  const next = i >= 0 ? entries[i + 1] : undefined;
  p.textContent = entry?.[3] || 'La guía no trae descripción para este programa.';
  p.classList.toggle('muted', !entry?.[3]);
  if (next) {
    const after = document.createElement('p');
    after.className = 'epg-desc muted';
    after.textContent = `Después: ${next[2]} · ${hhmm(next[0])}`;
    box.appendChild(after);
  }
}

function logoHtml(id: string | null, cls = '', custom?: string): string {
  const url = !logosOn() ? '' : custom || (id ? state.index?.icon.get(id) : '');
  return `<span class="logo ${cls}">${icon('tv')}${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
}

/** Un canal de la guía, siempre igual: nombre, país, fuente y lo que está dando ahora.
 *  `cur` = lo que da ahora si ya se sabe (búsqueda); si no, se completa con fillEpgRows. */
function epgRowHtml(id: string, extra = '', opts: { logo?: boolean; cur?: NowPlaying | null; note?: string } = {}): string {
  const idx = state.index;
  const name = idx?.displayName.get(id) ?? id;
  const country = idx?.country.get(id);
  const source = idx?.source.get(id);
  const logo = opts.logo ?? true;
  const known = opts.cur !== undefined;
  const now = known
    ? `<div class="epg-now${opts.cur ? ' on-air' : ''}">${nowHtml(opts.cur!, id, opts.note)}</div>`
    : `<div class="epg-now" data-now-for="${esc(id)}"${opts.note ? ` data-note="${esc(opts.note)}"` : ''}><span>Cargando programación…</span></div>`;
  return `<div class="epg-row${logo ? ' with-logo' : ''}">${logo ? logoHtml(id) : ''}<div class="epg-body">`
    + `<div class="epg-head"><span class="epg-name" title="${esc(id)}${source ? ` · ${esc(source)}` : ''}">${esc(name)}${country ? ` [${esc(country.toUpperCase())}]` : ''}</span>${extra}</div>`
    + `${now}</div></div>`;
}

/** Scroll infinito: llama a `more` cada vez que el centinela entra en pantalla (también si sigue
 *  a la vista después de cargar, para llenar pantallas altas). `more` devuelve false cuando ya no
 *  queda nada. */
function infiniteScroll(sentinel: HTMLElement, more: () => boolean): () => void {
  if (!('IntersectionObserver' in window)) return () => {};
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    if (more()) { io.unobserve(sentinel); io.observe(sentinel); } // vuelve a evaluar si sigue visible
  }, { rootMargin: '400px 0px' });
  io.observe(sentinel);
  return () => { io.unobserve(sentinel); io.observe(sentinel); };
}

/** Busca en toda la guía por nombre o id del canal y por lo que está dando ahora; primero los
 *  que tienen algo en el aire. */
const SEARCH_PAGE = 50;
let searchSeq = 0;
async function renderGuideSearch(term: string, results: HTMLElement) {
  const q = fold(term.trim());
  if (q.length < 2) {
    results.hidden = true;
    results.innerHTML = '';
    return;
  }
  const seq = ++searchSeq;
  const idx = await hourIndex();
  if (seq !== searchSeq) return;
  const hits: { id: string; cur: NowPlaying | null; byProgram: boolean }[] = [];
  for (const [id, name] of state.index!.displayName) {
    const byName = fold(name).includes(q) || fold(id).includes(q);
    const cur = idx ? nowFromHour(idx, id) : null;
    const byProgram = !!cur && fold(cur.title).includes(q);
    if (byName || byProgram) hits.push({ id, cur, byProgram });
  }
  if (idx) hits.sort((a, b) => Number(!a.cur) - Number(!b.cur));
  const summary = idx
    ? `${hits.length} resultado${hits.length === 1 ? '' : 's'} · primero los que están dando algo ahora`
    : 'Programación por hora no disponible: se carga canal por canal.';
  const row = ({ id, cur, byProgram }: (typeof hits)[number]) => candidateButton(id, undefined, {
    cur: idx ? cur : undefined, note: byProgram ? '· coincide con la búsqueda' : '',
  });
  let count = Math.min(SEARCH_PAGE, hits.length);
  results.innerHTML = `<div class="list-note">${esc(summary)}</div>`
    + (hits.slice(0, count).map(row).join('') || '<div class="list-note">Sin resultados</div>')
    + '<div class="load-sentinel" aria-hidden="true"></div>';
  results.hidden = false;
  fillEpgRows(results);
  const sentinel = $('.load-sentinel', results);
  sentinel.hidden = count >= hits.length;
  infiniteScroll(sentinel, () => {
    if (seq !== searchSeq || count >= hits.length) return false;
    const next = Math.min(count + SEARCH_PAGE, hits.length);
    sentinel.insertAdjacentHTML('beforebegin', hits.slice(count, next).map(row).join(''));
    count = next;
    sentinel.hidden = count >= hits.length;
    fillEpgRows(results);
    return !sentinel.hidden;
  });
}

function wireGuideSearch(root: HTMLElement) {
  const input = $<HTMLInputElement>('.catalog-search', root);
  const results = $('.search-results', root);
  if (!input || !results) return;
  let t = 0;
  input.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(() => renderGuideSearch(input.value, results), 150);
  };
}

/** Cómo se ve la lista: filas compactas (por defecto) o tarjetas. Es una preferencia de este navegador. */
const viewMode = (): 'row' | 'card' => (pref('grilla_view', 'row') === 'card' ? 'card' : 'row');

function cardHtml(i: number): string {
  const ch = state.channels[i];
  const { edit, epg, hidden, band, suggestion, divider, auto } = info(ch);
  const shown = edit.name || stripDisplayPrefix(ch.name, state.rules!)[0];
  const sel = selection.active;
  const picked = selection.items.has(i);
  if (divider) {
    return `<article class="card section-card${hidden ? ' is-hidden' : ''}${sel ? ' selectable' : ''}${picked ? ' selected' : ''}" data-i="${i}">
      ${sel ? `<span class="sel-box" aria-hidden="true">${icon(picked ? 'square-check' : 'square')}</span>` : ''}
      <div class="card-title"><div class="section-name">${esc(sectionTitle(groupLabel(groupOf(ch))))}</div>
        <div class="card-sub"><span>Separador de sección${shown !== groupOf(ch) && shown !== groupLabel(groupOf(ch)) ? ` · ${esc(shown)}` : ''}</span>${hidden ? `<span class="pill muted">${icon('eye-off', 'sm')}Oculto</span>` : ''}</div></div>
      <button class="icon-btn ghost card-menu-btn" data-open="${i}" aria-label="Opciones del separador">${icon('ellipsis')}</button>
    </article>`;
  }
  if (viewMode() === 'row') {
    const shownName = esc(state.index?.displayName.get(suggestion?.channelId ?? '') ?? suggestion?.channelId ?? '');
    const sug = !epg && !edit.manual && suggestion;
    const sub = sug
      ? `<span class="cat sug">Sugerencia: <b>${shownName}</b> <span class="pct ${suggestion!.score >= GOOD ? 'ok' : 'warn'}">${Math.round(Math.min(suggestion!.score, 1) * 100)} %</span></span>`
      : `<span class="cat">${esc(groupLabel(groupOf(ch)))}${state.newNames.has(ch.name) ? ' · nuevo' : ''}${edit.group ? ' · movido' : ''}${hidden ? ' · oculto' : ''}</span>`
        + (epg ? `<span class="epg-now" data-now-for="${esc(epg)}" data-compact="1"></span>` : '');
    return `<article class="card row-card${hidden ? ' is-hidden' : ''}${sel ? ' selectable' : ''}${picked ? ' selected' : ''}" data-i="${i}">
      ${sel ? `<span class="sel-box" aria-hidden="true">${icon(picked ? 'square-check' : 'square')}</span>` : ''}
      ${logoHtml(epg, '', edit.customLogo)}
      <div class="card-title"><div class="card-name">${esc(shown)}</div><div class="row-sub">${sub}</div></div>
      ${sug ? `<button type="button" class="btn btn-gray sm" data-use="${i}">Usar</button>` : bandTag(band, auto?.score)}
      <button class="icon-btn ghost card-menu-btn" data-open="${i}" aria-label="Opciones del canal">${icon('ellipsis')}</button>
    </article>`;
  }
  let body: string;
  if (epg) {
    const cur = programMatch(ch, fold(state.search.trim()));
    body = epgRowHtml(epg, '', cur ? { logo: false, cur, note: '· coincide con la búsqueda' } : { logo: false });
  }
  else if (edit.manual) body = '<div class="card-note">Sin EPG, a propósito.</div>';
  else if (suggestion) {
    body = `<div class="card-note suggest"><span>Sin EPG asignado. Sugerencia: <b>${esc(state.index?.displayName.get(suggestion.channelId) ?? suggestion.channelId)}</b> <span class="pct ${suggestion.score >= GOOD ? 'ok' : 'warn'}">${Math.round(Math.min(suggestion.score, 1) * 100)} %</span></span>`
      + `<button type="button" class="btn btn-gray sm" data-use="${i}">Usar</button></div>`;
  } else body = '<div class="card-note">Sin EPG asignado.</div>';
  return `<article class="card${hidden ? ' is-hidden' : ''}${sel ? ' selectable' : ''}${picked ? ' selected' : ''}" data-i="${i}">
    <div class="card-top">
      ${sel ? `<span class="sel-box" aria-hidden="true">${icon(picked ? 'square-check' : 'square')}</span>` : ''}
      ${logoHtml(epg, 'lg', edit.customLogo)}
      <div class="card-title">
        <div class="card-name">${esc(shown)}</div>
        ${edit.name ? `<div class="card-sub">En el proveedor: ${esc(ch.name)}</div>` : ''}
        <div class="card-sub"><span>${esc(groupLabel(groupOf(ch)))}</span>${state.newNames.has(ch.name) ? `<span class="pill">${icon('sparkles', 'sm')}Nuevo</span>` : ''}${edit.group ? `<span class="pill">${icon('folder-input', 'sm')}Movido</span>` : ''}${hidden ? `<span class="pill muted">${icon('eye-off', 'sm')}Oculto</span>` : ''}</div>
      </div>
      ${bandTag(band, auto?.score)}
      <button class="icon-btn ghost card-menu-btn" data-open="${i}" aria-label="Opciones del canal">${icon('ellipsis')}</button>
    </div>
    ${body}
  </article>`;
}

function renderStatusLine() {
  const el = $('#statusLine');
  const total = state.channels.length;
  const withEpg = state.channels.filter((c) => state.cfg!.channels[c.name]?.epg).length;
  const saved = el.dataset.pending ? ' · sin conexión: se guarda cuando vuelva'
    : el.dataset.saved ? ` · guardado ${el.dataset.saved}` : '';
  el.textContent = `${total} canales · ${withEpg} con guía${saved}`;
}

let recheckGrid: () => void = () => {};
function render() {
  if (!state.cfg) return;
  headersCache = null;
  renderNewBanner();
  for (const b of $$<HTMLButtonElement>('#filterTabs button')) {
    const f = b.dataset.filter!;
    b.setAttribute('aria-pressed', String(f === state.filter));
    b.innerHTML = `${esc(b.dataset.label)}<span class="count">${state.channels.filter((c) => matchesFilter(c, f)).length}</span>`;
  }
  const list = visibleChannels();
  const cards = $('#cards');
  cards.classList.toggle('rows', viewMode() === 'row');
  $('#viewBtn').innerHTML = icon(viewMode() === 'row' ? 'layout-grid' : 'rows-3');
  $('#viewBtn').title = $('#viewBtn').ariaLabel = viewMode() === 'row' ? 'Ver como tarjetas' : 'Ver como filas';
  cards.innerHTML = list.length
    ? list.slice(0, state.shown).map(cardHtml).join('')
    : `<div class="empty">${icon('inbox', 'lg')}<strong>Nada por acá</strong>${state.channels.length ? 'Ningún canal coincide con el filtro.' : 'Volvé a cargar la lista del proveedor (Configuración).'}</div>`;
  fillEpgRows(cards);
  $('#loadMoreSentinel').hidden = list.length <= state.shown;
  recheckGrid();
  renderStatusLine();
}

// ------------------------------------------------------------------ canal: diálogo
// Fila elegible: no es un <button> porque adentro va el botón de la descripción.
function candidateButton(id: string, score?: number, opts: { cur?: NowPlaying | null; note?: string } = {}) {
  const pct = score === undefined ? '' : `<span class="pct ${score >= GOOD ? 'ok' : 'warn'}">${Math.round(Math.min(score, 1) * 100)} %</span>`;
  return `<div class="pick-row" role="button" tabindex="0" data-pick="${esc(id)}">${epgRowHtml(id, pct, opts)}</div>`;
}

/** Clicks dentro de listas de canales de la guía: la línea "Ahora" despliega la descripción;
 *  el resto de la fila elige ese EPG. Devuelve el id elegido, si hubo. */
function epgClick(ev: Event): string | null | undefined {
  const t = ev.target as HTMLElement;
  const now = t.closest<HTMLElement>('.now-btn');
  if (now) {
    toggleDesc(now);
    return undefined;
  }
  return t.closest<HTMLElement>('[data-pick]')?.dataset.pick;
}

// ------------------------------------------------------------------ ediciones de EPG
function pickEpg(e: ChannelEdit, id: string) {
  e.epg = id;
  e.manual = true;
  const logo = state.index?.icon.get(id);
  if (logo) e.logo = logo;
  else delete e.logo;
}
function autoEpg(e: ChannelEdit, ch: Channel) {
  const a = state.auto.get(ch.name);
  delete e.manual;
  e.epg = a?.cid ?? undefined;
  e.logo = a?.cid ? state.index?.icon.get(a.cid) : undefined;
}
function noEpg(e: ChannelEdit) {
  e.epg = null;
  e.manual = true;
  delete e.logo;
}
/** Aplica una edición a varios canales, guarda y vuelve a dibujar. */
function editChannels(chs: Channel[], fn: (e: ChannelEdit, ch: Channel) => void, msg?: string) {
  const before = new Map(chs.map((ch) => [ch.name, state.cfg!.channels[ch.name]]));
  for (const ch of chs) {
    const e = { ...(state.cfg!.channels[ch.name] ?? {}) };
    fn(e, ch);
    setEdit(ch.name, e);
  }
  scheduleSave();
  render();
  if (msg) {
    toast(msg, 'ok', 3500, () => {
      for (const [name, e] of before) {
        if (e) state.cfg!.channels[name] = e;
        else delete state.cfg!.channels[name];
      }
      scheduleSave();
      render();
      toast('Cambio deshecho', 'info');
    });
  }
}

/** Cambia las categorías (orden, ocultas, sin guía) con "Deshacer". */
function editGroups(fn: (g: Config['groups']) => void, msg?: string) {
  const before = structuredClone(state.cfg!.groups);
  fn(state.cfg!.groups);
  scheduleSave();
  render();
  if (($('#categoriesDialog') as HTMLDialogElement).open) renderCategories();
  if (msg) {
    toast(msg, 'ok', 3500, () => {
      state.cfg!.groups = before;
      scheduleSave();
      render();
      renderCategories();
      toast('Cambio deshecho', 'info');
    });
  }
}

/** Lo que da el canal desde ahora hasta el final de la ventana publicada (~30 h), por día. */
async function toggleDay(root: HTMLElement, id: string) {
  const btn = $<HTMLElement>('.day-btn', root);
  const box = $('.day-list', root);
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open || box.dataset.loaded) return;
  box.innerHTML = '<div class="list-note">Cargando programación…</div>';
  const now = Date.now() / 1000;
  const entries = ((await schedule(id)) ?? []).filter(([, stop]) => stop > now);
  box.dataset.loaded = '1';
  if (!entries.length) {
    box.innerHTML = '<div class="list-note">La guía no trae programación para las próximas horas.</div>';
    return;
  }
  const dayName = (sec: number) => {
    const d = new Date(sec * 1000);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    if (d.toDateString() === today.toDateString()) return 'Hoy';
    if (d.toDateString() === tomorrow.toDateString()) return 'Mañana';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric' });
  };
  let last = '';
  box.innerHTML = entries.map(([start, stop, title, desc]) => {
    const day = dayName(start);
    const head = day !== last ? `<div class="day-head">${esc(day)}</div>` : '';
    last = day;
    const live = start <= now && now < stop;
    return `${head}<details class="day-item${live ? ' live' : ''}"><summary><span class="day-time">${hhmm(start)}</span>`
      + `<span class="day-title">${esc(title)}${live ? ' <span class="note">· ahora</span>' : ''}</span></summary>`
      + `<p>${desc ? esc(desc) : '<span class="muted">Sin descripción.</span>'}</p></details>`;
  }).join('');
}

/** La hoja de un canal (o de un separador de sección), todo junto y con íconos: la guía asignada
 *  con su programación, la búsqueda de otra guía (con volver al automático y dejar sin guía) y,
 *  abajo, nombre, categoría y logo. Mostrar u ocultar es el ojo del título. */
function openChannel(i: number) {
  const ch = state.channels[i];
  const { edit, auto, epg, hidden, divider, suggestion } = info(ch);
  const dlg = $('#channelDialog') as HTMLDialogElement;
  const body = $('#channelBody');
  const defaultName = stripDisplayPrefix(ch.name, state.rules!)[0];
  const categoryLabel = groupLabel(groupOf(ch));
  $('#channelTitle').textContent = divider ? sectionTitle(categoryLabel) : edit.name || ch.name;
  const catHidden = hidden && !edit.hidden;
  const visBtn = $<HTMLButtonElement>('#channelVis');
  visBtn.innerHTML = icon(edit.hidden || catHidden ? 'eye-off' : 'eye');
  visBtn.disabled = catHidden;
  visBtn.title = visBtn.ariaLabel = catHidden ? 'Oculto porque su categoría está oculta' : edit.hidden ? 'Oculto: tocá para mostrarlo' : 'Visible: tocá para ocultarlo';
  const ranked = (auto?.ranked ?? []).filter((c) => c.channelId !== edit.epg);
  const categories = groups().filter((g) => g === groupOf(ch) || !headersNow().has(g));

  const fields = `
    <div class="ch-fields">
      <label class="ch-field" title="Nombre en la playlist">${icon('text-cursor-input')}
        <input class="input rename" value="${esc(edit.name ?? '')}" placeholder="${esc(divider ? sectionTitle(defaultName) : defaultName)}" aria-label="Nombre en la playlist">
        <button type="button" class="icon-btn" data-act="rename" aria-label="Guardar nombre">${icon('check')}</button></label>
      <label class="ch-field" title="Categoría">${icon('folder-input')}
        <select class="select move" aria-label="Categoría">${categories
    .map((g) => `<option value="${esc(g)}"${g === groupOf(ch) ? ' selected' : ''}>${esc(headersNow().has(g) ? sectionTitle(groupLabel(g)) : groupLabel(g))}</option>`).join('')}
          <option value="__new__">Nueva categoría…</option></select></label>
      ${divider ? '' : `<label class="ch-field" title="Logo propio">${icon('image')}
        <input class="input custom-logo" type="url" inputmode="url" value="${esc(edit.customLogo ?? '')}" placeholder="Logo propio: https://…/logo.png" aria-label="URL del logo propio">
        <button type="button" class="icon-btn" data-act="logo" aria-label="Guardar logo">${icon('check')}</button></label>`}
    </div>`;

  if (divider) {
    body.innerHTML = `<p class="help">Separador de sección del proveedor: no es un canal y no lleva guía.</p>${fields}`;
  } else {
    const pct = !edit.manual && auto?.cid === edit.epg && auto
      ? `<span class="pct ${auto.score >= GOOD ? 'ok' : 'warn'}">${Math.round(Math.min(auto.score, 1) * 100)} %</span>` : '';
    const mine = edit.manual && edit.epg ? `<span class="tag manual with-icon" title="Elegida por vos">${icon('user-check', 'sm')}</span>` : '';
    const dayBtn = epg ? `<button type="button" class="icon-btn day-btn" data-act="day" aria-expanded="false" aria-label="Programación de hoy y mañana" title="Programación de hoy y mañana">${icon('calendar')}</button>` : '';
    const summary = epg
      ? epgRowHtml(epg, `<span class="ch-extras">${pct}${mine}${dayBtn}</span>`)
      : `<div class="card-note">${edit.manual ? 'Sin guía, a propósito.' : 'Sin guía asignada.'}${
        suggestion ? ` Sugerencia: <b>${esc(state.index?.displayName.get(suggestion.channelId) ?? suggestion.channelId)}</b>` : ''}</div>`;
    body.innerHTML = `<div class="ch-current">${summary}<div class="day-list" hidden></div></div>
      <div class="ch-search">
        <label class="search-field">${icon('search')}<input type="search" class="catalog-search" placeholder="Buscar otra guía: canal o programa" enterkeyhint="search" aria-label="Buscar otra guía"></label>
        <button type="button" class="icon-btn" data-act="auto" title="Volver a la guía automática" aria-label="Volver a la guía automática"${edit.manual ? '' : ' disabled'}>${icon('undo-2')}</button>
        <button type="button" class="icon-btn" data-act="no-epg" title="Dejar sin guía" aria-label="Dejar sin guía"${epg || !edit.manual ? '' : ' disabled'}>${icon('ban')}</button>
      </div>
      <div class="list search-results" hidden></div>
      ${ranked.length ? `<div class="list alts">${ranked.slice(0, 5).map((c) => candidateButton(c.channelId, c.score)).join('')}</div>` : ''}
      ${fields}`;
  }

  const update = (fn: (e: ChannelEdit) => void, msg?: string) => editChannels([ch], fn, msg);
  const again = () => openChannel(i);
  visBtn.onclick = () => {
    update((e) => { e.hidden = e.hidden ? undefined : true; }, edit.hidden ? 'Visible' : 'Oculto');
    again();
  };
  const saveName = () => {
    const v = $<HTMLInputElement>('.rename', body).value.trim();
    update((e) => { e.name = v && v !== defaultName ? v : undefined; }, v ? 'Nombre guardado' : 'Vuelve al nombre del proveedor');
    again();
  };
  body.onclick = (ev) => {
    const picked = epgClick(ev);
    if (picked) {
      dlg.close();
      update((e) => pickEpg(e, picked), 'Guía elegida');
      return;
    }
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'auto') {
      update((e) => autoEpg(e, ch), 'Volvió a la guía automática');
      again();
    } else if (act === 'no-epg') {
      update(noEpg, 'Quedó sin guía');
      again();
    } else if (act === 'rename') {
      saveName();
    } else if (act === 'day') {
      toggleDay(body, edit.epg!);
    } else if (act === 'logo') {
      const v = $<HTMLInputElement>('.custom-logo', body).value.trim();
      if (v && !/^https?:\/\/\S+$/i.test(v)) {
        toast('Tiene que ser una dirección http:// o https://', 'bad');
        return;
      }
      update((e) => { e.customLogo = v || undefined; }, v ? 'Logo guardado' : 'Vuelve al logo de la guía');
      again();
    }
  };
  body.onkeydown = (ev) => {
    const el = ev.target as HTMLElement;
    if (ev.key !== 'Enter') return;
    if (el.matches('[data-pick]')) el.click();
    else if (el.matches('.rename')) saveName();
  };
  if (!divider) wireGuideSearch(body);
  fillEpgRows(body);
  const move = $<HTMLSelectElement>('.move', body);
  move.onchange = async () => {
    let target = move.value;
    if (target === '__new__') {
      target = (await newCategoryName()) ?? '';
      if (!target) {
        move.value = groupOf(ch);
        return;
      }
    }
    update((e) => { e.group = target === ch.category ? undefined : target; }, `Movido a ${target}`);
  };
  if (!dlg.open) dlg.showModal();
}

// ------------------------------------------------------------------ selección múltiple
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function setSelectMode(on: boolean, first?: number) {
  selection.active = on;
  selection.items.clear();
  if (on && first !== undefined) selection.items.add(first);
  document.body.classList.toggle('selecting', on);
  $('#selectBtn').setAttribute('aria-pressed', String(on));
  $('#bulkBar').hidden = !on;
  render();
  updateBulkBar();
}

function updateBulkBar() {
  const n = selection.items.size;
  $('#bulkCount').textContent = n ? plural(n, 'seleccionado', 'seleccionados') : 'Tocá los canales';
  $<HTMLButtonElement>('#bulkActions').disabled = !n;
  const list = visibleChannels();
  $('#bulkAll').textContent = list.length && list.every((i) => selection.items.has(i)) ? 'Ninguno' : 'Todos';
}

function toggleSelected(i: number) {
  if (selection.items.has(i)) selection.items.delete(i);
  else selection.items.add(i);
  const card = $(`.card[data-i="${i}"]`);
  if (card) {
    const on = selection.items.has(i);
    card.classList.toggle('selected', on);
    const box = $('.sel-box', card);
    if (box) box.innerHTML = icon(on ? 'square-check' : 'square');
  }
  updateBulkBar();
}

function menuRowHtml(iconName: string, label: string, sub: string, action: string, cls = '') {
  return `<button type="button" class="menu-row ${cls}" data-action="${action}"><span class="menu-icon">${icon(iconName)}</span>`
    + `<span class="menu-text">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
}

/** Aplica a los seleccionados y sale del modo selección. */
function applyBulk(fn: (e: ChannelEdit, ch: Channel) => void, msg: string) {
  const chs = [...selection.items].map((i) => state.channels[i]);
  editChannels(chs, fn, msg);
  setSelectMode(false);
}

function openBulkMenu() {
  const chs = [...selection.items].map((i) => state.channels[i]);
  const n = chs.length;
  const cfg = state.cfg!;
  $('#bulkTitle').textContent = plural(n, 'canal seleccionado', 'canales seleccionados');
  const rows = [
    menuRowHtml('pencil', 'Cambiar EPG', `El mismo para ${plural(n, 'canal', 'canales')}`, 'epg'),
    menuRowHtml('folder-input', 'Mover de categoría', 'Todos a la misma categoría', 'category'),
    menuRowHtml('eye-off', 'Ocultar de la playlist', '', 'hide'),
    menuRowHtml('eye', 'Mostrar en la playlist', '', 'show'),
  ];
  const undo: string[] = [];
  if (chs.some((ch) => cfg.channels[ch.name]?.manual)) undo.push(menuRowHtml('undo-2', 'Volver al EPG automático', 'Descarta los EPG elegidos a mano', 'auto'));
  if (chs.some((ch) => cfg.channels[ch.name]?.name)) undo.push(menuRowHtml('rotate-ccw', 'Restaurar nombres originales', '', 'names'));
  if (chs.some((ch) => cfg.channels[ch.name]?.group)) undo.push(menuRowHtml('folder-input', 'Volver a la categoría original', '', 'orig-cat'));
  undo.push(menuRowHtml('ban', 'Dejar sin EPG', 'Para cuando ninguna guía sirve', 'no-epg', 'danger'));
  const body = $('#bulkBody');
  body.innerHTML = `<div class="menu">${rows.join('')}</div><div class="menu">${undo.join('')}</div>`;
  const dialog = $('#bulkDialog') as HTMLDialogElement;
  body.onclick = (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    dialog.close();
    switch (action) {
      case 'epg': openBulkEpg(chs); break;
      case 'category': openBulkCategory(chs); break;
      case 'hide': applyBulk((e) => { e.hidden = true; }, `${plural(n, 'canal oculto', 'canales ocultos')} de la playlist`); break;
      case 'show': applyBulk((e) => { delete e.hidden; }, `${plural(n, 'canal visible', 'canales visibles')} en la playlist`); break;
      case 'auto': applyBulk(autoEpg, `${plural(n, 'canal vuelve', 'canales vuelven')} al EPG automático`); break;
      case 'names': applyBulk((e) => { delete e.name; }, 'Nombres originales restaurados'); break;
      case 'orig-cat': applyBulk((e) => { delete e.group; }, 'Categorías originales restauradas'); break;
      case 'no-epg':
        confirmDialog({
          title: `¿Dejar ${plural(n, 'canal', 'canales')} sin EPG?`,
          text: 'No se les asigna guía ni logo, ni siquiera automáticamente. Se puede deshacer.',
          ok: 'Dejar sin EPG', danger: true,
        }).then((yes) => { if (yes) applyBulk(noEpg, `${plural(n, 'canal', 'canales')} sin EPG a propósito`); });
        break;
      default: break;
    }
  };
  dialog.showModal();
}

// EPG para todos: primero las opciones que más se repiten entre los seleccionados (su EPG
// actual y sus alternativas), después la búsqueda en toda la guía.
function openBulkEpg(chs: Channel[]) {
  const score = new Map<string, number>();
  for (const ch of chs) {
    const cur = state.cfg!.channels[ch.name]?.epg;
    const ids = [...(cur ? [cur] : []), ...(state.auto.get(ch.name)?.ranked ?? []).map((c) => c.channelId)];
    for (const id of new Set(ids)) score.set(id, (score.get(id) ?? 0) + 1);
  }
  const suggestions = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('#bulkEpgTitle').textContent = `EPG para ${plural(chs.length, 'canal', 'canales')}`;
  const body = $('#bulkEpgBody');
  body.innerHTML = `
    ${suggestions.length ? `<div class="section-label">Sugerencias</div><div class="list">${suggestions.map(([id, count]) => candidateButton(id, undefined, {
      note: count > 1 ? `· opción de ${count} de ${chs.length}` : '',
    })).join('')}</div>` : ''}
    <div class="section-label">Buscar en toda la guía</div>
    <label class="search-field">${icon('search')}<input type="search" class="catalog-search" placeholder="Canal o programa que está dando ahora" enterkeyhint="search"></label>
    <div class="list search-results" hidden></div>`;
  const dialog = $('#bulkEpgDialog') as HTMLDialogElement;
  body.onclick = (ev) => {
    const picked = epgClick(ev);
    if (!picked) return;
    dialog.close();
    applyBulk((e, ch) => { if (!info(ch).divider) pickEpg(e, picked); }, `EPG elegido para ${plural(chs.length, 'canal', 'canales')}`);
  };
  wireGuideSearch(body);
  fillEpgRows(body);
  dialog.showModal();
}

function openBulkCategory(chs: Channel[]) {
  $('#bulkTitle').textContent = `Mover ${plural(chs.length, 'canal', 'canales')}`;
  const body = $('#bulkBody');
  body.innerHTML = `<select class="select bulk-cat" aria-label="Categoría destino">
      <option value="" selected disabled>Elegí la categoría…</option>
      ${groups().filter((g) => !headersNow().has(g)).map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('')}<option value="__new__">Nueva categoría…</option>
    </select>
    <div class="row-actions"><button type="button" class="btn btn-primary bulk-move" disabled>Mover</button></div>`;
  body.onclick = null;
  const select = $<HTMLSelectElement>('.bulk-cat', body);
  const move = $<HTMLButtonElement>('.bulk-move', body);
  select.onchange = () => { move.disabled = !select.value; };
  const dialog = $('#bulkDialog') as HTMLDialogElement;
  move.onclick = async () => {
    let dest = select.value;
    if (dest === '__new__') dest = (await newCategoryName()) ?? '';
    if (!dest) return;
    dialog.close();
    applyBulk((e, ch) => { e.group = dest === ch.category ? undefined : dest; },
      `${plural(chs.length, 'canal movido', 'canales movidos')} a ${dest}`);
  };
  dialog.showModal();
}

// ------------------------------------------------------------------ categorías
// Separador de sección del proveedor ("▆▆▆ DEPORTES ▆▆▆"): una categoría decorativa, o una con
// un solo canal que se llama igual (así quedan los separadores importados de GitHub).
const DIVIDER_RE = /[\u2580-\u259F]{2,}/;
let headersCache: Set<string> | null = null;
/** sectionHeaders() de esta pasada de dibujo (render() y editGroups lo invalidan). */
const headersNow = () => (headersCache ??= sectionHeaders());
function sectionHeaders(): Set<string> {
  const members = new Map<string, Channel[]>();
  for (const ch of state.channels) {
    const g = groupOf(ch);
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(ch);
  }
  const out = new Set<string>(state.cfg!.groups.separators ?? []);
  for (const [g, chs] of members) {
    const only = chs.length === 1 ? (state.cfg!.channels[chs[0].name]?.name || chs[0].name) : null;
    if (DIVIDER_RE.test(g) || only === g) out.add(g);
  }
  return out;
}
/** Nombre legible de una sección: sin la decoración y con los caracteres anchos normales. */
const sectionTitle = (g: string) => g.replace(/[\u2580-\u259F]+/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim() || g;

// Secciones plegadas en Categorías (se recuerda por configuración en este navegador).
const COLLAPSED_KEY = (cfgId: string) => `grilla_cat_collapsed_${cfgId}`;
function collapsedSections(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY(state.local?.cfgId ?? '')) || '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY(state.local?.cfgId ?? ''), JSON.stringify([...set]));
  } catch { /* sin storage */ }
}

function renderCategories() {
  const list = groups();
  const hidden = new Set(state.cfg!.groups.hidden);
  const noEpg = new Set(state.cfg!.groups.noEpg ?? []);
  const headers = sectionHeaders();
  const collapsed = collapsedSections();
  const counts = new Map<string, number>();
  for (const ch of state.channels) counts.set(groupOf(ch), (counts.get(groupOf(ch)) ?? 0) + 1);
  const q = fold($<HTMLInputElement>('#categoriesFilter').value.trim());
  // Categorías que tiene cada sección (hasta la siguiente), y a qué sección pertenece cada una.
  const owner = new Map<string, string>();
  const size = new Map<string, number>();
  let current = '';
  for (const g of list) {
    if (headers.has(g)) {
      current = g;
      size.set(g, 0);
    } else if (current) {
      owner.set(g, current);
      size.set(current, (size.get(current) ?? 0) + 1);
    }
  }
  // Con un filtro el orden no se puede arrastrar (se movería entre categorías que no se ven).
  const rows = list.map((g, i) => ({ g, i })).filter(({ g }) => !q || fold(`${groupLabel(g)} ${g}`).includes(q));
  const folded = (g: string) => !q && !headers.has(g) && collapsed.has(owner.get(g) ?? '\u0000');
  const flags = (g: string) => (state.newGroups.has(g) ? ' · nueva' : '') + (noEpg.has(g) ? ' · sin guía' : '') + (hidden.has(g) ? ' · oculta' : '');
  const more = (g: string, i: number) => `<button type="button" class="icon-btn" data-more="${i}" aria-haspopup="dialog" aria-label="Más opciones de ${esc(sectionTitle(groupLabel(g)))}">${icon('ellipsis')}</button>`;
  const eye = (g: string, i: number) => `<button type="button" class="icon-btn vis-btn${hidden.has(g) ? ' off' : ''}" data-vis="${i}" aria-pressed="${!hidden.has(g)}" title="${hidden.has(g) ? 'Oculta: tocá para mostrarla' : 'Visible: tocá para ocultarla'}" aria-label="${hidden.has(g) ? 'Mostrar' : 'Ocultar'} ${esc(sectionTitle(groupLabel(g)))}">${icon(hidden.has(g) ? 'eye-off' : 'eye')}</button>`;
  $('#categoriesList').innerHTML = rows.map(({ g, i }) => headers.has(g) ? `
    <div class="menu-row static cat-row section-row${hidden.has(g) ? ' is-off' : ''}" data-g="${i}">
      ${q ? '' : `<button type="button" class="drag-handle" aria-label="Mover la sección ${esc(sectionTitle(groupLabel(g)))}" title="Arrastrá para cambiar el orden">${icon('grip-vertical')}</button>`}
      <button type="button" class="icon-btn sm fold-btn" data-fold="${i}" aria-expanded="${!collapsed.has(g)}" aria-label="${collapsed.has(g) ? 'Expandir' : 'Contraer'} la sección ${esc(sectionTitle(groupLabel(g)))}">${icon(collapsed.has(g) ? 'chevron-right' : 'chevron-down')}</button>
      <span class="menu-text"><span class="section-name">${esc(sectionTitle(groupLabel(g)))}</span><small>${plural(size.get(g) ?? 0, 'categoría', 'categorías')}${flags(g)}</small></span>
      ${eye(g, i)}
      ${more(g, i)}
    </div>` : `
    <div class="menu-row static cat-row${hidden.has(g) ? ' is-off' : ''}" data-g="${i}"${folded(g) ? ' hidden' : ''}>
      ${q ? '' : `<button type="button" class="drag-handle" aria-label="Mover ${esc(groupLabel(g))} (arrastrá, o flechas del teclado)" title="Arrastrá para cambiar el orden">${icon('grip-vertical')}</button>`}
      <span class="menu-text">${esc(groupLabel(g))}<small>${plural(counts.get(g) ?? 0, 'canal', 'canales')}${flags(g)}</small></span>
      ${eye(g, i)}
      ${more(g, i)}
    </div>`).join('') || '<p class="help">Ninguna categoría coincide.</p>';
  // Contraer o expandir todas las secciones, según lo que haya.
  const sections = list.filter((g) => headers.has(g) && (size.get(g) ?? 0) > 0);
  const allFolded = sections.length > 0 && sections.every((g) => collapsed.has(g));
  const toggle = $('#foldAllBtn');
  toggle.hidden = !sections.length;
  toggle.innerHTML = icon(allFolded ? 'chevrons-up-down' : 'chevrons-down-up');
  toggle.setAttribute('aria-label', allFolded ? 'Expandir todas las secciones' : 'Contraer todas las secciones');
  toggle.title = toggle.getAttribute('aria-label')!;
  toggle.dataset.mode = allFolded ? 'expand' : 'collapse';
}

/** La hoja "…" de una categoría o sección, con el mismo patrón que la del canal: el ojo junto al
 *  título, el nombre con su ícono y las demás acciones como filas con ícono. */
function openCategoryMenu(i: number) {
  const g = groups()[i];
  const isSection = sectionHeaders().has(g);
  const noEpg = !!state.cfg!.groups.noEpg?.includes(g);
  const hidden = state.cfg!.groups.hidden.includes(g);
  const mine = new Set([...(state.cfg!.groups.custom ?? []), ...(state.cfg!.groups.separators ?? [])]);
  const empty = !state.channels.some((ch) => groupOf(ch) === g);
  const dlg = $('#catMenuDialog') as HTMLDialogElement;
  dlg.dataset.g = String(i);
  const label = isSection ? sectionTitle(groupLabel(g)) : groupLabel(g);
  $('#catMenuTitle').textContent = label;
  const eye = $<HTMLButtonElement>('#catMenuVis');
  eye.innerHTML = icon(hidden ? 'eye-off' : 'eye');
  eye.title = eye.ariaLabel = hidden ? 'Oculta: tocá para mostrarla' : 'Visible: tocá para ocultarla';
  const row = (iconName: string, text: string, action: string, cls = '') =>
    `<button type="button" class="menu-row ${cls}" data-action="${action}"><span class="menu-icon">${icon(iconName)}</span><span class="menu-text">${esc(text)}</span>${cls.includes('on') ? icon('check') : ''}</button>`;
  const rows = [
    !isSection ? row('list-ordered', 'Ordenar los canales', 'order') : '',
    !isSection ? row('ban', 'Sin guía', 'noepg', noEpg ? 'on' : '') : '',
    state.cfg!.groups.rename?.[g] ? row('rotate-ccw', 'Volver al nombre original', 'unrename') : '',
    mine.has(g) && empty ? row('trash-2', 'Borrar', 'delete', 'danger') : '',
  ].join('');
  $('#catMenuBody').innerHTML = `
    <div class="ch-fields first"><label class="ch-field" title="Nombre en la playlist">${icon('text-cursor-input')}
      <input class="input cat-name" value="${esc(state.cfg!.groups.rename?.[g] ? label : '')}" placeholder="${esc(isSection ? sectionTitle(g) : g)}" aria-label="Nombre en la playlist">
      <button type="button" class="icon-btn" data-action="rename" aria-label="Guardar nombre">${icon('check')}</button></label></div>
    ${rows ? `<div class="menu">${rows}</div>` : ''}`;
  if (!dlg.open) dlg.showModal();
}

/** Crea una categoría o un separador de sección propio: queda al final, para arrastrarlo a su lugar. */
async function createGroup(kind: 'category' | 'separator') {
  const sep = kind === 'separator';
  const name = await promptDialog({
    title: sep ? 'Sección nueva' : 'Categoría nueva',
    ok: 'Crear', icon: sep ? 'separator-horizontal' : 'folder-plus',
    input: { label: 'Nombre', placeholder: sep ? 'Nombre de la sección (ej.: DEPORTES)' : 'Nombre de la categoría' },
  });
  if (!name) return;
  const taken = new Set([...groups(), ...groups().map(groupLabel)]);
  if (taken.has(name)) {
    toast(`Ya hay una categoría o sección "${name}"`, 'bad');
    return;
  }
  const base = groups();
  editGroups((gr) => {
    const key = sep ? 'separators' : 'custom';
    gr[key] = [...(gr[key] ?? []), name];
    gr.order = [...base, name];
  }, `${sep ? 'Sección' : 'Categoría'} "${name}" creada al final: arrastrala a su lugar`);
  const scroller = $('#categoriesDialog .sheet-body');
  requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

/** Cambia el nombre con el que sale en la playlist (vacío o igual al del proveedor = el original). */
function applyRename(g: string, value: string) {
  const sep = sectionHeaders().has(g);
  const next = value.trim();
  if (!next || next === g || (sep && next === sectionTitle(g))) {
    if (state.cfg!.groups.rename?.[g]) unrenameGroup(g);
    return;
  }
  if (next === groupLabel(g) || (sep && next === sectionTitle(groupLabel(g)))) return;
  editGroups((gr) => {
    const rename = { ...(gr.rename ?? {}) };
    rename[g] = next;
    gr.rename = rename;
  }, `Nombre cambiado a "${next}"`);
}

function unrenameGroup(g: string) {
  editGroups((gr) => {
    const rename = { ...(gr.rename ?? {}) };
    delete rename[g];
    gr.rename = rename;
  }, `Vuelve a llamarse "${g}"`);
}

/** Borra una categoría o separador creado a mano (una categoría con canales no se borra). */
function deleteGroup(g: string) {
  editGroups((gr) => {
    const without = (l?: string[]) => (l ?? []).filter((x) => x !== g);
    gr.custom = without(gr.custom);
    gr.separators = without(gr.separators);
    gr.order = without(gr.order);
    gr.hidden = without(gr.hidden);
    gr.noEpg = without(gr.noEpg);
    for (const k of ['rename', 'channels'] as const) {
      if (gr[k]) {
        const copy = { ...gr[k] } as Record<string, unknown>;
        delete copy[g];
        (gr as Record<string, unknown>)[k] = copy;
      }
    }
  }, `"${groupLabel(g)}" borrada`);
}

/** Un separador que se mueve solo, sin arrastrar las categorías que le siguen: los que creó la
 *  persona (son una marca de dónde empieza su sección) y los que no tienen categorías propias. */
function isLoneHeader(list: string[], i: number, headers: Set<string>): boolean {
  return headers.has(list[i])
    && (!!state.cfg!.groups.separators?.includes(list[i]) || i + 1 >= list.length || headers.has(list[i + 1]));
}

/** Mueve la categoría `from` a la posición `to` (índices de groups()). Una sección se mueve
 *  entera (el separador y sus categorías) y cae antes o después de otra sección, sin partirla. */
function moveGroup(from: number, to: number) {
  if (from === to) return;
  const list = groups();
  const headers = sectionHeaders();
  // Un separador propio cae justo donde se lo suelta, y desde ahí abre una sección nueva.
  if (!headers.has(list[from]) || isLoneHeader(list, from, headers)) {
    const [g] = list.splice(from, 1);
    list.splice(to, 0, g);
    editGroups((gr) => { gr.order = list; }, `${groupLabel(g)} movida`);
    return;
  }
  const end = (i: number) => {
    let j = i + 1;
    while (j < list.length && !headers.has(list[j])) j++;
    return j;
  };
  const start = (i: number) => {
    let j = i;
    while (j > 0 && !headers.has(list[j])) j--;
    return j;
  };
  const block = list.slice(from, end(from));
  const rest = [...list.slice(0, from), ...list.slice(end(from))];
  // Destino en la lista sin el bloque: antes de la sección donde cae (subiendo) o después (bajando).
  const target = to < from ? start(to) : end(to) - block.length;
  rest.splice(Math.max(0, Math.min(target, rest.length)), 0, ...block);
  editGroups((gr) => { gr.order = rest; }, `Sección ${sectionTitle(groupLabel(list[from]))} movida`);
}

/** Arrastrar desde la manija (mouse o dedo): la fila sigue al puntero y las demás se corren. */
/** Arrastrar filas desde su manija (mouse o dedo) y moverlas con las flechas del teclado.
 *  `drop(desde, hasta)` recibe las filas; `key(fila, arriba)` el movimiento por teclado. */
function setupDrag(box: HTMLElement, rowSel: string, drop: (from: HTMLElement, to: HTMLElement) => void,
  key: (row: HTMLElement, up: boolean) => void) {
  box.addEventListener('pointerdown', (ev) => {
    const handle = (ev.target as HTMLElement).closest<HTMLElement>('.drag-handle');
    if (!handle || ev.button !== 0) return;
    ev.preventDefault();
    const row = handle.closest<HTMLElement>(rowSel)!;
    const rows = $$<HTMLElement>(rowSel, box);
    const from = rows.indexOf(row);
    const tops = rows.map((r) => r.getBoundingClientRect());
    const height = tops[from].height;
    const scroller = box.closest<HTMLElement>('.sheet-body') ?? box;
    const startScroll = scroller.scrollTop;
    const startY = ev.clientY;
    let to = from;
    let lastY = ev.clientY;
    let raf = 0;
    handle.setPointerCapture(ev.pointerId);
    row.classList.add('dragging');
    box.classList.add('sorting');

    const layout = () => {
      const dy = lastY - startY + (scroller.scrollTop - startScroll);
      row.style.transform = `translateY(${dy}px)`;
      const center = tops[from].top + height / 2 + dy;
      to = from;
      for (let k = 0; k < rows.length; k++) {
        const mid = tops[k].top + tops[k].height / 2;
        if (k < from && center < mid) { to = k; break; }
        if (k > from && center > mid) to = k;
      }
      rows.forEach((r, k) => {
        if (k === from) return;
        const shift = from < to && k > from && k <= to ? -height : to < from && k >= to && k < from ? height : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    // Cerca del borde de la hoja, se desplaza sola para poder llevarla lejos.
    const autoScroll = () => {
      const box2 = scroller.getBoundingClientRect();
      const edge = 60;
      const v = lastY < box2.top + edge ? -(box2.top + edge - lastY) / 4 : lastY > box2.bottom - edge ? (lastY - (box2.bottom - edge)) / 4 : 0;
      if (v) {
        scroller.scrollTop += v;
        layout();
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);
    const move = (e: PointerEvent) => {
      lastY = e.clientY;
      layout();
    };
    const end = () => {
      cancelAnimationFrame(raf);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      rows.forEach((r) => { r.style.transform = ''; });
      row.classList.remove('dragging');
      box.classList.remove('sorting');
      if (from !== to) drop(rows[from], rows[to]);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  // Teclado: flechas sobre la manija.
  box.addEventListener('keydown', (ev) => {
    const handle = (ev.target as HTMLElement).closest<HTMLElement>('.drag-handle');
    if (!handle || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    key(handle.closest<HTMLElement>(rowSel)!, ev.key === 'ArrowUp');
  });
}

function setupCategoryDrag(box: HTMLElement) {
  setupDrag(box, '.cat-row:not([hidden])', (from, to) => moveGroup(Number(from.dataset.g), Number(to.dataset.g)), (row, up) => {
    const i = Number(row.dataset.g);
    const list = groups();
    const headers = sectionHeaders();
    let j = i + (up ? -1 : 1);
    // Una sección baja saltando la siguiente entera.
    if (!up && headers.has(list[i]) && !isLoneHeader(list, i, headers)) while (j < list.length && !headers.has(list[j])) j++;
    if (j < 0 || j >= list.length) return;
    const moved = list[i];
    moveGroup(i, j);
    const k = groups().indexOf(moved);
    $<HTMLElement>(`.cat-row[data-g="${k}"] .drag-handle`, box)?.focus();
  });
}

// ------------------------------------------------------------------ orden de canales
/** Canales de una categoría en el orden de la playlist (el propio primero). */
function groupChannels(g: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  state.channels.map((ch, i) => i).filter((i) => groupOf(state.channels[i]) === g)
    .sort((a, b) => withinPos(a) - withinPos(b))
    .forEach((i) => {
      const n = state.channels[i].name;
      if (!seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    });
  return names;
}

function renderChannelOrder(g: string) {
  const names = groupChannels(g);
  const custom = !!state.cfg!.groups.channels?.[g];
  $('#orderTitle').textContent = groupLabel(g);
  $('#orderBody').innerHTML = `
    <p class="help">Arrastrá desde <span class="inline-icon">${icon('grip-vertical')}</span> para ordenar los canales de esta categoría en la playlist. Los canales nuevos del proveedor van al final.</p>
    <div class="menu" id="orderList">${names.map((n, k) => {
      const shown = state.cfg!.channels[n]?.name || stripDisplayPrefix(n, state.rules!)[0];
      return `<div class="menu-row static ord-row" data-k="${k}">
        <button type="button" class="drag-handle" aria-label="Mover ${esc(shown)}">${icon('grip-vertical')}</button>
        <span class="menu-text">${esc(shown)}</span></div>`;
    }).join('')}</div>
    ${custom ? '<div class="row-actions"><button type="button" class="btn btn-plain" data-reset-order>Volver al orden del proveedor</button></div>' : ''}`;
}

function setChannelOrder(g: string, names: string[] | null, msg: string) {
  editGroups((gr) => {
    const all = { ...(gr.channels ?? {}) };
    if (names) all[g] = names;
    else delete all[g];
    gr.channels = all;
  }, msg);
  renderChannelOrder(g);
}

function openChannelOrder(g: string) {
  renderChannelOrder(g);
  const dlg = $('#orderDialog') as HTMLDialogElement;
  dlg.dataset.group = g;
  dlg.showModal();
}

function setupChannelOrder() {
  const body = $('#orderBody');
  const move = (from: number, to: number) => {
    const g = ($('#orderDialog') as HTMLDialogElement).dataset.group!;
    const names = groupChannels(g);
    const [n] = names.splice(from, 1);
    names.splice(to, 0, n);
    setChannelOrder(g, names, 'Orden de canales guardado');
    $<HTMLElement>(`.ord-row[data-k="${to}"] .drag-handle`, body)?.focus();
  };
  setupDrag(body, '.ord-row', (a, b) => move(Number(a.dataset.k), Number(b.dataset.k)), (row, up) => {
    const k = Number(row.dataset.k);
    const j = k + (up ? -1 : 1);
    if (j >= 0 && j < $$('.ord-row', body).length) move(k, j);
  });
  body.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('[data-reset-order]')) return;
    const g = ($('#orderDialog') as HTMLDialogElement).dataset.group!;
    setChannelOrder(g, null, 'Vuelve al orden del proveedor');
  });
}

function setupCategories() {
  const box = $('#categoriesList');
  setupCategoryDrag(box);
  $<HTMLInputElement>('#categoriesFilter').oninput = () => renderCategories();
  $('#newCategoryBtn').onclick = () => createGroup('category');
  $('#newSectionBtn').onclick = () => createGroup('separator');
  $('#categoriesHelpBtn').onclick = () => {
    const help = $('#helpDialog') as HTMLDialogElement;
    for (const d of $$<HTMLDetailsElement>('details', help)) d.open = d.id === 'helpCategories';
    help.showModal();
    $('#helpCategories').scrollIntoView({ block: 'start' });
  };
  $('#foldAllBtn').onclick = () => {
    const headers = sectionHeaders();
    const list = groups();
    const withMembers = list.filter((g, i) => headers.has(g) && i + 1 < list.length && !headers.has(list[i + 1]));
    saveCollapsed($('#foldAllBtn').dataset.mode === 'collapse' ? new Set(withMembers) : new Set());
    renderCategories();
  };
  box.onclick = (ev) => {
    const t = ev.target as HTMLElement;
    const more = t.closest<HTMLElement>('[data-more]');
    if (more) {
      openCategoryMenu(Number(more.dataset.more));
      return;
    }
    const vis = t.closest<HTMLElement>('[data-vis]');
    if (vis) {
      const g = groups()[Number(vis.dataset.vis)];
      const show = vis.getAttribute('aria-pressed') !== 'true';
      editGroups((gr) => {
        const hidden = new Set(gr.hidden);
        if (show) hidden.delete(g);
        else hidden.add(g);
        gr.hidden = [...hidden];
      }, show ? `${groupLabel(g)} visible en la playlist` : `${groupLabel(g)} oculta de la playlist`);
      return;
    }
    const fold = t.closest<HTMLElement>('[data-fold]');
    if (fold) {
      const g = groups()[Number(fold.dataset.fold)];
      const set = collapsedSections();
      if (!set.delete(g)) set.add(g);
      saveCollapsed(set);
      renderCategories();
    }
  };
  const menu = () => ($('#catMenuDialog') as HTMLDialogElement);
  const menuGroup = () => groups()[Number(menu().dataset.g)];
  const rename = () => {
    const g = menuGroup();
    applyRename(g, $<HTMLInputElement>('.cat-name', $('#catMenuBody')).value);
    openCategoryMenu(Number(menu().dataset.g));
  };
  $('#catMenuVis').onclick = () => {
    const g = menuGroup();
    const show = state.cfg!.groups.hidden.includes(g);
    editGroups((gr) => {
      const hidden = new Set(gr.hidden);
      if (show) hidden.delete(g);
      else hidden.add(g);
      gr.hidden = [...hidden];
    }, show ? `${groupLabel(g)} visible en la playlist` : `${groupLabel(g)} oculta de la playlist`);
    openCategoryMenu(Number(menu().dataset.g));
  };
  $('#catMenuBody').onkeydown = (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('.cat-name')) {
      ev.preventDefault();
      rename();
    }
  };
  $('#catMenuBody').onclick = (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    const g = menuGroup();
    if (action === 'rename') {
      rename();
      return;
    }
    if (action === 'noepg') {
      const on = !state.cfg!.groups.noEpg?.includes(g);
      editGroups((gr) => {
        const noEpg = new Set(gr.noEpg ?? []);
        if (on) noEpg.add(g);
        else noEpg.delete(g);
        gr.noEpg = [...noEpg];
      }, on ? `${groupLabel(g)}: sin guía` : `${groupLabel(g)} vuelve a necesitar guía`);
      openCategoryMenu(Number(menu().dataset.g));
      return;
    }
    menu().close();
    if (action === 'unrename') unrenameGroup(g);
    else if (action === 'delete') deleteGroup(g);
    else if (action === 'order') openChannelOrder(g);
  };
}

// ------------------------------------------------------------------ links
const shareText = (r: { playlistUrl: string; epgUrl: string }) =>
  `Playlist (M3U): ${r.playlistUrl}\nGuía (EPG): ${r.epgUrl}`;

interface Device { code: string; name: string; created?: string; lastUsed?: string; playlistUrl: string; epgUrl: string }
type LinkResult = { playlistUrl: string; epgUrl: string; name?: string };

const ago = (iso?: string) => {
  if (!iso) return 'sin uso todavía';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 60) return 'usado hace un rato';
  if (min < 1440) return `usado hace ${Math.round(min / 60)} h`;
  return `usado hace ${Math.round(min / 1440)} d`;
};

/** Pantalla de "Tus links": la lista de dispositivos (un link por cada uno) y el formulario para
 *  agregar otro. Con `result`, los links de un dispositivo. */
async function renderLinks(result?: LinkResult) {
  if (result) return renderLinkResult(result);
  const p = state.cfg!.provider;
  const body = $('#linksBody');
  body.onclick = null;
  body.innerHTML = '<p class="help">Cargando…</p>';
  let devices: Device[] = [];
  try {
    devices = (await api<{ devices: Device[] }>(`/api/cfg/${state.local!.cfgId}/devices`)).devices;
  } catch { /* sin lista: se puede agregar igual */ }
  const needsCreds = !state.creds;
  body.innerHTML = `
    <p>Un link por dispositivo: así sabés cuál es cuál y podés quitar uno sin afectar a los demás.
      Todos muestran lo mismo (tu configuración). Los links llevan tus datos del proveedor cifrados:
      el servidor no los guarda en claro.</p>
    ${devices.length ? `<div class="device-list">${devices.map((d) => `
      <div class="device" data-code="${esc(d.code)}">
        <div class="device-info"><strong>${esc(d.name)}</strong><small>${esc(ago(d.lastUsed))}</small></div>
        <button class="btn btn-tonal" data-dev="show">${icon('copy')}Ver links</button>
        <button class="icon-btn" data-dev="rename" aria-label="Cambiar nombre de ${esc(d.name)}">${icon('pencil')}</button>
        <button class="icon-btn" data-dev="remove" aria-label="Quitar ${esc(d.name)}">${icon('trash-2')}</button>
      </div>`).join('')}</div>` : '<p class="help">Todavía no tenés dispositivos.</p>'}
    <h3 class="sub-title">Agregar dispositivo</h3>
    <form class="stack" id="linksForm" autocomplete="off">
      <label class="field"><span>Nombre</span><input class="input" id="lnkName" maxlength="40" placeholder="TV del living" required></label>
      ${needsCreds && p.type === 'xtream' ? `
        <label class="field"><span>Usuario</span><input class="input" id="lnkUser" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Contraseña</span><input class="input" id="lnkPass" type="password" required></label>` : ''}
      ${needsCreds && p.type === 'm3u' ? '<label class="field"><span>URL de la lista</span><input class="input" id="lnkUrl" type="url" required></label>' : ''}
      <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" id="makeLinks">${icon('tv')}Generar links</button></div>
    </form>`;
  body.onclick = async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-dev]');
    if (!btn) return;
    const row = btn.closest<HTMLElement>('.device')!;
    const dev = devices.find((d) => d.code === row.dataset.code)!;
    if (btn.dataset.dev === 'show') {
      renderLinkResult(dev);
    } else if (btn.dataset.dev === 'rename') {
      const name = await promptDialog({ title: 'Nombre del dispositivo', ok: 'Guardar', input: { label: 'Nombre', value: dev.name } });
      if (name === null || !name.trim()) return;
      try {
        await api(`/api/cfg/${state.local!.cfgId}/devices/${dev.code}`, { method: 'PATCH', body: { name } });
        renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    } else if (btn.dataset.dev === 'remove') {
      if (!(await confirmDialog({
        title: `¿Quitar “${dev.name}”?`, text: 'Su link deja de funcionar al instante. Los demás dispositivos no se tocan.', ok: 'Quitar', danger: true,
      }))) return;
      try {
        await api(`/api/cfg/${state.local!.cfgId}/devices/${dev.code}`, { method: 'DELETE' });
        toast(`“${dev.name}” quitado`, 'ok');
        renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    }
  };
  $('#linksForm').onsubmit = async (ev) => {
    ev.preventDefault();
    let creds = state.creds;
    if (!creds) {
      creds = p.type === 'xtream'
        ? { username: $<HTMLInputElement>('#lnkUser').value.trim(), password: $<HTMLInputElement>('#lnkPass').value }
        : { url: $<HTMLInputElement>('#lnkUrl').value.trim() };
      if (Object.values(creds).some((v) => !v)) {
        toast('Completá los datos del proveedor', 'bad');
        return;
      }
    }
    try {
      await saveNow();
      const name = $<HTMLInputElement>('#lnkName').value.trim();
      const r = await api<LinkResult>(`/api/cfg/${state.local!.cfgId}/token`, { method: 'POST', body: { ...creds, name } });
      state.creds = creds;
      renderLinkResult({ ...r, name });
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
  };
}

function renderLinkResult(result: LinkResult) {
  const body = $('#linksBody');
  const row = (label: string, url: string, id: string) => `
    <label class="field"><span>${label}</span>
      <div class="inline-field"><input class="input mono" id="${id}" readonly value="${esc(url)}">
        <button type="button" class="icon-btn" data-copy="${id}" aria-label="Copiar">${icon('copy')}</button></div></label>`;
  body.innerHTML = `
    <button type="button" class="btn btn-gray" data-back>${icon('arrow-left')}Dispositivos</button>
    ${result.name ? `<h3 class="sub-title">${esc(result.name)}</h3>` : ''}
    ${row('Playlist (M3U)', result.playlistUrl, 'lnkPlaylist')}
    ${row('Guía (EPG)', result.epgUrl, 'lnkEpg')}
    <div class="share-row">
      ${'share' in navigator ? `<button type="button" class="btn btn-tonal" data-share="native">${icon('share-2')}Compartir</button>` : ''}
      <a class="btn btn-gray" target="_blank" rel="noopener noreferrer" href="https://wa.me/?text=${encodeURIComponent(shareText(result))}">${icon('message-circle')}WhatsApp</a>
      <a class="btn btn-gray" href="mailto:?subject=${encodeURIComponent('Grilla: mis links')}&body=${encodeURIComponent(shareText(result))}">${icon('mail')}Mail</a>
    </div>
    <div class="qr" id="qr"></div>
    <p class="help">En TiviMate: Agregar playlist → Ingresar URL → la de arriba; la guía la toma sola
      (si no, agregala en Ajustes → EPG). Los cambios que guardes llegan a la playlist al
      instante y a la guía en unos minutos. Los links no cambian: no hace falta volver a
      cargarlos en el reproductor.</p>
    <p class="help">Son links inadivinables pero no privados: quien los tenga puede ver tus canales. No
      los publiques.</p>`;
  body.onclick = async (ev) => {
    if ((ev.target as HTMLElement).closest('[data-back]')) {
      renderLinks();
      return;
    }
    if ((ev.target as HTMLElement).closest('[data-share]')) {
      try {
        await navigator.share({ title: 'Grilla: mis links', text: shareText(result) });
      } catch { /* cancelado */ }
      return;
    }
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-copy]')?.dataset.copy;
    if (!id) return;
    const input = $<HTMLInputElement>(`#${id}`);
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    toast('Copiado', 'ok');
  };
  showQr(result.playlistUrl);
}

async function showQr(text: string) {
  try {
    if (!window.qrcode) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('qr'));
        document.head.appendChild(s);
      });
    }
    const qr = window.qrcode!(0, 'L');
    qr.addData(text);
    qr.make();
    $('#qr').innerHTML = `${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<small class="help">Escaneá para abrir el link de la playlist en otro dispositivo</small>`;
  } catch {
    // Sin QR (sin internet para la librería): los links alcanzan.
  }
}

// ------------------------------------------------------------------ onboarding
let providerType: 'xtream' | 'm3u' = 'xtream';

function parseServers(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map((s) => (/^https?:\/\//i.test(s) ? s : `http://${s}`));
}

// Lo escrito en el onboarding: al volver de bajar la lista, el navegador del teléfono suele
// recargar la página (o volver a una pestaña descartada) y se perdía todo. Servidores, usuario
// y el paso de subir quedan en el navegador hasta terminar; la contraseña solo en la pestaña.
const DRAFT_KEY = 'grilla_draft';
const DRAFT_PW_KEY = 'grilla_draft_pw';
interface Draft { servers?: string; username?: string; password?: string; upload?: boolean }
function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Draft;
    const pw = sessionStorage.getItem(DRAFT_PW_KEY);
    return pw ? { ...d, password: pw } : d;
  } catch {
    return {};
  }
}
function writeDraft(patch: Draft | null) {
  try {
    if (patch === null) {
      localStorage.removeItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_PW_KEY);
      return;
    }
    const { password, ...rest } = { ...readDraft(), ...patch };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(rest));
    if (password) sessionStorage.setItem(DRAFT_PW_KEY, password);
  } catch { /* sin storage */ }
}
function restoreDraft() {
  const d = readDraft();
  if (d.servers && !$<HTMLTextAreaElement>('#servers').value) $<HTMLTextAreaElement>('#servers').value = d.servers;
  if (d.username && !$<HTMLInputElement>('#username').value) $<HTMLInputElement>('#username').value = d.username;
  if (d.password && !$<HTMLInputElement>('#password').value) $<HTMLInputElement>('#password').value = d.password;
  if (d.upload) showUpload();
}
/** El paso de bajar y subir la lista. El link a get.php se arma con lo que está escrito (lleva
 *  la contraseña, por eso no se guarda): si falta algo, se pide completarlo. */
function showUpload() {
  $('#uploadWhy').textContent = 'Tu proveedor no deja que Grilla baje la lista directamente (pasa con muchos: solo atienden a los reproductores). No es un error: hacelo en dos pasos.';
  $('#uploadBox').hidden = false;
  updateDownloadLink();
}
function updateDownloadLink() {
  const servers = parseServers($<HTMLTextAreaElement>('#servers').value);
  const username = $<HTMLInputElement>('#username').value.trim();
  const password = $<HTMLInputElement>('#password').value;
  const a = $<HTMLAnchorElement>('#m3uDownload');
  const ready = servers.length && username && password;
  a.href = ready ? `${servers[0]}/get.php?${new URLSearchParams({ username, password, type: 'm3u_plus', output: 'ts' })}` : '#';
  a.classList.toggle('disabled', !ready);
  a.title = ready ? '' : 'Completá servidores, usuario y contraseña arriba';
}

/** Canales en vivo de la lista M3U del proveedor, leída de a partes: hay proveedores que
 *  mandan 70 MB (con películas y series) y un teléfono no puede cargarla entera de una vez. */
async function readXtreamM3u(file: File, progress: (n: number, done: number) => void): Promise<{ channels: Channel[]; total: number }> {
  const channels: Channel[] = [];
  let total = 0;
  const push = m3uLineParser((ch) => {
    total++;
    const live = xtreamLiveChannel(ch);
    if (live) channels.push(live);
  });
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let read = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    const lines = (rest + value).split(/\r\n|\r|\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) push(line);
    if (read - lastReport > 2_000_000) {
      lastReport = read;
      progress(channels.length, Math.min(read / Math.max(file.size, 1), 1));
      await new Promise((r) => setTimeout(r));
    }
  }
  push(rest);
  return { channels, total };
}

function showOnboarding(reload = false) {
  state.reloading = reload;
  $('#onboarding').hidden = false;
  $('#editor').hidden = true;
  $('#uploadBox').hidden = true;
  const p = state.cfg?.provider;
  if (reload && p) {
    setProviderType(p.type);
    if (p.type === 'xtream') $<HTMLTextAreaElement>('#servers').value = p.servers.join('\n');
  }
  let cancel = $('#cancelReload');
  if (reload && !cancel) {
    cancel = document.createElement('button');
    cancel.id = 'cancelReload';
    cancel.className = 'btn btn-gray btn-block';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => showEditor();
    $('#onboarding .card').appendChild(cancel);
  }
  if (cancel) cancel.hidden = !reload;
  restoreDraft();
}

function setProviderType(t: 'xtream' | 'm3u') {
  providerType = t;
  for (const b of $$('#providerSeg button')) b.setAttribute('aria-checked', String(b.dataset.value === t));
  $('#xtreamForm').hidden = t !== 'xtream';
  $('#m3uForm').hidden = t !== 'm3u';
  $('#uploadBox').hidden = true;
}

/** Proveedor que bloquea al Worker pero cuya cuenta tiene la corrida de GitHub: se crea la
 *  configuración sin lista, GitHub la sube en su próxima corrida (cada 10 minutos) y la web
 *  espera sola. */
async function onboardViaGithub(servers: string[], username: string, password: string) {
  const st = $('#onboardStatus');
  try {
    status(st, 'Armando tu configuración…');
    state.cfg = { version: 1, provider: { type: 'xtream', servers, list: 'upload' }, channels: {}, groups: { order: [], hidden: [] } };
    const r = await api<{ cfgId: string; editKey: string }>('/api/cfg', {
      method: 'POST', auth: false, body: { ...state.cfg, link: { username, password } },
    });
    state.local = { cfgId: r.cfgId, editKey: r.editKey };
    saveLocal(state.local);
    writeDraft(null);
    status(st, null);
    await openSaved();
  } catch (e) {
    status(st, `No se pudo: ${(e as Error).message}`, 'bad');
  }
}

/** Espera la lista que sube GitHub (cada 10 minutos), consultando cada 15 segundos. */
async function waitForList(say: (t: string) => void): Promise<Channel[]> {
  const started = Date.now();
  for (;;) {
    const minutes = Math.floor((Date.now() - started) / 60000);
    say(`Cargando tu lista de canales… puede tardar unos minutos${minutes ? ` (van ${minutes})` : ''}. Podés cerrar esta página y volver más tarde.`);
    try {
      const list = await api<{ channels: Channel[] }>(`/api/cfg/${state.local!.cfgId}/list`);
      if (list.channels?.length) return list.channels;
    } catch { /* todavía no está */ }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function finishOnboarding(channels: Channel[], provider: Provider) {
  const st = $('#onboardStatus');
  const say = (t: string) => status(st, t);
  try {
    if (!channels.length) throw new Error('la lista no tiene canales');
    state.channels = channels;
    await loadGuide(say);
    const keep = state.reloading && state.cfg ? state.cfg : null;
    state.cfg = {
      version: 1,
      provider,
      channels: keep?.channels ?? {},
      groups: keep?.groups ?? { order: [...new Set(channels.map((c) => c.category))], hidden: [] },
    };
    await rematch(say);
    say('Guardando tu configuración…');
    if (state.local && state.reloading) await saveNow();
    else {
      state.local = { ...(await api<{ cfgId: string; editKey: string }>('/api/cfg', { method: 'POST', body: state.cfg, auth: false })) };
      saveLocal(state.local);
    }
    await storeList();
    writeDraft(null);
    status(st, null);
    if (keep) {
      detectNew();
      placeNewCategories();
    } else markSeen();
    showEditor();
    toast(`${channels.length} canales cargados`, 'ok');
  } catch (e) {
    status(st, `No se pudo: ${(e as Error).message}`, 'bad');
  }
}

// Lista de demostración: canales públicos y gratuitos (iptv-org), legales para probar.
const DEMO_M3U = 'https://iptv-org.github.io/iptv/countries/ar.m3u';

function setupOnboarding() {
  $('#demoBtn').onclick = () => {
    setProviderType('m3u');
    $<HTMLInputElement>('#m3uUrl').value = DEMO_M3U;
    $<HTMLFormElement>('#m3uForm').requestSubmit();
  };
  $('#providerSeg').onclick = (ev) => {
    const v = (ev.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value;
    if (v === 'xtream' || v === 'm3u') setProviderType(v);
  };
  const st = $('#onboardStatus');
  for (const [id, key] of [['#servers', 'servers'], ['#username', 'username'], ['#password', 'password']] as const) {
    $<HTMLInputElement>(id).addEventListener('input', (ev) => {
      writeDraft({ [key]: (ev.target as HTMLInputElement).value });
      updateDownloadLink();
    });
  }
  $<HTMLFormElement>('#xtreamForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const servers = parseServers($<HTMLTextAreaElement>('#servers').value);
    const username = $<HTMLInputElement>('#username').value.trim();
    const password = $<HTMLInputElement>('#password').value;
    state.creds = { username, password };
    status(st, 'Bajando la lista de canales del proveedor…');
    try {
      const r = await api<{ channels: Channel[] }>('/api/provider/list', { method: 'POST', auth: false, body: { type: 'xtream', servers, username, password } });
      await finishOnboarding(r.channels, { type: 'xtream', servers });
    } catch (e) {
      // Hay proveedores que bloquean los pedidos que salen de Cloudflare. Si GitHub tiene esta
      // cuenta, la lista la baja GitHub y no hay que hacer nada más.
      if ((e as { data?: { github?: boolean } }).data?.github) {
        await onboardViaGithub(servers, username, password);
        return;
      }
      // Si no, la baja el navegador de la persona (una descarga común, sin CORS) y la sube.
      status(st, null);
      console.info('provider/list:', (e as Error).message);
      writeDraft({ upload: true });
      showUpload();
    }
  };
  $<HTMLInputElement>('#m3uFile').onchange = async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const { channels, total } = await readXtreamM3u(file, (n, done) => status(st,
        `Leyendo la lista… ${Math.round(done * 100)} % (${n} canales en vivo)`));
      if (!channels.length) {
        status(st, total
          ? `El archivo tiene ${total} entradas pero ningún canal en vivo de Xtream (¿es la lista correcta?)`
          : 'El archivo no parece una lista M3U (¿se bajó bien?)', 'bad');
        return;
      }
      const servers = parseServers($<HTMLTextAreaElement>('#servers').value || readDraft().servers || '');
      const username = $<HTMLInputElement>('#username').value.trim();
      const password = $<HTMLInputElement>('#password').value;
      if (username && password) state.creds = { username, password };
      await finishOnboarding(channels, { type: 'xtream', servers, list: 'upload' });
    } catch (e) {
      status(st, `No se pudo leer el archivo: ${(e as Error).message}`, 'bad');
    }
  };
  $<HTMLFormElement>('#m3uForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const url = $<HTMLInputElement>('#m3uUrl').value.trim();
    state.creds = { url };
    status(st, 'Bajando la lista…');
    try {
      const r = await api<{ channels: Channel[] }>('/api/provider/list', { method: 'POST', auth: false, body: { type: 'm3u', url } });
      await finishOnboarding(r.channels, { type: 'm3u' });
    } catch (e) {
      status(st, `No se pudo bajar la lista: ${(e as Error).message}`, 'bad');
    }
  };
  $('#m3uDownload').addEventListener('click', (ev) => {
    if ($('#m3uDownload').classList.contains('disabled')) {
      ev.preventDefault();
      toast('Completá servidores, usuario y contraseña arriba', 'bad');
    }
  });
  $('#restoreLink').onclick = (ev) => {
    ev.preventDefault();
    $<HTMLInputElement>('#backupFile').click();
  };
}

// ------------------------------------------------------------------ editor
function showEditor() {
  $('#onboarding').hidden = true;
  $('#editor').hidden = false;
  window.scrollTo(0, 0); // si no, queda la posición de la pantalla anterior y la barra tapa las primeras tarjetas
  state.shown = PAGE;
  render();
  refreshGuideStatus();
  loadHourNow();
}

async function openSaved() {
  const st = $('#status');
  $('#onboarding').hidden = true;
  $('#editor').hidden = false;
  window.scrollTo(0, 0);
  const say = (t: string) => status(st, t);
  try {
    say('Abriendo tu configuración…');
    let cfg = await api<Config>(`/api/cfg/${state.local!.cfgId}`);
    // Cambios hechos sin conexión que todavía no llegaron: mandan sobre lo guardado.
    let pending = false;
    try {
      const raw = localStorage.getItem(PENDING_KEY(state.local!.cfgId));
      if (raw) {
        cfg = JSON.parse(raw) as Config;
        pending = true;
      }
    } catch { /* sin storage */ }
    cfg.groups = { ...cfg.groups, order: cfg.groups?.order ?? [], hidden: cfg.groups?.hidden ?? [], noEpg: cfg.groups?.noEpg ?? [], channels: cfg.groups?.channels ?? {} };
    state.cfg = cfg;
    state.channels = await loadStoredList();
    if (!state.channels.length && cfg.provider.type === 'xtream' && cfg.provider.list === 'upload') {
      state.channels = await waitForList(say);
      if (!cfg.groups.order.length) cfg.groups.order = [...new Set(state.channels.map((c) => c.category))];
      try {
        localStorage.setItem(LIST_KEY(state.local!.cfgId), JSON.stringify(state.channels));
      } catch { /* sin storage */ }
      toast(`${state.channels.length} canales cargados`, 'ok');
    }
    await loadGuide(say);
    // La guía cambia todos los días: se vuelve a cruzar y, si cambió algo, se guarda.
    if ((await rematch(say)) || pending) await saveNow();
    status(st, null);
    detectNew();
    placeNewCategories();
    render();
    refreshGuideStatus();
  } catch (e) {
    const msg = (e as Error).message;
    if (/inexistente|clave/.test(msg)) {
      status(st, null);
      toast(`Tu configuración ya no está (${msg}). Empezá de nuevo o importá un respaldo.`, 'bad', 8000);
      saveLocal((state.local = null));
      state.creds = null;
      showOnboarding();
    } else status(st, `No se pudo abrir: ${msg}`, 'bad');
  }
}

// La configuración que arma la corrida de GitHub (generate_playlist.write_web_import), publicada
// en la branch `data` del repo: con esto la web queda igual que la playlist de GitHub.
const GITHUB_IMPORT_URL = (profile: string) =>
  `https://raw.githubusercontent.com/luispied/epg-merger/data/grilla-import-${encodeURIComponent(profile)}.json`;

async function importFromGithub() {
  const profile = await promptDialog({
    title: 'Importar desde Grilla (GitHub)',
    text: 'Reemplaza la configuración de acá por la de GitHub: orden y títulos de categorías, EPG elegidos, nombres, movidos y ocultos.',
    ok: 'Importar', input: { label: 'Nombre de tu perfil', value: 'luis' },
  });
  if (!profile) return;
  try {
    const res = await fetch(GITHUB_IMPORT_URL(profile), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? `no hay un perfil "${profile}"` : `HTTP ${res.status}`);
    const data = await res.json() as { channels: Record<string, ChannelEdit>; groups: { order: string[]; hidden: string[]; noEpg?: string[] }; matching?: Config['matching'] };
    // Todo lo importado queda fijo (elegido a mano): así la playlist queda igual que la de
    // GitHub, que elige el EPG con tus reglas por sección. Los canales nuevos del proveedor
    // siguen tomando el EPG automático.
    const channels: Record<string, ChannelEdit> = {};
    for (const [name, edit] of Object.entries(data.channels ?? {})) {
      channels[name] = 'epg' in edit ? { ...edit, manual: true } : { ...edit };
    }
    state.cfg!.channels = channels;
    state.cfg!.groups = { order: data.groups?.order ?? [], hidden: data.groups?.hidden ?? [], noEpg: data.groups?.noEpg ?? [] };
    if (data.matching) state.cfg!.matching = data.matching;
    else delete state.cfg!.matching;
    await rematch(() => {});
    await saveNow();
    ($('#settingsDialog') as HTMLDialogElement).close();
    render();
    toast(`Importado: ${Object.keys(channels).length} canales y ${state.cfg!.groups.order.length} categorías`, 'ok', 5000);
  } catch (e) {
    toast(`No se pudo importar: ${(e as Error).message}`, 'bad', 6000);
  }
}

function exportBackup() {
  const data = { grilla: 1, worker: location.origin, cfgId: state.local!.cfgId, editKey: state.local!.editKey };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'grilla-respaldo.json';
  a.click();
  toast('Respaldo descargado. Guardalo: con él se puede editar tu configuración.', 'ok', 6000);
}

async function importBackup(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (!data?.cfgId || !data?.editKey) throw new Error('no es un respaldo de Grilla');
    state.creds = null;
    state.local = { cfgId: data.cfgId, editKey: data.editKey };
    await api(`/api/cfg/${data.cfgId}`);
    saveLocal(state.local);
    ($('#settingsDialog') as HTMLDialogElement).close();
    await openSaved();
  } catch (e) {
    state.local = loadLocal();
    toast(`No se pudo importar: ${(e as Error).message}`, 'bad', 6000);
  }
}

function setupEditor() {
  $('#filterTabs').onclick = (ev) => {
    const f = (ev.target as HTMLElement).closest<HTMLElement>('[data-filter]')?.dataset.filter;
    if (!f) return;
    state.filter = f;
    setPref('grilla_last_filter', f);
    state.shown = PAGE;
    render();
  };
  let t = 0;
  $<HTMLInputElement>('#searchBox').oninput = (ev) => {
    clearTimeout(t);
    loadHourNow(); // por si cambió la hora desde que se abrió
    t = window.setTimeout(() => {
      state.search = (ev.target as HTMLInputElement).value;
      state.shown = PAGE;
      render();
    }, 150);
  };
  const cards = $('#cards');
  let longPressed = -1;
  cards.onclick = (ev) => {
    const t = ev.target as HTMLElement;
    const card = t.closest<HTMLElement>('.card[data-i]');
    if (!card) return;
    const i = Number(card.dataset.i);
    if (longPressed === i) {
      longPressed = -1;
      return;
    }
    if (selection.active) {
      toggleSelected(i);
      return;
    }
    const now = t.closest<HTMLElement>('.now-btn');
    if (now) {
      toggleDesc(now);
      return;
    }
    const use = t.closest<HTMLElement>('[data-use]');
    if (use) {
      const cid = info(state.channels[i]).suggestion?.channelId;
      if (cid) editChannels([state.channels[i]], (e) => pickEpg(e, cid), 'Sugerencia aplicada');
      return;
    }
    openChannel(i);
  };
  // Toque largo en una tarjeta: entra al modo selección con esa tarjeta marcada.
  let press = 0;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(press);
    press = 0;
  };
  cards.addEventListener('pointerdown', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.card[data-i]');
    if (!card || selection.active || ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    press = window.setTimeout(() => {
      press = 0;
      longPressed = Number(card.dataset.i);
      setTimeout(() => { longPressed = -1; }, 600);
      navigator.vibrate?.(15);
      setSelectMode(true, Number(card.dataset.i));
    }, 500);
  });
  cards.addEventListener('pointermove', (ev) => {
    if (press && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) cancel();
  });
  cards.addEventListener('pointerup', cancel);
  cards.addEventListener('pointercancel', cancel);
  cards.addEventListener('contextmenu', (ev) => { if (selection.active) ev.preventDefault(); });
  $('#selectBtn').onclick = () => setSelectMode(!selection.active);
  $('#bulkCancel').onclick = () => setSelectMode(false);
  $('#bulkActions').onclick = openBulkMenu;
  $('#bulkAll').onclick = () => {
    const list = visibleChannels();
    if (list.every((i) => selection.items.has(i))) list.forEach((i) => selection.items.delete(i));
    else list.forEach((i) => selection.items.add(i));
    render();
    updateBulkBar();
  };
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && selection.active && !document.querySelector('dialog[open]')) setSelectMode(false);
  });
  recheckGrid = infiniteScroll($('#loadMoreSentinel'), () => {
    const list = visibleChannels();
    if (list.length <= state.shown) return false;
    const from = state.shown;
    state.shown += PAGE;
    $('#cards').insertAdjacentHTML('beforeend', list.slice(from, state.shown).map(cardHtml).join(''));
    fillEpgRows($('#cards'));
    $('#loadMoreSentinel').hidden = list.length <= state.shown;
    return !$('#loadMoreSentinel').hidden;
  });
  $('#viewBtn').onclick = () => {
    setPref('grilla_view', viewMode() === 'row' ? 'card' : 'row');
    render();
  };
  $('#categoriesBtn').onclick = () => {
    $<HTMLInputElement>('#categoriesFilter').value = '';
    renderCategories();
    ($('#categoriesDialog') as HTMLDialogElement).showModal();
  };
  setupCategories();
  setupChannelOrder();
  $('#newBanner').onclick = (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-new]')?.dataset.new;
    if (act === 'show') {
      state.filter = 'nuevos';
      state.shown = PAGE;
      render();
    } else if (act === 'seen') {
      markSeen();
      render();
      toast('Canales marcados como vistos', 'ok');
    }
  };
  // Atajos (escritorio): "/" busca; Escape en el buscador lo borra.
  document.addEventListener('keydown', (ev) => {
    if ($('#editor').hidden || document.querySelector('dialog[open]')) return;
    const t = ev.target as HTMLElement;
    const typing = t.matches('input, textarea, select, [contenteditable]');
    const box = $<HTMLInputElement>('#searchBox');
    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      box.focus();
      box.select();
    } else if (ev.key === 'Escape' && t === box && box.value) {
      ev.preventDefault();
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  $('#linksBtn').onclick = () => {
    ($('#settingsDialog') as HTMLDialogElement).close();
    renderLinks();
    ($('#linksDialog') as HTMLDialogElement).showModal();
  };
  $('#helpBtn').onclick = () => {
    ($('#settingsDialog') as HTMLDialogElement).close();
    ($('#helpDialog') as HTMLDialogElement).showModal();
  };
  $('#settingsBtn').onclick = () => {
    // Importar desde GitHub es solo para quien venía de la versión anterior: se muestra con el link `?importar`.
    $('#importGithubBtn').hidden = pref('grilla_show_import', '0') !== '1';
    const apply = $('#applyGuideBtn');
    apply.hidden = true;
    if (state.local) {
      api<GuideStatus>(`/api/cfg/${state.local.cfgId}/status`).then((st) => {
        if (!st.autoRefresh) return;
        apply.hidden = false;
        $('#applyGuideSub').textContent = st.guideUpToDate ? `Al día${st.guide ? ` · última actualización ${guideTime(st.guide)}` : ''}` : 'Se está actualizando';
      }).catch(() => {});
    }
    $<HTMLInputElement>('#logosToggle').checked = logosOn();
    $<HTMLSelectElement>('#startFilterSelect').value = pref('grilla_start_filter', 'last');
    ($('#settingsDialog') as HTMLDialogElement).showModal();
  };
  $('#applyGuideBtn').onclick = async () => {
    try {
      const r = await api<{ started: boolean }>(`/api/cfg/${state.local!.cfgId}/refresh`, { method: 'POST' });
      toast(r.started ? 'Actualizando la guía: queda lista en un par de minutos' : 'Ya se está actualizando', 'ok');
      guidePending = true;
      clearTimeout(guideTimer);
      guideTimer = window.setTimeout(refreshGuideStatus, 20000);
      ($('#settingsDialog') as HTMLDialogElement).close();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  $('#reloadListBtn').onclick = () => {
    ($('#settingsDialog') as HTMLDialogElement).close();
    showOnboarding(true);
  };
  document.body.classList.toggle('no-logos', !logosOn());
  $<HTMLInputElement>('#logosToggle').onchange = (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    setPref('grilla_logos', on ? '1' : '0');
    document.body.classList.toggle('no-logos', !on);
    render();
  };
  $<HTMLSelectElement>('#startFilterSelect').onchange = (ev) => setPref('grilla_start_filter', (ev.target as HTMLSelectElement).value);
  $('#exportBtn').onclick = exportBackup;
  $('#importGithubBtn').onclick = importFromGithub;
  $('#importBtn').onclick = () => $<HTMLInputElement>('#backupFile').click();
  $<HTMLInputElement>('#backupFile').onchange = (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) importBackup(f);
  };
  $('#forgetBtn').onclick = async () => {
    if (!await confirmDialog({
      title: '¿Borrar tu configuración?', text: 'Tus links de reproducción dejan de funcionar. No se puede deshacer.',
      ok: 'Borrar', danger: true,
    })) return;
    try {
      await api(`/api/cfg/${state.local!.cfgId}`, { method: 'DELETE' });
    } catch { /* ya no estaba */ }
    try {
      localStorage.removeItem(LIST_KEY(state.local!.cfgId));
    } catch { /* sin storage */ }
    saveLocal((state.local = null));
      state.creds = null;
    state.cfg = null;
    ($('#settingsDialog') as HTMLDialogElement).close();
    showOnboarding();
  };
  const theme = (() => {
    try {
      return localStorage.getItem('grilla_theme') || 'dark';
    } catch {
      return 'auto';
    }
  })();
  for (const b of $$('#themeSeg button')) b.setAttribute('aria-checked', String(b.dataset.value === theme));
  $('#themeSeg').onclick = (ev) => {
    const v = (ev.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value;
    if (!v) return;
    for (const b of $$('#themeSeg button')) b.setAttribute('aria-checked', String(b.dataset.value === v));
    if (v === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    try {
      localStorage.setItem('grilla_theme', v);
    } catch { /* sin storage */ }
  };
}

// ------------------------------------------------------------------ buscadores
// Cada buscador (también los que se arman en los diálogos) lleva una cruz para borrarlo: la
// del navegador no aparece en todos (Safari del iPhone) y es chica para el dedo.
function addSearchClear(root: ParentNode) {
  for (const field of $$('.search-field', root)) {
    if ($('.search-clear', field)) continue;
    const input = $<HTMLInputElement>('input', field);
    if (!input) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-clear';
    btn.setAttribute('aria-label', 'Borrar la búsqueda');
    btn.title = 'Borrar';
    btn.innerHTML = icon('x');
    btn.hidden = !input.value;
    field.appendChild(btn);
  }
}
document.addEventListener('input', (ev) => {
  const input = ev.target as HTMLElement;
  const btn = input.closest?.('.search-field')?.querySelector<HTMLElement>('.search-clear');
  if (btn) btn.hidden = !(input as HTMLInputElement).value;
});
document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest?.<HTMLElement>('.search-clear');
  if (!btn) return;
  ev.preventDefault();
  const input = btn.parentElement!.querySelector<HTMLInputElement>('input')!;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) addSearchClear(n.parentElement ?? n);
}).observe(document.body, { childList: true, subtree: true });

// ------------------------------------------------------------------ arranque
// Sin conexión: la app y los datos para editar quedan guardados (ver sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* sin SW: anda igual */ }));
}
hydrateIcons();
addSearchClear(document);
$('#askCancel').onclick = () => ($('#askDialog') as HTMLDialogElement).close('');
$('#askClose').onclick = () => ($('#askDialog') as HTMLDialogElement).close('');
if (/[?&]importar\b/.test(location.search)) {
  setPref('grilla_show_import', '1');
  history.replaceState(null, '', location.pathname + location.hash);
}
setupOnboarding();
setupEditor();
if (state.local) openSaved();
else showOnboarding();
