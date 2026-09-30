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
  groups: { order: string[]; hidden: string[] };
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

function toast(text: string, kind: 'ok' | 'bad' | 'info' = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'circle-check' : kind === 'bad' ? 'circle-x' : 'info')}<span class="msg">${esc(text)}</span>`;
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

// ------------------------------------------------------------------ estado
const state = {
  local: loadLocal() as Local | null,
  cfg: null as Config | null,
  channels: [] as Channel[],
  index: null as EpgIndex | null,
  rules: null as MatchingRules | null,
  auto: new Map<string, Auto>(),
  creds: null as Creds | null, // solo en memoria, para generar los links sin volver a pedirlos
  filter: 'todos',
  search: '',
  shown: PAGE,
  reloading: false,
};

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
  } catch (e) {
    toast(`No se pudo guardar: ${(e as Error).message}`, 'bad', 6000);
  }
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
  const suggestion = !epg && !edit.manual ? auto?.ranked.find((c) => c.nameScore >= 0.3) ?? null : null;
  return { edit, auto, epg, hidden, band, suggestion };
}

function matchesFilter(ch: Channel, filter: string) {
  const i = info(ch);
  switch (filter) {
    case 'revisar': return !i.hidden && (i.band === 'warn' || (i.band === 'none' && !!i.suggestion));
    case 'sin-epg': return !i.hidden && !i.epg;
    case 'manual': return i.band === 'manual';
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

function epgRowHtml(id: string, extra = ''): string {
  const idx = state.index;
  const name = idx?.displayName.get(id) ?? id;
  const country = idx?.country.get(id);
  const source = idx?.source.get(id);
  return `<div class="epg-row"><div class="epg-head"><span class="epg-name">${esc(name)}${country ? ` [${esc(country.toUpperCase())}]` : ''}</span>${extra}</div>`
    + `<small class="epg-src">${esc(id)}${source ? ` · ${esc(source)}` : ''}</small></div>`;
}

function cardHtml(i: number): string {
  const ch = state.channels[i];
  const { edit, epg, hidden, band, suggestion } = info(ch);
  const shown = edit.name || stripDisplayPrefix(ch.name, state.rules!)[0];
  let body: string;
  if (epg) body = epgRowHtml(epg);
  else if (edit.manual) body = '<div class="card-note">Sin EPG, a propósito.</div>';
  else if (suggestion) body = `<div class="card-note">Sin EPG asignado. Sugerencia: <b>${esc(state.index?.displayName.get(suggestion.channelId) ?? suggestion.channelId)}</b></div>`;
  else body = '<div class="card-note">Sin EPG asignado.</div>';
  return `<article class="card${hidden ? ' is-hidden' : ''}" data-i="${i}">
    <div class="card-top">
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
  $('#loadMoreBtn').hidden = list.length <= state.shown;
  renderStatusLine();
}

// ------------------------------------------------------------------ canal: diálogo
function candidateButton(id: string, score?: number) {
  const pct = score === undefined ? '' : `<span class="muted">${Math.round(Math.min(score, 1) * 100)} %</span>`;
  return `<button type="button" class="pick-row" data-pick="${esc(id)}">${epgRowHtml(id, pct)}</button>`;
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
    <label class="search-field">${icon('search')}<input type="search" class="catalog-search" placeholder="Nombre del canal" enterkeyhint="search"></label>
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
  const update = (fn: (e: ChannelEdit) => void, msg?: string) => {
    const e = { ...(state.cfg!.channels[ch.name] ?? {}) };
    fn(e);
    setEdit(ch.name, e);
    scheduleSave();
    render();
    if (msg) toast(msg, 'ok');
  };
  const pick = (id: string) => update((e) => {
    e.epg = id;
    e.manual = true;
    const logo = state.index?.icon.get(id);
    if (logo) e.logo = logo;
    else delete e.logo;
  }, 'EPG elegido');

  body.onclick = (ev) => {
    const t = ev.target as HTMLElement;
    const pickBtn = t.closest<HTMLElement>('[data-pick]');
    if (pickBtn) {
      pick(pickBtn.dataset.pick!);
      ($('#channelDialog') as HTMLDialogElement).close();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'auto') {
      const a = state.auto.get(ch.name);
      update((e) => {
        delete e.manual;
        e.epg = a?.cid ?? undefined;
        e.logo = a?.cid ? state.index?.icon.get(a.cid) : undefined;
      }, 'Volvió al EPG automático');
      openChannel(i);
    } else if (act === 'no-epg') {
      update((e) => {
        e.epg = null;
        e.manual = true;
        delete e.logo;
      }, 'Quedó sin EPG');
      openChannel(i);
    } else if (act === 'rename') {
      const v = $<HTMLInputElement>('.rename', body).value.trim();
      update((e) => { e.name = v || undefined; }, v ? 'Nombre guardado' : 'Vuelve al nombre del proveedor');
    }
  };
  const search = $<HTMLInputElement>('.catalog-search', body);
  search.oninput = () => {
    const q = fold(search.value.trim());
    const results = $('.search-results', body);
    results.hidden = q.length < 2;
    if (results.hidden) return;
    const hits: string[] = [];
    for (const [id, name] of state.index!.displayName) {
      if (fold(name).includes(q) || fold(id).includes(q)) hits.push(id);
      if (hits.length >= 40) break;
    }
    results.innerHTML = hits.length ? hits.map((id) => candidateButton(id)).join('') : '<div class="list-note">Sin resultados</div>';
  };
  $<HTMLSelectElement>('.move', body).onchange = (ev) => {
    const sel = ev.target as HTMLSelectElement;
    let target = sel.value;
    if (target === '__new__') {
      target = (prompt('Nombre de la categoría nueva') ?? '').trim();
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

// ------------------------------------------------------------------ categorías
function renderCategories() {
  const list = groups();
  const hidden = new Set(state.cfg!.groups.hidden);
  const counts = new Map<string, number>();
  for (const ch of state.channels) counts.set(groupOf(ch), (counts.get(groupOf(ch)) ?? 0) + 1);
  $('#categoriesList').innerHTML = list.map((g, i) => `
    <div class="menu-row static cat-row" data-g="${i}">
      <span class="menu-text">${esc(g)}<small>${counts.get(g) ?? 0} canales</small></span>
      <button type="button" class="icon-btn ghost sm" data-move="-1" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
      <button type="button" class="icon-btn ghost sm" data-move="1" aria-label="Bajar" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
      <input type="checkbox" class="switch" aria-label="Visible" ${hidden.has(g) ? '' : 'checked'}>
    </div>`).join('');
}

function setupCategories() {
  const box = $('#categoriesList');
  box.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-move]');
    if (!btn) return;
    const list = groups();
    const i = Number(btn.closest<HTMLElement>('[data-g]')!.dataset.g);
    const j = i + Number(btn.dataset.move);
    [list[i], list[j]] = [list[j], list[i]];
    state.cfg!.groups.order = list;
    scheduleSave();
    renderCategories();
    render();
  };
  box.onchange = (ev) => {
    const input = ev.target as HTMLInputElement;
    const g = groups()[Number(input.closest<HTMLElement>('[data-g]')!.dataset.g)];
    const hidden = new Set(state.cfg!.groups.hidden);
    if (input.checked) hidden.delete(g);
    else hidden.add(g);
    state.cfg!.groups.hidden = [...hidden];
    scheduleSave();
    render();
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
      (si no, agregala en Ajustes → EPG). La guía se arma una vez por día, a las 14:30 (hora de
      Argentina): después de guardar cambios, el link de la guía los muestra desde la próxima.</p>
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
    say(`Tu proveedor no deja que Grilla baje la lista, así que la baja GitHub: tarda hasta 10–15 minutos${minutes ? ` (van ${minutes})` : ''}. Podés cerrar esta página y volver más tarde.`);
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
}

async function openSaved() {
  const st = $('#status');
  $('#onboarding').hidden = true;
  $('#editor').hidden = false;
  const say = (t: string) => status(st, t);
  try {
    say('Abriendo tu configuración…');
    const cfg = await api<Config>(`/api/cfg/${state.local!.cfgId}`);
    cfg.groups = { order: cfg.groups?.order ?? [], hidden: cfg.groups?.hidden ?? [] };
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
  $('#cards').onclick = (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (card) openChannel(Number(card.dataset.i));
  };
  $('#loadMoreBtn').onclick = () => {
    state.shown += PAGE;
    render();
  };
  $('#categoriesBtn').onclick = () => {
    renderCategories();
    ($('#categoriesDialog') as HTMLDialogElement).showModal();
  };
  setupCategories();
  $('#linksBtn').onclick = () => {
    renderLinks();
    ($('#linksDialog') as HTMLDialogElement).showModal();
  };
  $('#settingsBtn').onclick = () => {
    $<HTMLInputElement>('#lenientToggle').checked = !!state.local?.lenient;
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
  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $<HTMLInputElement>('#backupFile').click();
  $<HTMLInputElement>('#backupFile').onchange = (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) importBackup(f);
  };
  $('#forgetBtn').onclick = async () => {
    if (!confirm('¿Borrar tu configuración? Tus links de reproducción dejan de funcionar.')) return;
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
setupOnboarding();
setupEditor();
if (state.local) openSaved();
else showOnboarding();
