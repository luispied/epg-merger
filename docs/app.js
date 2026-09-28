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
  // v2: el filtro por defecto pasó a "Todos"; la clave nueva hace que se vea así al abrir aunque
  // antes hubiera quedado guardado "A revisar".
  const FILTER_KEY = 'epg_ui_filter_v2';
  const HELP_SEEN_KEY = 'epg_ui_help_seen';
  // Preferencias de Configuración (por dispositivo).
  const THEME_KEY = 'epg_ui_theme';                // auto | light | dark (lo lee también index.html)
  const LOGOS_KEY = 'epg_ui_logos';                // '0' = logos apagados
  const START_FILTER_KEY = 'epg_ui_start_filter';  // last | todos | revisar
  const APP_VERSION = '2026.09.27';

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
  // No entran en "A revisar" ni en "Sin EPG" (siguen en "Todos"): "General" es donde caen los
  // canales sin categoría en Xtream (sobre todo eventos sueltos) y 24/7 son series/películas en loop.
  const REVIEW_EXCLUDED_CATEGORIES = new Set(['General']);
  const REVIEW_EXCLUDED_SECTIONS = new Set(['24/7']);
  // Y cualquier categoría "24 7 …" aunque el proveedor la cambie de sección.
  const REVIEW_EXCLUDED_CATEGORY_RE = /^\W*24\s*\/?\s*7\b/;

  // Mensajes de commit por sección de xtream_channel_map.json (ver setEntry).
  const EDIT_SECTIONS = ['renames', 'categories', 'hidden', 'hidden_categories'];

  // ================================================================= estado

  /** @type {CatalogEntry[]} */
  let catalog = [];
  /** @type {Map<string, CatalogEntry>} */
  let catalogById = new Map();
  /** @type {ChannelMap} */
  let channelMap = { overrides: {} };
  /** @type {Record<string, string> | null} channel_id -> URL del logo (epg_icons.json, carga en 2º plano) */
  let logoById = null;
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
  // Selección múltiple: nombres crudos de Xtream (la misma clave que usan los cambios).
  let selectMode = false;
  /** @type {Set<string>} */
  const selected = new Set();
  const startFilterPref = storageGet(START_FILTER_KEY) || 'last';
  let activeFilter = startFilterPref === 'last' ? (storageGet(FILTER_KEY) || 'todos') : startFilterPref;
  let logosEnabled = storageGet(LOGOS_KEY) !== '0';
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

  // channel_id -> Promise<ScheduleEntry[] | null>, bajo demanda y cacheado.
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
      if (idx.h + s * 60 <= now && now < idx.h + e * 60) {
        return { title: idx.t[t], start: idx.h + s * 60, stop: idx.h + e * 60 };
      }
    }
    return null;
  }

  /** @param {ScheduleEntry[] | null} entries @returns {NowPlaying | null} */
  function nowFromEntries(entries) {
    const now = Date.now() / 1000;
    const cur = (entries || []).find(([start, stop]) => start <= now && now < stop);
    return cur ? { title: cur[2], start: cur[0], stop: cur[1] } : null;
  }

  /** Con `id`, la línea es un botón que despliega la descripción del programa (toggleDesc).
   *  @param {NowPlaying | null} cur @param {string} [note] @param {string} [id] channel_id del EPG */
  function nowHtml(cur, note = '', id = '') {
    const noteHtml = note ? ` <span class="note">${esc(note)}</span>` : '';
    if (!cur) return `<span>Sin programación para este horario${noteHtml}</span>`;
    const text = `${icon('tv', 'sm')}<span>Ahora: ${esc(cur.title)} · hasta ${fmtTime(cur.stop * 1000)}${noteHtml}</span>`;
    if (!id || !catalogEntry(id).sched) return text;
    return `<button type="button" class="now-btn" data-desc-for="${esc(id)}" data-start="${cur.start}"
      aria-expanded="false" title="Ver descripción del programa">${text}${icon('chevron-down', 'sm chev')}</button>`;
  }

  // Descripción del programa en el aire: sale del archivo de programación del canal (unos pocos
  // KB), que se baja recién al tocar la línea "Ahora". El índice por hora no la trae para no
  // inflar el archivo que se baja entero.
  /** @param {HTMLElement} btn */
  async function toggleDesc(btn) {
    const box = /** @type {HTMLElement} */ (btn.parentElement);
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
    const entries = (await fetchSchedule(btn.dataset.descFor || '')) || [];
    const start = Number(btn.dataset.start);
    const now = Date.now() / 1000;
    const entry = entries.find((e) => e[0] === start) || entries.find(([s, e]) => s <= now && now < e);
    const desc = entry?.[3];
    p.textContent = desc || 'La guía no trae descripción para este programa.';
    p.classList.toggle('muted', !desc);
  }

  async function loadNowPlayingInto(el, channelId) {
    const idx = await fetchHourIndex();
    const cur = idx ? nowFromHourIndex(idx, channelId) : nowFromEntries(await fetchSchedule(channelId));
    el.innerHTML = nowHtml(cur, '', channelId);
    el.classList.toggle('on-air', !!cur);
  }

  // Logos de los canales del EPG: el mapa (epg_icons.json) se baja en segundo plano después de
  // la primera carga; hasta que llega, los lugares quedan con un ícono genérico.
  /** @param {string | null} id channel_id del EPG (null: sin EPG) @param {string} [cls] */
  function logoHtml(id, cls = '') {
    return `<span class="logo ${cls}"${id ? ` data-logo-for="${esc(id)}"` : ''}>${icon('tv')}</span>`;
  }

  /** @param {ParentNode} root */
  function fillLogos(root) {
    if (!logoById || !logosEnabled) return;
    $$('.logo[data-logo-for]', root).forEach((el) => {
      const url = logoById?.[el.dataset.logoFor];
      el.removeAttribute('data-logo-for');
      if (!url) return;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => el.classList.add('has-img'));
      img.addEventListener('error', () => img.remove()); // queda el ícono genérico
      img.src = url;
      el.appendChild(img);
    });
  }

  function loadLogos() {
    if (!logosEnabled) return;
    getJSON(`${DATA_RAW_BASE}/epg_icons.json?_=${dataNonce}`)
      .then((map) => { logoById = map; fillLogos(document); })
      .catch(() => { /* sin logos: la interfaz anda igual */ });
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

  // Categoría entera oculta (Configuración → Categorías). Cuenta la categoría donde se muestra
  // el canal, igual que el pipeline: uno movido a una categoría visible sigue en la playlist.
  const isCategoryHidden = (ch) => !!(channelMap.hidden_categories || {})[effectiveCategory(ch)];
  const isOut = (ch) => isHidden(ch) || isCategoryHidden(ch);

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
   * @param {{ score?: number | null, pick?: boolean, cur?: NowPlaying | null, note?: string, logo?: boolean }} [opts]
   */
  function epgRowHtml(id, { score = null, pick = false, cur = undefined, note = '', logo = true } = {}) {
    const c = catalogEntry(id);
    const known = cur !== undefined;
    const pickAttrs = pick ? ` data-id="${esc(id)}" role="button" tabindex="0"` : '';
    return `<div class="epg-row${pick ? ' pick' : ''}${logo ? ' with-logo' : ''}"${pickAttrs}>
      ${logo ? logoHtml(id) : ''}
      <div class="epg-body">
      <div class="epg-head">
        <span class="epg-name">${esc(c.name)}${c.country ? ' [' + esc(c.country.toUpperCase()) + ']' : ''}</span>
        ${score === null ? '' : scoreTag(score)}
      </div>
      <small class="epg-src">${esc(c.id)}${c.source ? ' · ' + esc(c.source) : ''}</small>
      <div class="epg-now${known && cur ? ' on-air' : ''}"${known ? '' : ` data-now-for="${esc(id)}"`}>${
        known ? nowHtml(cur, note, id) : '<span>Cargando programación…</span>'}</div>
      </div>
    </div>`;
  }

  function wirePicks(root, onPick) {
    $$('.epg-row.pick', root).forEach((row) => {
      row.addEventListener('click', () => onPick(row.dataset.id));
      // Solo el Enter sobre la fila misma: el de un botón adentro (descripción) no elige.
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) onPick(row.dataset.id); });
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
      loadLogos();
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
  const scrollSentinel = $('#scrollSentinel');

  // Scroll infinito: carga la próxima tanda cuando el final de la grilla se acerca a la pantalla.
  /** @type {IntersectionObserver | null} */
  const scrollObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && rendered < filtered.length) renderMore();
    }, { rootMargin: '0px 0px 800px 0px' })
    : null;

  const searchBox = $('#searchBox');
  const filterTabs = $('#filterTabs');

  function matchesFilter(ch, filter = activeFilter) {
    if (filter === 'ocultos') return isOut(ch);
    // Una categoría oculta no se quiere ver: sus canales solo aparecen en "Ocultos".
    if (isCategoryHidden(ch)) return false;
    if (filter === 'editados') return isEdited(ch);
    if (filter === 'override') return hasOverride(ch);
    if (filter === 'todos') return true;
    // "Sin EPG" y "A revisar": un oculto ya se decidió, un separador nunca lleva EPG y uno con
    // EPG manual ya se revisó. Tampoco entran los que no llevan guía por naturaleza (eventos
    // sueltos de "General" y los canales 24/7 de series y películas).
    if (isHidden(ch) || isDivider(ch) || hasOverride(ch)) return false;
    if (REVIEW_EXCLUDED_CATEGORIES.has(effectiveCategory(ch))
        || REVIEW_EXCLUDED_SECTIONS.has(effectiveSection(ch))
        || REVIEW_EXCLUDED_CATEGORY_RE.test(effectiveCategory(ch))) return false;
    if (filter === 'sin-epg') return !ch.chosen;
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
    // Los números siguen a la búsqueda: cuentan lo que mostraría cada filtro con ese texto.
    for (const ch of currentChannels) {
      if (!matchesSearch(ch)) continue;
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
    // Con scroll infinito el botón queda solo como respaldo para navegadores sin IntersectionObserver.
    loadMoreBtn.hidden = Boolean(scrollObserver) || rendered >= filtered.length;
    renderStatusLine();
    if (scrollObserver) {
      // Volver a observar fuerza una notificación inicial: si el centinela sigue a la vista
      // (pantalla alta o tarjetas ocultas), se carga otra tanda sin esperar a que el usuario se mueva.
      scrollObserver.unobserve(scrollSentinel);
      if (rendered < filtered.length) scrollObserver.observe(scrollSentinel);
    }
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
    const catHidden = isCategoryHidden(ch);
    const renamed = renameOf(ch);
    const movedTo = movedCategoryOf(ch);
    const section = effectiveSection(ch);
    const epg = currentEpgOf(ch);

    el.className = hidden || catHidden ? 'card is-hidden' : 'card';
    if (selectMode) el.classList.add('selectable');
    if (selected.has(key)) el.classList.add('selected');
    el.dataset.key = key;
    cardChannel.set(el, ch);

    let body;
    if (divider) body = '<div class="card-note">Separador del proveedor: no lleva EPG.</div>';
    else if (hasOverride(ch) && epg === null) body = '<div class="card-note">Sin EPG ni logo, a propósito.</div>';
    else body = epg ? epgRowHtml(epg, { logo: false }) : '<div class="card-note">Sin EPG asignado.</div>';

    el.innerHTML = `
      <div class="card-top">
        ${selectMode ? `<span class="sel-box" aria-hidden="true">${icon(selected.has(key) ? 'square-check' : 'square')}</span>` : ''}
        ${divider ? '' : logoHtml(epg || null, 'lg')}
        <div class="card-title">
          <div class="card-name">${esc(renamed || key)}</div>
          ${renamed ? `<div class="card-sub">En Xtream: ${esc(key)}</div>` : ''}
          <div class="card-sub">
            <span>${esc(effectiveCategory(ch))}${section ? ' · ' + esc(section) : ''}</span>
            ${movedTo ? `<span class="pill">${icon('folder-input', 'sm')}Movido</span>` : ''}
            ${hidden ? `<span class="pill muted">${icon('eye-off', 'sm')}Oculto</span>` : ''}
            ${catHidden ? `<span class="pill muted">${icon('layers', 'sm')}Categoría oculta</span>` : ''}
          </div>
        </div>
        ${divider ? '' : qualityTag(ch)}
        <button class="icon-btn ghost card-menu-btn" aria-haspopup="dialog" aria-label="Opciones del canal"
          title="Opciones">${icon('ellipsis')}</button>
      </div>
      ${body}
      <div class="panel" hidden></div>
    `;

    fillNowPlaying(el);
    fillLogos(el);
    $('.card-menu-btn', el).addEventListener('click', () => openCardMenu(el, ch));
    wireSelection(el, ch);
    return el;
  }

  // ================================================================= selección múltiple

  const bulkBar = $('#bulkBar');
  const selectBtn = $('#selectBtn');
  /** @type {HTMLDialogElement} */
  const bulkDialog = /** @type {HTMLDialogElement} */ ($('#bulkDialog'));
  /** @type {HTMLDialogElement} */
  const bulkEpgDialog = /** @type {HTMLDialogElement} */ ($('#bulkEpgDialog'));
  /** Tarjeta recién marcada con un toque largo: el click de soltar el dedo no la desmarca. */
  let suppressClickFor = '';

  /** @param {boolean} on @param {string} [firstKey] */
  function setSelectMode(on, firstKey) {
    selectMode = on;
    selected.clear();
    if (on && firstKey) selected.add(firstKey);
    document.body.classList.toggle('selecting', on);
    selectBtn.setAttribute('aria-pressed', String(on));
    bulkBar.hidden = !on;
    closePanels();
    $$('.card', cardsEl).forEach((old) => old.replaceWith(renderCard(cardChannel.get(old))));
    updateBulkBar();
  }

  function updateBulkBar() {
    const n = selected.size;
    $('#bulkCount').textContent = n ? `${n} seleccionado${n === 1 ? '' : 's'}` : 'Tocá los canales';
    /** @type {HTMLButtonElement} */ ($('#bulkActions')).disabled = !n;
    const allSel = filtered.length > 0 && filtered.every((ch) => selected.has(ch.xtream_name));
    $('#bulkAll').textContent = allSel ? 'Ninguno' : 'Todos';
  }

  /** @param {string} key */
  function toggleSelected(key) {
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    const on = selected.has(key);
    $$(`.card[data-key="${CSS.escape(key)}"]`, cardsEl).forEach((card) => {
      card.classList.toggle('selected', on);
      const box = $('.sel-box', card);
      if (box) box.innerHTML = icon(on ? 'square-check' : 'square');
    });
    updateBulkBar();
  }

  // En modo selección, tocar la tarjeta la marca (en captura: nada de adentro se activa).
  // Fuera de ese modo, mantenerla apretada medio segundo entra al modo con esa tarjeta marcada.
  /** @param {HTMLElement} el @param {ReportChannel} ch */
  function wireSelection(el, ch) {
    el.addEventListener('click', (e) => {
      if (suppressClickFor === ch.xtream_name) { suppressClickFor = ''; e.preventDefault(); e.stopPropagation(); return; }
      if (!selectMode) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelected(ch.xtream_name);
    }, true);
    let timer = 0;
    let startX = 0;
    let startY = 0;
    const cancel = () => { clearTimeout(timer); timer = 0; };
    el.addEventListener('pointerdown', (e) => {
      if (selectMode || e.button !== 0 || (/** @type {Element} */ (e.target)).closest('input, select, textarea, .panel')) return;
      startX = e.clientX;
      startY = e.clientY;
      timer = window.setTimeout(() => {
        timer = 0;
        // Si el click de soltar no llega (la tarjeta se re-renderizó), el flag caduca solo.
        suppressClickFor = ch.xtream_name;
        setTimeout(() => { suppressClickFor = ''; }, 600);
        navigator.vibrate?.(15);
        setSelectMode(true, ch.xtream_name);
      }, 500);
    });
    el.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { if (selectMode) e.preventDefault(); });
  }

  /** Canales seleccionados (uno por nombre de Xtream). @returns {ReportChannel[]} */
  function selectedChannels() {
    const byKey = new Map();
    for (const ch of allChannels) if (selected.has(ch.xtream_name) && !byKey.has(ch.xtream_name)) byKey.set(ch.xtream_name, ch);
    return [...byKey.values()];
  }

  /** Aplica a todos los seleccionados y sale del modo selección si se guardó.
   *  @param {MapChange[]} changes @param {string} label */
  async function applyBulk(changes, label) {
    if (changes.every((c) => currentValue(c.section, c.key) === c.value)) {
      toast('Nada que cambiar: ya estaban así', { kind: 'info', id: 'save' });
      return;
    }
    if (await applyChanges(changes, label)) setSelectMode(false);
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function openBulkMenu() {
    const chs = selectedChannels();
    const epgable = chs.filter((ch) => !isDivider(ch));
    const n = chs.length;
    $('#bulkTitle').textContent = plural(n, 'canal seleccionado', 'canales seleccionados');
    const rows = [];
    if (epgable.length) {
      rows.push(menuRowHtml('pencil', 'Cambiar EPG', `El mismo para ${plural(epgable.length, 'canal', 'canales')}`, 'epg'));
      rows.push(menuRowHtml('folder-input', 'Mover de categoría', 'Todos a la misma categoría', 'category'));
    }
    rows.push(menuRowHtml('eye-off', 'Ocultar de la playlist', '', 'hide'));
    rows.push(menuRowHtml('eye', 'Mostrar en la playlist', '', 'show'));
    const undoRows = [];
    if (epgable.some((ch) => hasOverride(ch))) undoRows.push(menuRowHtml('undo-2', 'Volver al EPG automático', 'Descarta los EPG elegidos a mano', 'auto-epg'));
    if (chs.some((ch) => renameOf(ch))) undoRows.push(menuRowHtml('rotate-ccw', 'Restaurar nombres originales', '', 'names'));
    if (chs.some((ch) => movedCategoryOf(ch))) undoRows.push(menuRowHtml('folder-input', 'Volver a la categoría original', '', 'orig-cat'));
    if (epgable.length) undoRows.push(menuRowHtml('ban', 'Dejar sin EPG', 'Para cuando ninguna guía sirve', 'no-epg', 'danger'));
    $('#bulkBody').innerHTML = `<div class="menu">${rows.join('')}</div>`
      + (undoRows.length ? `<div class="menu">${undoRows.join('')}</div>` : '');
    $$('[data-action]', $('#bulkBody')).forEach((btn) => btn.addEventListener('click', () => {
      bulkDialog.close();
      const keys = chs.map((ch) => ch.xtream_name);
      const epgKeys = epgable.map((ch) => ch.xtream_name);
      const set = (section, list, value) => list.map((key) => ({ section, key, value }));
      switch (btn.dataset.action) {
        case 'epg': openBulkEpg(epgable); break;
        case 'category': openBulkCategory(epgable); break;
        case 'hide': applyBulk(set('hidden', keys, true), `${plural(n, 'canal oculto', 'canales ocultos')} de la playlist`); break;
        case 'show': applyBulk(set('hidden', keys, undefined), `${plural(n, 'canal visible', 'canales visibles')} en la playlist`); break;
        case 'auto-epg': applyBulk(set('overrides', epgKeys, undefined), `${plural(epgKeys.length, 'canal vuelve', 'canales vuelven')} al EPG automático`); break;
        case 'names': applyBulk(set('renames', keys, undefined), 'Nombres originales restaurados'); break;
        case 'orig-cat': applyBulk(set('categories', keys, undefined), 'Categorías originales restauradas'); break;
        case 'no-epg': confirmDialog({
          title: `¿Dejar ${plural(epgKeys.length, 'canal', 'canales')} sin EPG?`,
          text: 'No se les va a asignar guía ni logo, ni siquiera automáticamente. Se puede deshacer.',
          ok: 'Dejar sin EPG',
        }).then((yes) => { if (yes) applyBulk(set('overrides', epgKeys, null), `${plural(epgKeys.length, 'canal', 'canales')} sin EPG a propósito`); });
          break;
        default: break;
      }
    }));
    bulkDialog.showModal();
  }

  // EPG para todos: primero las opciones que más se repiten entre los seleccionados (su EPG
  // actual y sus alternativas), después la búsqueda en todo el EPG.
  /** @param {ReportChannel[]} chs */
  function openBulkEpg(chs) {
    const score = new Map();
    for (const ch of chs) {
      const cur = currentEpgOf(ch);
      const ids = [...(cur ? [cur] : []), ...(ch.alternatives || []).map((a) => a.channel_id)];
      for (const id of new Set(ids)) score.set(id, (score.get(id) || 0) + 1);
    }
    const suggestions = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('#bulkEpgTitle').textContent = `EPG para ${plural(chs.length, 'canal', 'canales')}`;
    $('#bulkEpgBody').innerHTML = `
      ${suggestions.length ? `<div class="section-label">Sugerencias</div>
        <div class="list">${suggestions.map(([id, count]) => epgRowHtml(id, {
          pick: true, note: count > 1 ? `· opción de ${count} de ${chs.length}` : '',
        })).join('')}</div>` : ''}
      <div class="section-label">Buscar en todo el EPG</div>
      <label class="search-field" style="margin-top:6px">${icon('search')}
        <input type="search" class="catalog-search" placeholder="Canal o programa que está dando ahora" enterkeyhint="search">
      </label>
      <div class="list search-results" hidden></div>`;
    const body = $('#bulkEpgBody');
    const pick = (id) => {
      bulkEpgDialog.close();
      applyBulk(chs.map((ch) => ({ section: 'overrides', key: ch.xtream_name, value: id })),
        `EPG elegido para ${plural(chs.length, 'canal', 'canales')}`);
    };
    wirePicks(body, pick);
    fillNowPlaying(body);
    fillLogos(body);
    const input = $('.catalog-search', body);
    const results = $('.search-results', body);
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderCatalogSearch(input.value, results, pick), 150);
    });
    bulkEpgDialog.showModal();
  }

  /** @param {ReportChannel[]} chs */
  function openBulkCategory(chs) {
    $('#bulkTitle').textContent = `Mover ${plural(chs.length, 'canal', 'canales')}`;
    $('#bulkBody').innerHTML = `
      <select class="select bulk-cat" aria-label="Categoría destino">
        <option value="" selected disabled>Elegí la categoría…</option>${categoryGroupsHtml}
      </select>
      <div class="sheet-actions"><button class="btn btn-primary bulk-move" disabled>Mover</button></div>`;
    const select = /** @type {HTMLSelectElement} */ ($('.bulk-cat', $('#bulkBody')));
    const move = /** @type {HTMLButtonElement} */ ($('.bulk-move', $('#bulkBody')));
    select.addEventListener('change', () => { move.disabled = !select.value; });
    move.addEventListener('click', () => {
      bulkDialog.close();
      const dest = select.value;
      // Mover a su propia categoría original equivale a no tenerlo movido.
      applyBulk(chs.map((ch) => ({ section: 'categories', key: ch.xtream_name, value: dest === ch.category ? undefined : dest })),
        `${plural(chs.length, 'canal movido', 'canales movidos')} a ${dest}`);
    });
    bulkDialog.showModal();
  }

  selectBtn.addEventListener('click', () => setSelectMode(!selectMode));
  $('#bulkCancel').addEventListener('click', () => setSelectMode(false));
  $('#bulkActions').addEventListener('click', openBulkMenu);
  $('#bulkAll').addEventListener('click', () => {
    const allSel = filtered.length > 0 && filtered.every((ch) => selected.has(ch.xtream_name));
    if (allSel) filtered.forEach((ch) => selected.delete(ch.xtream_name));
    else filtered.forEach((ch) => selected.add(ch.xtream_name));
    $$('.card', cardsEl).forEach((old) => old.replaceWith(renderCard(cardChannel.get(old))));
    updateBulkBar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectMode && !document.querySelector('dialog[open]')) setSelectMode(false);
  });

  // ---- Menú "…" de la tarjeta: todas las acciones del canal en una hoja, para que la tarjeta
  // quede limpia. Las que necesitan datos (EPG, nombre, categoría) abren su panel en la tarjeta;
  // las demás se aplican directo.
  const cardMenuDialog = /** @type {HTMLDialogElement} */ ($('#cardMenuDialog'));

  /** @param {string} iconName @param {string} label @param {string} sub @param {string} action @param {string} [cls] */
  function menuRowHtml(iconName, label, sub, action, cls = '') {
    return `<button class="menu-row ${cls}" data-action="${action}">
      <span class="menu-icon">${icon(iconName)}</span>
      <span class="menu-text">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    </button>`;
  }

  function openCardMenu(cardEl, ch) {
    const key = ch.xtream_name;
    const epg = currentEpgOf(ch);
    const rows = [];
    if (!isDivider(ch)) {
      rows.push(menuRowHtml('pencil', 'Cambiar EPG', epg ? catalogEntry(epg).name : 'Sin EPG', 'editor'));
      rows.push(menuRowHtml('text-cursor-input', 'Cambiar nombre', renameOf(ch) || key, 'rename'));
      rows.push(menuRowHtml('folder-input', 'Mover de categoría', effectiveCategory(ch), 'category'));
    }
    // La visibilidad es un switch: cambia al instante sin cerrar el menú.
    rows.push(`<label class="menu-row static">
      <span class="menu-icon">${icon('eye')}</span>
      <span class="menu-text">Visible en la playlist<small class="vis-sub"></small></span>
      <input type="checkbox" class="switch vis-switch" aria-label="Visible en la playlist">
    </label>`);
    const extra = hasOverride(ch)
      ? `<div class="menu">${menuRowHtml('undo-2', 'Volver al EPG automático', 'Descarta el EPG elegido a mano', 'auto-epg', 'danger')}</div>`
      : '';
    $('#cardMenuTitle').textContent = renameOf(ch) || key;
    $('#cardMenuBody').innerHTML = `<div class="menu">${rows.join('')}</div>${extra}`;
    // Al cambiar la visibilidad la tarjeta se re-renderiza: las demás acciones buscan la actual.
    const liveCard = () => (cardEl.isConnected ? cardEl
      : $$('.card', cardsEl).find((c) => cardChannel.get(c) === ch) || cardEl);
    $$('[data-action]', $('#cardMenuBody')).forEach((btn) => btn.addEventListener('click', () => {
      cardMenuDialog.close();
      const action = btn.dataset.action || '';
      if (action === 'auto-epg') setEntry('overrides', key, undefined, 'Vuelve al EPG automático');
      else openPanel(liveCard(), ch, action);
    }));

    const sw = /** @type {HTMLInputElement} */ ($('.vis-switch', $('#cardMenuBody')));
    const syncSwitch = () => {
      sw.checked = !isHidden(ch);
      $('.vis-sub', $('#cardMenuBody')).textContent = !sw.checked ? 'Oculto: no sale en la playlist'
        : isCategoryHidden(ch) ? 'Su categoría está oculta: no sale igual' : 'Sale en la playlist';
    };
    syncSwitch();
    sw.addEventListener('change', async () => {
      const show = sw.checked;
      sw.disabled = true;
      await setEntry('hidden', key, show ? undefined : true, show ? 'Canal visible en la playlist' : 'Canal oculto de la playlist');
      sw.disabled = false;
      syncSwitch(); // si no se pudo guardar (p. ej. sin token) vuelve a su estado real
    });
    cardMenuDialog.showModal();
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
  const PANEL_TITLES = { editor: 'Cambiar EPG', rename: 'Cambiar nombre', category: 'Mover de categoría' };

  function closePanels() {
    $$('.panel:not([hidden])', cardsEl).forEach((p) => { p.hidden = true; p.innerHTML = ''; });
  }

  /** @param {HTMLElement} cardEl @param {ReportChannel} ch @param {string} kind */
  function openPanel(cardEl, ch, kind) {
    closePanels();
    const panel = $('.panel', cardEl);
    panel.hidden = false;
    panel.innerHTML = `<div class="panel-head">
        <span class="section-label">${esc(PANEL_TITLES[kind] || '')}</span>
        <button class="icon-btn ghost sm panel-close" aria-label="Cerrar">${icon('x')}</button>
      </div><div class="panel-body"></div>`;
    $('.panel-close', panel).addEventListener('click', closePanels);
    const body = $('.panel-body', panel);
    if (kind === 'editor') buildEditor(body, ch);
    else if (kind === 'rename') buildRenamePanel(body, ch);
    else buildCategoryPanel(body, ch);
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    fillLogos(panel);
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
    fillLogos(resultsEl);
  }

  // ---- Nombre: campo + guardar al costado (y volver al original si está renombrado)
  function buildRenamePanel(panel, ch) {
    const key = ch.xtream_name;
    const renamed = renameOf(ch);
    panel.innerHTML = `
      <div class="inline-field">
        <input class="input rename-input" type="text" value="${esc(renamed || key)}" enterkeyhint="done"
          aria-label="Nombre en la playlist">
        <button class="icon-btn filled rename-save" aria-label="Guardar nombre" title="Guardar nombre">${icon('check')}</button>
        ${renamed ? `<button class="icon-btn rename-restore" aria-label="Volver al nombre original"
          title="Volver al nombre original">${icon('rotate-ccw')}</button>` : ''}
      </div>
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
    input.focus({ preventScroll: true });
    input.select();
  }

  // ---- Categoría: se guarda al elegir
  function buildCategoryPanel(panel, ch) {
    const key = ch.xtream_name;
    panel.innerHTML = `<select class="select cat-select" aria-label="Categoría">${categoryOptions(ch)}</select>`;
    const select = $('.cat-select', panel);
    select.addEventListener('change', () => {
      setEntry('categories', key, select.value === ch.category ? undefined : select.value,
        select.value === ch.category ? 'Categoría original restaurada' : 'Canal movido de categoría');
    });
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
  /** @typedef {{ section: string, key: string, value: any }} MapChange */

  const currentValue = (section, key) => (has(channelMap[section], key) ? channelMap[section][key] : undefined);

  // Aplica uno o varios cambios en un solo commit (la selección múltiple usa el mismo camino),
  // re-renderiza las tarjetas afectadas y ofrece deshacerlos todos juntos. value === undefined
  // borra la entrada; en 'overrides', null es un valor válido ("dejar sin EPG").
  /** @param {MapChange[]} changes @param {string} label @returns {Promise<boolean>} */
  async function applyChanges(changes, label, { isUndo = false } = {}) {
    changes = changes.filter((c) => currentValue(c.section, c.key) !== c.value);
    if (!changes.length) return false;
    const undo = changes.map((c) => ({ ...c, value: currentValue(c.section, c.key) }));
    toast('Guardando…', { kind: 'busy', id: 'save' });
    try {
      await withChannelMap((doc) => {
        for (const { section, key, value } of changes) {
          doc[section] = doc[section] || {};
          if (value === undefined) delete doc[section][key];
          else doc[section][key] = value;
        }
      }, `${label} (interfaz de corrección)`);
    } catch (e) {
      toast(errMsg(e), { kind: 'error', id: 'save' });
      return false;
    }
    setPending(pendingChanges + (isUndo ? -1 : 1));
    // Ocultar una categoría cambia qué canales entran en cada filtro: se rearma la lista.
    if (changes.some((c) => c.section === 'hidden_categories')) {
      applyFilters();
      renderCategoriesList();
    } else {
      for (const key of new Set(changes.map((c) => c.key))) rerenderCards(key);
    }
    if (isUndo) {
      toast('Cambio deshecho', { kind: 'info', id: 'save' });
    } else {
      toast(label, {
        id: 'save',
        action: { label: 'Deshacer', fn: () => applyChanges(undo, `Deshacer: ${label.toLowerCase()}`, { isUndo: true }) },
      });
    }
    return true;
  }

  /** @param {string} section @param {string} key @param {any} value @param {string} label */
  function setEntry(section, key, value, label, { isUndo = false } = {}) {
    return applyChanges([{ section, key, value }], label, { isUndo });
  }

  // ================================================================= workflow

  const runBtn = $('#runWorkflowBtn');
  const workflowStatus = $('#workflowStatus');
  let pollTimer = null;
  let dispatchedAt = 0;          // para no confundir la corrida recién lanzada con la anterior

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

  let workflowBusy = false;       // hay una corrida en marcha o en cola (para el texto al lanzar otra)

  // Estado de las últimas corridas. El workflow corre de a una: una lanzada mientras otra está
  // en marcha queda en cola y arranca cuando esa termina (ver concurrency en merge-epgs.yml).
  /** @param {WorkflowRun[]} runs más nuevas primero @returns {boolean} true si no queda nada en curso */
  function renderRun(runs) {
    const active = runs.filter((r) => r.status !== 'completed');
    const wasBusy = workflowBusy;
    workflowBusy = active.length > 0;
    const run = active.find((r) => r.status === 'in_progress') || active[active.length - 1] || runs[0];
    const link = `<a href="${esc(run.html_url)}" target="_blank" rel="noopener">Ver ${icon('external-link', 'sm')}</a>`;
    let cls; let lead; let text; let extra = '';
    if (workflowBusy) {
      const waiting = active.length - (run.status === 'in_progress' ? 1 : 0);
      cls = 'busy'; lead = icon('loader-circle', 'spin');
      text = run.status === 'in_progress'
        ? `Workflow corriendo · ${Math.max(0, Math.round((Date.now() - new Date(run.run_started_at || run.created_at).getTime()) / 60000))} min (suele tardar ~8)`
          + (waiting ? ` · ${waiting} en cola` : '')
        : 'Workflow en cola: arranca en un momento';
    } else if (run.conclusion === 'success') {
      cls = 'ok'; lead = icon('circle-check');
      text = `Último workflow OK · ${fmtDateTime(run.updated_at)}`;
      extra = '<button class="btn btn-plain refresh-link">Actualizar datos</button>';
    } else if (run.conclusion === 'cancelled') {
      cls = 'ok'; lead = icon('info');
      text = `Último workflow reemplazado por uno más nuevo · ${fmtDateTime(run.updated_at)}`;
    } else {
      cls = 'bad'; lead = icon('circle-x');
      text = `El último workflow falló (${esc(run.conclusion)}) · ${fmtDateTime(run.updated_at)}`;
    }
    workflowStatus.hidden = false;
    workflowStatus.className = `status-bar ${cls}`;
    workflowStatus.innerHTML = `<span class="lead">${lead}</span><span class="grow">${text}</span>${extra}${link}`;
    const refresh = $('.refresh-link', workflowStatus);
    if (refresh) refresh.addEventListener('click', refreshData);

    // Aviso cuando termina todo lo que se vio en curso en esta sesión.
    if (wasBusy && !workflowBusy) {
      if (run.conclusion === 'success') {
        toast('El workflow terminó: playlists y EPG actualizados', { action: { label: 'Actualizar datos', fn: refreshData } });
      } else if (run.conclusion !== 'cancelled') {
        toast('El workflow falló', { kind: 'error', action: { label: 'Ver', fn: () => window.open(run.html_url, '_blank', 'noopener') } });
      }
    }
    return !workflowBusy;
  }

  async function pollWorkflow() {
    clearTimeout(pollTimer);
    /** @type {WorkflowRun[]} */
    let runs;
    try {
      runs = (await gh(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`)).workflow_runs || [];
    } catch {
      return; // sin permiso de Actions: el botón lo explica al usarlo
    }
    const stale = dispatchedAt && (!runs[0] || new Date(runs[0].created_at).getTime() < dispatchedAt - 60000);
    if (stale && Date.now() - dispatchedAt < 3 * 60000) {
      pollTimer = setTimeout(pollWorkflow, 5000); // todavía no apareció la corrida nueva
      return;
    }
    if (!runs.length) return;
    // Pendientes = cambios posteriores al arranque de la corrida más nueva (la que los va a aplicar).
    countPending(runs[0]);
    if (!renderRun(runs)) pollTimer = setTimeout(pollWorkflow, 15000);
  }

  async function runWorkflow() {
    if (!getToken()) { openTokenDialog(); return; }
    const ok = await confirmDialog({
      title: 'Correr el workflow',
      text: (pendingChanges
        ? `Aplica ${pendingChanges} cambio(s) guardado(s) a las playlists y al EPG. Tarda unos 8 minutos.`
        : 'Regenera playlists y EPG con lo último del proveedor. Tarda unos 8 minutos.')
        + (workflowBusy ? ' Ya hay uno en marcha: este queda en cola y arranca cuando termine.' : ''),
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
    runBtn.disabled = false;
    toast(workflowBusy ? 'Workflow en cola · arranca cuando termine el actual' : 'Workflow lanzado · te aviso cuando termine', { kind: 'info' });
    dispatchedAt = Date.now();
    workflowBusy = true; // para avisar cuando termine, aunque no se la llegue a ver corriendo
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

  // ================================================================= configuración

  const settingsDialog = $('#settingsDialog');

  /** @param {string} value auto | light | dark */
  function applyTheme(value) {
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
    // La barra del navegador / de la app instalada acompaña al tema elegido.
    const forced = value === 'light' ? '#f2f2f7' : value === 'dark' ? '#000000' : null;
    $$('meta[name="theme-color"]').forEach((m) => {
      if (!m.dataset.original) m.dataset.original = m.content;
      m.content = forced || m.dataset.original;
    });
  }

  /** @param {boolean} on */
  function setLogosEnabled(on) {
    logosEnabled = on;
    storageSet(LOGOS_KEY, on ? null : '0');
    document.body.classList.toggle('no-logos', !on);
    if (on) {
      if (logoById) fillLogos(document); else loadLogos();
    }
  }

  function openSettings() {
    $('#tokenState').textContent = getToken() ? 'Configurado' : 'Sin configurar: no se pueden guardar cambios';
    const hiddenCats = hiddenCategoryCount();
    $('#categoriesState').textContent = hiddenCats ? `${hiddenCats} oculta${hiddenCats === 1 ? '' : 's'}` : 'Todas visibles';
    const theme = storageGet(THEME_KEY) || 'auto';
    $$('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === theme)));
    $('#logosToggle').checked = logosEnabled;
    $('#startFilterSelect').value = storageGet(START_FILTER_KEY) || 'last';
    $('#aboutLine').textContent = `Grilla · versión ${APP_VERSION}`
      + (dataGeneratedAt ? ` · datos del ${fmtDateTime(dataGeneratedAt)}` : '');
    settingsDialog.showModal();
  }

  $('#themeSeg').addEventListener('click', (e) => {
    const btn = /** @type {Element} */ (e.target).closest('button[data-value]');
    if (!btn) return;
    const value = /** @type {HTMLElement} */ (btn).dataset.value || 'auto';
    storageSet(THEME_KEY, value === 'auto' ? null : value);
    applyTheme(value);
    $$('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  });
  $('#logosToggle').addEventListener('change', (e) => {
    setLogosEnabled(/** @type {HTMLInputElement} */ (e.target).checked);
  });
  $('#startFilterSelect').addEventListener('change', (e) => {
    const value = /** @type {HTMLSelectElement} */ (e.target).value;
    storageSet(START_FILTER_KEY, value === 'last' ? null : value);
    toast('Se aplica la próxima vez que abras Grilla', { kind: 'info' });
  });
  $('#menuToken').addEventListener('click', () => { settingsDialog.close(); openTokenDialog(); });
  $('#menuHelp').addEventListener('click', () => { settingsDialog.close(); $('#helpDialog').showModal(); });

  // ---- Categorías: un switch por categoría para sacarla entera de la playlist
  const categoriesDialog = /** @type {HTMLDialogElement} */ ($('#categoriesDialog'));
  const categoriesFilter = /** @type {HTMLInputElement} */ ($('#categoriesFilter'));

  function hiddenCategoryCount() {
    return Object.values(channelMap.hidden_categories || {}).filter(Boolean).length;
  }

  function renderCategoriesList() {
    if (!categoriesDialog.open) return;
    const term = normalize(categoriesFilter.value.trim());
    // Canales por categoría (donde se muestran) y la sección de cada una, agrupadas como en la playlist.
    const counts = new Map();
    const sectionOf = new Map();
    // Todas, también las de PPV que la grilla no muestra: igual salen en la playlist.
    for (const ch of allChannels) {
      if (isDivider(ch)) continue;
      const cat = effectiveCategory(ch);
      counts.set(cat, (counts.get(cat) || 0) + 1);
      if (!sectionOf.has(cat)) sectionOf.set(cat, effectiveSection(ch) || 'Sin sección');
    }
    const hiddenCats = channelMap.hidden_categories || {};
    const collator = new Intl.Collator('es');
    const bySection = new Map();
    for (const cat of [...counts.keys()].sort(collator.compare)) {
      if (term && !normalize(`${cat} ${sectionOf.get(cat)}`).includes(term)) continue;
      const sec = sectionOf.get(cat);
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec).push(cat);
    }
    $('#categoriesList').innerHTML = [...bySection.keys()].sort(collator.compare).map((sec) => `
      <div class="section-label">${esc(sec)}</div>
      <div class="menu">${bySection.get(sec).map((cat) => `
        <label class="menu-row static">
          <span class="menu-text">${esc(cat)}<small>${counts.get(cat)} canal${counts.get(cat) === 1 ? '' : 'es'}${hiddenCats[cat] ? ' · oculta' : ''}</small></span>
          <input type="checkbox" class="switch cat-switch" data-cat="${esc(cat)}" ${hiddenCats[cat] ? '' : 'checked'}
            aria-label="Mostrar ${esc(cat)}">
        </label>`).join('')}
      </div>`).join('') || '<p class="help">Ninguna categoría coincide.</p>';
  }

  $('#categoriesList').addEventListener('change', async (e) => {
    const sw = /** @type {HTMLInputElement} */ (e.target);
    if (!sw.classList.contains('cat-switch')) return;
    const cat = sw.dataset.cat || '';
    sw.disabled = true;
    await setEntry('hidden_categories', cat, sw.checked ? undefined : true,
      sw.checked ? `Categoría visible: ${cat}` : `Categoría oculta: ${cat}`);
    // Si no se pudo guardar, la lista se vuelve a armar con el estado real.
    renderCategoriesList();
  });
  categoriesFilter.addEventListener('input', renderCategoriesList);

  $('#menuCategories').addEventListener('click', () => {
    settingsDialog.close();
    categoriesFilter.value = '';
    categoriesDialog.showModal();
    renderCategoriesList();
  });

  // ---- Copia de seguridad: exportar / importar
  // El archivo lleva los cambios de canales (xtream_channel_map.json) y las preferencias de este
  // dispositivo. El token NO se exporta: es una credencial.
  const BACKUP_FORMAT = 1;
  const CHANNEL_SECTIONS = /** @type {const} */ (['overrides', 'renames', 'categories', 'hidden', 'hidden_categories']);

  /** Solo las entradas con la forma esperada (un archivo editado a mano no rompe nada).
   *  @param {any} raw @returns {ChannelMap} */
  function sanitizeChannelMap(raw) {
    /** @type {ChannelMap} */
    const out = { overrides: {} };
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const [k, v] of Object.entries(src.overrides || {})) {
      if (typeof v === 'string' || v === null) out.overrides[k] = v;
    }
    for (const sec of /** @type {const} */ (['renames', 'categories'])) {
      const entries = Object.entries(src[sec] || {}).filter(([, v]) => typeof v === 'string' && v.trim());
      if (entries.length) out[sec] = Object.fromEntries(entries);
    }
    for (const sec of /** @type {const} */ (['hidden', 'hidden_categories'])) {
      const entries = Object.entries(src[sec] || {}).filter(([, v]) => v === true);
      if (entries.length) out[sec] = Object.fromEntries(entries.map(([k]) => [k, true]));
    }
    return out;
  }

  /** @param {ChannelMap} map */
  function describeMap(map) {
    const ov = Object.values(map.overrides);
    const n = (/** @type {Record<string, unknown> | undefined} */ o) => Object.keys(o || {}).length;
    return `${ov.filter((v) => v !== null).length} EPG manuales, ${ov.filter((v) => v === null).length} sin EPG a propósito, `
      + `${n(map.renames)} renombrados, ${n(map.categories)} movidos, ${n(map.hidden)} ocultos`
      + ` y ${n(map.hidden_categories)} categorías ocultas`;
  }

  async function exportConfig() {
    settingsDialog.close();
    let map = channelMap;
    try { map = await getJSON(`${RAW_MAP_URL}?_=${Date.now()}`); } catch { /* se usa lo que ya está cargado */ }
    const data = {
      app: 'Grilla',
      format: BACKUP_FORMAT,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      channelMap: sanitizeChannelMap(map),
      preferences: {
        theme: storageGet(THEME_KEY) || 'auto',
        logos: logosEnabled,
        startFilter: storageGet(START_FILTER_KEY) || 'last',
      },
    };
    const name = `grilla-configuracion-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(data, null, 2) + '\n'], name, { type: 'application/json' });
    // En el celular, la hoja de compartir permite guardarlo en Archivos/iCloud/Drive o mandarlo.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Configuración de Grilla' });
        toast('Configuración exportada');
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // canceló
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Configuración exportada: ${name}`);
  }

  /** @param {File} file */
  async function importConfig(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('El archivo no es una configuración válida (no es JSON).', { kind: 'error' });
      return;
    }
    // Se acepta el archivo exportado por Grilla o directamente un xtream_channel_map.json.
    const rawMap = data && data.channelMap ? data.channelMap : data;
    if (!rawMap || typeof rawMap !== 'object' || typeof rawMap.overrides !== 'object') {
      toast('El archivo no tiene una configuración de Grilla.', { kind: 'error' });
      return;
    }
    const map = sanitizeChannelMap(rawMap);
    const when = data.exportedAt ? ` del ${fmtDateTime(data.exportedAt)}` : '';
    const ok = await confirmDialog({
      title: 'Importar configuración',
      text: `El archivo${when} trae ${describeMap(map)}. Reemplaza los cambios de canales actuales `
        + '(que igual quedan en el historial de GitHub) y se aplica al correr el workflow.',
      ok: 'Importar',
    });
    if (!ok) return;
    toast('Importando…', { kind: 'busy', id: 'save' });
    try {
      await withChannelMap((doc) => {
        for (const sec of CHANNEL_SECTIONS) delete doc[sec];
        Object.assign(doc, map);
      }, 'Importar configuración (interfaz de corrección)');
    } catch (e) {
      toast(errMsg(e), { kind: 'error', id: 'save' });
      return;
    }
    const prefs = data.preferences || {};
    if (['auto', 'light', 'dark'].includes(prefs.theme)) {
      storageSet(THEME_KEY, prefs.theme === 'auto' ? null : prefs.theme);
      applyTheme(prefs.theme);
    }
    if (typeof prefs.logos === 'boolean') setLogosEnabled(prefs.logos);
    if (['last', 'todos', 'revisar'].includes(prefs.startFilter)) {
      storageSet(START_FILTER_KEY, prefs.startFilter === 'last' ? null : prefs.startFilter);
    }
    setPending(pendingChanges + 1);
    applyFilters();
    toast('Configuración importada. Corré el workflow para aplicarla a la playlist.', { id: 'save' });
  }

  $('#menuExport').addEventListener('click', exportConfig);
  $('#menuImport').addEventListener('click', () => {
    if (!getToken()) { settingsDialog.close(); openTokenDialog(); return; }
    settingsDialog.close();
    $('#importFile').click();
  });
  $('#importFile').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files && input.files[0];
    input.value = ''; // permite volver a elegir el mismo archivo
    if (file) importConfig(file);
  });

  // Borra lo guardado en este dispositivo (preferencias, filtro, caché de la PWA) pero no el
  // token, por si algo queda trabado después de una actualización.
  $('#menuReset').addEventListener('click', async () => {
    settingsDialog.close();
    const ok = await confirmDialog({
      title: 'Restablecer la app',
      text: 'Se borran los filtros, el tema y la copia guardada de la app en este dispositivo, y se vuelve a cargar. Los cambios de canales (están en GitHub) y el token se conservan.',
      ok: 'Restablecer',
    });
    if (!ok) return;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('epg_ui_')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* sin storage */ }
    try {
      const regs = await navigator.serviceWorker?.getRegistrations() || [];
      await Promise.all(regs.map((r) => r.unregister()));
      if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    } catch { /* sin service worker */ }
    location.reload();
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

  // En captura: la línea "Ahora" puede estar dentro de una fila que se elige al tocarla
  // (alternativas, búsqueda); abrir la descripción no tiene que elegir ese EPG.
  document.addEventListener('click', (e) => {
    if (selectMode && (/** @type {Element} */ (e.target)).closest?.('#cards')) return; // la tarjeta se selecciona
    const btn = /** @type {HTMLElement | null} */ ((/** @type {Element} */ (e.target)).closest?.('.now-btn'));
    if (!btn) return;
    e.stopPropagation();
    toggleDesc(btn);
  }, true);

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
  $('#settingsBtn').addEventListener('click', openSettings);

  // PWA: instalable en la pantalla de inicio (ver sw.js). Solo en contexto seguro (GitHub Pages
  // por https, o localhost al probar).
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin PWA: la página anda igual */ });
  }

  (async () => {
    applyTheme(storageGet(THEME_KEY) || 'auto');
    document.body.classList.toggle('no-logos', !logosEnabled);
    hydrateIcons();
    cardsEl.innerHTML = skeletonHtml();
    try {
      await loadRelease();
      const names = Object.keys(profiles).sort();
      if (!names.length) throw new Error('Todavía no hay ningún match_report publicado: corré el workflow una vez.');
      await loadProfile(names[0]);
      loadLogos();
      pollWorkflow();
      // La primera vez en este dispositivo se muestra la ayuda.
      if (!storageGet(HELP_SEEN_KEY)) {
        storageSet(HELP_SEEN_KEY, '1');
        $('#helpDialog').showModal();
      }
    } catch (e) {
      cardsEl.innerHTML = `<div class="empty">${icon('triangle-alert', 'lg')}<strong>No se pudieron cargar los datos</strong>${esc(errMsg(e))}</div>`;
      toast(errMsg(e), { kind: 'error' });
    }
  })();
})();
