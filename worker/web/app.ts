// nowline web (Etapa 1, paso 4): la interfaz sobre el Worker. Conectar el proveedor, cruzar los
// canales con la guía en el navegador (@grilla/core, el mismo matcher que la corrida de
// Python), corregir y copiar los links para el reproductor. Sin cuenta: la configuración vive
// en el Worker y la clave para editarla, en este navegador (exportable como respaldo).
import {
  channelAlias, EpgIndex, flagToCountryCode, MatchingRules, matchStream, stripDisplayPrefix, variantKey, type Candidate, type GuideChannel,
  type MatchingRulesData, type SourceInfo,
} from '../../core/src/index.ts';
import { sourceAlias } from '../src/crypto.ts';
import { hashKey, readCache, writeCache } from './cache.ts';
import { parseEvent } from '../src/events.ts';
import { placeNewGroups } from '../src/groups.ts';
import { m3uLineParser, xtreamLiveChannel } from '../src/provider.ts';
import {
  linksBack, linksHelpTopic, openLinksView, openProfileSwitch, renderLinkResult, renderLinks, renderProfileNotice, type LinksView,
} from './ui/perfiles.tsx';
import { openChannel, refreshChannelSheet, startReview } from './ui/canal.tsx';
import { loadReports } from './ui/reports.tsx';
import { checkNovedades } from './ui/novedades.tsx';
import { renderIcon, renderNetPill, renderQr, renderStatus } from './ui/piezas.tsx';
import { renderFilterBar as drawFilterBar, type FilterHandlers, type FilterModel } from './ui/filtros.tsx';
import { hydrateIcons } from './ui/icon.tsx';
import { installSheets } from './ui/sheet.ts';
import { placeTabPill } from './ui/tabbar.ts';
import { openRowMenu as openRowMenuView, refreshCards, renderCards, renderReviewCard as renderReviewCardView, renderSkeleton } from './ui/canales.tsx';
import { openCodes } from './ui/codes.tsx';
import { openCategories, renderCategories, renderChannelOrder } from './ui/categorias.tsx';
import { LINKS_CARD_KEY, renderLinksCard, renderTipCard } from './ui/cards.tsx';
import { openProgramLink, showGuide, type GuideHost, type Habits } from './ui/guide.tsx';
import { setGenreAll, tasteAll } from './ui/avisos-gusto.tsx';
import { openBulkMenu } from './ui/seleccion.tsx';
import { iosNotInstalled, pushSupported, setPush } from './ui/settings.tsx';
import { hideSplash } from './ui/splash.ts';
import { toast } from './ui/toast.tsx';
import { loadTopics, titleKey, type TopicSearch } from './ui/topics.ts';
import { genreAssign, genreGroups, loadChannelGenres } from './ui/vista-genero.ts';

// ------------------------------------------------------------------ tipos (los del Worker)
type Provider = { type: 'xtream'; servers: string[]; list?: 'upload' } | { type: 'm3u' };
interface ChannelEdit { epg?: string | null; logo?: string; name?: string; group?: string; hidden?: boolean; manual?: boolean; customLogo?: string }
/** Una vista de las categorías guardada: sus categorías y la categoría de cada canal en esa vista. */
interface CategoryView { groups: { order: string[]; hidden: string[]; noEpg?: string[]; channels?: Record<string, string[]>; rename?: Record<string, string>; custom?: string[]; separators?: string[] }; assign: Record<string, string> }
interface Config {
  version: 1;
  provider: Provider;
  directUrls?: boolean;
  channels: Record<string, ChannelEdit>;
  groups: { order: string[]; hidden: string[]; noEpg?: string[]; channels?: Record<string, string[]>; rename?: Record<string, string>; custom?: string[]; separators?: string[] };
  /** Vista «Por género» de las categorías: la activa va en `groups` y en los canales; la otra, guardada aparte. */
  view?: 'genre';
  views?: { provider?: CategoryView; genre?: CategoryView };
  /** Cómo elige la guía la corrida de GitHub (importado): se usa igual para los canales nuevos. */
  matching?: { minScore?: number; feed?: string | null; categories?: Record<string, { country?: string | null; prefer_sources?: string[] }> };
  /** Perfil activo: la cuenta adicional con la que se baja la lista y se prueban los canales (sin dato = la principal).
   *  Se cambia con PUT …/active (ver «perfiles»). */
  activeAccount?: string;
  mainName?: string;
}
declare const __APP_VERSION__: string;
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
  'bell-off': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'cloud-off': '<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>',
  house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  'arrow-right-left': '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  'link-2': '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
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
const fold = (s: string) => s.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
/** Si el texto (ya plegado) tiene todas las palabras de la búsqueda (ya plegada), en cualquier
 *  orden: "inter parma" encuentra "Inter de Milán vs. Parma". */
const hasWords = (text: string, q: string) => q.split(/\s+/).every((w) => text.includes(w));

// showModal() y show() enfocan el primer elemento de la hoja (el ojo, la ayuda o el nombre editable del
// canal) y queda el aro de foco o el teclado abierto sin que nadie haya tocado nada. Si el foco cae en un
// botón o en el nombre de un canal o categoría, pasa a la hoja misma; los demás campos (por ejemplo, el de
// un diálogo que pide un nombre) conservan su foco.
function settleFocus(dlg: HTMLDialogElement) {
  const a = document.activeElement;
  if (a instanceof HTMLElement && dlg.contains(a) && (!a.matches('input, textarea, select') || a.classList.contains('ch-name'))) {
    dlg.tabIndex = -1;
    dlg.focus({ preventScroll: true });
  }
}
// Al cerrar una hoja el navegador devuelve el foco a la fila que la abrió y queda marcada en la grilla:
// se lo saca (el teclado sigue pudiendo moverse con Tab desde ahí).
document.addEventListener('close', (ev) => {
  if (!(ev.target instanceof HTMLDialogElement)) return;
  const a = document.activeElement;
  if (a instanceof HTMLElement && a.matches('.card, .cat-row, .row-card, .section-card')) a.blur();
}, true);
const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  nativeShowModal.call(this);
  settleFocus(this);
};
const nativeShow = HTMLDialogElement.prototype.show;
HTMLDialogElement.prototype.show = function (this: HTMLDialogElement) {
  nativeShow.call(this);
  settleFocus(this);
};

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
  renderIcon($('#askIcon'), o.icon ?? 'text-cursor-input');
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

function status(el: HTMLElement, text: string | null, kind: 'busy' | 'ok' | 'bad' = 'busy', retry?: () => void) {
  if (el.id === 'onboardStatus') document.body.classList.toggle('onboard-busy', !!text && kind === 'busy');
  el.hidden = !text;
  if (!text) return;
  el.className = `status-bar ${kind}`;
  renderStatus(el, text, kind, retry);
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

/** Un GET que falla por la red o por un error pasajero del servidor (5xx) se reintenta dos veces (a los 0,6 y 1,8 s):
 *  con datos móviles el primer pedido a veces se corta y la grilla quedaba sin cargar. Los cambios no se reintentan. */
/** Un pedido que no contesta en este tiempo se da por caído (en el celular, una conexión colgada dejaba la carga
 *  esperando para siempre). */
const GET_TIMEOUT_MS = 20000;
async function fetchRetry(path: string, init: RequestInit = {}): Promise<Response> {
  const get = !init.method || init.method === 'GET';
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(path, get ? { ...init, signal: AbortSignal.timeout(GET_TIMEOUT_MS) } : init);
      if (!get || res.status < 500 || i >= 2) return res;
    } catch (e) {
      if (!get || i >= 2) throw e;
    }
    await new Promise((ok) => setTimeout(ok, 600 * 3 ** i));
  }
}

/** Sin red de verdad: el navegador no tiene conexión o el pedido falló en el camino. Un error de código (o del
 *  servidor) no cuenta: antes, cualquier TypeError se mostraba como «sin conexión». */
const offlineError = (e: unknown) => !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed|aborted/i.test(e.message));
/** El servidor no contestó a tiempo (y no es falta de conexión). */
const slowError = (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError';
/** Lo que se le dice a la persona cuando algo de la carga falla. */
const loadError = (e: unknown) => (offlineError(e) ? 'sin conexión' : slowError(e) ? 'el servidor tarda en responder' : (e as Error).message);

/** Cuántos cambios de links, perfiles o cuentas se mandaron al Worker: Perfil dibuja con lo que ya tiene solo si no hubo ninguno desde que lo bajó. */
let apiWrites = 0;
async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; key?: string } = {}): Promise<T> {
  if (opts.method && opts.method !== 'GET' && /\/(devices|profiles|token|account-name|credentials|active)\b/.test(path)) apiWrites++;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  // `key`: la clave de otra configuración del hogar (otro proveedor); sin eso, la de la que está abierta.
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  else if (opts.auth !== false && state.local) headers.Authorization = `Bearer ${state.local.editKey}`;
  const get = (opts.method ?? 'GET') === 'GET';
  for (let i = 0; ; i++) {
    const res = await fetchRetry(path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    let data: unknown = {};
    try {
      data = await res.json();
    } catch (e) {
      // Con la respuesta bien pero el cuerpo cortado (pasa en la red del celular), se vuelve a pedir. Un error del
      // servidor que no trae JSON sigue siendo un error con su código.
      if (res.ok && get && i < 2) {
        await new Promise((ok) => setTimeout(ok, 600 * 3 ** i));
        continue;
      }
      if (res.ok) throw e;
    }
    if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), { data });
    return data as T;
  }
}

// ------------------------------------------------------------------ hogar
// Todas las configuraciones (una por proveedor) de esta persona. Se guardan en este navegador y, si hay más de una, en el
// Worker como hogar (/api/home): cifradas acá con una clave que sale de la del hogar, así el servidor no ve las claves de
// edición. Con el código del hogar (id.clave) se abre todo en otro dispositivo. Ver planes/perfiles.md.
interface HomeConfig { cfgId: string; editKey: string; name?: string }
// `removed`: las configuraciones quitadas, para que otro dispositivo no las vuelva a sumar al hogar.
interface Home { configs: HomeConfig[]; removed?: string[]; homeId?: string; homeKey?: string }
const HOME_KEY = 'grilla_home_v1';
function loadHome(): Home {
  let h: Home = { configs: [] };
  try {
    h = JSON.parse(localStorage.getItem(HOME_KEY) || 'null') ?? h;
  } catch { /* sin storage */ }
  if (!Array.isArray(h.configs)) h.configs = [];
  if (!Array.isArray(h.removed)) h.removed = [];
  // La configuración abierta siempre está en el hogar (las de antes de esta versión entran solas).
  if (state.local && !h.configs.some((c) => c.cfgId === state.local!.cfgId) && !h.removed.includes(state.local.cfgId)) h.configs.unshift({ ...state.local });
  return h;
}
let homeSync = 0;
function saveHome(h: Home, sync = true) {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(h));
  } catch { /* sin storage */ }
  if (!sync || (h.configs.length < 2 && !h.homeId)) return;
  clearTimeout(homeSync);
  homeSync = window.setTimeout(() => void pushHome(h).catch(() => {}), 500);
}
const providerName = (h: Home, cfgId: string) => {
  const i = h.configs.findIndex((c) => c.cfgId === cfgId);
  return h.configs[i]?.name || `Proveedor ${i + 1}`;
};

const te = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (t: string) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
async function homeCryptoKey(homeKey: string) {
  const raw = await crypto.subtle.digest('SHA-256', te.encode(`grilla-hogar-cifrado\n${homeKey}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealHome(h: Home): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await homeCryptoKey(h.homeKey!), te.encode(JSON.stringify({ configs: h.configs, removed: h.removed ?? [] }))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}
async function openHome(homeKey: string, data: string): Promise<{ configs: HomeConfig[]; removed: string[] }> {
  const raw = unb64u(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await homeCryptoKey(homeKey), raw.slice(12));
  const { configs, removed } = JSON.parse(new TextDecoder().decode(pt)) as { configs?: HomeConfig[]; removed?: string[] };
  return {
    configs: Array.isArray(configs) ? configs.filter((c) => typeof c?.cfgId === 'string' && typeof c?.editKey === 'string') : [],
    removed: Array.isArray(removed) ? removed.filter((id) => typeof id === 'string') : [],
  };
}
/** Junta en `h` lo del hogar del servidor: suma las configuraciones que falten y saca las quitadas. Devuelve cuántas suma. */
function mergeHome(h: Home, remote: { configs: HomeConfig[]; removed: string[] }): number {
  const removed = new Set([...(h.removed ?? []), ...remote.removed]);
  const before = new Set(h.configs.map((c) => c.cfgId));
  for (const c of remote.configs) if (!before.has(c.cfgId)) h.configs.push(c);
  h.configs = h.configs.filter((c) => !removed.has(c.cfgId));
  h.removed = [...removed].slice(-200);
  return h.configs.filter((c) => !before.has(c.cfgId)).length;
}
/** Sube el hogar al Worker (lo crea la primera vez). */
async function pushHome(h: Home) {
  if (!h.homeId || !h.homeKey) {
    // El Worker arma el id y la clave; el contenido se cifra después con esa clave.
    const created = await api<{ homeId: string; homeKey: string }>('/api/home', { method: 'POST', auth: false, body: { v: 1, data: 'nuevo' } });
    h.homeId = created.homeId;
    h.homeKey = created.homeKey;
    saveHome(h, false);
  } else {
    // Antes de subir se trae lo del servidor: si otro dispositivo sumó o quitó un proveedor, no se pisa.
    try {
      const remote = await api<{ data: string }>(`/api/home/${h.homeId}`, { key: h.homeKey });
      mergeHome(h, await openHome(h.homeKey, remote.data));
      saveHome(h, false);
    } catch { /* hogar recién creado o ilegible: se sube lo de acá */ }
  }
  await api(`/api/home/${h.homeId}`, { method: 'PUT', key: h.homeKey, body: { v: 1, data: await sealHome(h) } });
}
/** Trae lo que otro dispositivo sumó o quitó del hogar (como mucho una vez por minuto). */
let homePulledAt = 0;
async function pullHome() {
  const h = loadHome();
  if (!h.homeId || !h.homeKey || Date.now() - homePulledAt < 60_000) return;
  homePulledAt = Date.now();
  try {
    const before = JSON.stringify([h.configs, h.removed]);
    mergeHome(h, await openHome(h.homeKey, (await api<{ data: string }>(`/api/home/${h.homeId}`, { key: h.homeKey })).data));
    if (JSON.stringify([h.configs, h.removed]) !== before) saveHome(h, false);
  } catch { /* sin conexión: queda lo de acá */ }
}
const homeCode = (h: Home) => (h.homeId && h.homeKey ? `${h.homeId}.${h.homeKey}` : '');
/** Trae un hogar con su código y lo junta con el de este navegador. Devuelve cuántas configuraciones suma. */
async function joinHome(code: string): Promise<number> {
  const m = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{20,})$/.exec(code.trim());
  if (!m) throw new Error('no es un código de nowline');
  const data = await api<{ data: string }>(`/api/home/${m[1]}`, { key: m[2] });
  const h = loadHome();
  const added = mergeHome(h, await openHome(m[2], data.data));
  h.homeId = m[1];
  h.homeKey = m[2];
  saveHome(h);
  return added;
}
/** Abre otra configuración del hogar (otro proveedor): cambia la grilla, la lista y los perfiles. */
async function switchProvider(cfgId: string) {
  const c = loadHome().configs.find((x) => x.cfgId === cfgId);
  if (!c || c.cfgId === state.local?.cfgId) return;
  for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close();
  state.local = { cfgId: c.cfgId, editKey: c.editKey };
  saveLocal(state.local);
  state.creds = null;
  profileDevices = [];
  profileDefs = [];
  profilesAt = -1;
  liveAccounts = {};
  streamHealth = null;
  await openSaved();
}
// Código para ver (Perfil → un perfil → Compartir para ver): «ver.<código>», o el link /ver#<código>. Abre este
// dispositivo en el modo «solo ver» (ver.tsx), que no guarda ninguna clave de edición.
const VIEW_CODE_KEY = 'grilla_ver_code';
const viewCodeOf = (text: string) => /(?:^ver\.|\/ver#)([A-Za-z0-9_-]{20,32})$/.exec(text.trim())?.[1] ?? null;
async function useViewCode(code: string) {
  const res = await fetchRetry(`/api/view/${code}`);
  if (res.status === 404) throw new Error('ese código para ver ya no existe');
  if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
  try { localStorage.setItem(VIEW_CODE_KEY, code); } catch { /* sin storage: queda en la dirección */ }
  location.href = `/ver#${code}`;
}
/** Pegar el código de un hogar: suma sus proveedores a este navegador y, si no había ninguno abierto, abre el primero.
 *  Un código para ver abre el modo «solo ver». */
async function useHomeCode() {
  const code = await promptDialog({ title: 'Pegar un código', ok: 'Usar', icon: 'arrow-right-left', input: { label: 'Código', placeholder: 'El de tu otro dispositivo o uno para ver' } });
  if (!code) return;
  try {
    const view = viewCodeOf(code);
    if (view) return void await useViewCode(view);
    const added = await joinHome(code);
    toast(added ? `Listo: ${plural(added, 'proveedor sumado', 'proveedores sumados')}` : 'Ya tenías todos los proveedores de ese código', 'ok', 6000);
    for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close();
    if (!state.local) {
      const first = loadHome().configs[0];
      if (!first) return;
      state.local = { cfgId: first.cfgId, editKey: first.editKey };
      saveLocal(state.local);
      await openSaved();
    } else void loadProfiles();
  } catch (e) {
    toast(`No se pudo usar el código: ${(e as Error).message}`, 'bad', 6000);
  }
}
/** Quitar el proveedor abierto: borra su configuración (sus links dejan de andar) y abre el siguiente del hogar. */
async function forgetConfig() {
  if (!await confirmDialog({
    title: `¿Quitar ${providerName(loadHome(), state.local!.cfgId)}?`, text: 'Tus links de reproducción dejan de funcionar. No se puede deshacer.',
    ok: 'Quitar', danger: true,
  })) return;
  try {
    await api(`/api/cfg/${state.local!.cfgId}`, { method: 'DELETE' });
  } catch { /* ya no estaba */ }
  try {
    localStorage.removeItem(LIST_KEY(state.local!.cfgId));
  } catch { /* sin storage */ }
  const h = loadHome();
  h.configs = h.configs.filter((c) => c.cfgId !== state.local!.cfgId);
  h.removed = [...(h.removed ?? []), state.local!.cfgId];
  saveHome(h);
  saveLocal((state.local = null));
  state.creds = null;
  state.cfg = null;
  for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close();
  // Con otros proveedores en el hogar, se abre el siguiente.
  if (h.configs[0]) {
    state.local = { cfgId: h.configs[0].cfgId, editKey: h.configs[0].editKey };
    saveLocal(state.local);
    return void openSaved();
  }
  showOnboarding();
}

/** «Tu código»: el del hogar, para abrir todos los proveedores en otro dispositivo, y los de modo ver de cada perfil. */
async function showHomeCode() {
  const h = loadHome();
  try {
    if (!h.homeId) await pushHome(h);
  } catch (e) {
    return void toast((e as Error).message, 'bad', 6000);
  }
  openCodes(homeCode(loadHome()));
}

/** Agregar otro proveedor: el alta de siempre, sin perder la configuración abierta (queda en el hogar). */
let addingFrom: Local | null = null;
async function addProvider() {
  if (!state.local) return;
  if (!(await confirmDialog({ title: 'Agregar otro proveedor', icon: 'plus',
    text: 'Vas a cargar otra lista (otro servicio de IPTV) con su propia grilla. Tu configuración de ahora queda guardada y la abrís desde Perfiles.', ok: 'Continuar' }))) return;
  saveHome(loadHome());
  for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close();
  addingFrom = state.local;
  state.local = null;
  state.cfg = null;
  state.creds = null;
  state.channels = [];
  showOnboarding();
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
  // Venir de un aviso de canales nuevos (/?filtro=nuevos): abre en «Nuevos».
  if (/[?&]filtro=nuevos\b/.test(location.search)) {
    history.replaceState(null, '', location.pathname + location.hash);
    return 'nuevos';
  }
  const start = pref('grilla_start_filter', 'last');
  const f = start === 'last' ? pref('grilla_last_filter', 'todos') : start;
  return FILTERS.includes(f) ? f : 'todos';
}
const logosOn = () => pref('grilla_logos', '1') !== '0';

// ------------------------------------------------------------------ canales nuevos
// Los canales que aparecen después en la lista del proveedor (y no están ocultos) se marcan como nuevos durante
// 24 horas, o hasta «Marcar como vistos». El aviso de arriba sale una sola vez: la sesión (apertura de la app) en que
// el canal apareció; después queda solo el filtro «Nuevos». Por cada nombre se guarda en este navegador cuándo se vio
// por primera vez (0 = ya visto) y en qué apertura de la app.
const SEEN_KEY = (cfgId: string) => `grilla_seen_${cfgId}`;
const NEW_FOR_S = 24 * 3600;
const SESSION = Math.random().toString(36).slice(2, 8);
type SeenMap = Record<string, [number, string]>;
function loadSeen(): SeenMap | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY(state.local!.cfgId));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    // Formato viejo: lista de nombres vistos.
    if (Array.isArray(v)) return Object.fromEntries((v as string[]).map((n) => [n, [0, ''] as [number, string]]));
    return v && typeof v === 'object' ? (v as SeenMap) : null;
  } catch {
    return null;
  }
}
function saveSeen(seen: SeenMap) {
  try {
    localStorage.setItem(SEEN_KEY(state.local!.cfgId), JSON.stringify(seen));
  } catch { /* sin storage */ }
}
function detectNew() {
  if (!state.local) return;
  const seen = loadSeen();
  if (!seen) {
    // Primera vez: todo es conocido.
    markSeen();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const c of state.channels) {
    if (!(c.name in seen)) {
      seen[c.name] = [now, SESSION];
      changed = true;
    }
  }
  if (changed) saveSeen(seen);
  const fresh = state.channels.filter((c) => {
    const e = seen[c.name];
    return !!e && e[0] > 0 && now - e[0] < NEW_FOR_S && !info(c).hidden && !info(c).divider;
  });
  state.newNames = new Set(fresh.map((c) => c.name));
  state.bannerNames = new Set(fresh.filter((c) => seen[c.name][1] === SESSION).map((c) => c.name));
}
function markSeen() {
  if (!state.local) return;
  saveSeen(Object.fromEntries(state.channels.map((c) => [c.name, [0, ''] as [number, string]])));
  state.newNames = new Set();
  state.bannerNames = new Set();
}
/** Canales nuevos del proveedor (por canal, no por nombre: hay nombres repetidos). El filtro «Nuevos» los muestra 24 horas;
 *  el aviso va dentro de la tarjeta de revisión (renderReviewCard) y solo la primera vez. */
let newCount = 0;
let bannerCount = 0;
function renderNewBanner() {
  newCount = state.channels.filter((c) => state.newNames.has(c.name)).length;
  bannerCount = state.channels.filter((c) => state.bannerNames.has(c.name)).length;
  if (!newCount && state.filter === 'nuevos') state.filter = 'todos';
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
  bannerNames: new Set<string>(), // los nuevos de esta apertura de la app (los del aviso)
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
/** Cuándo se armó la guía que está cargada: cambia una vez por día y es la clave del caché del cruce. */
let guideAt: string | null = null;
/** Si ya corrió el cruce de esta apertura: antes, las filas no muestran coincidencia (ver computeInfo). */
let guideReady = false;
async function loadGuide(onStatus: (t: string) => void) {
  if (state.index) return;
  onStatus('Bajando la guía de programación…');
  const guide = await api<{
    matching_rules: MatchingRulesData; sources: Record<string, SourceInfo>; channels: GuideChannel[]; generated_at?: string;
  }>('/api/guide/index.json', { auth: false });
  guideAt = guide.generated_at ?? null;
  onStatus('Preparando la guía…');
  await new Promise((r) => setTimeout(r));
  state.rules = new MatchingRules(guide.matching_rules);
  state.index = new EpgIndex(guide.channels, state.rules, guide.sources);
}

/** Con la guía enmascarada (ids con alias), lo guardado con el id real pasa a su alias; al guardarse, la
 *  playlist y la guía del reproductor cambian juntas. Con una guía vieja (sin alias) no toca nada. */
function maskStoredIds(): boolean {
  if (!state.index?.masked) return false;
  let changed = false;
  for (const e of Object.values(state.cfg!.channels)) {
    if (typeof e.epg === 'string' && channelAlias(e.epg) !== e.epg) {
      e.epg = channelAlias(e.epg);
      changed = true;
    }
  }
  return changed;
}

const MATCH_CACHE = 'cruce';
/** Lo que tiene que ser igual para reusar el cruce: la guía del día, la lista (nombre, id y categoría) y las preferencias. */
function matchCacheKey(cfg: Config, channels: Channel[], guideDay: string): Promise<string> {
  return hashKey(JSON.stringify([2, guideDay, cfg.provider.type, cfg.matching ?? null, channels.map((c) => [c.name, c.epgId ?? null, c.category])]));
}

/** Cruza todos los canales con la guía. Con miles de canales tarda varios segundos, así que el resultado se guarda en
 *  este navegador (ver matchCacheKey): mientras no cambie la guía del día, la lista o las preferencias, se reusa. Los EPG
 *  elegidos a mano no se tocan. Devuelve si cambió algo de la configuración. */
async function rematch(onStatus: (t: string) => void): Promise<boolean> {
  const { cfg, index, rules } = state;
  if (!cfg || !index || !rules) return false;
  const before = JSON.stringify(cfg.channels);
  const trust = cfg.provider.type === 'm3u';
  // Con las preferencias importadas de GitHub se elige igual que allá (su umbral, su señal
  // horaria y las fuentes/país de cada categoría); sin ellas, lo dudoso queda como sugerencia.
  const prefs = cfg.matching ?? {};
  // La guía trae las fuentes enmascaradas: las preferidas de cada categoría se traducen al mismo alias.
  const categories: Record<string, { country?: string | null; prefer_sources?: string[] }> = {};
  for (const [cat, c] of Object.entries(prefs.categories ?? {})) {
    categories[cat] = { ...c, ...(c.prefer_sources ? { prefer_sources: await Promise.all(c.prefer_sources.map(sourceAlias)) } : {}) };
  }
  const baseScore = prefs.minScore ?? 0.7;
  const minAssignScore = baseScore;
  if ('feed' in prefs) index.preferredFeed = prefs.feed ?? null;
  const names = [...new Set(state.channels.map((c) => c.name))];
  const byName = new Map(state.channels.map((c) => [c.name, c]));
  const cacheKey = guideAt ? await matchCacheKey(cfg, state.channels, guideAt).catch(() => null) : null;
  const cached = cacheKey ? await readCache<Record<string, Auto>>(MATCH_CACHE, cacheKey) : null;
  const matches = new Map<string, Auto>(Object.entries(cached ?? {}));
  if (!cached) {
    for (let i = 0; i < names.length; i++) {
      if (i % 150 === 0) {
        onStatus(`Buscando la guía de cada canal… ${Math.round((100 * i) / names.length)} %`);
        await new Promise((r) => setTimeout(r));
      }
      const ch = byName.get(names[i])!;
      // Los separadores de sección del proveedor no son canales: nunca llevan guía.
      if (DIVIDER_RE.test(ch.category)) continue;
      const m = matchStream(ch.name, ch.epgId, index, {}, categories[ch.category] ?? {}, flagToCountryCode(ch.category, rules), { trustListIds: trust, minAssignScore });
      matches.set(ch.name, { cid: m.channelId, score: m.score, ranked: m.ranked.slice(0, 8) });
    }
    if (cacheKey) void writeCache(MATCH_CACHE, cacheKey, Object.fromEntries(matches));
  }
  guideReady = true;
  for (const name of names) {
    const ch = byName.get(name)!;
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
    const m = matches.get(ch.name) ?? { cid: null, score: 0, ranked: [] };
    state.auto.set(ch.name, m);
    const edit = cfg.channels[ch.name] ?? {};
    // Lo que trajo la importación de GitHub entra marcado "a mano" para no recalcularlo, pero si
    // coincide con lo que elige el cruce automático no es una elección propia: vuelve a ser
    // automático (muestra su porcentaje y sigue la guía del día, como en GitHub).
    if (cfg.matching && edit.manual && edit.epg && m.cid === edit.epg) delete edit.manual;
    if (!edit.manual) {
      if (m.cid) {
        edit.epg = m.cid;
        const logo = index.icon.get(m.cid);
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

async function saveNow(announce = true) {
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
    if (announce) guideAnnounce = true;
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
let guideAnnounce = false; // solo se avisa si guardaste un cambio en esta sesión

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
      if (guideAnnounce) toast(`La guía ya está lista con tus cambios (${guideTime(st.guide)})`, 'ok');
    }
    return;
  }
  if (!guidePending) {
    guidePending = true;
    if (guideAnnounce) toast(`La playlist ya tiene tus cambios; la guía se actualiza en ${st.autoRefresh ? 'un par de minutos' : 'unos 10 minutos'}`, 'info', 4500);
  }
  guideTimer = window.setTimeout(refreshGuideStatus, 30000);
}

/** «Actualizar la guía ahora» (Configuración): el Worker arranca la corrida y se vuelve a mirar en 20 s. */
async function startGuideRefresh(): Promise<boolean> {
  const r = await api<{ started: boolean }>(`/api/cfg/${state.local!.cfgId}/refresh`, { method: 'POST' });
  guidePending = true;
  clearTimeout(guideTimer);
  guideTimer = window.setTimeout(refreshGuideStatus, 20000);
  return r.started;
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
  return orderedGroups(state.cfg!.groups, groupOf);
}

/** Las categorías de una vista (sus canales van a la que diga `catOf`) en el orden de `gr`. */
function orderedGroups(gr: Config['groups'], catOf: (ch: Channel) => string): string[] {
  const present: string[] = [];
  const seen = new Set<string>();
  for (const ch of state.channels) {
    const g = catOf(ch);
    if (!seen.has(g)) {
      seen.add(g);
      present.push(g);
    }
  }
  // Las creadas a mano existen aunque todavía no tengan canales.
  for (const g of [...(gr.custom ?? []), ...(gr.separators ?? [])]) {
    if (!seen.has(g)) {
      seen.add(g);
      present.push(g);
    }
  }
  return placeNewGroups(gr.order, present, new Set(gr.separators ?? [])).filter((g) => seen.has(g));
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

type Band = 'ok' | 'warn' | 'none' | 'manual' | 'purpose' | 'loading';
/** Durante un render() el estado no cambia: se calcula una sola vez por canal (los conteos de las
 *  pestañas, la lista y el filtro lo piden varias veces; con 10 000 canales se nota). */
let infoMemo: Map<Channel, ReturnType<typeof computeInfo>> | null = null;
function info(ch: Channel) {
  if (!infoMemo) return computeInfo(ch);
  let r = infoMemo.get(ch);
  if (!r) infoMemo.set(ch, (r = computeInfo(ch)));
  return r;
}
function computeInfo(ch: Channel) {
  const edit = state.cfg!.channels[ch.name] ?? {};
  const auto = state.auto.get(ch.name);
  const epg = edit.epg ?? null;
  const hidden = !!edit.hidden || state.cfg!.groups.hidden.includes(groupOf(ch));
  // "purpose": lo dejaste sin EPG a propósito (es una decisión tuya, no un canal sin resolver).
  // Hasta que el cruce de esta apertura corre, ninguna fila dice «Sin EPG» ni «Dudoso»: no hay dato todavía.
  const band: Band = edit.manual ? (epg ? 'manual' : 'purpose') : !guideReady ? 'loading' : epg ? ((auto?.score ?? 0) >= GOOD ? 'ok' : 'warn') : 'none';
  // Categoría marcada "Sin guía" (Categorías): no cuenta en "A revisar" ni en "Sin EPG".
  const noGuide = !!state.cfg!.groups.noEpg?.includes(groupOf(ch));
  const divider = DIVIDER_RE.test(ch.category) || headersNow().has(groupOf(ch));
  const suggestion = !epg && !edit.manual && !divider ? auto?.ranked.find((c) => c.nameScore >= 0.3) ?? null : null;
  return { edit, auto, epg, hidden, band, suggestion, noGuide, divider, prog: epg ? progOf(epg) : null, down: isDown(ch), q: qualityOf(ch) };
}

// ------------------------------------------------------------------ canales caídos
// Una vez por día el cron del Worker prueba una tanda de streams por el relay y deja el resultado
// (src/streamcheck.ts). «Caído» = falló dos pruebas seguidas. Es solo un aviso: no oculta nada.
interface Account { status?: string; expires?: string | null; trial?: boolean; maxConnections?: number; activeConnections?: number; timezone?: string }
interface StreamHealth { checked?: string; requested?: string; relayOk?: string; relayFail?: string; listAt?: string; listOkAt?: string; listFailAt?: string; tested?: number; total?: number; account?: Account; accounts?: Record<string, Account>; channels: Record<string, { t: string; ok: boolean; fails: number }>; res?: Record<string, { t: string; w?: number; h?: number }>; progress?: { done: number; total: number; down: number } }
const DOWN_AFTER = 2;
let streamHealth: StreamHealth | null = null;

/** «hace 5 h», «hace 3 días». */
function sinceText(t: number): string {
  const h = Math.max(1, Math.round((Date.now() - t) / 3600_000));
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
/** El relay (el servicio que habla con el proveedor) dejó de responder: la prueba de canales falló la última vez y lo
 *  último bueno tiene más de un día, o la lista no se pudo bajar la última vez y la guardada tiene más de 2 horas.
 *  Dice desde cuándo («hace 3 días», o null si nunca anduvo) cada cosa no se actualiza; null si todo anda. */
function relayTrouble(): { probe?: string | null; list?: string } | null {
  const h = streamHealth;
  if (!h) return null;
  const t = (s?: string) => Date.parse(s ?? '') || 0;
  const out: { probe?: string | null; list?: string } = {};
  const fail = t(h.relayFail), good = Math.max(t(h.relayOk), t(h.checked));
  if (fail > good && Date.now() - (good || fail) > 24 * 3600_000) out.probe = good ? sinceText(good) : null;
  const listFail = t(h.listFailAt), listAt = t(h.listAt);
  if (listFail > t(h.listOkAt) && listAt && Date.now() - listAt > 2 * 3600_000) out.list = sinceText(listAt);
  return 'probe' in out || out.list ? out : null;
}
const isDown = (ch: Channel) => {
  const h = streamHealth?.channels[ch.id];
  return !!h && !h.ok && h.fails >= DOWN_AFTER;
};
/** La resolución real del canal (la mide el relay una vez por semana, junto con la prueba de caídos): la etiqueta
 *  corta (SD, HD, FHD, 4K) y el detalle. Sin medir todavía, null. */
export interface Quality { label: 'SD' | 'HD' | 'FHD' | '4K'; w: number; h: number; t: string }
function qualityOf(ch: Channel): Quality | null {
  const r = streamHealth?.res?.[ch.id];
  if (!r?.w || !r.h) return null;
  const label = r.h >= 1800 ? '4K' : r.h >= 1000 ? 'FHD' : r.h >= 700 ? 'HD' : 'SD';
  return { label, w: r.w, h: r.h, t: r.t };
}
export const qualityTitle = (q: Quality) => `Resolución: ${q.w} × ${q.h}`;
async function loadStreamHealth() {
  if (!state.local) return;
  try {
    streamHealth = await api<StreamHealth>(`/api/cfg/${state.local.cfgId}/health`);
  } catch {
    streamHealth = null;
  }
  render();
  renderProfileNotice();
  renderProbeStrip();
  // Con la Guía abierta, que tome las etiquetas de resolución recién llegadas.
  const guide = document.getElementById('guide');
  if (guide && !guide.hidden) {
    infoMemo = new Map();
    try { showGuide(guide, guideHost); } finally { infoMemo = null; }
  }
}

// ------------------------------------------------------------------ salud de la guía
// ¿La guía asignada tiene programación? Se compara con el índice por hora de ahora y el de dentro de 12 h:
// «ok» da algo ahora; «gap» no da nada ahora pero sí más tarde; «dead» no tiene nada en las próximas 12 h
// (fuente vieja o canal sin datos). Sin índice todavía, no se sabe (null).
const HEALTH_AHEAD_H = 12;
let healthIdx: { now: HourIndex; later: HourIndex | null } | null = null;
type Prog = 'ok' | 'gap' | 'dead';
function progOf(epg: string): Prog | null {
  if (!healthIdx) return null;
  if (nowFromHour(healthIdx.now, epg)) return 'ok';
  if (!healthIdx.later) return 'gap';
  return (healthIdx.later.c[epg]?.length ?? 0) > 0 ? 'gap' : 'dead';
}
async function loadHealth() {
  const [now, later] = await Promise.all([cfgHourIndex(0), cfgHourIndex(HEALTH_AHEAD_H)]);
  healthIdx = now ? { now, later } : null;
  render();
}
/** Resumen para Configuración: de los canales visibles con guía asignada, cuántos dan programación ahora. */
function guideHealth() {
  let withGuide = 0, ok = 0, gap = 0, dead = 0, none = 0;
  for (const ch of state.channels) {
    const i = info(ch);
    if (i.hidden || i.noGuide || i.divider) continue;
    if (!i.epg) { if (i.band !== 'purpose') none++; continue; } // los dejados sin guía a propósito no cuentan (igual que el filtro «Sin EPG»)
    withGuide++;
    if (i.prog === 'ok') ok++;
    else if (i.prog === 'gap') gap++;
    else if (i.prog === 'dead') dead++;
  }
  return { withGuide, ok, gap, dead, none, known: !!healthIdx };
}

// Los filtros de la lista: un estado (uno solo) y las categorías elegidas (varias). Los dibuja ui/filtros.tsx.
const STATE_FILTERS: [string, string][] = [
  ['todos', 'Todos'], ['nuevos', 'Nuevos'], ['revisar', 'A revisar'], ['sin-epg', 'Sin EPG'], ['sin-prog', 'Sin programación'],
  ['caidos', 'Caídos'], ['manual', 'Elegidos a mano'], ['editados', 'Editados'], ['ocultos', 'Ocultos'],
];
// Estos siempre se ofrecen en la hoja; los demás solo cuando hay canales que cumplen.
const ALWAYS_STATES = new Set(['todos', 'revisar', 'sin-epg']);
let listCats: string[] = [];
function renderFilterBar() {
  const states = STATE_FILTERS
    .map(([key, label]) => ({ key, label, count: state.channels.filter((c) => matchesFilter(c, key)).length }))
    .filter((s) => ALWAYS_STATES.has(s.key) || s.count > 0 || s.key === state.filter);
  // Las categorías ocultas (y los separadores) no se ofrecen: no tienen canales que mostrar.
  const cats = new Map<string, number>();
  for (const ch of state.channels) {
    if (info(ch).divider || state.cfg!.groups.hidden.includes(groupOf(ch))) continue;
    cats.set(groupOf(ch), (cats.get(groupOf(ch)) ?? 0) + 1);
  }
  listCats = listCats.filter((c) => cats.has(c));
  // En el orden de la lista (el que arregló la persona), no en el del proveedor.
  const categories = groups().filter((key) => cats.has(key)).map((key) => ({ key, label: groupLabel(key), count: cats.get(key)! }));
  const model: FilterModel = { filter: state.filter, cats: listCats, states, categories };
  renderFilterControls(model);
}

// Los controles de arriba de la lista (el botón de filtros y la fila de chips), dibujados en Preact (ui/filtros.tsx).
const filterHandlers: FilterHandlers = {
  onState: (f) => {
    state.filter = f;
    setPref('grilla_last_filter', f);
    state.shown = PAGE;
    render();
  },
  onCats: (cats) => {
    listCats = cats;
    state.shown = PAGE;
    render();
  },
};
function renderFilterControls(model: FilterModel) {
  drawFilterBar(model, filterHandlers, $('#filterMount'), $('#activeFilters'));
}

function matchesFilter(ch: Channel, filter: string) {
  const i = info(ch);
  switch (filter) {
    case 'revisar': return !i.hidden && !i.noGuide && !i.divider && (i.band === 'warn' || (i.band === 'none' && !!i.suggestion));
    // "Sin EPG" = los que todavía no tienen guía; los que dejaste sin EPG a propósito están en
    // "Elegidos a mano", con lo demás que decidiste vos.
    case 'sin-epg': return !i.hidden && !i.noGuide && !i.divider && !i.epg && i.band !== 'purpose';
    case 'manual': return i.band === 'manual' || i.band === 'purpose';
    case 'caidos': return !i.hidden && !i.divider && i.down;
    case 'sin-prog': return !i.hidden && !i.noGuide && !i.divider && i.prog === 'dead';
    case 'nuevos': return state.newNames.has(ch.name);
    case 'editados': return !!(i.edit.name || i.edit.group || i.edit.hidden);
    case 'ocultos': return i.hidden;
    default: return !i.hidden;
  }
}

// Lo que está dando ahora cada canal (índice de la hora actual), para buscar por programa en
// la lista principal. Se carga al abrir el editor y al buscar; mientras no llega, se busca solo
// por nombre y categoría. Las descripciones (archivo aparte, más pesado) se bajan recién al buscar.
let hourNow: HourIndex | null = null;
let hourNowDesc: HourDesc | null = null;
function loadHourNow() {
  hourIndex().then((idx) => {
    if (!idx || idx === hourNow) return;
    hourNow = idx;
    if (state.search.trim()) render();
  });
}
function loadHourNowDesc() {
  hourDescIndex().then((d) => {
    if (!d || d === hourNowDesc) return;
    hourNowDesc = d;
    if (state.search.trim()) render();
  });
}
let topicsNow: TopicSearch | null = null;
/** El índice de temas se baja la primera vez que se busca, no al abrir. */
function loadTopicsNow() {
  loadTopics().then((t) => {
    if (!t || t === topicsNow) return;
    topicsNow = t;
    if (state.search.trim()) render();
  });
}
/** El programa en el aire del EPG del canal, si coincide con la búsqueda por título o descripción. */
function programMatch(ch: Channel, q: string): NowPlaying | null {
  const epg = state.cfg!.channels[ch.name]?.epg;
  if (!q || !hourNow || !epg) return null;
  const cur = nowFromHour(hourNow, epg);
  if (!cur) return null;
  // Por título y descripción, o por el género y los temas del programa (ui/ topics.ts): «mundial» encuentra un partido sin decirlo.
  return hasWords(fold(`${cur.title} ${hourNowDesc ? descFromHour(hourNowDesc, hourNow, epg, cur) : ''}`), q)
    || topicsNow?.match(q).has(titleKey(cur.title)) ? cur : null;
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
      if (listCats.length && !listCats.includes(groupOf(ch))) return false;
      if (!q) return true;
      const edit = state.cfg!.channels[ch.name] ?? {};
      const guideName = edit.epg ? state.index?.displayName.get(edit.epg) ?? '' : '';
      return hasWords(fold(`${ch.name} ${edit.name ?? ''} ${groupLabel(groupOf(ch))} ${groupOf(ch)} ${guideName}`), q) || !!programMatch(ch, q);
    })
    .sort((a, b) => (order.get(groupOf(state.channels[a])) ?? 0) - (order.get(groupOf(state.channels[b])) ?? 0)
      || withinPos(a) - withinPos(b));
}

/** La etiqueta de estado de una tarjeta: el porcentaje de coincidencia (verde si es "Bien",
 *  naranja si es dudosa) o "Sin EPG". Lo elegido a mano no lleva marca en la lista. */
function bandTag(band: Band, score?: number): string {
  const pct = score && score > 0 ? `${Math.round(Math.min(score, 1) * 100)} %` : '';
  switch (band) {
    case 'ok': return `<span class="tag ok" title="Coincidencia buena${pct ? `: ${pct}` : ''}">${pct || 'Bien'}</span>`;
    case 'warn': return `<span class="tag warn" title="Coincidencia dudosa${pct ? `: ${pct}` : ''}: conviene revisarla">${pct || 'Dudoso'}</span>`;
    case 'none': return '<span class="tag bad">Sin EPG</span>';
    case 'loading': return ''; // la guía todavía no cruzó: sin etiqueta
    case 'manual': return ''; // la marca "elegida por vos" se ve solo al abrir el canal
    case 'purpose': return ''; // sin guía a propósito: se ve al abrir el canal
  }
}

// ------------------------------------------------------------------ programación ("Ahora: …")
// La corrida diaria sube a R2 (ui/schedule/) un índice por hora UTC con lo que da toda la guía
// y un archivo por canal con títulos y descripciones (nombre: sha1 del id, 16 caracteres).
interface HourIndex { h: number; t: string[]; c: Record<string, [number, number, number][]> }
/** Descripciones de la misma hora (<hora>-d.json): por canal, [inicio en minutos, i_descripción]. */
interface HourDesc { d: string[]; c: Record<string, [number, number][]> }
type ScheduleEntry = [number, number, string, string?];
interface NowPlaying { title: string; start: number; stop: number }

const hourCache = new Map<string, Promise<HourIndex | null>>();
function hourIndex(offsetHours = 0): Promise<HourIndex | null> {
  const key = new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 13).replace(/\D/g, '');
  if (!hourCache.has(key)) {
    hourCache.set(key, fetch(`/api/ui/schedule/hour/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return hourCache.get(key)!;
}

// Lo mismo con solo los canales de la configuración (~20 KB por hora en vez de ~400 KB): para lo que mira solo
// los canales propios. El buscador de la guía sigue con el de toda la guía.
const cfgHourCache = new Map<string, Promise<HourIndex | null>>();
function cfgHourIndex(offsetHours = 0): Promise<HourIndex | null> {
  if (!state.local) return hourIndex(offsetHours);
  const hour = new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 13).replace(/\D/g, '');
  const key = `${state.local.cfgId}/${hour}`;
  if (!cfgHourCache.has(key)) {
    cfgHourCache.set(key, fetch(`/api/cfg/${state.local.cfgId}/hour/${hour}.json`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cfgHourCache.get(key)!;
}

const hourDescCache = new Map<string, Promise<HourDesc | null>>();
function hourDescIndex(): Promise<HourDesc | null> {
  const key = new Date().toISOString().slice(0, 13).replace(/\D/g, '');
  if (!hourDescCache.has(key)) {
    hourDescCache.set(key, fetch(`/api/ui/schedule/hour/${key}-d.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return hourDescCache.get(key)!;
}
/** La descripción del programa `cur` (sacado de `idx`), si la guía la trae. */
function descFromHour(d: HourDesc, idx: HourIndex, id: string, cur: NowPlaying): string {
  const start = (cur.start - idx.h) / 60;
  const hit = d.c[id]?.find(([s]) => s === start);
  return hit ? d.d[hit[1]] : '';
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

const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** Nombre de un canal de la guía, sin el ".us" que algunas guías pegan al final (el país va aparte). Nunca el id:
 *  va enmascarado y no le dice nada a nadie. */
const cleanGuideName = (name: string) => name.replace(/\.[a-z]{2}$/i, '');
const guideLabel = (id: string) => {
  const name = state.index?.displayName.get(id);
  return name ? cleanGuideName(name) : 'Guía que ya no está';
};

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

/** Cómo se ve la lista: filas compactas (por defecto) o tarjetas. Es una preferencia de este navegador. */

/** Condensado (por defecto) o detallado (suma lo que está dando ahora la guía asignada). */
type ViewMode = 'compact' | 'detail' | 'grid';
const viewMode = (): ViewMode => { const v = pref('grilla_density', 'compact'); return v === 'detail' || v === 'grid' ? v : 'compact'; };
const NEXT_VIEW: Record<ViewMode, ViewMode> = { compact: 'detail', detail: 'grid', grid: 'compact' };
const VIEW_BTN: Record<ViewMode, [string, string]> = {
  compact: ['chevrons-up-down', 'Ver detallado'], detail: ['layout-grid', 'Ver logos'], grid: ['chevrons-down-up', 'Ver condensado'],
};

const validTz = (tz: string | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** La zona que tiene elegida el panel del proveedor (la trae la cuenta en uso por el relay), o null si no se sabe. */
function providerTz(): string | null {
  const a = myAccounts().find((x) => x.account === activeAccount());
  const tz = (a && accountData(a)?.timezone) || streamHealth?.account?.timezone;
  return validTz(tz) ? tz : null;
}
/** Zona elegida a mano en la página del proveedor: solo vale mientras el proveedor no informa la suya. */
const EVENT_TZ_KEY = () => `grilla_event_tz_${state.local?.cfgId ?? ''}`;
const DEFAULT_EVENT_TZ = 'America/Mexico_City';
/** Zona horaria de los eventos (PPV) del proveedor abierto: siempre la del panel del proveedor, así, si se cambia
 *  allá, la grilla se acomoda sola. Si el proveedor no la informa, la elegida a mano (o México). */
const eventTz = () => {
  const manual = pref(EVENT_TZ_KEY(), pref('grilla_event_tz', DEFAULT_EVENT_TZ));
  return providerTz() ?? (validTz(manual) ? manual : DEFAULT_EVENT_TZ);
};
/** Comienzo de un evento (PPV) que figura en el nombre del canal, pasado a la hora de este dispositivo. */
const eventOf = (ch: Channel) => parseEvent(ch.name, eventTz(), Date.now());
const EVENT_LIVE_MS = 3 * 3600000;
function eventLabel(start: number): { text: string; cls: string } {
  const now = Date.now();
  const at = new Date(start);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayDiff = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
    - new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()) / 86400000);
  const day = dayDiff === 0 ? 'Hoy' : dayDiff === 1 ? 'Mañana' : dayDiff === -1 ? 'Ayer'
    : at.toLocaleDateString([], { weekday: 'short', day: 'numeric' }).replace('.', '');
  if (now >= start && now < start + EVENT_LIVE_MS) return { text: `En vivo · desde ${time}`, cls: 'live' };
  if (now < start) return { text: `${day} ${time}`, cls: 'soon' };
  return { text: `Terminó · ${day} ${time}`, cls: 'done' };
}

/** Píldora arriba: sin conexión (los cambios se guardan en el dispositivo) o guardando. */
function updateNet() {
  const pill = $('#netPill');
  const pending = !!$('#statusLine').dataset.pending;
  const text = !navigator.onLine ? 'Sin conexión · tus cambios se guardan en este dispositivo' : pending ? 'Guardando tus cambios…' : '';
  pill.hidden = !text;
  if (text) renderNetPill(pill, !navigator.onLine, text);
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

function renderStatusLine() {
  const el = $('#statusLine');
  const total = state.channels.length;
  const withEpg = state.channels.filter((c) => state.cfg!.channels[c.name]?.epg).length;
  const saved = el.dataset.pending ? ' · sin conexión: se guarda cuando vuelva'
    : el.dataset.saved ? ` · guardado ${el.dataset.saved}` : '';
  el.textContent = `${total} canales · ${withEpg} con guía${saved}`;
  updateNet();
}

let recheckGrid: () => void = () => {};
function render() {
  if (!state.cfg) return;
  infoMemo = new Map();
  try { renderNow(); } finally { infoMemo = null; }
}
function renderNow() {
  headersCache = null;
  renderNewBanner();
  if (!state.channels.some((c) => matchesFilter(c, 'sin-prog')) && state.filter === 'sin-prog') state.filter = 'todos';
  if (!state.channels.some((c) => matchesFilter(c, 'caidos')) && state.filter === 'caidos') state.filter = 'todos';
  renderFilterBar();
  renderReviewCard();
  const list = visibleChannels();
  const cards = $('#cards');
  const mode = viewMode();
  const viewBtn = $('#viewBtn');
  renderIcon(viewBtn, VIEW_BTN[mode][0]);
  viewBtn.title = viewBtn.ariaLabel = VIEW_BTN[mode][1];
  cards.classList.toggle('detail', mode === 'detail');
  cards.classList.toggle('grid', mode === 'grid');
  renderCards(list);
  $('#loadMoreSentinel').hidden = list.length <= state.shown;
  recheckGrid();
  renderStatusLine();
}

// ------------------------------------------------------------------ guía (grilla de canales × hora)
// La pantalla es un componente Preact (ui/guide.tsx); acá se le pasan los canales (en el orden de
// Canales, sin ocultos ni separadores) y lo que necesita del resto de la app.
const guideHost: GuideHost = {
  get hourPath() { return state.local ? `/api/cfg/${state.local.cfgId}/hour` : undefined; },
  channels() {
    const order = new Map(groups().map((g, k) => [g, k]));
    return state.channels.map((ch, i) => ({ ch, i, inf: info(ch) }))
      .filter(({ inf }) => !inf.hidden && !inf.divider)
      .sort((a, b) => (order.get(groupOf(a.ch)) ?? 0) - (order.get(groupOf(b.ch)) ?? 0) || withinPos(a.i) - withinPos(b.i))
      .map(({ ch, i, inf }) => {
        const name = inf.edit.name || eventOf(ch)?.clean || stripDisplayPrefix(ch.name, state.rules!)[0];
        const logo = !logosOn() ? '' : inf.edit.customLogo || (inf.epg ? state.index?.icon.get(inf.epg) ?? '' : '');
        return { i, name, cat: groupLabel(groupOf(ch)), epg: inf.epg, logo, quiet: inf.noGuide || inf.band === 'purpose', q: inf.q?.label ?? null, qTitle: inf.q ? qualityTitle(inf.q) : '' };
      });
  },
  openChannel: (i) => openChannel(i),
  schedule: (epg) => schedule(epg),
  reminders: async () => {
    const st = await loadReminders();
    return st.configured ? st.keys : null;
  },
  toggleReminder: (btn, channel) => void toggleReminder(btn, channel),
  habits: () => api<Habits>(`/api/cfg/${state.local!.cfgId}/habits`).catch(() => null),
  feedback: (title, kind, genre) => api<Habits & { autoOff?: string }>(`/api/cfg/${state.local!.cfgId}/habits`, { method: 'POST', body: { title, kind, genre } }),
  help: () => openHelp('guide'),
  tasteAlerts: {
    state: () => tasteAll().catch(() => null),
    setGenre: (genre, on) => setGenreAll(genre, on),
  },
};
// ------------------------------------------------------------------ pestañas de abajo
// Canales es la página de la lista; Guía, Categorías y Perfil son páginas enteras que la tapan, con la barra de abajo
// siempre a mano. Categorías y Perfil son <dialog> no modales (show()): lo que se abre desde ellas sigue siendo una hoja
// modal encima.
type Tab = 'home' | 'guide' | 'categories' | 'profile';
const TAB_BTN: Record<Tab, string> = { home: '#tabHome', guide: '#tabGuide', categories: '#categoriesBtn', profile: '#tabLinks' };
const PAGES = { categories: '#categoriesDialog', profile: '#linksDialog' } as const;
type PageTab = keyof typeof PAGES;
const pageDialog = (t: PageTab) => $(PAGES[t]) as HTMLDialogElement;

function markTab(t: Tab) {
  for (const [k, sel] of Object.entries(TAB_BTN)) {
    $(sel).classList.toggle('active', k === t);
    if (k === t) $(sel).setAttribute('aria-current', 'page');
    else $(sel).removeAttribute('aria-current');
  }
  placeTabPill($('#tabbar'));
}
/** La pestaña que se ve: una página abierta o, si no hay, la Guía o la lista. */
function currentTab(): Tab {
  for (const t of Object.keys(PAGES) as PageTab[]) if (pageDialog(t).open) return t;
  return $('#guide').hidden ? 'home' : 'guide';
}
function closePages(except?: PageTab) {
  for (const t of Object.keys(PAGES) as PageTab[]) if (t !== except && pageDialog(t).open) pageDialog(t).close();
}
/** Abre Categorías o Perfil como página entera (si ya está abierta, la deja como está). */
function openPage(t: PageTab) {
  closePages(t);
  if (!$('#guide').hidden) setGuide(false);
  const d = pageDialog(t);
  if (!d.open) {
    d.show();
    $('.sheet-body', d).scrollTop = 0;
  }
  markTab(t);
}
/** Abre Perfil (en la vista pedida) desde la pestaña o desde cualquier otro lado. */
function openProfiles(v: LinksView = { v: 'list' }, from?: () => void) {
  openLinksView(v, from);
  openPage('profile');
}

/** Venir de un aviso por gusto (/?programa=<guía>&inicio=<segundos>): abre la Guía con la hoja de ese programa. */
function openProgramFromUrl() {
  const q = new URLSearchParams(location.search);
  const epg = q.get('programa');
  const start = Number(q.get('inicio'));
  if (!epg || !start) return;
  history.replaceState(null, '', location.pathname + location.hash);
  openProgramLink(epg, start);
  setGuide(true);
}

function setGuide(on: boolean) {
  const el = $('#guide');
  if (on) closePages();
  el.hidden = !on;
  document.body.classList.toggle('guide-open', on);
  markTab(on ? 'guide' : 'home');
  if (on) {
    infoMemo = new Map();
    try { showGuide(el, guideHost); } finally { infoMemo = null; }
  }
}

// ------------------------------------------------------------------ canal: diálogo
// ------------------------------------------------------------------ ediciones de EPG
function pickEpg(e: ChannelEdit, id: string) {
  e.epg = id;
  e.manual = true;
  const logo = state.index?.icon.get(id);
  if (logo) e.logo = logo;
  else delete e.logo;
}
/** Variantes del mismo canal (SD, HD, FHD, 4K…) que todavía esperan guía: se resuelven con la misma elección,
 *  así corregir una vez alcanza. Solo las que tienen una guía dudosa o ninguna; nunca las que ya elegiste vos. */
function pendingVariants(ch: Channel): Channel[] {
  const key = variantKey(ch.name, state.rules!);
  if (!key) return [];
  return state.channels.filter((o) => {
    if (o === ch || o.name === ch.name || variantKey(o.name, state.rules!) !== key) return false;
    const i = info(o);
    return !i.divider && !i.hidden && !i.noGuide && (i.band === 'warn' || i.band === 'none');
  });
}
/** Elige una guía para un canal y la repite en sus variantes pendientes, con un solo «Deshacer». */
function chooseEpg(ch: Channel, id: string, msg: string) {
  const sibs = pendingVariants(ch);
  editChannels([ch, ...sibs], (e) => pickEpg(e, id), sibs.length ? `${msg} · también en ${plural(sibs.length, 'variante', 'variantes')}` : msg);
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
      refreshChannelSheet();
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

// ------------------------------------------------------------------ recordatorios («Avisarme»)
// Un programa que todavía no empezó se puede marcar: el Worker manda un push poco antes (la corrida de avisos
// es cada 30 minutos: llega entre 0 y 30 minutos antes). Sin claves de push en el Worker, el botón no aparece.
interface RemindState { configured: boolean; keys: Set<string> }
let remindState: RemindState | null = null;
const remindKey = (epg: string, start: number) => `${epg}|${start}`;

async function loadReminders(): Promise<RemindState> {
  if (remindState) return remindState;
  const st: RemindState = { configured: false, keys: new Set() };
  let known = true;
  try {
    await api('/api/push/key', { auth: false });
    st.configured = true;
    const r = await api<{ items: { epg: string; start: number }[] }>(`/api/cfg/${state.local!.cfgId}/remind`);
    for (const it of r.items) st.keys.add(remindKey(channelAlias(it.epg), it.start));
  } catch (e) {
    // 404 = el Worker no tiene las claves VAPID; otro error (sin conexión): se vuelve a probar la próxima vez.
    if (!/no activados/i.test((e as Error).message)) known = false;
  }
  return known ? (remindState = st) : st;
}

/** El dispositivo tiene que estar suscrito a los avisos: si no lo está, se activan (pide el permiso). */
async function ensurePush(): Promise<boolean> {
  if (!pushSupported()) {
    toast(iosNotInstalled() ? 'En iPhone: instalá la app (Compartir → Agregar a inicio) para recibir avisos' : 'Este navegador no admite avisos', 'bad', 6000);
    return false;
  }
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
  if (sub && Notification.permission === 'granted') return true;
  await setPush(true);
  const after = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
  return !!after && Notification.permission === 'granted';
}

async function toggleReminder(btn: HTMLElement, channel: string) {
  const st = await loadReminders();
  if (!st.configured) {
    toast('Los avisos todavía no están activados en el servidor: faltan las claves VAPID en el Worker (worker/README.md, «Avisos push»)', 'info', 9000);
    return;
  }
  const epg = btn.dataset.epg!;
  const start = Number(btn.dataset.start);
  const key = remindKey(epg, start);
  const cfg = state.local!.cfgId;
  const mark = (on: boolean) => {
    if (on) st.keys.add(key);
    else st.keys.delete(key);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  };
  try {
    if (st.keys.has(key)) {
      await api(`/api/cfg/${cfg}/remind`, { method: 'DELETE', body: { epg, start } });
      mark(false);
      toast('Recordatorio quitado', 'ok');
      return;
    }
    if (!(await ensurePush())) return;
    await api(`/api/cfg/${cfg}/remind`, { method: 'POST', body: { epg, name: channel, title: btn.dataset.title, start } });
    mark(true);
    toast(`Te avisamos antes de que empiece (${hhmm(start)})`, 'ok', 3500, () => {
      api(`/api/cfg/${cfg}/remind`, { method: 'DELETE', body: { epg, start } }).then(() => mark(false)).catch(() => {});
    });
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

const REVIEW_KEY = (id: string) => `grilla_review_base_${id}`;
const reviewList = () => state.channels.map((_, i) => i).filter((i) => matchesFilter(state.channels[i], 'revisar'));
/** Cuántos quedan por revisar y cuántos había al empezar (la base solo crece; en 0 se reinicia). */
function reviewProgress(left = reviewList().length) {
  const key = REVIEW_KEY(state.local?.cfgId ?? '');
  let base = Number(pref(key, '0')) || 0;
  if (!left) base = 0;
  else if (left > base) base = left;
  setPref(key, String(base));
  return { left, base, done: Math.max(0, base - left), pct: base ? Math.round(((base - left) / base) * 100) : 0 };
}

function renderReviewCard() {
  renderReviewCardView({
    ...reviewProgress(), news: bannerCount, onNewFilter: state.filter === 'nuevos', onStart: startReview,
    onShowNew: () => {
      state.filter = 'nuevos';
      state.shown = PAGE;
      render();
    },
    onSeen: () => {
      markSeen();
      render();
      toast('Canales marcados como vistos', 'ok');
    },
  });
}

// La hoja de un canal (y el modo «Revisar») está en ui/canal.tsx.
const DOCK_MQ = matchMedia('(min-width: 1100px) and (hover: hover)');
const DOCKABLE = ['#channelDialog'];
/** En escritorio ancho, canal y configuración quedan fijos a la derecha (sin velo) y la
 *  lista sigue usable (maestro-detalle); si no, son hojas modales. Solo hay un panel fijo a la vez. */
function openDock(dlg: HTMLDialogElement) {
  if (!DOCK_MQ.matches) {
    dlg.classList.remove('docked');
    dlg.showModal();
    return;
  }
  for (const sel of DOCKABLE) {
    const other = $(sel) as HTMLDialogElement;
    if (other !== dlg && other.open && other.classList.contains('docked')) other.close();
  }
  dlg.classList.add('docked');
  dlg.show();
  document.body.classList.add('has-dock');
  if (!dlg.dataset.dockWired) {
    dlg.dataset.dockWired = '1';
    dlg.addEventListener('close', () => {
      if (!DOCKABLE.some((sel) => ($(sel) as HTMLDialogElement).open && $(sel).classList.contains('docked'))) document.body.classList.remove('has-dock');
    });
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Un diálogo modal abierto (por ejemplo, el de una categoría) maneja su propio Esc.
  if (document.querySelector('dialog.sheet:modal')) return;
  for (const sel of DOCKABLE) {
    const d = $(sel) as HTMLDialogElement;
    if (d.open && d.classList.contains('docked')) { d.close(); return; }
  }
  // En una página (Categorías, Perfil), Esc vuelve a la lista como la pestaña Canales.
  if (currentTab() === 'categories' || currentTab() === 'profile') closePages();
});

/** Menú «…» de una fila (con mouse no hay gestos obvios): ocultar o mostrar, sin guía, seleccionar. */
function openRowMenu(anchor: HTMLElement, i: number) {
  const ch = state.channels[i];
  const wasHidden = !!state.cfg!.channels[ch.name]?.hidden;
  openRowMenuView(anchor, [
    { icon: wasHidden ? 'eye' : 'eye-off', text: wasHidden ? 'Mostrar' : 'Ocultar',
      run: () => editChannels([ch], (e) => { e.hidden = e.hidden ? undefined : true; }, wasHidden ? 'Visible' : 'Oculto') },
    { icon: 'ban', text: 'Dejar sin guía', run: () => editChannels([ch], noEpg, 'Quedó sin guía') },
    { icon: 'square-check', text: 'Seleccionar', run: () => setSelectMode(true, i) },
  ]);
}

// ------------------------------------------------------------------ selección múltiple
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function setSelectMode(on: boolean, first?: number) {
  selection.active = on;
  selection.items.clear();
  if (on && first !== undefined) selection.items.add(first);
  document.body.classList.toggle('selecting', on);
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
  refreshCards();
  updateBulkBar();
}

/** Aplica a los seleccionados y sale del modo selección. */
function applyBulk(fn: (e: ChannelEdit, ch: Channel) => void, msg: string) {
  const chs = [...selection.items].map((i) => state.channels[i]);
  editChannels(chs, fn, msg);
  setSelectMode(false);
}

// ------------------------------------------------------------------ categorías
// Separador de sección del proveedor ("▆▆▆ DEPORTES ▆▆▆"): una categoría decorativa, o una con
// un solo canal que se llama igual (así quedan los separadores importados de GitHub).
const DIVIDER_RE = /[\u2580-\u259F]{2,}/;
let headersCache: Set<string> | null = null;
/** sectionHeaders() de esta pasada de dibujo (render() y editGroups lo invalidan). */
const headersNow = () => (headersCache ??= sectionHeaders());
function sectionHeaders(): Set<string> {
  return headersOf(state.cfg!.groups, groupOf);
}

/** Las secciones de una vista: separadores y categorías decorativas o de un solo canal que se llama igual. */
function headersOf(gr: Config['groups'], catOf: (ch: Channel) => string): Set<string> {
  const members = new Map<string, Channel[]>();
  for (const ch of state.channels) {
    const g = catOf(ch);
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(ch);
  }
  const out = new Set<string>(gr.separators ?? []);
  for (const [g, chs] of members) {
    const only = chs.length === 1 ? (state.cfg!.channels[chs[0].name]?.name || chs[0].name) : null;
    if (DIVIDER_RE.test(g) || only === g) out.add(g);
  }
  return out;
}

/** Las categorías de una vista, sea la activa o la guardada aparte (`views`), para armar su lista sin cambiarla.
 *  Null si esa vista todavía no existe (la de género se arma con ensureView). */
export interface ViewModel { gr: Config['groups']; groups: string[]; headers: Set<string>; catOf: (ch: Channel) => string; label: (g: string) => string }
export function viewModel(view: 'provider' | 'genre'): ViewModel | null {
  const active = (state.cfg!.view === 'genre' ? 'genre' : 'provider') === view;
  const snap = active ? undefined : state.cfg!.views?.[view];
  if (!active && !snap) return null;
  const gr = active ? state.cfg!.groups : snap!.groups;
  const assign = snap?.assign ?? {};
  const catOf = active ? groupOf : (ch: Channel) => assign[ch.name] || ch.category;
  return { gr, groups: orderedGroups(gr, catOf), headers: headersOf(gr, catOf), catOf, label: (g) => gr.rename?.[g] || g };
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

// La hoja de Categorías, la de una categoría y la de ordenar sus canales están en ui/categorias.tsx.

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

function setChannelOrder(g: string, names: string[] | null, msg: string) {
  editGroups((gr) => {
    const all = { ...(gr.channels ?? {}) };
    if (names) all[g] = names;
    else delete all[g];
    gr.channels = all;
  }, msg);
  renderChannelOrder(g);
}

const HELP_TITLES: Record<string, string> = { main: 'Cómo usar nowline', guide: 'Cómo usar la Guía', settings: 'Ayuda', categories: 'Ayuda', links: 'Ayuda' };
/** La ayuda de la pantalla desde la que se abre. Con `from`, «‹» vuelve a esa pantalla y «×» cierra todo. */
function openHelp(topic: 'main' | 'guide' | 'settings' | 'categories' | 'links', from?: string) {
  const help = $('#helpDialog') as HTMLDialogElement;
  for (const t of $$<HTMLElement>('.help-topic', help)) t.hidden = t.dataset.topic !== topic;
  $('#helpTitle').textContent = HELP_TITLES[topic];
  $('#helpBack').hidden = !from;
  help.dataset.from = from ?? '';
  $('.sheet-body', help).scrollTop = 0;
  help.showModal();
}
/** Hojas anidadas: «‹» cierra solo la de arriba y vuelve a la anterior; «×» cierra las dos. */
function wireNested(child: string, back: string, close: string) {
  const dlg = $(child) as HTMLDialogElement;
  $(back).onclick = () => dlg.close();
  $(close).onclick = () => {
    const from = dlg.dataset.from;
    dlg.close();
    // Una página (Categorías, Perfil) queda abierta: es la pestaña en la que se está.
    if (from && !$(from).classList.contains('page')) ($(from) as HTMLDialogElement).close();
  };
}

/** La categoría de cada canal en la vista activa (solo los que tienen una propia). */
function assignOf(): Record<string, string> {
  return Object.fromEntries(Object.entries(state.cfg!.channels).flatMap(([name, e]) => (e.group ? [[name, e.group]] : [])));
}

/** Cambia la vista de las categorías. La que se deja queda guardada aparte; la que se pide vuelve tal como se dejó, o
 *  se arma con los géneros de la guía la primera vez. Devuelve false si no pudo armarla (sin datos de género). */
export async function setView(view: 'provider' | 'genre'): Promise<boolean> {
  const cfg = state.cfg!;
  const current = cfg.view === 'genre' ? 'genre' : 'provider';
  if (view === current) return true;
  const saved = await ensureView(view);
  if (!saved) return false;
  const { groups, assign } = saved;
  const views = { ...cfg.views };
  views[current] = { groups: structuredClone(cfg.groups), assign: assignOf() };
  delete views[view];
  cfg.groups = structuredClone(groups);
  for (const [name, e] of Object.entries(cfg.channels)) {
    delete e.group;
    if (!Object.keys(e).length) delete cfg.channels[name];
  }
  for (const [name, group] of Object.entries(assign)) cfg.channels[name] = { ...cfg.channels[name], group };
  cfg.view = view === 'genre' ? 'genre' : undefined;
  cfg.views = views;
  scheduleSave();
  render();
  if (($('#categoriesDialog') as HTMLDialogElement).open) renderCategories();
  toast(view === 'genre' ? 'Categorías por género' : 'Categorías del proveedor', 'ok', 3500, () => {
    void setView(current);
  });
  return true;
}

/** La vista guardada aparte (`views`), armada si hace falta: la de género sale de los géneros de cada canal. No cambia
 *  la vista activa. Sin datos, null. */
export async function ensureView(view: 'provider' | 'genre'): Promise<CategoryView | null> {
  const cfg = state.cfg!;
  const saved = cfg.views?.[view];
  if (saved) return saved;
  if (view !== 'genre') return null;
  const data = await loadChannelGenres();
  if (!data) {
    toast('No se pudieron cargar los géneros de los canales. Probá de nuevo', 'info');
    return null;
  }
  const assign = genreAssign(state.channels.map((ch) => ({ name: ch.name, epg: cfg.channels[ch.name]?.epg ?? null })), data);
  const built: CategoryView = { groups: { ...genreGroups(assign), noEpg: [] }, assign };
  cfg.views = { ...cfg.views, [view]: built };
  scheduleSave();
  return built;
}

function toggleGroupHidden(g: string) {
  const show = state.cfg!.groups.hidden.includes(g);
  editGroups((gr) => {
    const hidden = new Set(gr.hidden);
    if (show) hidden.delete(g);
    else hidden.add(g);
    gr.hidden = [...hidden];
  }, show ? `${groupLabel(g)} visible en la playlist` : `${groupLabel(g)} oculta de la playlist`);
}

function toggleGroupNoEpg(g: string) {
  const on = !state.cfg!.groups.noEpg?.includes(g);
  editGroups((gr) => {
    const noEpg = new Set(gr.noEpg ?? []);
    if (on) noEpg.add(g);
    else noEpg.delete(g);
    gr.noEpg = [...noEpg];
  }, on ? `${groupLabel(g)}: sin guía` : `${groupLabel(g)} vuelve a necesitar guía`);
}

/** Deslizar una fila con el dedo (no con el mouse). Devuelve una función que dice si el toque
 *  que acaba de terminar fue un deslizamiento (para no tomarlo como un clic). */
function wireSwipe(box: HTMLElement, rowSel: string, left: (row: HTMLElement) => void, right: (row: HTMLElement) => void, canRight: (row: HTMLElement) => boolean = () => true): () => boolean {
  let sw: { row: HTMLElement; x: number; y: number; dx: number; on: boolean } | null = null;
  let until = 0;
  const reset = (row: HTMLElement) => {
    row.classList.remove('swiping', 'armed');
    row.style.removeProperty('--sx');
    delete row.dataset.sw;
  };
  box.addEventListener('pointerdown', (ev) => {
    const t = ev.target as HTMLElement;
    if (ev.pointerType === 'mouse' || box.classList.contains('grid') || t.closest('.drag-handle, .fold-btn')) return;
    const row = t.closest<HTMLElement>(rowSel);
    if (row) sw = { row, x: ev.clientX, y: ev.clientY, dx: 0, on: false };
  });
  box.addEventListener('pointermove', (ev) => {
    if (!sw) return;
    const dx = ev.clientX - sw.x;
    const dy = ev.clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      sw.on = true;
      sw.row.classList.add('swiping');
    }
    sw.dx = Math.max(-140, Math.min(canRight(sw.row) ? 140 : 0, dx));
    sw.row.style.setProperty('--sx', `${sw.dx}px`);
    if (sw.dx) sw.row.dataset.sw = sw.dx < 0 ? 'l' : 'r';
    else delete sw.row.dataset.sw;
    sw.row.classList.toggle('armed', Math.abs(sw.dx) > 80);
  });
  box.addEventListener('pointerup', () => {
    if (!sw) return;
    const { row, dx, on } = sw;
    sw = null;
    if (!on) return;
    reset(row);
    until = Date.now() + 400;
    if (dx < -80) left(row);
    else if (dx > 80) right(row);
  });
  box.addEventListener('pointercancel', () => {
    if (sw) reset(sw.row);
    sw = null;
  });
  return () => Date.now() < until;
}

// ------------------------------------------------------------------ links
const shareText = (r: { playlistUrl: string; epgUrl: string }) =>
  `Playlist (M3U): ${r.playlistUrl}\nGuía (EPG): ${r.epgUrl}`;

interface DeviceFilter { only?: boolean; groups: string[]; channels: string[]; view?: 'genre' }
interface Device { code: string; name: string; created?: string; lastUsed?: string; active: boolean; filter?: DeviceFilter; account?: string; accountKey?: string; profile?: string; lastPlay?: { t: string; ch: string }; playlistUrl: string; epgUrl: string }
type LinkResult = { playlistUrl: string; epgUrl: string; name?: string };

const ago = (iso?: string) => {
  if (!iso) return 'sin uso todavía';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 60) return 'usado hace un rato';
  if (min < 1440) return `usado hace ${Math.round(min / 60)} h`;
  return `usado hace ${Math.round(min / 1440)} d`;
};

// ------------------------------------------------------------------ cuentas y perfiles
// Cuenta: el usuario y la contraseña del proveedor (la principal o la de un familiar: `account` en sus links), con su
// vencimiento y sus conexiones. La cuenta en uso (config.activeAccount) baja la lista y prueba los canales caídos; su
// inicial va en la pestaña «Perfil». Perfil: dentro de una cuenta, un nombre y qué ve (config.profiles, los maneja el
// Worker); sus links llevan su filtro. Un mismo link sirve para varios dispositivos. Ver planes/perfiles.md.
interface ProfileDef { id: string; name: string; account?: string; filter?: DeviceFilter; view?: string; kids?: { genres: string[] } }
interface ProfileView extends ProfileDef { devices: Device[] }
interface AccountView { account: string; name: string; key?: string; profiles: ProfileView[]; devices: Device[] }
let profileDevices: Device[] = [];
let profileDefs: ProfileDef[] = [];
let liveAccounts: Record<string, Account> = {};
const activeAccount = () => state.cfg?.activeAccount ?? '';
const accountName = (account: string, main = state.cfg?.mainName) => account || main || 'Tu cuenta';
const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

/** Las cuentas de una configuración con sus perfiles y links: la principal siempre, después las demás en orden de alta. */
function accountsOf(devices: Device[], profiles: ProfileDef[], main?: string): AccountView[] {
  const out = new Map<string, AccountView>();
  const get = (acc: string) => {
    if (!out.has(acc)) out.set(acc, { account: acc, name: accountName(acc, main), profiles: [], devices: [] });
    return out.get(acc)!;
  };
  get('');
  for (const p of profiles) get(p.account ?? '').profiles.push({ ...p, devices: [] });
  for (const d of devices) {
    const a = get(d.account ?? '');
    a.devices.push(d);
    a.key ??= d.accountKey;
    a.profiles.find((x) => x.id === d.profile)?.devices.push(d);
  }
  return [...out.values()];
}
const myAccounts = () => accountsOf(profileDevices, profileDefs);

/** Datos de una cuenta: los de ahora (relay) o, si no, los de la última prueba. */
const accountData = (a: AccountView): Account | undefined =>
  (a.key && (liveAccounts[a.key] ?? streamHealth?.accounts?.[a.key])) || (!a.account && !a.key ? streamHealth?.account : undefined);
const daysLeft = (acc?: Account) => (acc?.expires ? Math.floor((Date.parse(acc.expires) - Date.now()) / 86_400_000) : null);

function renderTabAvatar() {
  const el = document.querySelector<HTMLElement>('#tabAvatar');
  if (!el) return;
  const name = accountName(activeAccount());
  el.textContent = initialOf(name);
  $('#tabLinks').setAttribute('aria-label', `Perfil. Cuenta en uso: ${name} (mantené apretado para cambiar)`);
}

/** Dispositivos y datos de las cuentas: para la pestaña, el aviso y la pantalla de Perfiles. */
let liveAt = 0;
/** Los demás proveedores del hogar: sus cuentas, perfiles y links, y los datos de sus cuentas. */
interface OtherProvider { cfgId: string; editKey: string; name: string; devices: Device[]; profiles: ProfileDef[]; accounts: Record<string, Account>; mainName?: string }
let otherProviders: OtherProvider[] = [];
type DevicesResponse = { devices: Device[]; profiles?: ProfileDef[]; mainName?: string };
async function loadOtherProviders(live: boolean) {
  const h = loadHome();
  otherProviders = await Promise.all(h.configs.filter((c) => c.cfgId !== state.local?.cfgId).map(async (c) => {
    const prev = otherProviders.find((o) => o.cfgId === c.cfgId);
    const o: OtherProvider = { cfgId: c.cfgId, editKey: c.editKey, name: providerName(h, c.cfgId), devices: prev?.devices ?? [],
      profiles: prev?.profiles ?? [], accounts: prev?.accounts ?? {}, mainName: prev?.mainName };
    try {
      const r = await api<DevicesResponse>(`/api/cfg/${c.cfgId}/devices`, { key: c.editKey });
      o.devices = r.devices;
      o.profiles = r.profiles ?? [];
      o.mainName = r.mainName || undefined;
      if (live) o.accounts = (await api<{ accounts: Record<string, Account> }>(`/api/cfg/${c.cfgId}/accounts`, { key: c.editKey })).accounts;
    } catch { /* sin conexión o configuración borrada: queda lo último */ }
    return o;
  }));
}
const otherAccounts = (o: OtherProvider) => accountsOf(o.devices, o.profiles, o.mainName);
/** Hasta qué cambio están al día los perfiles bajados (-1: nunca se bajaron). */
let profilesAt = -1;
async function loadProfiles(live = true) {
  if (!state.local) return;
  const cfgId = state.local.cfgId;
  const writes = apiWrites;
  await pullHome();
  // Los de esta configuración y los de los demás proveedores, a la vez.
  await Promise.all([
    api<DevicesResponse>(`/api/cfg/${cfgId}/devices`).then((r) => {
      if (state.local?.cfgId !== cfgId) return;
      profileDevices = r.devices;
      profileDefs = r.profiles ?? [];
      profilesAt = writes;
    }).catch(() => { /* sin conexión: queda lo último */ }),
    loadOtherProviders(live && Date.now() - liveAt > 60_000),
  ]);
  renderTabAvatar();
  renderProfileNotice();
  if (!live) return;
  try {
    const tz = eventTz();
    liveAccounts = (await api<{ accounts: Record<string, Account> }>(`/api/cfg/${state.local.cfgId}/accounts`)).accounts;
    liveAt = Date.now();
    if (eventTz() !== tz) render(); // cambió la zona en el panel del proveedor: las horas de los eventos se corren
  } catch { /* sin relay o sin conexión: los de la última prueba */ }
  renderProfileNotice();
}

/** Usar una cuenta de otro proveedor: pasa a ser su cuenta en uso y se abre esa configuración (otra grilla). */
async function useOtherAccount(cfgId: string, account: string) {
  const o = otherProviders.find((x) => x.cfgId === cfgId);
  if (!o) return;
  try {
    await api(`/api/cfg/${cfgId}/active`, { method: 'PUT', key: o.editKey, body: { account } });
    toast(`Cuenta en uso: ${accountName(account, o.mainName)} (${o.name}). Cargando su grilla…`, 'ok', 6000);
    await switchProvider(cfgId);
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

async function setActiveAccount(account: string) {
  if (account === activeAccount()) return;
  try {
    await api(`/api/cfg/${state.local!.cfgId}/active`, { method: 'PUT', body: { account } });
    if (state.cfg) {
      if (account) state.cfg.activeAccount = account;
      else delete state.cfg.activeAccount;
    }
    renderTabAvatar();
    renderProfileNotice();
    toast(`Cuenta en uso: ${accountName(account)}. La prueba de canales caídos se hace con esta cuenta en un rato`, 'ok', 6000);
    loadStreamHealth();
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

/** Conexiones en uso, sin pasar del máximo: el proveedor sigue contando por un rato la conexión de un canal que se
 *  dejó (al cambiar de canal o abrir un link nuevo) y a veces informa más de las que permite («4 de 3»). */
const connectionsInUse = (acc?: Account) => acc?.activeConnections === undefined ? undefined
  : acc.maxConnections ? Math.min(acc.activeConnections, acc.maxConnections) : acc.activeConnections;
// Las páginas de la hoja «Perfiles», la lista para cambiar de cuenta y el aviso de arriba están en ui/perfiles.tsx.

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

// La primera vez los links se arman solos (con un dispositivo «Mi reproductor») y una tarjeta arriba de la lista los
// ofrece listos para copiar (ui/cards.tsx).
async function createFirstDevice() {
  if (!state.local || !state.creds) return;
  try {
    await saveNow(false);
    await api(`/api/cfg/${state.local.cfgId}/token`, { method: 'POST', body: { ...state.creds, name: 'Mi reproductor' } });
    setPref(LINKS_CARD_KEY(state.local.cfgId), '1');
  } catch { /* se pueden generar después, desde Configuración */ }
}

async function showQr(text: string, caption = 'Escaneá para abrir el link de la playlist en otro dispositivo') {
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
    renderQr($('#qr'), qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), caption);
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
  $('#uploadWhy').textContent = 'Tu proveedor no deja que nowline baje la lista directamente (pasa con muchos: solo atienden a los reproductores). No es un error: hacelo en dos pasos.';
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
  if ((reload || addingFrom) && !cancel) {
    cancel = document.createElement('button');
    cancel.id = 'cancelReload';
    cancel.className = 'btn btn-gray btn-block';
    cancel.textContent = 'Cancelar';
    $('#onboarding .card').appendChild(cancel);
  }
  if (cancel) {
    cancel.hidden = !reload && !addingFrom;
    // Cancelar el alta de otro proveedor vuelve a la configuración que estaba abierta.
    cancel.onclick = () => {
      if (!addingFrom) return showEditor();
      state.local = addingFrom;
      addingFrom = null;
      saveLocal(state.local);
      void openSaved();
    };
  }
  restoreDraft();
}

function setProviderType(t: 'xtream' | 'm3u') {
  providerType = t;
  for (const b of $$('#providerSeg button')) b.setAttribute('aria-checked', String(b.dataset.value === t));
  $('#xtreamForm').hidden = t !== 'xtream';
  $('#m3uForm').hidden = t !== 'm3u';
  $('#uploadBox').hidden = true;
}

/** Espera la lista que todavía no se subió (la baja el relay o la sube tools/grilla_home.py), consultando cada 15 segundos. */
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
      addingFrom = null;
      saveHome(loadHome()); // entra al hogar (con otro proveedor, se sube cifrado)
    }
    await storeList();
    writeDraft(null);
    status(st, null);
    if (keep) {
      detectNew();
      placeNewCategories();
    } else {
      markSeen();
      await createFirstDevice();
    }
    showEditor();
    await renderLinksCard();
    renderTipCard();
    toast(`${channels.length} canales cargados`, 'ok');
  } catch (e) {
    status(st, `No se pudo: ${(e as Error).message}`, 'bad');
  }
}

// Lista de demostración: canales públicos y gratuitos (iptv-org), legales para probar.
const DEMO_M3U = 'https://iptv-org.github.io/iptv/countries/uy.m3u';

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
      const r = await api<{ channels: Channel[]; viaRelay?: boolean }>('/api/provider/list', { method: 'POST', auth: false, body: { type: 'xtream', servers, username, password } });
      // Si el proveedor bloquea al Worker y la lista la bajó el relay, el Worker no vuelve a pedirla: usa la guardada.
      await finishOnboarding(r.channels, { type: 'xtream', servers, ...(r.viaRelay ? { list: 'upload' as const } : {}) });
    } catch (e) {
      // Hay proveedores que bloquean los pedidos que salen de Cloudflare y no hay relay: la baja el navegador de la persona (una descarga común, sin CORS) y la sube.
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
      status(st, /error interno/.test((e as Error).message) ? 'No se pudo bajar la lista. Revisá que la dirección esté bien y que abra en el navegador.' : `No se pudo bajar la lista: ${(e as Error).message}`, 'bad');
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
  $('#homeLink').onclick = (ev) => {
    ev.preventDefault();
    void useHomeCode();
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
  loadHealth();
  loadStreamHealth();
  loadProfiles();
}

async function openSaved(soft = false) {
  const st = $('#status');
  $('#onboarding').hidden = true;
  $('#editor').hidden = false;
  // Al refrescar (soft) la lista queda donde está mientras se vuelve a bajar todo: sin esqueleto ni salto arriba. En el
  // iPhone, mover la página o achicarla en medio del rebote del gesto dejaba los toques trabados.
  if (!soft) window.scrollTo(0, 0);
  const say = (t: string) => { if (!soft) status(st, t); };
  const main = $('#editor main');
  if (!soft) {
    main.classList.add('loading');
    renderSkeleton();
  }
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
    saveHome(loadHome(), false);
    state.channels = await loadStoredList();
    if (!state.channels.length && cfg.provider.type === 'xtream' && cfg.provider.list === 'upload') {
      state.channels = await waitForList(say);
      if (!cfg.groups.order.length) cfg.groups.order = [...new Set(state.channels.map((c) => c.category))];
      try {
        localStorage.setItem(LIST_KEY(state.local!.cfgId), JSON.stringify(state.channels));
      } catch { /* sin storage */ }
      toast(`${state.channels.length} canales cargados`, 'ok');
    }
    // La lista se pinta enseguida con lo guardado (el EPG y el logo de cada canal ya están en la configuración); sin
    // coincidencia todavía, las filas no muestran etiqueta. La guía y el cruce, que tardan, corren después.
    main.classList.remove('loading');
    render();
    // Si la guía no baja, la lista de canales igual se ve (sin logos ni programa): se avisa arriba y «Reintentar» la vuelve a pedir.
    let guideError: unknown = null;
    try {
      await loadGuide(say);
    } catch (e) {
      guideError = e;
    }
    const masked = maskStoredIds();
    // La guía cambia todos los días: se vuelve a cruzar y, si cambió algo, se guarda.
    if ((await rematch(say)) || pending || masked) await saveNow(false);
    guideReady = true;
    status(st, null);
    if (guideError) status(st, `No se pudo bajar la guía: ${loadError(guideError)}`, 'bad', () => void refreshGrid());
    detectNew();
    placeNewCategories();
    render();
    await renderLinksCard();
    renderTipCard();
    refreshGuideStatus();
    loadHealth();
    loadStreamHealth();
    loadProfiles();
    void loadReports();
    openProgramFromUrl();
  } catch (e) {
    main.classList.remove('loading');
    const msg = (e as Error).message;
    if (/inexistente|clave/.test(msg)) {
      status(st, null);
      toast('Tu configuración ya no está guardada en el servidor. Empezá de nuevo o importá un respaldo.', 'bad', 8000);
      saveLocal((state.local = null));
      state.creds = null;
      showOnboarding();
    } else {
      status(st, `No se pudo cargar la grilla: ${loadError(e)}`, 'bad', () => void refreshGrid());
    }
  }
}

/** Volver a cargar la grilla (tirando hacia abajo o con «Reintentar»): primero se guarda lo pendiente; después se
 *  vuelven a bajar la configuración, la lista y la guía. */
let refreshing = false;
async function refreshGrid() {
  if (refreshing || !state.local) return;
  refreshing = true;
  document.body.classList.add('refreshing');
  try {
    const loaded = state.cfg && !$('#editor main').classList.contains('loading');
    if (loaded) await saveNow(false);
    await openSaved(!!loaded);
  } finally {
    refreshing = false;
    document.body.classList.remove('refreshing');
  }
}

/** Tirar hacia abajo estando arriba de todo recarga la grilla (como en las apps del celular). */
function wirePullToRefresh() {
  const ind = $('#ptr');
  const MAX = 96, GO = 72;
  let y0 = -1, dy = 0;
  const reset = () => {
    y0 = -1;
    dy = 0;
    ind.style.transform = '';
    ind.classList.remove('ready', 'pulling');
  };
  window.addEventListener('touchstart', (ev) => {
    // Solo en la lista de Canales: la Guía y las páginas (Categorías, Perfil) se desplazan por dentro.
    const editorOpen = !$('#editor').hidden && $('#guide').hidden && !document.querySelector('dialog[open]') && !document.body.classList.contains('selecting');
    y0 = editorOpen && window.scrollY <= 0 && !refreshing ? ev.touches[0].clientY : -1;
  }, { passive: true });
  window.addEventListener('touchmove', (ev) => {
    if (y0 < 0) return;
    dy = Math.min(MAX, Math.max(0, (ev.touches[0].clientY - y0) * 0.5));
    if (window.scrollY > 0) return reset();
    ind.classList.toggle('pulling', dy > 4);
    ind.classList.toggle('ready', dy >= GO);
    ind.style.transform = `translate(-50%, ${dy}px) rotate(${dy * 3}deg)`;
  }, { passive: true });
  window.addEventListener('touchend', () => {
    const go = y0 >= 0 && dy >= GO;
    reset();
    if (go) void refreshGrid();
  });
  window.addEventListener('touchcancel', reset);
}

function exportBackup() {
  // `configs`: todos los proveedores del hogar (un respaldo viejo trae solo cfgId y editKey, y se sigue aceptando).
  const data = { grilla: 1, worker: location.origin, cfgId: state.local!.cfgId, editKey: state.local!.editKey, configs: loadHome().configs };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'grilla-respaldo.json';
  a.click();
  toast('Respaldo descargado. Guardalo: con él se puede editar tu configuración.', 'ok', 6000);
}

async function importBackup(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (!data?.cfgId || !data?.editKey) throw new Error('no es un respaldo de nowline');
    state.creds = null;
    state.local = { cfgId: data.cfgId, editKey: data.editKey };
    await api(`/api/cfg/${data.cfgId}`);
    saveLocal(state.local);
    const h = loadHome();
    // La que se abre existe en el servidor (se acaba de leer): si figuraba como quitada, vuelve. Las demás quitadas no.
    h.removed = h.removed!.filter((id) => id !== data.cfgId);
    if (!h.configs.some((x) => x.cfgId === data.cfgId)) h.configs.unshift({ ...state.local });
    for (const c of (Array.isArray(data.configs) ? data.configs : []) as HomeConfig[]) {
      if (typeof c?.cfgId === 'string' && typeof c?.editKey === 'string' && !h.removed.includes(c.cfgId) && !h.configs.some((x) => x.cfgId === c.cfgId)) h.configs.push(c);
    }
    saveHome(h);
    for (const d of $$<HTMLDialogElement>('dialog[open]')) d.close();
    await openSaved();
  } catch (e) {
    state.local = loadLocal();
    toast(`No se pudo importar: ${(e as Error).message}`, 'bad', 6000);
  }
}

/** La prueba de canales corre una vez por día: la fila «Probar ahora» dice cuándo se puede volver a lanzar. */
const CHECK_EVERY_H = 20;
function checkWaitHours(): number {
  const last = Math.max(Date.parse(streamHealth?.checked ?? '') || 0, Date.parse(streamHealth?.requested ?? '') || 0);
  return last ? Math.max(0, CHECK_EVERY_H - (Date.now() - last) / 3600_000) : 0;
}
/** ¿Hay una prueba de canales en curso? Se pidió y todavía no terminó (el cron la toma en hasta 30 minutos), o el Worker
 *  está dejando su avance (también la de la madrugada). */
function probeRunning(): boolean {
  const requested = Date.parse(streamHealth?.requested ?? '') || 0;
  const checked = Date.parse(streamHealth?.checked ?? '') || 0;
  return !!streamHealth?.progress || (requested > checked && Date.now() - requested < 30 * 60_000);
}

let probeWasRunning = false;
let probeTimer = 0;
/** La franja fija arriba de la lista mientras se prueban los canales: «Probando 50 de 180 · 3 caídos hasta ahora» con su
 *  barra y «Detener». Mientras corre, vuelve a preguntar cada 15 s; al terminar se va y deja un aviso con el resultado. */
function renderProbeStrip() {
  const strip = document.querySelector<HTMLElement>('#probeStrip');
  if (!strip) return;
  clearTimeout(probeTimer);
  const running = probeRunning();
  strip.hidden = !running;
  if (running) {
    const p = streamHealth?.progress;
    $('#probeText').textContent = p ? `Probando ${p.done} de ${p.total}` : 'Prueba de canales en espera';
    $('#probeDown').textContent = !p ? 'arranca en unos minutos' : p.down ? plural(p.down, 'caído', 'caídos') : 'ninguno caído';
    const bar = $('#probeBar');
    bar.classList.toggle('wait', !p?.total);
    bar.style.setProperty('--p', p?.total ? `${Math.round((p.done / p.total) * 100)}%` : '0%');
    probeTimer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') void loadStreamHealth().then(renderDownRow);
      else renderProbeStrip();
    }, 15_000);
  } else if (probeWasRunning && streamHealth?.checked) {
    const down = state.channels.filter((c) => matchesFilter(c, 'caidos')).length;
    const tested = streamHealth.tested ?? 0;
    const text = `Listo: ${down ? plural(down, 'canal caído', 'canales caídos') : 'ningún canal caído'}${tested ? ` entre ${tested} probados` : ''}`;
    toast(text, 'ok', 7000, down ? { label: 'Ver', run: showDownChannels } : undefined);
  }
  probeWasRunning = running;
}

/** Lleva a Canales con el filtro «Caídos». */
function showDownChannels() {
  closePages();
  setGuide(false);
  state.filter = 'caidos';
  state.shown = PAGE;
  render();
  window.scrollTo(0, 0);
}

/** «Detener»: saca el pedido o corta la prueba después de la tanda en curso (queda lo que alcanzó a probar). */
async function stopProbe() {
  const btn = $<HTMLButtonElement>('#probeStop');
  btn.disabled = true;
  try {
    await api(`/api/cfg/${state.local!.cfgId}/health/run`, { method: 'DELETE' });
    probeWasRunning = false; // el aviso es este, no el de «Listo»
    toast(streamHealth?.progress ? 'Prueba detenida: queda lo que alcanzó a probar' : 'Prueba cancelada', 'info');
    if (streamHealth) { delete streamHealth.requested; delete streamHealth.progress; }
    renderProbeStrip();
    renderDownRow();
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  } finally {
    btn.disabled = false;
  }
}

/** Una sola fila «Canales caídos»: el resultado de las pruebas hechas y, al costado, el botón para probar ahora. */
function renderDownRow() {
  const sub = document.querySelector<HTMLElement>('#downSub');
  if (!sub) return; // la fila está en la página del perfil en uso
  const wait = checkWaitHours();
  const running = probeRunning();
  const parts: string[] = [];
  if (!streamHealth?.checked) parts.push('Todavía no se probó ningún canal');
  else {
    const tested = Object.keys(streamHealth!.channels).length;
    const down = state.channels.filter((c) => matchesFilter(c, 'caidos')).length;
    parts.push(`${down ? plural(down, 'canal caído', 'canales caídos') : 'Ninguno caído'} · ${tested} de ${streamHealth!.total ?? '?'} probados`);
  }
  const trouble = relayTrouble();
  if (running) parts.push(streamHealth?.progress ? `probando ahora: ${streamHealth.progress.done} de ${streamHealth.progress.total}` : 'probando ahora: arranca en unos minutos');
  else if (trouble && 'probe' in trouble) {
    parts.push(`${trouble.probe ? `sin probar desde ${trouble.probe}` : 'no se pudo probar'}: el servicio que prueba no responde`);
  } else if (wait > 0) parts.push(`próxima prueba en ${Math.ceil(wait)} h`);
  else parts.push('ya se puede probar');
  sub.textContent = parts.join(' · ');
  const btn = $<HTMLButtonElement>('#runCheckBtn');
  btn.disabled = running;
  btn.classList.toggle('is-wait', wait > 0 && !running);
  btn.textContent = running ? 'Probando…' : 'Probar ahora';
}

/** La fila «Canales caídos» de la página del perfil en uso: tocarla filtra la grilla; «Probar ahora» lanza la prueba. */
function wireDownRow() {
  $('#runCheckBtn').onclick = async (ev) => {
    ev.stopPropagation(); // el resto de la fila abre el filtro «Caídos»
    const wait = checkWaitHours();
    if (wait > 0) {
      toast(`La prueba de canales corre una vez por día: se puede volver a lanzar en ${Math.ceil(wait)} h`, 'info', 5000);
      return;
    }
    try {
      const r = await api<{ started: boolean; reason?: string; requested?: string; nextAt?: string }>(`/api/cfg/${state.local!.cfgId}/health/run`, { method: 'POST', body: {} });
      if (r.started) {
        streamHealth = { channels: {}, ...(streamHealth ?? {}), requested: r.requested };
        renderDownRow();
        renderProbeStrip();
        toast('Prueba lanzada: arranca en unos minutos y el avance se ve arriba de la lista de canales', 'ok', 6000);
      } else if (r.reason === 'recent') {
        toast('Ya se probó hoy: se puede volver a lanzar mañana', 'info', 5000);
        await loadStreamHealth();
        renderDownRow();
      } else {
        toast('La prueba de canales necesita el relay: falta cargar RELAY_URL y RELAY_SECRET en el Worker', 'bad', 7000);
      }
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
  };
  $('#downRow').onkeydown = (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) ($('#downRow') as HTMLElement).click(); };
  $('#downRow').onclick = () => {
    const n = state.channels.filter((c) => matchesFilter(c, 'caidos')).length;
    if (!n) {
      toast(streamHealth?.checked ? 'No hay canales caídos entre los que ya se probaron' : 'Todavía no se probó ningún canal: corre una vez por día', 'info');
      return;
    }
    ($('#linksDialog') as HTMLDialogElement).close();
    state.filter = 'caidos';
    state.shown = PAGE;
    render();
    window.scrollTo(0, 0);
  };
}

function setupEditor() {
  let t = 0;
  $<HTMLInputElement>('#searchBox').oninput = (ev) => {
    clearTimeout(t);
    loadHourNow(); // por si cambió la hora desde que se abrió
    loadHourNowDesc();
    if ((ev.target as HTMLInputElement).value.trim()) loadTopicsNow();
    t = window.setTimeout(() => {
      state.search = (ev.target as HTMLInputElement).value;
      state.shown = PAGE;
      render();
    }, 150);
  };
  const cards = $('#cards');
  let longPressed = -1;
  let swiped = -1;
  cards.onclick = (ev) => {
    const t = ev.target as HTMLElement;
    const card = t.closest<HTMLElement>('.card[data-i]');
    if (!card) return;
    const i = Number(card.dataset.i);
    if (longPressed === i) {
      longPressed = -1;
      return;
    }
    if (swiped === i) {
      swiped = -1;
      return;
    }
    if (selection.active) {
      toggleSelected(i);
      return;
    }
    const more = t.closest<HTMLElement>('[data-more]');
    if (more) {
      openRowMenu(more, i);
      return;
    }
    const use = t.closest<HTMLElement>('[data-use]');
    if (use) {
      const cid = info(state.channels[i]).suggestion?.channelId;
      if (cid) chooseEpg(state.channels[i], cid, 'Sugerencia aplicada');
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
  // Deslizar una fila (con el dedo): izquierda = ocultar o mostrar, derecha = dejar sin guía.
  let sw: { card: HTMLElement; x: number; y: number; dx: number; on: boolean } | null = null;
  const resetSwipe = (card: HTMLElement) => {
    card.classList.remove('swiping', 'armed');
    card.style.removeProperty('--sx');
    delete card.dataset.sw;
  };
  cards.addEventListener('pointerdown', (ev) => {
    if (selection.active || cards.classList.contains('grid') || (ev.target as HTMLElement).closest('.row-more')) return;
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.row-card[data-i]');
    if (card) sw = { card, x: ev.clientX, y: ev.clientY, dx: 0, on: false };
  });
  cards.addEventListener('pointermove', (ev) => {
    if (!sw) return;
    const dx = ev.clientX - sw.x;
    const dy = ev.clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      sw.on = true;
      cancel();
      sw.card.classList.add('swiping');
    }
    sw.dx = Math.max(-140, Math.min(140, dx));
    sw.card.style.setProperty('--sx', `${sw.dx}px`);
    sw.card.dataset.sw = sw.dx < 0 ? 'l' : 'r';
    sw.card.classList.toggle('armed', Math.abs(sw.dx) > 80);
  });
  cards.addEventListener('pointerup', () => {
    if (!sw) return;
    const { card, dx, on } = sw;
    sw = null;
    if (!on) return;
    resetSwipe(card);
    const i = Number(card.dataset.i);
    swiped = i;
    setTimeout(() => { swiped = -1; }, 400);
    if (Math.abs(dx) <= 80) return;
    const ch = state.channels[i];
    if (dx < 0) {
      const wasHidden = !!state.cfg!.channels[ch.name]?.hidden;
      editChannels([ch], (e) => { e.hidden = e.hidden ? undefined : true; }, wasHidden ? 'Visible' : 'Oculto');
    } else editChannels([ch], noEpg, 'Quedó sin guía');
  });
  cards.addEventListener('pointercancel', () => {
    if (sw) resetSwipe(sw.card);
    sw = null;
  });
  // Con teclado: Enter o espacio abren la fila.
  cards.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if ((ev.key === 'Enter' || ev.key === ' ') && t.matches('.card[data-i]')) {
      ev.preventDefault();
      t.click();
    }
  });
  $('#viewBtn').onclick = () => {
    setPref('grilla_density', NEXT_VIEW[viewMode()]);
    render();
  };
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
    state.shown += PAGE;
    refreshCards();
    $('#loadMoreSentinel').hidden = list.length <= state.shown;
    return !$('#loadMoreSentinel').hidden;
  });
  $('#categoriesBtn').onclick = () => {
    if (!pageDialog('categories').open) openCategories();
  };
  // Al cerrarse una página (por ejemplo, para ir a los canales caídos) la barra vuelve a marcar lo que se ve.
  for (const t of Object.keys(PAGES) as PageTab[]) pageDialog(t).addEventListener('close', () => markTab(currentTab()));
  wirePullToRefresh();
  // Barra inferior: Canales (volver arriba), Guía, Categorías y Perfil. Revisar entra por la tarjeta de arriba de la grilla.
  $('#helpTopBtn').onclick = () => openHelp('main');
  $('#probeStop').onclick = () => void stopProbe();
  $('#tabHome').onclick = () => {
    if (currentTab() !== 'home') {
      closePages();
      return setGuide(false);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  $('#tabGuide').onclick = () => setGuide(true);
  placeTabPill($('#tabbar'));
  // Pestaña Perfil: un toque abre Perfiles; mantenerla apretada (o clic derecho) cambia de perfil sin entrar.
  let pressTimer = 0;
  let pressed = false;
  const tabProfile = $('#tabLinks');
  tabProfile.onpointerdown = () => {
    pressed = false;
    pressTimer = window.setTimeout(() => { pressed = true; navigator.vibrate?.(10); openProfileSwitch(); }, 500);
  };
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) tabProfile.addEventListener(ev, () => clearTimeout(pressTimer));
  tabProfile.oncontextmenu = (ev) => {
    ev.preventDefault();
    clearTimeout(pressTimer);
    if (!pressed) openProfileSwitch();
    pressed = true;
  };
  tabProfile.onclick = () => {
    if (pressed) { pressed = false; return; }
    openProfiles(); // ya en Perfil: vuelve a la lista
  };
  $('#profileNotice').onclick = () => openProfiles({ v: 'account', account: activeAccount() });
  $('#linksBack').onclick = linksBack;
  $('#linksHelpBtn').onclick = () => openHelp(linksHelpTopic(), '#linksDialog');
  wireNested('#helpDialog', '#helpBack', '#helpClose');
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
  document.body.classList.toggle('no-logos', !logosOn());
  $<HTMLInputElement>('#backupFile').onchange = (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) importBackup(f);
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
    renderIcon(btn, 'x');
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
// Versión nueva: el service worker nuevo se instala y toma la página solo (sw.js), y al abrir la app la navegación
// baja el HTML de la versión nueva; no hay aviso con la app abierta. Al abrirla con una versión nueva, un aviso breve
// (ui/novedades.tsx) dice que se actualizó y muestra qué cambió.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* sin SW: anda igual */ }));
}
void checkNovedades(__APP_VERSION__);
hydrateIcons();
installSheets();
addSearchClear(document);
for (const el of $$('[data-version]')) el.textContent = `nowline ${__APP_VERSION__}`;
$('#askCancel').onclick = () => ($('#askDialog') as HTMLDialogElement).close('');
$('#askClose').onclick = () => ($('#askDialog') as HTMLDialogElement).close('');
setupOnboarding();
setupEditor();
{
  // El filtro se esconde al bajar la lista y vuelve al subir (con margen para que no titile).
  const bar0 = document.querySelector<HTMLElement>('.toolbar');
  if (bar0 && 'ResizeObserver' in window) {
    new ResizeObserver(() => document.documentElement.style.setProperty('--toolbar-h', `${bar0.offsetHeight}px`)).observe(bar0);
  }
  let lastY = 0;
  let travel = 0; // lo recorrido en la dirección actual
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const bar = document.querySelector('.toolbar');
    const d = y - lastY;
    lastY = y;
    if (!bar || !d) return;
    travel = Math.sign(d) === Math.sign(travel) ? travel + d : d;
    if (y < 120) bar.classList.remove('compact');
    else if (travel > 40) bar.classList.add('compact');
    else if (travel < -40) bar.classList.remove('compact');
  }, { passive: true });
}
// Un dispositivo que entró con un código para ver abre siempre en ese modo; salir pide el código de la casa (ver.tsx).
let viewOnly: string | null = null;
// Aunque el dispositivo tenga configuración propia: quien mira no llega al editor escribiendo la dirección sin «ver».
try { viewOnly = localStorage.getItem(VIEW_CODE_KEY); } catch { /* sin storage */ }
// La app instalada en el inicio del editor abre el editor aunque otra app instalada (la de modo ver) use el mismo storage:
// en iPhone, todas las apps agregadas del mismo sitio comparten localStorage. Quien mira sigue sin llegar al editor desde el navegador.
const installed = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
if (viewOnly && !installed) {
  try { sessionStorage.removeItem('nowline_splash'); } catch { /* sin storage */ } // que el logo siga en /ver
  location.replace(`/ver#${viewOnly}`);
} else {
  if (state.local) openSaved();
  else showOnboarding();
  hideSplash();
}

// Lo que usan los componentes de ui/ mientras la web pasa a Preact (planes/react.md): a medida que se migra, cada cosa
// se muda a su propio módulo y sale de esta lista.
export {
  accountData, accountName, activeAccount, addProvider, ago, api, apiWrites, applyBulk, applyRename, autoEpg,
  chooseEpg, collapsedSections, confirmDialog, connectionsInUse, copyText, createGroup, daysLeft, deleteGroup,
  descFromHour, editChannels, EVENT_TZ_KEY, eventLabel, eventOf, eventTz, exportBackup, fold, forgetConfig, GOOD,
  groupChannels, groupLabel, groupOf, groups, guideHealth, guideLabel, guideTime, hasWords, HEALTH_AHEAD_H, hhmm,
  hourDescIndex, hourIndex, info, initialOf, isLoneHeader, liveAt, loadHealth, loadHome, loadProfiles,
  loadReminders, loadStreamHealth, logosOn, matchesFilter, moveGroup, myAccounts, newCategoryName, noEpg, nowFromHour,
  nowPlaying, openDock, openHelp, openPage, openProfiles, otherAccounts, otherProviders, PAGE, pickEpg, plural, pref,
  profileDefs, profileDevices, profilesAt, promptDialog, providerName, providerTz, relayTrouble, remindKey, render, renderDownRow,
  renderTabAvatar, reviewList, reviewProgress, saveCollapsed, saveHome, saveNow, schedule, sectionHeaders,
  sectionTitle, selection, setActiveAccount, setChannelOrder, setPref, setupDrag, shareText, showHomeCode,
  showOnboarding, showQr, startGuideRefresh, state, switchProvider, toggleGroupHidden, toggleGroupNoEpg,
  toggleReminder, unrenameGroup, useHomeCode, useOtherAccount, useViewCode, viewMode, visibleChannels, wireDownRow, wireSwipe,
};
export type { Account, Band, ChannelEdit, NowPlaying, ScheduleEntry, AccountView, Device, DeviceFilter, GuideStatus, LinkResult, OtherProvider, ProfileDef, ProfileView };
