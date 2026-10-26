// Avisos por gusto, por perfil (planes/avisos-por-gusto.md y el mock aprobado en capturas/mocks-avisos-perfil/). Se
// prenden desde la página de cada perfil (ui/perfiles.tsx: TasteRows), y la hoja de acá elige géneros, horario y muestra
// los últimos avisos. Las reglas viven en el Worker (src/taste.ts); acá solo se pide y se cambia su estado. Solo en la
// edición: el modo ver no tiene push.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, profileDefs, state } from '../app.ts';
import { Icon } from './icon.tsx';
import { genrePlural } from './guide.tsx';
import { Skeleton } from './kit.tsx';
import { toast } from './toast.tsx';

export type TasteWhen = 'manana' | 'tarde' | 'noche';
export interface TasteView {
  on: boolean;
  when: TasteWhen;
  tz: string;
  /** Este dispositivo recibe los avisos de este perfil. */
  here: boolean;
  genres: { name: string; on: boolean }[];
  sent: { title: string; genre: string; at: string; name: string }[];
}

export const WHEN_LABEL: Record<TasteWhen, string> = { manana: 'Mañana', tarde: 'Tarde', noche: 'Noche' };
export const WHEN_HOURS: Record<TasteWhen, string> = { manana: '9 a 13', tarde: '13 a 20', noche: '20 a 22' };
const path = () => `/api/cfg/${state.local!.cfgId}/push/taste`;
const LOAD_MS = 10_000;
export const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** La suscripción de este dispositivo a los avisos ('' si no hay). Sin ella, los avisos por gusto no llegan acá. */
export async function pushEndpoint(): Promise<string> {
  if (!('serviceWorker' in navigator)) return '';
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
  return sub?.endpoint ?? '';
}

/** El estado de un perfil, con un tiempo máximo (la hoja avisa y deja «Probar de nuevo»). */
export function loadTaste(profile: string, endpoint = ''): Promise<TasteView> {
  const q = `?profile=${encodeURIComponent(profile)}&endpoint=${encodeURIComponent(endpoint)}`;
  return Promise.race([
    api<TasteView>(`${path()}${q}`),
    new Promise<never>((_, no) => setTimeout(() => no(new Error('tarda demasiado')), LOAD_MS)),
  ]);
}
export const changeTaste = (profile: string, body: Record<string, unknown>) =>
  api<TasteView>(path(), { method: 'POST', body: { profile, ...body } });

/** Lo que dice la fila del perfil: apagados, o prendidos con los géneros que siguen. */
export function tasteSummary(v: TasteView | null): string {
  if (!v || !v.on) return 'Apagados';
  if (!v.here) return 'Prendidos · tocá para recibirlos en este dispositivo';
  const on = v.genres.filter((g) => g.on).map((g) => g.name);
  return on.length ? `Prendidos · ${on.slice(0, 3).join(', ')}` : 'Prendidos · todavía sin géneros';
}

/** Lo que muestra la guía: los avisos de todos los perfiles juntos (prendidos en alguno; un género suena si suena en alguno). */
export async function tasteAll(): Promise<{ on: boolean; genres: { name: string; on: boolean }[] } | null> {
  const views = await Promise.all(profileDefs.map((p) => loadTaste(p.id).catch(() => null)));
  const live = views.filter((v): v is TasteView => !!v);
  if (!live.length) return null;
  const names = new Map<string, boolean>();
  for (const v of live) for (const g of v.genres) names.set(g.name, (names.get(g.name) ?? false) || (v.on && g.on));
  return { on: live.some((v) => v.on), genres: [...names].map(([name, on]) => ({ name, on })) };
}

// Apagar un género desde la guía lo apaga en los perfiles donde sonaba; «Deshacer» lo vuelve a prender solo en esos.
let lastOff: { genre: string; ids: string[] } | null = null;
export async function setGenreAll(genre: string, on: boolean): Promise<void> {
  if (on) {
    const ids = lastOff?.genre === genre ? lastOff.ids : [];
    lastOff = null;
    await Promise.all(ids.map((id) => changeTaste(id, { genre, genreOn: true })));
    return;
  }
  const views = await Promise.all(profileDefs.map((p) => loadTaste(p.id).then((v) => [p.id, v] as const).catch(() => null)));
  const ids = views.flatMap((x) => (x && x[1].on && x[1].genres.some((g) => g.name === genre && g.on) ? [x[0]] : []));
  await Promise.all(ids.map((id) => changeTaste(id, { genre, genreOn: false })));
  lastOff = { genre, ids };
}

/** Apaga o prende un género en todos los perfiles, con «Deshacer» (lo usa la hoja del programa). */
export async function setGenreAlert(genre: string, on: boolean, quiet = false): Promise<void> {
  try {
    await setGenreAll(genre, on);
    if (!quiet) {
      toast(on ? `Listo: te aviso de ${genrePlural(genre)}.` : `Listo: no te aviso más de ${genrePlural(genre)}.`, 'ok', 3500,
        { label: 'Deshacer', run: () => void setGenreAlert(genre, !on, true) });
    }
  } catch {
    toast('No se pudo guardar. Probá de nuevo.', 'bad');
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days <= 0 ? 'Hoy' : days === 1 ? 'Ayer' : d.toLocaleDateString('es-AR', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  return `${day} · ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function Sheet({ profile, close, onChange }: { profile: { id: string; name: string }; close: () => void; onChange: (v: TasteView) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<TasteView | null>(null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const load = () => {
    setFailed(false);
    void pushEndpoint().then((ep) => loadTaste(profile.id, ep)).then((v) => { setView(v); onChange(v); }).catch(() => setFailed(true));
  };
  useEffect(load, []);
  const apply = (v: TasteView | null) => { if (v) { setView(v); onChange(v); } };
  const send = async (body: Record<string, unknown>) => {
    try {
      apply(await changeTaste(profile.id, { endpoint: await pushEndpoint(), ...body }));
    } catch {
      toast('No se pudo guardar. Probá de nuevo.', 'bad');
    }
  };
  const v = view;
  return (
    <dialog class="sheet settings-sheet" id="tasteDialog" ref={dlg} onClose={close} aria-labelledby="tasteTitle">
      <div class="sheet-body">
        <div class="title-row">
          <span class="title-left"><h2 id="tasteTitle">Avisos por gusto</h2></span>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <p class="help">{profile.name}</p>
        {!v && !failed && <div aria-busy="true" aria-label="Cargando los avisos por gusto"><Skeleton rows={2} /></div>}
        {!v && failed && (
          <>
            <p class="help">No se pudieron cargar los avisos por gusto.</p>
            <button type="button" class="btn btn-primary" onClick={load}><Icon name="refresh-cw" />Probar de nuevo</button>
          </>
        )}
        {v && (
          <>
            <h3 class="sec-title">Géneros que avisan</h3>
            {v.genres.length ? (
              <div class="filter-chips">
                {v.genres.map((g) => (
                  <button key={g.name} type="button" class="chip-btn" aria-pressed={g.on} onClick={() => {
                    void send({ genre: g.name, genreOn: !g.on });
                    // Apagar un género se deshace al momento, como «No avisarme de…» en la hoja del programa.
                    if (g.on) toast(`Listo: no te aviso más de ${genrePlural(g.name)}.`, 'ok', 3500, { label: 'Deshacer', run: () => void send({ genre: g.name, genreOn: true }) });
                  }}>{g.name}</button>
                ))}
              </div>
            ) : <p class="help">Todavía no hay un género que mire seguido.</p>}
            <p class="help">Automático: se eligen solos según lo que más mira este perfil. Tocá uno para cambiarlo. Publicidad y noticias nunca avisan.</p>
            <h3 class="sec-title">Cuándo</h3>
            <div class="segmented" role="group" aria-label="Cuándo avisar">
              {(['manana', 'tarde', 'noche'] as TasteWhen[]).map((w) => (
                <button key={w} type="button" aria-pressed={v.when === w} onClick={() => void send({ when: w })}>{WHEN_LABEL[w]}</button>
              ))}
            </div>
            <p class="help">De {WHEN_HOURS[v.when]} horas. Como mucho uno por día y tres por semana; nunca de madrugada.</p>
            <h3 class="sec-title">Últimos avisos</h3>
            {v.sent.length ? (
              <div class="menu">
                {v.sent.map((s) => {
                  const off = v.genres.some((g) => g.name === s.genre && !g.on);
                  return (
                    <div key={s.at} class="menu-row static">
                      <span class="menu-text">{s.title}<small>{when(s.at)} · {s.genre}</small></span>
                      <button type="button" class="chip-btn" disabled={off} onClick={() => void send({ genre: s.genre, genreOn: false })}>{off ? 'Apagado' : 'Menos así'}</button>
                    </div>
                  );
                })}
              </div>
            ) : <p class="help">Todavía no mandé ninguno. Cuando mande uno, lo ves acá.</p>}
          </>
        )}
      </div>
    </dialog>
  );
}

/** Abre la hoja de un perfil; `onChange` recibe su estado cada vez que cambia (para la fila de la página del perfil). */
export function openTasteSheet(profile: { id: string; name: string }, onChange: (v: TasteView) => void) {
  let host = document.getElementById('tasteHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tasteHost';
    document.body.appendChild(host);
  }
  const h = host;
  render(<Sheet key={`${profile.id}-${Date.now()}`} profile={profile} close={() => render(null, h)} onChange={onChange} />, h);
}
