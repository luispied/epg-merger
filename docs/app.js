// @ts-check
/* Interfaz de corrección de EPG (docs/). Lee los reportes que publica el workflow en la branch
   "data" y guarda los cambios (overrides de EPG, renombrados, categorías, ocultos) como commits
   a xtream_channel_map.json usando la API de GitHub desde el navegador. */
(() => {
  'use strict';

  // ================================================================= configuración

  const REPO = 'luispied/epg-merger';
  const API = `https://api.github.com/repos/${REPO}`;
  const RAW_MAP_URL = `https://raw.githubusercontent.com/${REPO}/main/xtream_channel_map.json`;
  // epg_catalog.json y match_report-<perfil>.json no viven en el release: sus assets se sirven
  // vía un redirect a Azure Blob que no manda cabecera CORS, así que fetch() desde acá los
  // bloquea (confirmado). raw.githubusercontent.com sí manda Access-Control-Allow-Origin, así
  // que el workflow los publica además en esta branch aparte (force-push, sin credenciales).
  const DATA_BRANCH = 'data';
  const DATA_RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${DATA_BRANCH}`;
  const MAP_PATH = 'xtream_channel_map.json';
  const WORKFLOW_FILE = 'merge-epgs.yml';
  const TOKEN_KEY = 'epg_admin_pat';
  const FILTER_KEY = 'epg_ui_filter';

  const MIN_SCORE = 0.45;
  const PAGE_SIZE = 60;
  const SEARCH_LIMIT = 50;
  const SCHEDULE_HOURS = 30;  // ventana que publica generate_playlist.py (SCHEDULE_WINDOW_FUTURE)

  // Mismo criterio que generate_playlist.is_divider_category: los separadores decorativos del
  // proveedor no son categorías reales, no se ofrecen como destino ni se pueden mover.
  const DIVIDER_RE = /[▆░▒▓█]/;
  // Los eventos de PPV son transmisiones puntuales que ningún EPG público cubre: se filtran
  // antes de cualquier conteo o pestaña. Excepción: PPV DAZN, que son canales fijos.
  const PPV_SECTION = 'PPV EVENTS';
  const PPV_EDITABLE_CATEGORIES = new Set(['PPV DAZN']);
  // No entran en "A revisar" (siguen en "Sin EPG" y "Todos"): "General" es donde caen los canales
  // sin categoría en Xtream (sobre todo eventos sueltos) y 24/7 son series/películas en loop.
  const REVIEW_EXCLUDED_CATEGORIES = new Set(['General']);
  const REVIEW_EXCLUDED_SECTIONS = new Set(['24/7']);

  // Mensajes de commit por sección de xtream_channel_map.json (ver setEntry).
  const EDIT_SECTIONS = ['renames', 'categories', 'hidden'];

  // ================================================================= estado

  /** @type {CatalogEntry[]} */
  let catalog = [];
  /** @type {Map<string, CatalogEntry>} */
  let catalogById = new Map();
  /** @type {ChannelMap} */
  let channelMap = { overrides: {} };
  /** @type {Record<string, string>} nombre de perfil -> URL raw de su match_report */
  let profiles = {};
  // Los perfiles solo difieren en credenciales (mismos canales, mismo EPG, y los cambios de acá
  // son compartidos), así que se muestra siempre el primero.
  /** @type {string | null} */
  let currentProfile = null;
  /** @type {Date | null} fecha del último commit de la branch "data" */
  let dataGeneratedAt = null;
  /** @type {ReportChannel[]} reporte completo (incluye PPV) */
  let allChannels = [];
  /** @type {ReportChannel[]} lo que se muestra */
  let currentChannels = [];
  /** @type {ReportChannel[]} */
  let filtered = [];
  let rendered = 0;
  let searchTerm = '';
  let activeFilter = storageGet(FILTER_KEY) || 'revisar';
  let pendingChanges = 0;       // commits a MAP_PATH desde la última corrida del workflow
  // raw.githubusercontent.com cachea unos minutos por URL: este sufijo cambia al actualizar datos.
  let dataNonce = Date.now();

  // ================================================================= utilidades

  // Los elementos que se buscan siempre existen (los arma esta misma página): se tipan como any
  // para no llenar el código de chequeos de null que nunca fallan.
  /** @type {(sel: string, root?: ParentNode) => any} */
  const $ = (sel, root = document) => root.querySelector(sel);
  /** @type {(sel: string, root?: ParentNode) => any[]} */
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

  /** Mensaje legible de cualquier cosa atrapada en un catch. @param {unknown} e */
  const errMsg = (e) => (e instanceof Error ? e.message : String(e));

  /** @param {unknown} s */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function normalize(s) {
    return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* sin storage: queda solo en esta sesión */ }
  }

  function fmtDateTime(d) {
    return new Date(d).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtTime(d) {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Íconos SVG de icons.js (Lucide), con el trazo y color del texto que los rodea.
  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`
      + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.ICONS[name] || ''}</svg>`;
  }

  function hydrateIcons(root = document) {
    $$('[data-icon]', root).forEach((el) => { el.outerHTML = icon(el.dataset.icon, el.className); });
  }

  // ================================================================= red

  /** @param {string} url @returns {Promise<any>} */
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer ${(url.split('/').pop() || url).split('?')[0]} (HTTP ${res.status})`);
    return res.json();
  }

  function getToken() {
    return storageGet(TOKEN_KEY) || '';
  }

  // Único punto de acceso a la API de GitHub. auth: 'none' (datos públicos: un token vencido no
  // debe romper la carga), 'optional' (mejor rate limit si hay token) o 'required' (escribir).
  /**
   * @param {string} path ruta de la API relativa al repo (ej. "/contents/…")
   * @param {{ method?: string, body?: any, auth?: 'none' | 'optional' | 'required' }} [opts]
   * @returns {Promise<any>}
   */
  async function gh(path, { method = 'GET', body = undefined, auth = 'optional' } = {}) {
    const token = getToken();
    if (auth === 'required' && !token) {
      openTokenDialog();
      throw new Error('Falta el token de GitHub');
    }
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/vnd.github+json' };
    if (token && auth !== 'none') headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* sin cuerpo */ }
      const messages = {
        401: 'El token de GitHub no es válido o venció.',
        403: 'Al token le falta permiso para esto.',
        409: 'El archivo cambió mientras guardabas. Probá de nuevo.',
      };
      /** @type {Record<number, string>} */
      const byStatus = messages;
      const err = /** @type {GitHubError} */ (new Error(byStatus[res.status] || `GitHub respondió ${res.status}${detail ? ': ' + detail : ''}`));
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function b64encode(text) {
    let bin = '';
    for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
    return btoa(bin);
  }

  // ================================================================= catálogo y programación

  /** @param {string} id @returns {CatalogEntry} */
  function catalogEntry(id) {
    return catalogById.get(id) || { id, name: id, country: null, source: null };
  }

  // channel_id -> Promise<[[start, stop, title], ...] | null>, bajo demanda y cacheado.
  const scheduleCache = new Map();
  function fetchSchedule(channelId) {
    if (!scheduleCache.has(channelId)) {
      const c = catalogEntry(channelId);
      scheduleCache.set(channelId, c.sched
        ? getJSON(`${DATA_RAW_BASE}/schedule/${c.sched}.json?_=${dataNonce}`).catch(() => null)
        : Promise.resolve(null));
    }
    return scheduleCache.get(channelId);
  }

  // Índice de la hora UTC actual (schedule/hour/<AAAAMMDDHH>.json): qué da TODO el catálogo en
  // esta hora, en un solo archivo. null si no está publicado: se cae al archivo por canal.
  const hourIndexCache = new Map();
  function fetchHourIndex() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const key = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
    if (!hourIndexCache.has(key)) {
      hourIndexCache.set(key, getJSON(`${DATA_RAW_BASE}/schedule/hour/${key}.json?_=${dataNonce}`).catch(() => null));
    }
    return hourIndexCache.get(key);
  }

  /** Lo que está en el aire ahora según el índice por hora, o null.
   *  @param {HourIndex} idx @param {string} channelId @returns {NowPlaying | null} */
  function nowFromHourIndex(idx, channelId) {
    const now = Date.now() / 1000;
    for (const [s, e, t] of idx.c[channelId] || []) {
      if (idx.h + s * 60 <= now && now < idx.h + e * 60) return { title: idx.t[t], stop: idx.h + e * 60 };
    }
    return null;
  }

  /** @param {[number, number, string][] | null} entries @returns {NowPlaying | null} */
  function nowFromEntries(entries) {
    const now = Date.now() / 1000;
    const cur = (entries || []).find(([start, stop]) => start <= now && now < stop);
    return cur ? { title: cur[2], stop: cur[1] } : null;
  }

  /** @param {NowPlaying | null} cur @param {string} [note] */
  function nowHtml(cur, note = '') {
    const noteHtml = note ? ` <span class="note">${esc(note)}</span>` : '';
    return cur
      ? `${icon('tv', 'sm')}<span>Ahora: ${esc(cur.title)} · hasta ${fmtTime(cur.stop * 1000)}${noteHtml}</span>`
      : `<span>Sin programación para este horario${noteHtml}</span>`;
  }

  async function loadNowPlayingInto(el, channelId) {
    const idx = await fetchHourIndex();
    const cur = idx ? nowFromHourIndex(idx, channelId) : nowFromEntries(await fetchSchedule(channelId));
    el.innerHTML = nowHtml(cur);
    el.classList.toggle('on-air', !!cur);
  }

  function fillNowPlaying(root) {
    $$('.epg-now[data-now-for]', root).forEach((el) => {
      const id = el.dataset.nowFor;
      el.removeAttribute('data-now-for');
      loadNowPlayingInto(el, id);
    });
  }

  // ================================================================= modelo de canal

  const isDivider = (ch) => DIVIDER_RE.test(ch.category);
  const isHidden = (ch) => !!(channelMap.hidden || {})[ch.xtream_name];
  const renameOf = (ch) => (channelMap.renames || {})[ch.xtream_name] || null;
  const hasOverride = (ch) => has(channelMap.overrides, ch.xtream_name);

  function movedCategoryOf(ch) {
    const moved = (channelMap.categories || {})[ch.xtream_name];
    return moved && moved !== ch.category ? moved : null;
  }

  const effectiveCategory = (ch) => movedCategoryOf(ch) || ch.category;

  function effectiveSection(ch) {
    const moved = movedCategoryOf(ch);
    return moved ? sectionOfCategory.get(moved) : ch.section;
  }

  // EPG vigente: lo guardado a mano manda sobre el reporte, que recién se actualiza al correr el
  // workflow. null = sin EPG (a propósito o no).
  const currentEpgOf = (ch) => (hasOverride(ch) ? channelMap.overrides[ch.xtream_name] : ch.chosen);

  const isEdited = (ch) => !!(renameOf(ch) || movedCategoryOf(ch) || isHidden(ch));

  // Categorías reales (sin separadores) agrupadas por sección, para el desplegable de "Más".
  let categoryGroupsHtml = '';
  let sectionOfCategory = new Map();

  function buildCategoryGroups() {
    const bySection = new Map();
    sectionOfCategory = new Map();
    for (const ch of allChannels) {
      if (isDivider(ch)) continue;
      sectionOfCategory.set(ch.category, ch.section);
      const sec = ch.section || 'Sin sección';
      if (!bySection.has(sec)) bySection.set(sec, new Set());
      bySection.get(sec).add(ch.category);
    }
    const collator = new Intl.Collator('es');
    categoryGroupsHtml = [...bySection.keys()].sort(collator.compare).map((sec) => {
      const opts = [...bySection.get(sec)].sort(collator.compare)
        .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      return `<optgroup label="${esc(sec)}">${opts}</optgroup>`;
    }).join('');
  }

  function categoryOptions(ch) {
    const current = effectiveCategory(ch);
    let html = categoryGroupsHtml
      .replace(`<option value="${esc(current)}">`, `<option value="${esc(current)}" selected>`)
      .replace(`>${esc(ch.category)}</option>`, `>${esc(ch.category)} (original)</option>`);
    // Destino que ya no existe en el proveedor: se muestra igual para no perderlo de vista.
    if (!html.includes(`value="${esc(current)}"`)) {
      html = `<option value="${esc(current)}" selected>${esc(current)}</option>` + html;
    }
    return html;
  }

  // ================================================================= componentes

  /**
   * @param {string} kind ok | warn | bad | manual | muted
   * @param {string} text
   * @param {{ iconName?: string | null, title?: string }} [opts]
   */
  function tag(kind, text, { iconName = null, title = '' } = {}) {
    return `<span class="tag ${kind}${iconName ? ' with-icon' : ''}"${title ? ` title="${esc(title)}"` : ''}>`
      + `${iconName ? icon(iconName, 'sm') : ''}${esc(text)}</span>`;
  }

  // Calidad de un match, misma escala en todos lados (el número queda en el tooltip).
  function scoreTag(score) {
    const title = `Coincidencia ${score.toFixed(2)}`;
    if (score >= 0.8) return tag('ok', 'Bien', { title });
    if (score >= MIN_SCORE) return tag('warn', 'Dudoso', { title });
    return tag('bad', 'Débil', { title });
  }

  function qualityTag(ch) {
    if (hasOverride(ch)) {
      return channelMap.overrides[ch.xtream_name] === null
        ? tag('muted', 'Sin EPG', { iconName: 'ban', title: 'Elegiste dejarlo sin EPG' })
        : tag('manual', 'Manual', { iconName: 'hand', title: 'EPG elegido a mano' });
    }
    return ch.chosen ? scoreTag(ch.score) : tag('bad', 'Sin EPG');
  }

  // Un canal del EPG se muestra siempre igual (tarjeta, alternativas, búsqueda). `cur` = lo que
  // está dando ahora si ya se sabe; si es undefined se completa después con fillNowPlaying().
  /**
   * @param {string} id channel_id del EPG
   * @param {{ score?: number | null, pick?: boolean, cur?: NowPlaying | null, note?: string }} [opts]
   */
  function epgRowHtml(id, { score = null, pick = false, cur = undefined, note = '' } = {}) {
    const c = catalogEntry(id);
    const known = cur !== undefined;
    const pickAttrs = pick ? ` data-id="${esc(id)}" role="button" tabindex="0"` : '';
    return `<div class="epg-row${pick ? ' pick' : ''}"${pickAttrs}>
      <div class="epg-head">
        <span class="epg-name">${esc(c.name)}${c.country ? ' [' + esc(c.country.toUpperCase()) + ']' : ''}</span>
        ${score === null ? '' : scoreTag(score)}
      </div>
      <small class="epg-src">${esc(c.id)}${c.source ? ' · ' + esc(c.source) : ''}</small>
      <div class="epg-now${known && cur ? ' on-air' : ''}"${known ? '' : ` data-now-for="${esc(id)}"`}>${
        known ? nowHtml(cur, note) : '<span>Cargando programación…</span>'}</div>
    </div>`;
  }

  function wirePicks(root, onPick) {
    $$('.epg-row.pick', root).forEach((row) => {
      row.addEventListener('click', () => onPick(row.dataset.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPick(row.dataset.id); });
    });
  }

  function skeletonHtml(n = 4) {
    return '<div class="skeleton"><div class="bar w60"></div><div class="bar w40"></div><div class="bar block"></div></div>'.repeat(n);
  }

  const EMPTY_STATES = {
    revisar: ['Nada para revisar', 'Todos los canales tienen un EPG confiable.'],
    'sin-epg': ['Todos tienen EPG', 'No quedan canales sin guía asignada.'],
    override: ['Sin EPG manual', 'Todavía no elegiste ningún EPG a mano.'],
    editados: ['Sin ediciones', 'No renombraste, moviste ni ocultaste canales.'],
    ocultos: ['Nada oculto', 'Todos los canales están visibles en la playlist.'],
  };

  function emptyHtml() {
    const [title, text] = (!searchTerm && EMPTY_STATES[activeFilter])
      || ['Sin resultados', 'Probá con otra búsqueda o con otro filtro.'];
    return `<div class="empty">${icon('inbox', 'lg')}<strong>${esc(title)}</strong>${esc(text)}</div>`;
  }

  // ================================================================= toasts y diálogos

  const toastsEl = $('#toasts');
  const TOAST_ICONS = { success: 'circle-check', error: 'circle-x', info: 'info', busy: 'loader-circle' };

  // kind: success | error | info | busy. Un `id` reemplaza el toast anterior con ese id (ej.
  // "Guardando…" -> "✓ Guardado"). `action`: {label, fn}, p. ej. Deshacer.
  /**
   * @param {string} text
   * @param {{ kind?: 'success' | 'error' | 'info' | 'busy', action?: { label: string, fn: () => unknown } | null,
   *           sticky?: boolean, id?: string | null }} [opts]
   */
  function toast(text, { kind = 'success', action = null, sticky = kind === 'busy', id = null } = {}) {
    let el = id ? $(`[data-toast-id="${id}"]`, toastsEl) : null;
    if (!el) {
      el = document.createElement('div');
      if (id) el.dataset.toastId = id;
      toastsEl.prepend(el);
      while (toastsEl.children.length > 3) toastsEl.lastElementChild.remove();
    }
    clearTimeout(el.timer);
    el.className = `toast ${kind === 'busy' ? 'info' : kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(TOAST_ICONS[kind], kind === 'busy' ? 'spin' : '')}<span class="msg">${esc(text)}</span>`
      + (action ? `<button class="btn btn-plain">${esc(action.label)}</button>` : '');
    if (action) {
      $('button', el).addEventListener('click', () => { dismissToast(el); action.fn(); });
    }
    if (!sticky) el.timer = setTimeout(() => dismissToast(el), action ? 7000 : 3500);
    return el;
  }

  function dismissToast(el) {
    el.removeAttribute('data-toast-id'); // que un toast nuevo con el mismo id no lo reutilice
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  }

  // Reemplazo de confirm() con el estilo de la página. -> Promise<boolean>
  /** @param {{ title: string, text: string, ok?: string }} opts @returns {Promise<boolean>} */
  function confirmDialog({ title, text, ok = 'Aceptar' }) {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = ok;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    });
  }

  // ================================================================= carga de datos

  async function loadRelease() {
    const listing = await gh(`/contents?ref=${DATA_BRANCH}`, { auth: 'none' });
    const names = new Set(listing.map((f) => f.name));
    if (!names.has('epg_catalog.json')) {
      throw new Error('La branch "data" todavía no tiene epg_catalog.json: esperá a que corra el workflow.');
    }
    catalog = await getJSON(`${DATA_RAW_BASE}/epg_catalog.json?_=${dataNonce}`);
    catalogById = new Map(catalog.map((c) => [c.id, c]));

    profiles = {};
    for (const name of names) {
      const m = name.match(/^match_report-(.+)\.json$/);
      if (m) profiles[m[1]] = `${DATA_RAW_BASE}/${name}`;
    }

    try {
      const commit = await gh(`/commits/${DATA_BRANCH}`, { auth: 'none' });
      dataGeneratedAt = new Date(commit.commit.committer.date);
    } catch {
      dataGeneratedAt = null;
    }

    try {
      channelMap = await getJSON(`${RAW_MAP_URL}?_=${Date.now()}`);
    } catch {
      channelMap = { overrides: {} };
    }
    if (!channelMap.overrides) channelMap.overrides = {};
  }

  async function loadProfile(name) {
    currentProfile = name;
    const data = await getJSON(`${profiles[name]}?_=${dataNonce}`);
    allChannels = data.channels || [];
    buildCategoryGroups();
    currentChannels = allChannels.filter(
      (ch) => ch.section !== PPV_SECTION || PPV_EDITABLE_CATEGORIES.has(ch.category));
    applyFilters();
  }

  async function refreshData() {
    const btn = $('#refreshDataBtn');
    btn.disabled = true;
    cardsEl.innerHTML = skeletonHtml();
    try {
      dataNonce = Date.now();
      scheduleCache.clear();
      hourIndexCache.clear();
      await loadRelease();
      await loadProfile(currentProfile);
      pollWorkflow();
      toast('Datos actualizados');
    } catch (e) {
      cardsEl.innerHTML = '';
      toast(errMsg(e), { kind: 'error' });
    } finally {
      btn.disabled = false;
    }
  }

  // ================================================================= filtros y lista

  const cardsEl = $('#cards');
  const statusLine = $('#statusLine');
  const loadMoreBtn = $('#loadMoreBtn');
  const searchBox = $('#searchBox');
  const filterTabs = $('#filterTabs');

  function matchesFilter(ch, filter = activeFilter) {
    if (filter === 'ocultos') return isHidden(ch);
    if (filter === 'editados') return isEdited(ch);
    if (filter === 'override') return hasOverride(ch);
    if (filter === 'todos') return true;
    // "Sin EPG" y "A revisar": un oculto ya se decidió, un separador nunca lleva EPG y uno con
    // EPG manual ya se revisó.
    if (isHidden(ch) || isDivider(ch) || hasOverride(ch)) return false;
    if (filter === 'sin-epg') return !ch.chosen;
    if (REVIEW_EXCLUDED_CATEGORIES.has(effectiveCategory(ch))
        || REVIEW_EXCLUDED_SECTIONS.has(effectiveSection(ch))) return false;
    return !ch.chosen || ch.score < 0.8 || ch.reason === 'xtream_epg_id';
  }

  function matchesSearch(ch) {
    if (!searchTerm) return true;
    return normalize(`${ch.xtream_name} ${renameOf(ch) || ''} ${effectiveCategory(ch)} ${ch.section || ''}`)
      .includes(searchTerm);
  }

  function updateFilterCounts() {
    const tabs = $$('button', filterTabs);
    const counts = Object.fromEntries(tabs.map((b) => [b.dataset.filter, 0]));
    for (const ch of currentChannels) {
      for (const f in counts) if (matchesFilter(ch, f)) counts[f]++;
    }
    for (const b of tabs) {
      b.innerHTML = `${esc(b.dataset.label)}<span class="count">${counts[b.dataset.filter]}</span>`;
      b.setAttribute('aria-pressed', String(b.dataset.filter === activeFilter));
    }
  }

  function applyFilters() {
    updateFilterCounts();
    filtered = currentChannels.filter((ch) => matchesFilter(ch) && matchesSearch(ch));
    rendered = 0;
    cardsEl.innerHTML = filtered.length ? '' : emptyHtml();
    renderMore();
  }

  function renderMore() {
    const frag = document.createDocumentFragment();
    for (const ch of filtered.slice(rendered, rendered + PAGE_SIZE)) frag.appendChild(renderCard(ch));
    rendered = Math.min(filtered.length, rendered + PAGE_SIZE);
    cardsEl.appendChild(frag);
    loadMoreBtn.hidden = rendered >= filtered.length;
    renderStatusLine();
  }

  function renderStatusLine() {
    let html = `${filtered.length} de ${currentChannels.length} canales`;
    let warn = false;
    if (dataGeneratedAt) {
      const hours = (Date.now() - dataGeneratedAt.getTime()) / 3600000;
      const when = fmtDateTime(dataGeneratedAt);
      if (hours > SCHEDULE_HOURS - 2) {
        warn = true;
        html = `${icon('triangle-alert', 'sm')}${html} · datos del ${when}: la programación `
          + `${hours > SCHEDULE_HOURS ? 'ya venció' : 'está por vencer'}, corré el workflow`;
      } else {
        html += ` · datos del ${when}`;
      }
    }
    statusLine.innerHTML = html;
    statusLine.classList.toggle('warn', warn);
  }

  // ================================================================= tarjetas

  const cardChannel = new WeakMap();   // tarjeta -> canal, para re-renderizarla sola

  function renderCard(ch) {
    const el = document.createElement('article');
    const key = ch.xtream_name;
    const divider = isDivider(ch);
    const hidden = isHidden(ch);
    const renamed = renameOf(ch);
    const movedTo = movedCategoryOf(ch);
    const section = effectiveSection(ch);
    const epg = currentEpgOf(ch);

    el.className = hidden ? 'card is-hidden' : 'card';
    el.dataset.key = key;
    cardChannel.set(el, ch);

    let body;
    if (divider) body = '<div class="card-note">Separador del proveedor: no lleva EPG.</div>';
    else if (hasOverride(ch) && epg === null) body = '<div class="card-note">Sin EPG ni logo, a propósito.</div>';
    else body = epg ? epgRowHtml(epg) : '<div class="card-note">Sin EPG asignado.</div>';

    el.innerHTML = `
      <div class="card-top">
        <div class="card-title">
          <div class="card-name">${esc(renamed || key)}</div>
          ${renamed ? `<div class="card-sub">En Xtream: ${esc(key)}</div>` : ''}
          <div class="card-sub">
            <span>${esc(effectiveCategory(ch))}${section ? ' · ' + esc(section) : ''}</span>
            ${movedTo ? `<span class="pill">${icon('folder-input', 'sm')}Movido</span>` : ''}
          </div>
        </div>
        ${divider ? '' : qualityTag(ch)}
      </div>
      ${body}
      <div class="card-actions">
        ${divider ? '' : `
          <button class="btn btn-plain" data-panel="editor" aria-expanded="false">${icon('pencil')}Cambiar EPG</button>
          <button class="btn btn-plain" data-panel="more" aria-expanded="false">${icon('ellipsis')}Más</button>`}
        <span class="spacer"></span>
        <button class="icon-btn ghost hide-btn${hidden ? '' : ' on'}" aria-pressed="${!hidden}"
          title="${hidden ? 'Oculto en la playlist: tocá para mostrarlo' : 'Visible en la playlist: tocá para ocultarlo'}"
          aria-label="${hidden ? 'Mostrar en la playlist' : 'Ocultar de la playlist'}">${icon(hidden ? 'eye-off' : 'eye')}</button>
      </div>
      <div class="panel" data-for="editor" hidden></div>
      <div class="panel" data-for="more" hidden></div>
    `;

    fillNowPlaying(el);
    $('.hide-btn', el).addEventListener('click', () => {
      const hide = !isHidden(ch);
      setEntry('hidden', key, hide ? true : undefined, hide ? 'Canal oculto de la playlist' : 'Canal visible en la playlist');
    });
    $$('[data-panel]', el).forEach((btn) => btn.addEventListener('click', () => togglePanel(el, ch, btn.dataset.panel)));
    return el;
  }

  // Re-renderiza solo las tarjetas de ese canal (puede haber varias con el mismo nombre en
  // categorías distintas), sin rehacer la lista: no se pierde el scroll ni las páginas cargadas.
  function rerenderCards(key) {
    $$(`.card[data-key="${CSS.escape(key)}"]`, cardsEl).forEach((old) => {
      old.replaceWith(renderCard(cardChannel.get(old)));
    });
    updateFilterCounts();
  }

  // Un solo panel abierto a la vez en toda la lista. Se arman al abrirse (no para las 60
  // tarjetas de la página): el desplegable de categorías solo tiene ~100 opciones.
  function togglePanel(cardEl, ch, kind) {
    const panel = $(`.panel[data-for="${kind}"]`, cardEl);
    const opening = panel.hidden;
    $$('.panel:not([hidden])', cardsEl).forEach((p) => { p.hidden = true; p.innerHTML = ''; });
    $$('[data-panel][aria-expanded="true"]', cardsEl).forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (!opening) return;
    panel.hidden = false;
    $(`[data-panel="${kind}"]`, cardEl).setAttribute('aria-expanded', 'true');
    if (kind === 'editor') buildEditor(panel, ch);
    else buildMorePanel(panel, ch);
  }

  // ---- "Cambiar EPG": alternativas + búsqueda en todo el EPG + dejar sin EPG
  function buildEditor(panel, ch) {
    const current = currentEpgOf(ch);
    const alts = (ch.alternatives || []).filter((a) => a.channel_id !== current);
    panel.innerHTML = `
      ${alts.length ? `<div class="section-label">Alternativas</div>
        <div class="list">${alts.map((a) => epgRowHtml(a.channel_id, { score: a.score, pick: true })).join('')}</div>` : ''}
      <div class="section-label">Buscar en todo el EPG</div>
      <label class="search-field" style="margin-top:6px">${icon('search')}
        <input type="search" class="catalog-search" placeholder="Canal o programa que está dando ahora" enterkeyhint="search">
      </label>
      <div class="list search-results" hidden></div>
      <div class="row-actions">
        <button class="btn btn-danger force-none-btn">${icon('ban')}Dejar sin EPG</button>
      </div>
      <p class="help">Para cuando ninguna guía sirve (p. ej. «Channel No Longer Available»): mejor sin EPG que con uno equivocado.</p>
    `;
    const pick = (id) => setEntry('overrides', ch.xtream_name, id, id === null ? 'Canal sin EPG a propósito' : 'EPG elegido');
    wirePicks(panel, pick);
    fillNowPlaying(panel);
    $('.force-none-btn', panel).addEventListener('click', () => pick(null));
    const input = $('.catalog-search', panel);
    const results = $('.search-results', panel);
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderCatalogSearch(input.value, results, pick), 150);
    });
  }

  // Busca por nombre/id del canal Y por lo que está dando ahora, y muestra la programación de
  // cada resultado: primero los que tienen algo en el aire.
  let searchSeq = 0;
  async function renderCatalogSearch(term, resultsEl, pick) {
    term = normalize(term.trim());
    if (term.length < 2) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }
    const seq = ++searchSeq;
    const idx = await fetchHourIndex();
    if (seq !== searchSeq) return; // llegó otra búsqueda mientras se bajaba el índice

    const matches = [];
    for (const c of catalog) {
      const byName = normalize(c.name).includes(term) || c.id.toLowerCase().includes(term);
      const cur = idx ? nowFromHourIndex(idx, c.id) : null;
      const byProgram = !!cur && normalize(cur.title).includes(term);
      if (byName || byProgram) matches.push({ c, cur, byProgram });
    }
    if (idx) matches.sort((a, b) => Number(!a.cur) - Number(!b.cur));
    const shown = matches.slice(0, SEARCH_LIMIT);
    const summary = idx
      ? `${matches.length} resultado(s)${matches.length > SEARCH_LIMIT ? `, se muestran ${SEARCH_LIMIT}` : ''} · primero los que tienen programación ahora`
      : 'Programación por hora no disponible: se carga canal por canal.';

    resultsEl.innerHTML = `<div class="list-note">${esc(summary)}</div>`
      + (shown.map(({ c, cur, byProgram }) => epgRowHtml(c.id, {
        pick: true, cur: idx ? cur : undefined, note: byProgram ? '· coincide con la búsqueda' : '',
      })).join('') || '<div class="list-note">Sin resultados</div>');
    resultsEl.hidden = false;
    wirePicks(resultsEl, pick);
    fillNowPlaying(resultsEl);
  }

  // ---- "Más": nombre, categoría y volver al EPG automático
  function buildMorePanel(panel, ch) {
    const key = ch.xtream_name;
    const renamed = renameOf(ch);
    panel.innerHTML = `
      <label class="field"><span>Nombre en la playlist</span>
        <input class="input rename-input" type="text" value="${esc(renamed || key)}" enterkeyhint="done">
      </label>
      <div class="row-actions">
        <button class="btn btn-tonal rename-save">${icon('check')}Guardar nombre</button>
        ${renamed ? `<button class="btn btn-plain rename-restore">${icon('rotate-ccw')}Nombre original</button>` : ''}
      </div>
      <label class="field"><span>Categoría</span>
        <select class="select cat-select">${categoryOptions(ch)}</select>
      </label>
      ${hasOverride(ch) ? `<div class="row-actions">
        <button class="btn btn-plain auto-epg">${icon('undo-2')}Volver al EPG automático</button></div>` : ''}
    `;
    const input = $('.rename-input', panel);
    const rename = (value) => {
      value = (value || '').trim();
      setEntry('renames', key, value && value !== key ? value : undefined, value && value !== key ? 'Canal renombrado' : 'Nombre original restaurado');
    };
    $('.rename-save', panel).addEventListener('click', () => rename(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') rename(input.value); });
    const restore = $('.rename-restore', panel);
    if (restore) restore.addEventListener('click', () => rename(''));
    const select = $('.cat-select', panel);
    select.addEventListener('change', () => {
      setEntry('categories', key, select.value === ch.category ? undefined : select.value,
        select.value === ch.category ? 'Categoría original restaurada' : 'Canal movido de categoría');
    });
    const auto = $('.auto-epg', panel);
    if (auto) auto.addEventListener('click', () => setEntry('overrides', key, undefined, 'Vuelve al EPG automático'));
    input.focus({ preventScroll: true });
  }

  // ================================================================= guardar en GitHub

  // Relee xtream_channel_map.json justo antes de escribir (para no pisar un cambio hecho desde
  // otro lado), aplica `mutate` sobre el documento entero y lo commitea.
  async function withChannelMap(mutate, commitMessage) {
    const current = await gh(`/contents/${MAP_PATH}`, { auth: 'required' });
    const doc = JSON.parse(b64decode(current.content));
    if (!doc.overrides) doc.overrides = {};
    mutate(doc);
    for (const key of EDIT_SECTIONS) {
      if (doc[key] && !Object.keys(doc[key]).length) delete doc[key];
    }
    await gh(`/contents/${MAP_PATH}`, {
      method: 'PUT',
      auth: 'required',
      body: { message: commitMessage, content: b64encode(JSON.stringify(doc, null, 2) + '\n'), sha: current.sha },
    });
    channelMap = doc;
  }

  // Pone (o borra, con value === undefined) una entrada de una sección del JSON ('overrides',
  // 'renames', 'categories', 'hidden'), re-renderiza la tarjeta y ofrece deshacer. En
  // 'overrides', null es un valor válido ("dejar sin EPG").
  async function setEntry(section, key, value, label, { isUndo = false } = {}) {
    const had = has(channelMap[section], key);
    const prev = had ? channelMap[section][key] : undefined;
    if (prev === value) return;
    toast('Guardando…', { kind: 'busy', id: 'save' });
    try {
      await withChannelMap((doc) => {
        doc[section] = doc[section] || {};
        if (value === undefined) delete doc[section][key];
        else doc[section][key] = value;
      }, `${label} (interfaz de corrección)`);
    } catch (e) {
      toast(errMsg(e), { kind: 'error', id: 'save' });
      return;
    }
    setPending(pendingChanges + (isUndo ? -1 : 1));
    rerenderCards(key);
    if (isUndo) {
      toast('Cambio deshecho', { kind: 'info', id: 'save' });
    } else {
      toast(label, {
        id: 'save',
        action: { label: 'Deshacer', fn: () => setEntry(section, key, prev, `Deshacer: ${label.toLowerCase()}`, { isUndo: true }) },
      });
    }
  }

  // ================================================================= workflow

  const runBtn = $('#runWorkflowBtn');
  const workflowStatus = $('#workflowStatus');
  let pollTimer = null;
  let dispatchedAt = 0;          // para no confundir la corrida recién lanzada con la anterior
  let watchedRun = null;         // {id, done}: para avisar con un toast cuando termina

  function setPending(n) {
    pendingChanges = Math.max(0, n);
    // En pantallas chicas queda solo el ícono y el número (ver .wide en app.css).
    $('#runLabel').innerHTML = pendingChanges
      ? `<span class="wide">Aplicar </span>${pendingChanges}` : '<span class="wide">Workflow</span>';
    runBtn.classList.toggle('pending', pendingChanges > 0);
    runBtn.classList.toggle('btn-tonal', pendingChanges === 0);
    runBtn.title = pendingChanges
      ? `Correr el workflow para aplicar ${pendingChanges} cambio(s) guardado(s)`
      : 'Regenera playlists y EPG (no hay cambios pendientes)';
  }

  // Cambios guardados desde que arrancó la última corrida (commits a MAP_PATH posteriores).
  async function countPending(run) {
    try {
      const since = new Date(run.run_started_at || run.created_at).toISOString();
      const commits = await gh(`/commits?sha=main&path=${MAP_PATH}&since=${encodeURIComponent(since)}&per_page=100`);
      setPending(commits.length);
    } catch { /* sin datos: se deja como está */ }
  }

  function renderRun(run) {
    const done = run.status === 'completed';
    const link = `<a href="${esc(run.html_url)}" target="_blank" rel="noopener">Ver ${icon('external-link', 'sm')}</a>`;
    let cls; let lead; let text; let extra = '';
    if (!done) {
      const mins = Math.max(0, Math.round((Date.now() - new Date(run.run_started_at || run.created_at).getTime()) / 60000));
      cls = 'busy'; lead = icon('loader-circle', 'spin');
      text = `Workflow ${run.status === 'queued' ? 'en cola' : 'corriendo'} · ${mins} min (suele tardar ~8)`;
    } else if (run.conclusion === 'success') {
      cls = 'ok'; lead = icon('circle-check');
      text = `Último workflow OK · ${fmtDateTime(run.updated_at)}`;
      extra = '<button class="btn btn-plain refresh-link">Actualizar datos</button>';
    } else {
      cls = 'bad'; lead = icon('circle-x');
      text = `El último workflow falló (${esc(run.conclusion)}) · ${fmtDateTime(run.updated_at)}`;
    }
    workflowStatus.hidden = false;
    workflowStatus.className = `status-bar ${cls}`;
    workflowStatus.innerHTML = `<span class="lead">${lead}</span><span class="grow">${text}</span>${extra}${link}`;
    const refresh = $('.refresh-link', workflowStatus);
    if (refresh) refresh.addEventListener('click', refreshData);
    runBtn.disabled = !done;

    // Aviso cuando termina una corrida que se vio en curso en esta sesión.
    if (watchedRun && watchedRun.id === run.id && !watchedRun.done && done) {
      if (run.conclusion === 'success') {
        toast('El workflow terminó: playlists y EPG actualizados', { action: { label: 'Actualizar datos', fn: refreshData } });
      } else {
        toast('El workflow falló', { kind: 'error', action: { label: 'Ver', fn: () => window.open(run.html_url, '_blank', 'noopener') } });
      }
    }
    watchedRun = { id: run.id, done };
    return done;
  }

  async function pollWorkflow() {
    clearTimeout(pollTimer);
    let run;
    try {
      run = ((await gh(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`)).workflow_runs || [])[0];
    } catch {
      return; // sin permiso de Actions: el botón lo explica al usarlo
    }
    const stale = dispatchedAt && (!run || new Date(run.created_at).getTime() < dispatchedAt - 60000);
    if (stale && Date.now() - dispatchedAt < 3 * 60000) {
      pollTimer = setTimeout(pollWorkflow, 5000); // todavía no apareció la corrida nueva
      return;
    }
    if (!run) return;
    countPending(run);
    if (!renderRun(run)) pollTimer = setTimeout(pollWorkflow, 15000);
  }

  async function runWorkflow() {
    if (!getToken()) { openTokenDialog(); return; }
    const ok = await confirmDialog({
      title: 'Correr el workflow',
      text: pendingChanges
        ? `Aplica ${pendingChanges} cambio(s) guardado(s) a las playlists y al EPG. Tarda unos 8 minutos.`
        : 'Regenera playlists y EPG con lo último del proveedor. Tarda unos 8 minutos.',
      ok: 'Correr',
    });
    if (!ok) return;
    runBtn.disabled = true;
    try {
      await gh(`/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: 'POST', auth: 'required', body: { ref: 'main' } });
    } catch (e) {
      runBtn.disabled = false;
      const status = /** @type {GitHubError} */ (e).status;
      const msg = status === 403 || status === 404
        ? 'No se pudo lanzar: al token le falta el permiso Actions: Read and write.'
        : `No se pudo lanzar el workflow. ${errMsg(e)}`;
      toast(msg, { kind: 'error' });
      return;
    }
    toast('Workflow lanzado · te aviso cuando termine', { kind: 'info' });
    dispatchedAt = Date.now();
    watchedRun = null;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollWorkflow, 5000);
  }

  // ================================================================= token

  const tokenDialog = $('#tokenDialog');
  const tokenInput = $('#tokenInput');

  function openTokenDialog() {
    tokenInput.value = getToken();
    tokenDialog.returnValue = '';
    tokenDialog.showModal();
  }

  // Enter en el campo guarda (el primer botón del formulario sería "Borrar").
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tokenDialog.close('save'); }
  });

  tokenDialog.addEventListener('close', () => {
    if (tokenDialog.returnValue === 'save') {
      const value = tokenInput.value.trim();
      if (!value) return;
      storageSet(TOKEN_KEY, value);
      toast('Token guardado');
      pollWorkflow();
    } else if (tokenDialog.returnValue === 'clear') {
      storageSet(TOKEN_KEY, null);
      tokenInput.value = '';
      toast('Token borrado de este navegador', { kind: 'info' });
    }
  });

  // ================================================================= eventos e inicio

  filterTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    storageSet(FILTER_KEY, activeFilter);
    applyFilters();
    btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  let searchTimer = null;
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = normalize(searchBox.value.trim());
      applyFilters();
    }, 150);
  });

  // "/" enfoca el buscador (escritorio), como en la mayoría de las apps web.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !(/** @type {Element} */ (e.target)).closest('input, textarea, select, dialog')) {
      e.preventDefault();
      searchBox.focus();
    }
  });

  loadMoreBtn.addEventListener('click', renderMore);
  $('#refreshDataBtn').addEventListener('click', refreshData);
  runBtn.addEventListener('click', runWorkflow);
  $('#settingsBtn').addEventListener('click', openTokenDialog);

  // PWA: instalable en la pantalla de inicio (ver sw.js). Solo en contexto seguro (GitHub Pages
  // por https, o localhost al probar).
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin PWA: la página anda igual */ });
  }

  (async () => {
    hydrateIcons();
    cardsEl.innerHTML = skeletonHtml();
    try {
      await loadRelease();
      const names = Object.keys(profiles).sort();
      if (!names.length) throw new Error('Todavía no hay ningún match_report publicado: corré el workflow una vez.');
      await loadProfile(names[0]);
      pollWorkflow();
    } catch (e) {
      cardsEl.innerHTML = `<div class="empty">${icon('triangle-alert', 'lg')}<strong>No se pudieron cargar los datos</strong>${esc(errMsg(e))}</div>`;
      toast(errMsg(e), { kind: 'error' });
    }
  })();
})();
