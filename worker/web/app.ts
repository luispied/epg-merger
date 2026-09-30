// Grilla web (Etapa 1, paso 4): la interfaz sobre el Worker. Conectar el proveedor, cruzar los
// canales con la guía en el navegador (@grilla/core, el mismo matcher que la corrida de
// Python), corregir y copiar los links para el reproductor. Sin cuenta: la configuración vive
// en el Worker y la clave para editarla, en este navegador (exportable como respaldo).
import {
  EpgIndex, flagToCountryCode, MatchingRules, matchStream, stripDisplayPrefix, type Candidate, type GuideChannel,
  type MatchingRulesData, type SourceInfo,
} from '../../core/src/index.ts';
import { m3uLineParser, xtreamLiveChannel } from '../src/provider.ts';

// ------------------------------------------------------------------ tipos (los del Worker)
type Provider = { type: 'xtream'; servers: string[]; list?: 'upload' } | { type: 'm3u' };
interface ChannelEdit { epg?: string | null; logo?: string; name?: string; group?: string; hidden?: boolean; manual?: boolean }
interface Config {
  version: 1;
  provider: Provider;
  directUrls?: boolean;
  channels: Record<string, ChannelEdit>;
  groups: { order: string[]; hidden: string[]; noEpg?: string[] };
}
interface Channel { name: string; category: string; id: string; ext: string; icon: string; epgId: string | null }
interface Local { cfgId: string; editKey: string; lenient?: boolean }
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
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
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
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Confirmar y pedir un texto con el estilo de la página (en vez de confirm/prompt del
// navegador). Van en un <dialog> propio, que queda arriba de cualquier otro abierto.
interface AskOptions { title: string; text?: string; ok?: string; danger?: boolean; input?: { label: string; value?: string; placeholder?: string } }
function ask(o: AskOptions): Promise<string | null> {
  const dlg = $('#askDialog') as HTMLDialogElement;
  $('#askTitle').textContent = o.title;
  $('#askText').textContent = o.text ?? '';
  $('#askText').hidden = !o.text;
  const field = $('#askField');
  const input = $<HTMLInputElement>('#askInput');
  field.hidden = !o.input;
  $('#askLabel').textContent = o.input?.label ?? '';
  input.value = o.input?.value ?? '';
  input.placeholder = o.input?.placeholder ?? '';
  input.required = !!o.input;
  const ok = $<HTMLButtonElement>('#askOk');
  ok.textContent = o.ok ?? 'Aceptar';
  ok.className = `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`;
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
  title: 'Categoría nueva', ok: 'Crear', input: { label: 'Nombre', placeholder: 'Ej.: Deportes AR' },
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

// ------------------------------------------------------------------ estado
const state = {
  local: loadLocal() as Local | null,
  cfg: null as Config | null,
  channels: [] as Channel[],
  index: null as EpgIndex | null,
  rules: null as MatchingRules | null,
  auto: new Map<string, Auto>(),
  creds: null as Creds | null, // solo en memoria, para generar los links sin volver a pedirlos
  filter: startFilter(),
  search: '',
  shown: PAGE,
  reloading: false,
};

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
  const minAssignScore = state.local?.lenient ? 0.45 : 0.7;
  const names = [...new Set(state.channels.map((c) => c.name))];
  const byName = new Map(state.channels.map((c) => [c.name, c]));
  for (let i = 0; i < names.length; i++) {
    if (i % 150 === 0) {
      onStatus(`Buscando la guía de cada canal… ${Math.round((100 * i) / names.length)} %`);
      await new Promise((r) => setTimeout(r));
    }
    const ch = byName.get(names[i])!;
    const m = matchStream(ch.name, ch.epgId, index, {}, {}, flagToCountryCode(ch.category, rules), { trustListIds: trust, minAssignScore });
    state.auto.set(ch.name, { cid: m.channelId, score: m.score, ranked: m.ranked.slice(0, 8) });
    const edit = cfg.channels[ch.name] ?? {};
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
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.local || !state.cfg) return;
  try {
    await api(`/api/cfg/${state.local.cfgId}`, { method: 'PUT', body: state.cfg });
    $('#statusLine').dataset.saved = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderStatusLine();
    refreshGuideStatus();
  } catch (e) {
    toast(`No se pudo guardar: ${(e as Error).message}`, 'bad', 6000);
  }
}

// ------------------------------------------------------------------ estado de los cambios
// La playlist toma los cambios al instante (el Worker la arma en cada pedido); la guía la
// vuelve a armar la corrida de GitHub. Esto muestra si la guía ya los tiene y permite
// "Aplicar ahora" (como el botón Workflow de la interfaz de GitHub).
interface GuideStatus { guideUpToDate: boolean; guide: string | null; autoRefresh: boolean }
let guideTimer = 0;

async function refreshGuideStatus() {
  clearTimeout(guideTimer);
  if (!state.local || $('#editor').hidden) return;
  let st: GuideStatus;
  try {
    st = await api<GuideStatus>(`/api/cfg/${state.local.cfgId}/status`);
  } catch {
    return;
  }
  const el = $('#guideStatus');
  el.hidden = false;
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  if (st.guideUpToDate) {
    el.className = 'guide-status ok';
    el.innerHTML = `${icon('circle-check')}<span class="grow">Tus cambios están aplicados: playlist y guía (actualizada ${time(st.guide)}).</span>`;
    return;
  }
  el.className = 'guide-status pending';
  el.innerHTML = `${icon('loader-circle', 'spin')}<span class="grow">La playlist ya tiene tus cambios. La guía se está actualizando: ${st.autoRefresh ? 'un par de minutos' : 'hasta 10 minutos'}.</span>`
    + (st.autoRefresh ? '<button type="button" class="btn btn-tonal" id="applyNow">Aplicar ahora</button>' : '');
  const btn = $('#applyNow', el);
  if (btn) {
    btn.onclick = async () => {
      btn.setAttribute('disabled', '');
      try {
        const r = await api<{ started: boolean }>(`/api/cfg/${state.local!.cfgId}/refresh`, { method: 'POST' });
        toast(r.started ? 'Aplicando tus cambios: la guía queda lista en un par de minutos' : 'Ya se están aplicando', 'ok');
      } catch (e) {
        toast((e as Error).message, 'bad');
      }
    };
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
  const order = state.cfg!.groups.order.filter((g) => seen.has(g));
  return [...order, ...present.filter((g) => !order.includes(g))];
}

type Band = 'ok' | 'warn' | 'none' | 'manual';
function info(ch: Channel) {
  const edit = state.cfg!.channels[ch.name] ?? {};
  const auto = state.auto.get(ch.name);
  const epg = edit.epg ?? null;
  const hidden = !!edit.hidden || state.cfg!.groups.hidden.includes(groupOf(ch));
  const band: Band = edit.manual ? 'manual' : epg ? ((auto?.score ?? 0) >= GOOD ? 'ok' : 'warn') : 'none';
  // Categoría marcada "Sin guía" (Categorías): no cuenta en "A revisar" ni en "Sin EPG".
  const noGuide = !!state.cfg!.groups.noEpg?.includes(groupOf(ch));
  const suggestion = !epg && !edit.manual ? auto?.ranked.find((c) => c.nameScore >= 0.3) ?? null : null;
  return { edit, auto, epg, hidden, band, suggestion, noGuide };
}

function matchesFilter(ch: Channel, filter: string) {
  const i = info(ch);
  switch (filter) {
    case 'revisar': return !i.hidden && !i.noGuide && (i.band === 'warn' || (i.band === 'none' && !!i.suggestion));
    case 'sin-epg': return !i.hidden && !i.noGuide && !i.epg;
    case 'manual': return i.band === 'manual';
    case 'editados': return !!(i.edit.name || i.edit.group || i.edit.hidden);
    case 'ocultos': return i.hidden;
    default: return !i.hidden;
  }
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
      return fold(`${ch.name} ${edit.name ?? ''} ${groupOf(ch)}`).includes(q);
    })
    .sort((a, b) => (order.get(groupOf(state.channels[a])) ?? 0) - (order.get(groupOf(state.channels[b])) ?? 0) || a - b);
}

const BAND_TAG: Record<Band, string> = {
  ok: '<span class="tag ok">Bien</span>',
  warn: '<span class="tag warn">Dudoso</span>',
  none: '<span class="tag bad">Sin EPG</span>',
  manual: `<span class="tag manual with-icon">${icon('hand', 'sm')}A mano</span>`,
};

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

function logoHtml(id: string | null, cls = ''): string {
  const url = id && logosOn() ? state.index?.icon.get(id) : '';
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
    + `<div class="epg-head"><span class="epg-name">${esc(name)}${country ? ` [${esc(country.toUpperCase())}]` : ''}</span>${extra}</div>`
    + `<small class="epg-src">${esc(id)}${source ? ` · ${esc(source)}` : ''}</small>${now}</div></div>`;
}

/** Busca en toda la guía por nombre o id del canal y por lo que está dando ahora; primero los
 *  que tienen algo en el aire. */
const SEARCH_LIMIT = 50;
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
  const shown = hits.slice(0, SEARCH_LIMIT);
  const summary = idx
    ? `${hits.length} resultado${hits.length === 1 ? '' : 's'}${hits.length > SEARCH_LIMIT ? `, se muestran ${SEARCH_LIMIT}` : ''} · primero los que están dando algo ahora`
    : 'Programación por hora no disponible: se carga canal por canal.';
  results.innerHTML = `<div class="list-note">${esc(summary)}</div>`
    + (shown.map(({ id, cur, byProgram }) => candidateButton(id, undefined, {
      cur: idx ? cur : undefined, note: byProgram ? '· coincide con la búsqueda' : '',
    })).join('') || '<div class="list-note">Sin resultados</div>');
  results.hidden = false;
  fillEpgRows(results);
}

function wireGuideSearch(root: HTMLElement) {
  const input = $<HTMLInputElement>('.catalog-search', root);
  const results = $('.search-results', root);
  let t = 0;
  input.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(() => renderGuideSearch(input.value, results), 150);
  };
}

function cardHtml(i: number): string {
  const ch = state.channels[i];
  const { edit, epg, hidden, band, suggestion } = info(ch);
  const shown = edit.name || stripDisplayPrefix(ch.name, state.rules!)[0];
  let body: string;
  if (epg) body = epgRowHtml(epg, '', { logo: false });
  else if (edit.manual) body = '<div class="card-note">Sin EPG, a propósito.</div>';
  else if (suggestion) {
    body = `<div class="card-note suggest"><span>Sin EPG asignado. Sugerencia: <b>${esc(state.index?.displayName.get(suggestion.channelId) ?? suggestion.channelId)}</b></span>`
      + `<button type="button" class="btn btn-gray sm" data-use="${i}">Usar</button></div>`;
  } else body = '<div class="card-note">Sin EPG asignado.</div>';
  const sel = selection.active;
  const picked = selection.items.has(i);
  return `<article class="card${hidden ? ' is-hidden' : ''}${sel ? ' selectable' : ''}${picked ? ' selected' : ''}" data-i="${i}">
    <div class="card-top">
      ${sel ? `<span class="sel-box" aria-hidden="true">${icon(picked ? 'square-check' : 'square')}</span>` : ''}
      ${logoHtml(epg, 'lg')}
      <div class="card-title">
        <div class="card-name">${esc(shown)}</div>
        ${edit.name ? `<div class="card-sub">En el proveedor: ${esc(ch.name)}</div>` : ''}
        <div class="card-sub"><span>${esc(groupOf(ch))}</span>${edit.group ? `<span class="pill">${icon('folder-input', 'sm')}Movido</span>` : ''}${hidden ? `<span class="pill muted">${icon('eye-off', 'sm')}Oculto</span>` : ''}</div>
      </div>
      ${BAND_TAG[band]}
      <button class="icon-btn ghost card-menu-btn" data-open="${i}" aria-label="Opciones del canal">${icon('ellipsis')}</button>
    </div>
    ${body}
  </article>`;
}

function renderStatusLine() {
  const el = $('#statusLine');
  const total = state.channels.length;
  const withEpg = state.channels.filter((c) => state.cfg!.channels[c.name]?.epg).length;
  const saved = el.dataset.saved ? ` · guardado ${el.dataset.saved}` : '';
  el.textContent = `${total} canales · ${withEpg} con guía${saved}`;
}

function render() {
  if (!state.cfg) return;
  for (const b of $$<HTMLButtonElement>('#filterTabs button')) {
    const f = b.dataset.filter!;
    b.setAttribute('aria-pressed', String(f === state.filter));
    b.innerHTML = `${esc(b.dataset.label)}<span class="count">${state.channels.filter((c) => matchesFilter(c, f)).length}</span>`;
  }
  const list = visibleChannels();
  const cards = $('#cards');
  cards.innerHTML = list.length
    ? list.slice(0, state.shown).map(cardHtml).join('')
    : `<div class="empty">${icon('inbox', 'lg')}<strong>Nada por acá</strong>${state.channels.length ? 'Ningún canal coincide con el filtro.' : 'Volvé a cargar la lista del proveedor (Configuración).'}</div>`;
  fillEpgRows(cards);
  $('#loadMoreBtn').hidden = list.length <= state.shown;
  renderStatusLine();
}

// ------------------------------------------------------------------ canal: diálogo
// Fila elegible: no es un <button> porque adentro va el botón de la descripción.
function candidateButton(id: string, score?: number, opts: { cur?: NowPlaying | null; note?: string } = {}) {
  const pct = score === undefined ? '' : `<span class="muted">${Math.round(Math.min(score, 1) * 100)} %</span>`;
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

function openChannel(i: number) {
  const ch = state.channels[i];
  const { edit, auto, hidden } = info(ch);
  $('#channelTitle').textContent = edit.name || ch.name;
  const categories = groups();
  const ranked = (auto?.ranked ?? []).filter((c) => c.channelId !== edit.epg);
  $('#channelBody').innerHTML = `
    <div class="section-label">Guía (EPG)</div>
    ${edit.epg ? epgRowHtml(edit.epg) : `<div class="card-note">${edit.manual ? 'Sin EPG, a propósito.' : 'Sin EPG asignado.'}</div>`}
    ${ranked.length ? `<div class="section-label">Alternativas</div><div class="list">${ranked.map((c) => candidateButton(c.channelId, c.score)).join('')}</div>` : ''}
    <div class="section-label">Buscar en toda la guía</div>
    <label class="search-field">${icon('search')}<input type="search" class="catalog-search" placeholder="Canal o programa que está dando ahora" enterkeyhint="search"></label>
    <div class="list search-results" hidden></div>
    <div class="row-actions">
      ${edit.manual ? '<button type="button" class="btn btn-gray" data-act="auto">Volver al automático</button>' : ''}
      ${edit.epg || !edit.manual ? '<button type="button" class="btn btn-gray" data-act="no-epg">Sin EPG</button>' : ''}
    </div>
    <div class="section-label">Nombre en la playlist</div>
    <div class="inline-field"><input class="input rename" value="${esc(edit.name ?? '')}" placeholder="${esc(stripDisplayPrefix(ch.name, state.rules!)[0])}">
      <button type="button" class="icon-btn" data-act="rename" aria-label="Guardar nombre">${icon('check')}</button></div>
    <div class="section-label">Categoría</div>
    <select class="select move">${categories.map((g) => `<option${g === groupOf(ch) ? ' selected' : ''}>${esc(g)}</option>`).join('')}
      <option value="__new__">Nueva categoría…</option></select>
    <div class="menu" style="margin-top:12px"><label class="menu-row static">
      <span class="menu-icon">${icon('eye')}</span><span class="menu-text">Visible en la playlist</span>
      <input type="checkbox" class="switch vis" ${edit.hidden ? '' : 'checked'} ${hidden && !edit.hidden ? 'disabled' : ''}></label></div>
    ${hidden && !edit.hidden ? '<p class="help">Está oculto porque su categoría está oculta.</p>' : ''}`;

  const body = $('#channelBody');
  const update = (fn: (e: ChannelEdit) => void, msg?: string) => editChannels([ch], fn, msg);

  body.onclick = (ev) => {
    const picked = epgClick(ev);
    if (picked) {
      ($('#channelDialog') as HTMLDialogElement).close();
      update((e) => pickEpg(e, picked), 'EPG elegido');
      return;
    }
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'auto') {
      update((e) => autoEpg(e, ch), 'Volvió al EPG automático');
      openChannel(i);
    } else if (act === 'no-epg') {
      update(noEpg, 'Quedó sin EPG');
      openChannel(i);
    } else if (act === 'rename') {
      const v = $<HTMLInputElement>('.rename', body).value.trim();
      update((e) => { e.name = v || undefined; }, v ? 'Nombre guardado' : 'Vuelve al nombre del proveedor');
    }
  };
  body.onkeydown = (ev) => {
    const row = ev.target as HTMLElement;
    if (ev.key === 'Enter' && row.matches('[data-pick]')) row.click();
  };
  wireGuideSearch(body);
  fillEpgRows(body);
  $<HTMLSelectElement>('.move', body).onchange = async (ev) => {
    const sel = ev.target as HTMLSelectElement;
    let target = sel.value;
    if (target === '__new__') {
      target = (await newCategoryName()) ?? '';
      if (!target) {
        sel.value = groupOf(ch);
        return;
      }
    }
    update((e) => { e.group = target === ch.category ? undefined : target; }, `Movido a ${target}`);
  };
  $<HTMLInputElement>('.vis', body).onchange = (ev) => {
    const visible = (ev.target as HTMLInputElement).checked;
    update((e) => { e.hidden = visible ? undefined : true; }, visible ? 'Visible' : 'Oculto');
  };
  ($('#channelDialog') as HTMLDialogElement).showModal();
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
    applyBulk((e) => pickEpg(e, picked), `EPG elegido para ${plural(chs.length, 'canal', 'canales')}`);
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
      ${groups().map((g) => `<option>${esc(g)}</option>`).join('')}<option value="__new__">Nueva categoría…</option>
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
function sectionHeaders(): Set<string> {
  const members = new Map<string, Channel[]>();
  for (const ch of state.channels) {
    const g = groupOf(ch);
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(ch);
  }
  const out = new Set<string>();
  for (const [g, chs] of members) {
    const only = chs.length === 1 ? (state.cfg!.channels[chs[0].name]?.name || chs[0].name) : null;
    if (DIVIDER_RE.test(g) || only === g) out.add(g);
  }
  return out;
}
/** Nombre legible de una sección: sin la decoración y con los caracteres anchos normales. */
const sectionTitle = (g: string) => g.replace(/[\u2580-\u259F]+/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim() || g;

function renderCategories() {
  const list = groups();
  const hidden = new Set(state.cfg!.groups.hidden);
  const noEpg = new Set(state.cfg!.groups.noEpg ?? []);
  const headers = sectionHeaders();
  const counts = new Map<string, number>();
  for (const ch of state.channels) counts.set(groupOf(ch), (counts.get(groupOf(ch)) ?? 0) + 1);
  const q = fold($<HTMLInputElement>('#categoriesFilter').value.trim());
  // Con un filtro el orden no se puede arrastrar (se movería entre categorías que no se ven).
  const rows = list.map((g, i) => ({ g, i })).filter(({ g }) => !q || fold(g).includes(q));
  $('#categoriesList').innerHTML = rows.map(({ g, i }) => headers.has(g) ? `
    <div class="menu-row static cat-row section-row" data-g="${i}">
      ${q ? '' : `<button type="button" class="drag-handle" aria-label="Mover la sección ${esc(sectionTitle(g))}" title="Arrastrá para cambiar el orden">${icon('grip-vertical')}</button>`}
      <span class="menu-text"><span class="section-name">${esc(sectionTitle(g))}</span><small>Sección · separador en la playlist</small></span>
      <input type="checkbox" class="switch" aria-label="Mostrar el separador ${esc(sectionTitle(g))}" ${hidden.has(g) ? '' : 'checked'}>
    </div>` : `
    <div class="menu-row static cat-row" data-g="${i}">
      ${q ? '' : `<button type="button" class="drag-handle" aria-label="Mover ${esc(g)} (arrastrá, o flechas del teclado)" title="Arrastrá para cambiar el orden">${icon('grip-vertical')}</button>`}
      <span class="menu-text">${esc(g)}<small>${counts.get(g) ?? 0} canal${counts.get(g) === 1 ? '' : 'es'}${hidden.has(g) ? ' · oculta' : ''}</small>
        <button type="button" class="chip-btn noepg-btn" aria-pressed="${noEpg.has(g)}"
          title="${noEpg.has(g) ? 'Marcada como sin guía: tocá para que vuelva a contar en &quot;A revisar&quot;' : 'Tocá si esta categoría no necesita guía (no cuenta en &quot;A revisar&quot; ni &quot;Sin EPG&quot;)'}">${icon('ban', 'sm')}Sin guía</button></span>
      <input type="checkbox" class="switch" aria-label="Mostrar ${esc(g)}" ${hidden.has(g) ? '' : 'checked'}>
    </div>`).join('') || '<p class="help">Ninguna categoría coincide.</p>';
}

/** Mueve la categoría `from` a la posición `to` (índices de groups()). Una sección se mueve
 *  entera (el separador y sus categorías) y cae antes o después de otra sección, sin partirla. */
function moveGroup(from: number, to: number) {
  if (from === to) return;
  const list = groups();
  const headers = sectionHeaders();
  if (!headers.has(list[from])) {
    const [g] = list.splice(from, 1);
    list.splice(to, 0, g);
    editGroups((gr) => { gr.order = list; }, `${g} movida`);
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
  editGroups((gr) => { gr.order = rest; }, `Sección ${sectionTitle(list[from])} movida`);
}

/** Arrastrar desde la manija (mouse o dedo): la fila sigue al puntero y las demás se corren. */
function setupCategoryDrag(box: HTMLElement) {
  box.addEventListener('pointerdown', (ev) => {
    const handle = (ev.target as HTMLElement).closest<HTMLElement>('.drag-handle');
    if (!handle || ev.button !== 0) return;
    ev.preventDefault();
    const row = handle.closest<HTMLElement>('.cat-row')!;
    const rows = $$<HTMLElement>('.cat-row', box);
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
      moveGroup(Number(rows[from].dataset.g), Number(rows[to].dataset.g));
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
    const i = Number(handle.closest<HTMLElement>('[data-g]')!.dataset.g);
    const list = groups();
    const headers = sectionHeaders();
    let j = i + (ev.key === 'ArrowUp' ? -1 : 1);
    // Una sección baja saltando la siguiente entera.
    if (ev.key === 'ArrowDown' && headers.has(list[i])) while (j < list.length && !headers.has(list[j])) j++;
    if (j < 0 || j >= list.length) return;
    const moved = list[i];
    moveGroup(i, j);
    const k = groups().indexOf(moved);
    $<HTMLElement>(`.cat-row[data-g="${k}"] .drag-handle`, box)?.focus();
  });
}

function setupCategories() {
  const box = $('#categoriesList');
  setupCategoryDrag(box);
  $<HTMLInputElement>('#categoriesFilter').oninput = () => renderCategories();
  box.onclick = (ev) => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>('.noepg-btn');
    if (!chip) return;
    const g = groups()[Number(chip.closest<HTMLElement>('[data-g]')!.dataset.g)];
    const on = !state.cfg!.groups.noEpg?.includes(g);
    editGroups((gr) => {
      const noEpg = new Set(gr.noEpg ?? []);
      if (on) noEpg.add(g);
      else noEpg.delete(g);
      gr.noEpg = [...noEpg];
    }, on ? `${g}: sin guía` : `${g} vuelve a necesitar guía`);
  };
  box.onchange = (ev) => {
    const input = ev.target as HTMLInputElement;
    const g = groups()[Number(input.closest<HTMLElement>('[data-g]')!.dataset.g)];
    editGroups((gr) => {
      const hidden = new Set(gr.hidden);
      if (input.checked) hidden.delete(g);
      else hidden.add(g);
      gr.hidden = [...hidden];
    }, input.checked ? `${g} visible en la playlist` : `${g} oculta de la playlist`);
  };
}

// ------------------------------------------------------------------ links
function renderLinks(result?: { playlistUrl: string; epgUrl: string }) {
  const p = state.cfg!.provider;
  const body = $('#linksBody');
  if (!result) {
    const needsCreds = !state.creds;
    body.innerHTML = `
      <p>Los links llevan tus datos del proveedor cifrados: el servidor no los guarda. Si cambiás
        la contraseña del proveedor, generalos de nuevo.</p>
      ${needsCreds && p.type === 'xtream' ? `
        <label class="field"><span>Usuario</span><input class="input" id="lnkUser" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Contraseña</span><input class="input" id="lnkPass" type="password"></label>` : ''}
      ${needsCreds && p.type === 'm3u' ? '<label class="field"><span>URL de la lista</span><input class="input" id="lnkUrl" type="url"></label>' : ''}
      <button type="button" class="btn btn-primary btn-block" id="makeLinks">${icon('tv')}Generar links</button>`;
    $('#makeLinks').onclick = async () => {
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
        const r = await api<{ playlistUrl: string; epgUrl: string }>(`/api/cfg/${state.local!.cfgId}/token`, { method: 'POST', body: creds });
        state.creds = creds;
        renderLinks(r);
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    };
    return;
  }
  const row = (label: string, url: string, id: string) => `
    <label class="field"><span>${label}</span>
      <div class="inline-field"><input class="input mono" id="${id}" readonly value="${esc(url)}">
        <button type="button" class="icon-btn" data-copy="${id}" aria-label="Copiar">${icon('copy')}</button></div></label>`;
  body.innerHTML = `
    ${row('Playlist (M3U)', result.playlistUrl, 'lnkPlaylist')}
    ${row('Guía (EPG)', result.epgUrl, 'lnkEpg')}
    <div class="qr" id="qr"></div>
    <p class="help">En TiviMate: Agregar playlist → Ingresar URL → la de arriba; la guía la toma sola
      (si no, agregala en Ajustes → EPG). Los cambios que guardes llegan a la playlist al
      instante y a la guía en unos minutos. Los links no cambian: no hace falta volver a
      cargarlos en el reproductor.</p>
    <p class="help">Son links inadivinables pero no privados: quien los tenga puede ver tus canales. No
      los publiques.</p>`;
  body.onclick = async (ev) => {
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
    showEditor();
    toast(`${channels.length} canales cargados`, 'ok');
  } catch (e) {
    status(st, `No se pudo: ${(e as Error).message}`, 'bad');
  }
}

function setupOnboarding() {
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
  state.shown = PAGE;
  render();
  refreshGuideStatus();
}

async function openSaved() {
  const st = $('#status');
  $('#onboarding').hidden = true;
  $('#editor').hidden = false;
  const say = (t: string) => status(st, t);
  try {
    say('Abriendo tu configuración…');
    const cfg = await api<Config>(`/api/cfg/${state.local!.cfgId}`);
    cfg.groups = { order: cfg.groups?.order ?? [], hidden: cfg.groups?.hidden ?? [], noEpg: cfg.groups?.noEpg ?? [] };
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
    if (await rematch(say)) await saveNow();
    status(st, null);
    render();
    refreshGuideStatus();
  } catch (e) {
    const msg = (e as Error).message;
    if (/inexistente|clave/.test(msg)) {
      status(st, null);
      toast(`Tu configuración ya no está (${msg}). Empezá de nuevo o importá un respaldo.`, 'bad', 8000);
      saveLocal((state.local = null));
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
    const data = await res.json() as { channels: Record<string, ChannelEdit>; groups: { order: string[]; hidden: string[]; noEpg?: string[] } };
    // Todo lo importado queda fijo (elegido a mano): así la playlist queda igual que la de
    // GitHub, que elige el EPG con tus reglas por sección. Los canales nuevos del proveedor
    // siguen tomando el EPG automático.
    const channels: Record<string, ChannelEdit> = {};
    for (const [name, edit] of Object.entries(data.channels ?? {})) {
      channels[name] = 'epg' in edit ? { ...edit, manual: true } : { ...edit };
    }
    state.cfg!.channels = channels;
    state.cfg!.groups = { order: data.groups?.order ?? [], hidden: data.groups?.hidden ?? [], noEpg: data.groups?.noEpg ?? [] };
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
  $('#loadMoreBtn').onclick = () => {
    state.shown += PAGE;
    render();
  };
  $('#categoriesBtn').onclick = () => {
    $<HTMLInputElement>('#categoriesFilter').value = '';
    renderCategories();
    ($('#categoriesDialog') as HTMLDialogElement).showModal();
  };
  setupCategories();
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
    $<HTMLInputElement>('#lenientToggle').checked = !!state.local?.lenient;
    $<HTMLInputElement>('#logosToggle').checked = logosOn();
    $<HTMLSelectElement>('#startFilterSelect').value = pref('grilla_start_filter', 'last');
    ($('#settingsDialog') as HTMLDialogElement).showModal();
  };
  $('#reloadListBtn').onclick = () => {
    ($('#settingsDialog') as HTMLDialogElement).close();
    showOnboarding(true);
  };
  $<HTMLInputElement>('#lenientToggle').onchange = async (ev) => {
    state.local = { ...state.local!, lenient: (ev.target as HTMLInputElement).checked };
    saveLocal(state.local);
    if (await rematch(() => {})) await saveNow();
    render();
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
    state.cfg = null;
    ($('#settingsDialog') as HTMLDialogElement).close();
    showOnboarding();
  };
  const theme = (() => {
    try {
      return localStorage.getItem('grilla_theme') || 'auto';
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

// ------------------------------------------------------------------ arranque
hydrateIcons();
$('#askCancel').onclick = () => ($('#askDialog') as HTMLDialogElement).close('');
setupOnboarding();
setupEditor();
if (state.local) openSaved();
else showOnboarding();
