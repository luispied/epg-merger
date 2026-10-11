// Piezas de la guía que comparten la lista de canales, la hoja de un canal y la de la selección (ver planes/react.md):
// el logo, lo que está dando ahora, una opción elegible, el buscador de guías y la programación del día.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  descFromHour, fold, GOOD, guideLabel, hasWords, hhmm, hourDescIndex, hourIndex, loadReminders, logosOn, nowFromHour,
  nowPlaying, remindKey, schedule, state, toggleReminder, type NowPlaying, type ScheduleEntry,
} from '../app.ts';
import { Icon } from './icon.tsx';
import { Progress } from './kit.tsx';
import { initials } from './mono.ts';

/** Sin imagen: las iniciales, en un tono neutro (no compiten con los logos). */
function Mono({ label }: { label: string }) {
  const ini = initials(label);
  if (!ini) return <Icon name="tv" />;
  return <span class="mono" aria-hidden="true">{ini}</span>;
}

/** El logo del canal (el propio, o el de la guía), sobre las iniciales mientras carga o si no hay. */
export function Logo({ id, custom, label }: { id: string | null; custom?: string; label?: string }) {
  const [ok, setOk] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = !logosOn() ? '' : custom || (id ? state.index?.icon.get(id) : '');
  return (
    <span class={`logo ${ok ? ' has-img' : ''}`}>
      <Mono label={label ?? (id ? guideLabel(id) : '')} />
      {url && !failed && <img src={url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
        onLoad={() => setOk(true)} onError={() => setFailed(true)} />}
    </span>
  );
}

/** Lo que está dando ahora un canal de la guía: `known` si ya se sabe (la búsqueda lo trae); si no, se pide.
 *  `undefined` mientras carga. */
function useNowPlaying(id: string, known?: NowPlaying | null): NowPlaying | null | undefined {
  const [cur, setCur] = useState<NowPlaying | null | undefined>(known);
  useEffect(() => {
    if (known !== undefined) return;
    let alive = true;
    void nowPlaying(id).then((c) => { if (alive) setCur(c); });
    return () => { alive = false; };
  }, [id]);
  return known !== undefined ? known : cur;
}

const nowText = (cur: NowPlaying | null) => (cur ? `Ahora: ${cur.title} · hasta ${hhmm(cur.stop)}` : 'Sin programación en este horario');

/** «Ahora: … · hasta …» en una línea (la guía asignada de la hoja del canal). */
export function NowLine({ id, cls }: { id: string; cls: string }) {
  const cur = useNowPlaying(id);
  return <div class={`${cls} epg-now${cur ? ' on-air' : ''}`}>{cur !== undefined && nowText(cur)}</div>;
}

/** Vista detallada de la lista: el programa y hasta cuándo, con una barra fina de cuánto va. */
export function RowNow({ id }: { id: string }) {
  const cur = useNowPlaying(id);
  const now = Date.now() / 1000;
  const pct = cur ? Math.max(0, Math.min(100, Math.round(((now - cur.start) / Math.max(1, cur.stop - cur.start)) * 100))) : 0;
  return (
    <div class="row-now"><span class={`epg-now${cur ? ' on-air' : ''}`}>
      {cur === undefined ? null : cur
        ? <><span class="np-line"><span class="np-title">{cur.title}</span><span class="np-until">hasta {hhmm(cur.stop)}</span></span><Progress cls="np-bar" value={pct} /></>
        : <span class="np-line"><span class="np-title">Sin programación en este horario</span></span>}
    </span></div>
  );
}

/** Opción elegible (con círculo, como una lista de selección): un solo toque elige esa guía. */
export function Candidate({ id, score, cur: known, note, home, onPick }: {
  id: string; score?: number; cur?: NowPlaying | null; note?: string; home?: string | null; onPick: (id: string) => void;
}) {
  const cur = useNowPlaying(id, known);
  const cc = state.index?.country.get(id);
  const isHome = !!home && cc?.toLowerCase() === home;
  return (
    <div class="pick-row opt" role="button" tabindex={0} data-pick={id} onClick={() => onPick(id)}
      onKeyDown={(ev) => { if (ev.key === 'Enter') onPick(id); }}>
      <span class="radio" aria-hidden="true" />
      <div class="opt-body"><div class="opt-top"><span class="opt-name">{guideLabel(id)}</span>
        {cc && <span class={`cc${isHome ? ' home' : ''}`} title={isHome ? 'Del país de la categoría' : undefined}>{cc.toUpperCase()}</span>}
        {score !== undefined && <span class={`pct ${score >= GOOD ? 'ok' : 'warn'}`}>{Math.round(Math.min(score, 1) * 100)} %</span>}</div>
        {known !== undefined
          ? <div class={`opt-now${known ? ' on-air' : ''}`}>{nowText(known)}{note && <> <span class="note">{note}</span></>}</div>
          : <div class={`opt-now epg-now${cur ? ' on-air' : ''}`}>{cur !== undefined && nowText(cur)}</div>}
      </div>
    </div>
  );
}

/** Scroll infinito: `more` cada vez que el centinela entra en pantalla (también si sigue a la vista después de cargar,
 *  para llenar pantallas altas, porque el efecto vuelve a observar cuando cambia `key`). */
function useInfiniteScroll(ref: { current: HTMLElement | null }, active: boolean, key: unknown, more: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active, key]);
}

const SEARCH_PAGE = 50;
interface Hit { id: string; cur: NowPlaying | null; byProgram: boolean }

/** Busca en toda la guía por nombre del canal y por lo que está dando ahora; primero los que tienen algo en el aire.
 *  `children` va entre el buscador y los resultados (los chips «Automática» y «Sin guía»). */
export function GuideSearch({ placeholder, label, onPick, children }: {
  placeholder: string; label: string; onPick: (id: string) => void; children?: ComponentChildren;
}) {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<{ hits: Hit[]; byHour: boolean } | null>(null);
  const [count, setCount] = useState(SEARCH_PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const q = fold(term.trim());
    if (q.length < 2) {
      setFound(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      const [idx, descs] = await Promise.all([hourIndex(), hourDescIndex()]);
      if (!alive) return;
      const hits: Hit[] = [];
      for (const [id, name] of state.index!.displayName) {
        const byName = hasWords(fold(name), q);
        const cur = idx ? nowFromHour(idx, id) : null;
        const byProgram = !!cur && hasWords(fold(`${cur.title} ${descs ? descFromHour(descs, idx!, id, cur) : ''}`), q);
        if (byName || byProgram) hits.push({ id, cur, byProgram });
      }
      if (idx) hits.sort((a, b) => Number(!a.cur) - Number(!b.cur));
      setCount(SEARCH_PAGE);
      setFound({ hits, byHour: !!idx });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [term]);
  const more = !!found && count < found.hits.length;
  useInfiniteScroll(sentinel, more, count, () => setCount((c) => c + SEARCH_PAGE));

  const n = found?.hits.length ?? 0;
  return (
    <>
      <label class="search-field"><Icon name="search" /><input type="search" class="catalog-search" placeholder={placeholder} enterkeyhint="search"
        aria-label={label} value={term} onInput={(ev) => setTerm(ev.currentTarget.value)} /></label>
      {children}
      <div class="list search-results" hidden={!found}>
        {found && <>
          <div class="list-note">{found.byHour ? `${n} resultado${n === 1 ? '' : 's'} · primero los que están dando algo ahora`
            : 'Programación por hora no disponible: se carga canal por canal.'}</div>
          {n ? found.hits.slice(0, count).map(({ id, cur, byProgram }) => (
            <Candidate key={id} id={id} cur={found.byHour ? cur : undefined} note={byProgram ? '· coincide con la búsqueda' : ''} onPick={onPick} />
          )) : <div class="list-note">Sin resultados</div>}
          <div class="load-sentinel" aria-hidden="true" ref={sentinel} hidden={!more} />
        </>}
      </div>
    </>
  );
}

/** «Ver programación de hoy»: lo que da el canal desde ahora hasta el final de la ventana publicada (~30 h), por día,
 *  con la campana para que avise cuando empiece. */
export function DayProgram({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ entries: ScheduleEntry[]; rem: Set<string> } | null>(null);
  const toggle = async () => {
    setOpen(!open);
    if (open || rows) return;
    const now = Date.now() / 1000;
    const entries = ((await schedule(id)) ?? []).filter(([, stop]) => stop > now);
    setRows({ entries, rem: entries.length ? (await loadReminders()).keys : new Set() });
  };
  return (
    <>
      <button type="button" class="link-btn day-btn" aria-expanded={open} onClick={toggle}>Ver programación de hoy<Icon name="chevron-right" class="sm" /></button>
      <div class="day-list" hidden={!open}>
        {!rows ? <div class="list-note">Cargando programación…</div>
          : !rows.entries.length ? <div class="list-note">La guía no trae programación para las próximas horas.</div>
          : <DayRows id={id} entries={rows.entries} rem={rows.rem} />}
      </div>
    </>
  );
}

function DayRows({ id, entries, rem }: { id: string; entries: ScheduleEntry[]; rem: Set<string> }) {
  const now = Date.now() / 1000;
  const dayName = (sec: number) => {
    const d = new Date(sec * 1000);
    if (d.toDateString() === new Date().toDateString()) return 'Hoy';
    if (d.toDateString() === new Date(Date.now() + 86400000).toDateString()) return 'Mañana';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric' });
  };
  let last = '';
  return (
    <>
      {entries.map(([start, stop, title, desc]) => {
        const day = dayName(start);
        const head = day !== last;
        last = day;
        const live = start <= now && now < stop;
        const on = rem.has(remindKey(id, start));
        return [
          head && <div key={`d${start}`} class="day-head">{day}</div>,
          <details key={start} class={`day-item${live ? ' live' : ''}`}><summary><span class="day-time">{hhmm(start)}</span>
            <span class="day-title">{title}{live && <> <span class="note">· ahora</span></>}</span>
            {start > now && (
              // Dentro del <summary>: no abre ni cierra la descripción. toggleReminder marca la campana.
              <button type="button" class={`remind-btn${on ? ' on' : ''}`} data-epg={id} data-start={start} data-title={title} aria-pressed={on}
                aria-label={`Avisarme cuando empiece: ${title}`} title="Avisarme" onClick={(ev) => {
                  ev.preventDefault();
                  void toggleReminder(ev.currentTarget, (document.getElementById('channelName') as HTMLInputElement).value);
                }}><Icon name="bell" /></button>
            )}</summary>
            <p>{desc || <span class="muted">Sin descripción.</span>}</p></details>,
        ];
      })}
    </>
  );
}
