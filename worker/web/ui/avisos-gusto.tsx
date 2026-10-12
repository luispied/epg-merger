// Avisos por gusto (planes/avisos-por-gusto.md, opción B): una hoja que se abre desde la fila de Configuración. Prende o
// apaga los avisos, elige de qué géneros, cuándo y cuántos, y muestra los últimos con «Menos así». Las reglas viven en
// el Worker (src/taste.ts); acá solo se pide y se cambia su estado. Solo en la edición: el modo ver no tiene push.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, openHelp, state } from '../app.ts';
import { Icon } from './icon.tsx';
import { genrePlural } from './guide.tsx';
import { Skeleton } from './kit.tsx';
import { toast } from './toast.tsx';

export interface TasteView {
  on: boolean;
  when: 'tarde' | 'noche';
  per: 'dia' | 'semana';
  tz: string;
  genres: { name: string; on: boolean }[];
  sent: { title: string; genre: string; at: string; name: string }[];
}

const path = () => `/api/cfg/${state.local!.cfgId}/push/taste`;
const LOAD_MS = 10_000;

/** La ayuda de Configuración, con el apartado de los avisos por gusto abierto. */
function helpTaste() {
  openHelp('settings', '#tasteDialog');
  const d = document.getElementById('helpTaste') as HTMLDetailsElement | null;
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: 'start' });
}

/** El estado de los avisos por gusto, con un tiempo máximo (la hoja avisa y deja «Probar de nuevo»). */
export function loadTaste(): Promise<TasteView> {
  return Promise.race([
    api<TasteView>(path()),
    new Promise<never>((_, no) => setTimeout(() => no(new Error('tarda demasiado')), LOAD_MS)),
  ]);
}
export const changeTaste = (body: Record<string, unknown>) => api<TasteView>(path(), { method: 'POST', body });
const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Lo que dice la fila de Configuración: apagados, o prendidos con los géneros que siguen. */
export function tasteSummary(v: TasteView | null): string {
  if (!v || !v.on) return 'Apagados';
  const on = v.genres.filter((g) => g.on).map((g) => g.name);
  return on.length ? `Prendidos · ${on.slice(0, 3).join(', ')}` : 'Prendidos · todavía sin géneros';
}

/** Apaga o prende un género, con «Deshacer» (lo usan la hoja de avisos y la hoja del programa). */
export async function setGenreAlert(genre: string, on: boolean, quiet = false): Promise<TasteView | null> {
  try {
    const v = await changeTaste({ genre, genreOn: on });
    if (!quiet) {
      toast(on ? `Listo: te aviso de ${genrePlural(genre)}.` : `Listo: no te aviso más de ${genrePlural(genre)}.`, 'ok', 3500,
        { label: 'Deshacer', run: () => void setGenreAlert(genre, !on, true).then((w) => w && onGenre?.(w)) });
    }
    return v;
  } catch {
    toast('No se pudo guardar. Probá de nuevo.', 'bad');
    return null;
  }
}
let onGenre: ((v: TasteView) => void) | null = null;

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days <= 0 ? 'Hoy' : days === 1 ? 'Ayer' : d.toLocaleDateString('es-AR', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  return `${day} · ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function Sheet({ close, onChange }: { close: () => void; onChange: (v: TasteView) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<TasteView | null>(null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const load = () => {
    setFailed(false);
    loadTaste().then((v) => { setView(v); onChange(v); }).catch(() => setFailed(true));
  };
  useEffect(load, []);
  const apply = (v: TasteView | null) => { if (v) { setView(v); onChange(v); } };
  onGenre = apply;
  const send = async (body: Record<string, unknown>) => {
    try {
      apply(await changeTaste(body));
    } catch {
      toast('No se pudo guardar. Probá de nuevo.', 'bad');
    }
  };
  const v = view;
  return (
    <dialog class="sheet settings-sheet" id="tasteDialog" ref={dlg} onClose={() => { onGenre = null; close(); }} aria-labelledby="tasteTitle">
      <div class="sheet-body">
        <div class="title-row">
          <span class="title-left"><h2 id="tasteTitle">Avisos por gusto</h2>
            <button type="button" class="icon-btn help-btn" aria-label="Ayuda" title="Ayuda" onClick={helpTaste}><Icon name="circle-help" /></button></span>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        {!v && !failed && <div aria-busy="true" aria-label="Cargando los avisos por gusto"><Skeleton rows={2} /></div>}
        {!v && failed && (
          <>
            <p class="help">No se pudieron cargar los avisos por gusto.</p>
            <button type="button" class="btn btn-primary" onClick={load}><Icon name="refresh-cw" />Probar de nuevo</button>
          </>
        )}
        {v && (
          <>
            <div class="menu">
              <label class="menu-row static">
                <span class="menu-icon"><Icon name="sparkles" /></span>
                <span class="menu-text">Avisarme lo que me gusta<small>{v.per === 'dia' ? 'Como mucho uno por día' : 'Como mucho tres por semana'}; nunca de noche</small></span>
                <input type="checkbox" class="switch" role="switch" checked={v.on}
                  onChange={(ev) => void send({ on: ev.currentTarget.checked, ...(ev.currentTarget.checked ? { tz: deviceTz() } : {}) })} />
              </label>
            </div>
            {!v.on && <p class="help">Cuando lo prendas, nowline te avisa de un programa del género que más mirás. Si no hay uno bueno, no manda nada.</p>}
            {v.on && (
              <>
                <h3 class="sec-title">De qué géneros</h3>
                {v.genres.length ? (
                  <div class="filter-chips">
                    {v.genres.map((g) => (
                      <button key={g.name} type="button" class="chip-btn" aria-pressed={g.on} onClick={() => void send({ genre: g.name, genreOn: !g.on })}>{g.name}</button>
                    ))}
                  </div>
                ) : <p class="help">Todavía no hay un género que mires seguido.</p>}
                <p class="help">Los que más mirás, de lo que abriste con nowline. Noticias y publicidad nunca.</p>
                <h3 class="sec-title">Cuándo</h3>
                <div class="segmented" role="group" aria-label="Cuándo">
                  <button type="button" aria-pressed={v.when === 'tarde'} onClick={() => void send({ when: 'tarde' })}>Tarde · 18 a 20</button>
                  <button type="button" aria-pressed={v.when === 'noche'} onClick={() => void send({ when: 'noche' })}>Noche · 20 a 22</button>
                </div>
                <h3 class="sec-title">Cuántos</h3>
                <div class="segmented" role="group" aria-label="Cuántos">
                  <button type="button" aria-pressed={v.per === 'dia'} onClick={() => void send({ per: 'dia' })}>1 por día</button>
                  <button type="button" aria-pressed={v.per === 'semana'} onClick={() => void send({ per: 'semana' })}>3 por semana</button>
                </div>
                <h3 class="sec-title">Últimos avisos</h3>
                {v.sent.length ? (
                  <div class="menu">
                    {v.sent.map((s) => {
                      const off = v.genres.some((g) => g.name === s.genre && !g.on);
                      return (
                        <div key={s.at} class="menu-row static">
                          <span class="menu-text">{s.title}<small>{when(s.at)} · {s.genre}</small></span>
                          <button type="button" class="chip-btn" disabled={off} onClick={() => void setGenreAlert(s.genre, false).then(apply)}>{off ? 'Apagado' : 'Menos así'}</button>
                        </div>
                      );
                    })}
                  </div>
                ) : <p class="help">Todavía no mandé ninguno. Cuando mande uno, lo ves acá.</p>}
              </>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

/** Abre la hoja; `onChange` recibe el estado cada vez que cambia (para la fila de Configuración). */
export function openTasteSheet(onChange: (v: TasteView) => void) {
  let host = document.getElementById('tasteHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tasteHost';
    document.body.appendChild(host);
  }
  const h = host;
  render(<Sheet key={Date.now()} close={() => render(null, h)} onChange={onChange} />, h);
}
