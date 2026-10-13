// Configuración (la hoja del engranaje) y los avisos push, en Preact (ver planes/react.md). El estado de la guía, su
// salud y las preferencias siguen en app.ts; acá está la hoja y cómo se activan los avisos en este dispositivo.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  api, guideHealth, guideTime, HEALTH_AHEAD_H, loadHealth, logosOn, openDock, openHelp, openProfiles, PAGE, plural, pref,
  profileDefs, render as renderGrid, setPref, startGuideRefresh, state, type GuideStatus,
} from '../app.ts';
import { loadTaste, openTasteSheet, pushEndpoint, tasteSummary } from './avisos-gusto.tsx';
import { Icon } from './icon.tsx';
import { toast } from './toast.tsx';
import { openNovedades } from './novedades.tsx';
import { BrandFoot } from './kit.tsx';

declare const __APP_VERSION__: string;

const dialog = () => document.getElementById('settingsDialog') as HTMLDialogElement;

// ------------------------------------------------------------------ avisos push
// El Worker manda una notificación (Web Push) cuando aparecen canales nuevos. Funciona en el navegador y en
// la app instalada; en iPhone solo con la app instalada (Safari común no tiene push). Sin las claves VAPID en
// el Worker, el interruptor no aparece.
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const iosNotInstalled = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone;
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

const PUSH_HINT = 'Canales nuevos, vencimientos y tus campanas';
let pushKey = '';
interface PushView { on: boolean; disabled: boolean; hint: string }

/** Cómo está el interruptor de avisos en este dispositivo (todavía sin saber si está suscrito); null si el Worker no
 *  tiene los avisos activados. */
async function pushView(): Promise<PushView | null> {
  try {
    pushKey = (await api<{ key: string }>('/api/push/key', { auth: false })).key;
  } catch {
    pushKey = ''; // avisos no activados en el Worker
  }
  if (!pushKey) return null;
  if (!pushSupported()) {
    return { on: false, disabled: true, hint: iosNotInstalled() ? 'En iPhone: instalá la app (Compartir → Agregar a inicio)' : 'Este navegador no admite avisos' };
  }
  if (Notification.permission === 'denied') return { on: false, disabled: true, hint: 'Bloqueados: activalos en los ajustes del sitio del navegador' };
  return { on: false, disabled: false, hint: PUSH_HINT };
}
async function pushSubscribed() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
  return !!sub && Notification.permission === 'granted';
}

/** Suscribe (pide el permiso) o da de baja este dispositivo de los avisos. */
export async function setPush(on: boolean) {
  const reg = await navigator.serviceWorker.ready;
  try {
    if (on) {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('No diste permiso para los avisos');
      if (!pushKey) await pushView();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(pushKey) });
      await api(`/api/cfg/${state.local!.cfgId}/push`, { method: 'POST', body: sub.toJSON() });
      await api(`/api/cfg/${state.local!.cfgId}/push/test`, { method: 'POST', body: {} });
      toast('Avisos activados', 'ok');
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api(`/api/cfg/${state.local!.cfgId}/push`, { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
      toast('Avisos desactivados', 'ok');
    }
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

// ------------------------------------------------------------------ la hoja
type Theme = 'auto' | 'light' | 'dark';
const THEMES: { v: Theme; label: string; icon: string }[] = [
  { v: 'auto', label: 'Como el sistema', icon: 'monitor' },
  { v: 'light', label: 'Claro', icon: 'sun' },
  { v: 'dark', label: 'Oscuro', icon: 'moon' },
];
function savedTheme(): string {
  try {
    return localStorage.getItem('grilla_theme') || 'auto';
  } catch {
    return 'auto';
  }
}

/** El resumen de «Salud de la guía»: de los canales visibles con guía, cuántos dan programación ahora. */
function healthText() {
  const h = guideHealth();
  if (!h.known) return 'Todavía no hay datos de programación';
  const pct = h.withGuide ? Math.round((100 * h.ok) / h.withGuide) : 0;
  const parts = [`${pct} % con programación ahora`];
  if (h.dead) parts.push(`${plural(h.dead, 'canal', 'canales')} sin programación en las próximas ${HEALTH_AHEAD_H} h`);
  if (h.none) parts.push(`${h.none} sin guía`);
  return parts.join(' · ');
}

/** Avisos por gusto: con un solo perfil abre su hoja; con varios, Perfil, donde cada uno tiene la suya (ui/avisos-gusto.tsx). */
function TasteRow() {
  const [sub, setSub] = useState('');
  useEffect(() => {
    if (profileDefs.length !== 1) {
      setSub('Se prenden en cada perfil');
      return;
    }
    void pushEndpoint()
      .then((ep) => (ep ? loadTaste(profileDefs[0].id, ep).then(tasteSummary) : 'Primero prendé Avisos'))
      .then(setSub)
      .catch(() => setSub('No se pudo cargar. Probá de nuevo.'));
  }, []);
  const open = () => {
    dialog().close();
    if (profileDefs.length === 1) openTasteSheet(profileDefs[0], () => {});
    else openProfiles();
  };
  return <MenuRow icon="sparkles" title="Avisos por gusto" sub={sub} onClick={open} />;
}

function MenuRow({ icon, title, sub, onClick, hidden }: { icon: string; title: string; sub?: string; onClick: () => void; hidden?: boolean }) {
  return (
    <button class="menu-row" hidden={hidden} onClick={onClick}>
      <span class="menu-icon"><Icon name={icon} /></span>
      <span class="menu-text">{title}{sub !== undefined && <small>{sub}</small>}</span>
      <Icon name="chevron-right" />
    </button>
  );
}

function Settings() {
  const [health, setHealth] = useState('Calculando…');
  const [guide, setGuide] = useState<GuideStatus | null>(null);
  const [push, setPushState] = useState<PushView | null>(null);
  const [logos, setLogos] = useState(logosOn);
  const [startFilter, setStartFilter] = useState(() => pref('grilla_start_filter', 'last'));
  const [theme, setTheme] = useState(savedTheme);
  const [bigText, setBigText] = useState(() => document.documentElement.dataset.text === 'lg');

  useEffect(() => {
    void loadHealth().then(() => setHealth(healthText()));
    if (state.local) {
      api<GuideStatus>(`/api/cfg/${state.local.cfgId}/status`).then((st) => { if (st.autoRefresh) setGuide(st); }).catch(() => {});
    }
    void refreshPush();
  }, []);

  // El interruptor aparece apenas se sabe que hay avisos; si está prendido, cuando responde el service worker.
  const refreshPush = async () => {
    const v = await pushView();
    setPushState(v);
    if (v && !v.disabled) {
      const on = await pushSubscribed();
      setPushState({ ...v, on });
    }
  };
  const showHealth = () => {
    const h = guideHealth();
    if (!h.known) return toast('Todavía no hay datos de programación para comparar', 'info');
    if (!h.dead) return toast('Todos los canales con guía tienen programación en las próximas horas', 'ok');
    dialog().close();
    state.filter = 'sin-prog';
    state.shown = PAGE;
    renderGrid();
    window.scrollTo(0, 0);
  };
  const applyGuide = async () => {
    try {
      const started = await startGuideRefresh();
      toast(started ? 'Actualizando la guía: queda lista en un par de minutos' : 'Ya se está actualizando', 'ok');
      dialog().close();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const pickTheme = (v: Theme) => {
    setTheme(v);
    if (v === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    try {
      localStorage.setItem('grilla_theme', v);
    } catch { /* sin storage */ }
  };

  return (
    <>
      <div class="title-row">
        <span class="title-left"><h2 id="settingsTitle">Configuración</h2>
          <button type="button" class="icon-btn help-btn" aria-label="Ayuda" title="Ayuda" onClick={() => openHelp('settings', '#settingsDialog')}><Icon name="circle-help" /></button></span>
        <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
      </div>
      <h3 class="sec-title">Guía</h3>
      <div class="menu">
        <MenuRow icon="refresh-cw" title="Actualizar la guía ahora" hidden={!guide} onClick={applyGuide}
          sub={!guide ? '' : guide.guideUpToDate ? `Al día${guide.guide ? ` · última actualización ${guideTime(guide.guide)}` : ''}` : 'Se está actualizando'} />
        <MenuRow icon="satellite-dish" title="Salud de la guía" sub={health} onClick={showHealth} />
      </div>
      <p class="help settings-moved">La suscripción, los canales caídos, la dirección del servicio y recargar la lista están en <b>Perfil</b>, abajo.</p>
      <h3 class="sec-title">Otro dispositivo</h3>
      <div class="menu">
        <MenuRow icon="arrow-right-left" title="Usar en otro dispositivo" sub="Con un código o un archivo de respaldo" onClick={() => {
          dialog().close();
          openProfiles({ v: 'hogar' });
        }} />
      </div>
      <h3 class="sec-title">Preferencias</h3>
      <div class="menu">
        <div class="menu-row static">
          <span class="menu-icon"><Icon name="sun-moon" /></span>
          <span class="menu-text">Tema</span>
          <div class="seg" role="radiogroup" aria-label="Tema" id="themeSeg">
            {THEMES.map((t) => (
              <button key={t.v} type="button" role="radio" aria-checked={theme === t.v} aria-label={t.label} title={t.label}
                onClick={() => pickTheme(t.v)}><Icon name={t.icon} /></button>
            ))}
          </div>
        </div>
        {push && (
          <label class="menu-row static">
            <span class="menu-icon"><Icon name="bell" /></span>
            <span class="menu-text">Avisos<small>{push.hint}</small></span>
            <input type="checkbox" class="switch" role="switch" checked={push.on} disabled={push.disabled}
              onChange={(ev) => { void setPush(ev.currentTarget.checked).then(refreshPush); }} />
          </label>
        )}
        {push && <TasteRow />}
        <label class="menu-row static">
          <span class="menu-icon"><Icon name="a-large-small" /></span>
          <span class="menu-text">Letra grande<small>Agranda toda la app en este dispositivo</small></span>
          <input type="checkbox" class="switch" role="switch" checked={bigText} onChange={(ev) => {
            const on = ev.currentTarget.checked;
            setBigText(on);
            setPref('grilla_text', on ? 'lg' : '');
            if (on) document.documentElement.dataset.text = 'lg';
            else delete document.documentElement.dataset.text;
          }} />
        </label>
        <label class="menu-row static">
          <span class="menu-icon"><Icon name="image" /></span>
          <span class="menu-text">Mostrar logos<small>Apagalos para ahorrar datos</small></span>
          <input type="checkbox" class="switch" checked={logos} onChange={(ev) => {
            const on = ev.currentTarget.checked;
            setLogos(on);
            setPref('grilla_logos', on ? '1' : '0');
            document.body.classList.toggle('no-logos', !on);
            renderGrid();
          }} />
        </label>
        <label class="menu-row static">
          <span class="menu-icon"><Icon name="funnel" /></span>
          <span class="menu-text">Filtro al abrir</span>
          <select class="select compact" value={startFilter} onChange={(ev) => {
            setStartFilter(ev.currentTarget.value);
            setPref('grilla_start_filter', ev.currentTarget.value);
          }}>
            <option value="last">El último usado</option>
            <option value="todos">Todos</option>
            <option value="revisar">A revisar</option>
          </select>
        </label>
      </div>
      <BrandFoot />
      <p class="app-version" data-version>{`Versión ${__APP_VERSION__}`}</p>
      <p class="app-news"><button type="button" class="link-btn" onClick={() => void openNovedades(__APP_VERSION__)}>Ver novedades</button></p>
    </>
  );
}

let seq = 0;
/** Abre Configuración, armada de cero cada vez (la salud, la guía y los avisos se vuelven a mirar). */
export function openSettings() {
  const dlg = dialog();
  render(<Settings key={++seq} />, dlg.querySelector('.sheet-body')!);
  openDock(dlg);
}
