// Modo «solo ver» (/ver#<código>): la grilla y la Guía de un perfil para otra persona (por ejemplo, alguien mayor que
// no quiere ni necesita tocar nada). Solo lee: GET /api/view/<código> devuelve los canales del perfil (nombre,
// categoría, guía y logo) y la programación sale de los mismos índices que usa la app. No hay claves de edición,
// cuentas ni links de reproducción en esta página, y no comparte código con app.ts (que arma el editor).
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './ui/icon.tsx';
import { ActiveFilters, FilterToggle, type FilterModel } from './ui/filtros.tsx';
import { BrandFoot, Progress, Skeleton } from './ui/kit.tsx';
import { installSheets } from './ui/sheet.ts';
import { placeTabPill } from './ui/tabbar.ts';
import { hideSplash } from './ui/splash.ts';
import { loadTopics, titleKey, type TopicSearch } from './ui/topics.ts';
import { Logo, MASKED, showGuide, type GuideChannel, type GuideHost } from './ui/guide.tsx';

declare global { interface Window { ICONS: Record<string, string> } }
Object.assign(window.ICONS, {
  // La flecha de volver de Tu noche y las de «Ahora» en la Guía (ui/guide.tsx); en el editor vienen de app.ts.
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  // Los íconos del tema, como en el editor (app.ts).
  'arrow-right-left': '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
});

interface ViewData { name: string; kids?: boolean; channels: { id: string; name: string; cat: string; epg: string | null; logo: string; quiet?: boolean }[] }
interface Conn { inUse?: number; max?: number; watching: { name: string; channel: string; t: string }[] }
interface HourIndex { h: number; t: string[]; c: Record<string, [number, number, number][]> }
type Entry = [number, number, string, string?];
/** `m`: en un perfil infantil, un programa que no es apto (el Worker lo manda sin título). */
interface Prog { s: number; e: number; t: string; m?: boolean }

const CODE_KEY = 'grilla_ver_code';
const THEME_KEY = 'grilla_theme';
// Los mismos tres íconos que el editor (ui/settings.tsx), en el mismo orden.
const THEMES = [
  { v: 'auto', label: 'Como el sistema', icon: 'monitor' },
  { v: 'light', label: 'Claro', icon: 'sun' },
  { v: 'dark', label: 'Oscuro', icon: 'moon' },
] as const;
type Theme = typeof THEMES[number]['v'];
/** El tema que tiene guardado el dispositivo: «auto» sigue al sistema; sin nada guardado, también (como el editor). */
function savedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'auto' || v === 'light' || v === 'dark') return v;
  } catch { /* sin storage */ }
  return 'auto';
}
const RE = /^[A-Za-z0-9_-]{20,32}$/;

/** El código va después del # (no llega a ningún servidor en los registros); si no está, el último que se abrió acá. */
function readCode(): string | null {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (RE.test(fromHash)) {
    try { localStorage.setItem(CODE_KEY, fromHash); } catch { /* sin storage */ }
    return fromHash;
  }
  try {
    const saved = localStorage.getItem(CODE_KEY);
    if (saved && RE.test(saved)) return saved;
  } catch { /* sin storage */ }
  return null;
}

const hm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const fold = (s: string) => s.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
const left = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `quedan ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `quedan ${m} min`;
};

// Índices por hora (lo que da toda la guía en esa hora) y el archivo de cada canal (con descripciones).
const hours = new Map<string, Promise<HourIndex | null>>();
// Con el código, solo los canales de su configuración (~20 KB por hora en vez de ~400 KB de toda la guía).
let hourPath = '/api/ui/schedule/hour';
function hourIndex(t: number): Promise<HourIndex | null> {
  const k = hourKey(t);
  if (!hours.has(k)) hours.set(k, fetch(`${hourPath}/${k}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return hours.get(k)!;
}
// Un perfil infantil baja la programación de cada canal por el Worker del código, que ya la filtra (kids.ts); la pública no.
let schedulePath = '/api/ui/schedule';
const files = new Map<string, Promise<Entry[] | null>>();
function schedule(epg: string): Promise<Entry[] | null> {
  if (!files.has(epg)) {
    files.set(epg, crypto.subtle.digest('SHA-1', new TextEncoder().encode(epg))
      .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16))
      .then((f) => fetch(`${schedulePath}/${f}.json`))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return files.get(epg)!;
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Lo que está dando y lo que sigue en cada canal, con los índices de esta hora y la siguiente. */
function useNowNext(now: number): Map<string, { cur?: Prog; next?: Prog }> | null {
  const h = Math.floor(now / 3600) * 3600;
  const [map, setMap] = useState<Map<string, { cur?: Prog; next?: Prog }> | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([hourIndex(h), hourIndex(h + 3600)]).then((idx) => {
      if (!alive) return;
      const out = new Map<string, { cur?: Prog; next?: Prog }>();
      for (const ix of idx) {
        if (!ix) continue;
        for (const [epg, list] of Object.entries(ix.c)) {
          for (const [s, e, t] of list) {
            const p: Prog = ix.t[t] ? { s: ix.h + s * 60, e: ix.h + e * 60, t: ix.t[t] } : { s: ix.h + s * 60, e: ix.h + e * 60, t: MASKED, m: true };
            const o = out.get(epg) ?? {};
            if (p.s <= now && now < p.e) o.cur = p;
            else if (p.s >= now && (!o.next || p.s < o.next.s)) o.next = p;
            out.set(epg, o);
          }
        }
      }
      setMap(out);
    });
    return () => { alive = false; };
  }, [h, Math.floor(now / 300)]);
  return map;
}

function Row({ ch, info, now, open }: { ch: GuideChannel; info?: { cur?: Prog; next?: Prog }; now: number; open: () => void }) {
  const cur = info?.cur;
  const pct = cur ? Math.round(((now - cur.s) / (cur.e - cur.s)) * 100) : 0;
  return (
    <button type="button" class="vw-row" onClick={open} aria-label={`${ch.name}${cur ? `: ahora ${cur.t}` : ''}`}>
      <Logo ch={ch} cls="lg" />
      <span class="vw-body">
        <span class="vw-name">{ch.name}</span>
        {cur?.m ? (
          <span class="vw-when">{MASKED}</span>
        ) : cur ? (
          <>
            <span class="vw-now">{cur.t}</span>
            <Progress cls="vw-bar" value={pct} />
            <span class="vw-when vw-left">{left(cur.e - now)[0].toUpperCase() + left(cur.e - now).slice(1)} · hasta las {hm(cur.e)}</span>
            {info?.next && <span class="vw-when vw-next">Después: {info.next.m ? MASKED : info.next.t}</span>}
          </>
        ) : (
          <span class="vw-when">{ch.epg ? (info === undefined ? 'Cargando…' : 'Sin programación ahora') : 'Sin guía'}</span>
        )}
      </span>
      <Icon name="chevron-right" class="vw-chev" />
    </button>
  );
}

const since = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? 'recién' : min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
};

/** Conexiones en uso de la cuenta (lo que dice el proveedor) y qué está mirando cada link. Se pide cada minuto. */
function Connections({ code }: { code: string }) {
  const [c, setC] = useState<Conn | null>(null);
  useEffect(() => {
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(`/api/view/${code}/connections`).then((r) => (r.ok ? r.json() : null)).then((v) => v && setC(v)).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    document.addEventListener('visibilitychange', load);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, []);
  const [open, setOpen] = useState(false);
  if (!c || (c.inUse === undefined && !c.watching.length)) return null;
  const full = c.max && (c.inUse ?? 0) >= c.max;
  // Como en la cuenta del editor: «N de M · Conexiones en uso»; tocarlo despliega qué mira cada link.
  return (
    <section class={`vw-conn${open ? ' open' : ''}`} aria-label="Conexiones">
      <button type="button" class="vw-conn-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`vw-conn-n${full ? ' warn' : ''}`}>{c.inUse ?? c.watching.length}{c.max ? ` de ${c.max}` : ''}</span>
        <span class="vw-conn-t">{c.inUse === undefined ? 'Mirando ahora' : 'Conexiones en uso'}</span>
        <Icon name="chevron-down" class="vw-conn-chev" />
      </button>
      {open && (
        <div class="vw-conn-list">
          {full ? <p class="vw-conn-note">Están todas ocupadas.</p> : null}
          {c.watching.length ? c.watching.map((w) => (
            <div class="vw-conn-row" key={w.name + w.t}>
              <span class="conn-dot on" aria-hidden="true" />
              <span class="vw-conn-who"><strong>{w.name}</strong><small>{w.channel} · {since(w.t)}</small></span>
            </div>
          )) : <p class="vw-conn-note">Nadie está mirando ahora.</p>}
        </div>
      )}
    </section>
  );
}

/** La hoja de un canal: lo que da ahora (con su descripción) y lo que viene, y avisar si la guía no coincide. */
function ChannelSheet({ ch, id, code, now, close }: { ch: GuideChannel; id: string; code: string; now: number; close: () => void }) {
  const [sent, setSent] = useState<'' | 'busy' | 'ok' | 'bad'>('');
  const dlg = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<Entry[] | null | undefined>(ch.epg ? undefined : null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  useEffect(() => { if (ch.epg) schedule(ch.epg).then(setEntries); }, []);
  const cur = entries?.find(([s, e]) => s <= now && now < e);
  const hidden = !!cur && !cur[2]; // perfil infantil: lo que da ahora no es apto
  const later = (entries ?? []).filter(([s]) => s > now).slice(0, 8);
  return (
    <dialog class="sheet settings-sheet gd-sheet vw-sheet" ref={dlg} onClose={close} aria-label={ch.name}>
      <div class="sheet-body">
        <div class="title-row">
          <div class="gd-sh-ch"><Logo ch={ch} cls="lg" /><div><strong>{ch.name}</strong><small>{ch.cat}</small></div></div>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        {entries === undefined && <p class="gd-sh-desc muted">Cargando…</p>}
        {entries === null && <p class="gd-sh-desc muted">Este canal no tiene programación.</p>}
        {cur && (
          <>
            <p class="vw-k">Ahora</p>
            <h2 class="gd-sh-title">{hidden ? MASKED : cur[2]}</h2>
            <p class="gd-sh-when">{hm(cur[0])} – {hm(cur[1])} · {left(cur[1] - now)}</p>
            <Progress cls="np-bar gd-sh-bar" value={((now - cur[0]) / (cur[1] - cur[0])) * 100} />
            {cur[3] && !hidden && <p class="gd-sh-desc">{cur[3]}</p>}
          </>
        )}
        {entries && !cur && <p class="gd-sh-desc muted">No hay nada anunciado para este momento.</p>}
        <div class="vw-report">
          {sent === 'ok' ? <p class="vw-report-ok"><Icon name="check" />Listo, le avisamos a quien arma la grilla.</p> : (
            <button type="button" class="btn btn-gray btn-block" disabled={sent === 'busy'} onClick={() => {
              setSent('busy');
              fetch(`/api/view/${code}/report`, { method: 'POST', body: JSON.stringify({ id, title: cur?.[2] ?? '' }) })
                .then((r) => setSent(r.ok ? 'ok' : 'bad')).catch(() => setSent('bad'));
            }}><Icon name="triangle-alert" />Lo que dan en la tele no es esto</button>
          )}
          {sent === 'bad' && <p class="vw-report-bad">No se pudo avisar. Probá de nuevo en un rato.</p>}
        </div>
        {later.length > 0 && (
          <div class="gd-sh-next">
            <h3>Más tarde</h3>
            {later.map(([s, , t]) => <div key={s} class="gd-sh-row"><b>{hm(s)}</b><span>{t || MASKED}</span></div>)}
          </div>
        )}
      </div>
    </dialog>
  );
}

/** Configuración de este dispositivo: la misma hoja y la misma fila de Tema que en el editor (ui/settings.tsx). */
function SettingsSheet({ close, leave }: { close: () => void; leave: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const pick = (t: Theme) => {
    setTheme(t);
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* sin storage: vale por esta vez */ }
  };
  return (
    <dialog class="sheet settings-sheet" ref={dlg} onClose={close} aria-labelledby="vwSetTitle">
      <div class="sheet-body">
        <div class="title-row">
          <span class="title-left"><h2 id="vwSetTitle">Configuración</h2></span>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <h3 class="sec-title">Preferencias</h3>
        <div class="menu">
          <div class="menu-row static">
            <span class="menu-icon"><Icon name="sun-moon" /></span>
            <span class="menu-text">Tema</span>
            <div class="seg" role="radiogroup" aria-label="Tema">
              {THEMES.map((t) => (
                <button key={t.v} type="button" role="radio" aria-checked={theme === t.v} aria-label={t.label} title={t.label}
                  onClick={() => pick(t.v)}><Icon name={t.icon} /></button>
              ))}
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-tonal btn-block vw-leave" onClick={leave}><Icon name="key-round" />Salir del modo ver</button>
        <p class="help">Para salir hace falta el código de la casa.</p>
      </div>
    </dialog>
  );
}

/** La ayuda del modo ver: corta, con letra grande y en el orden en que se descubre la app. */
function HelpSheet({ close }: { close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  return (
    <dialog class="sheet help-sheet vw-help" ref={dlg} onClose={close} aria-labelledby="vwHelpTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="vwHelpTitle">Cómo se usa</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <p>Acá ves los canales que te preparó otra persona y qué dan en cada uno. No se puede cambiar ni romper nada: tocá tranquilo. Al abrir, el logo de nowline se ve un instante mientras cargan los canales.</p>
        <details open>
          <summary>Canales<Icon name="chevron-down" /></summary>
          <p>Cada canal muestra lo que dan <b>ahora</b>, cuánto le queda y hasta qué hora (la barra <b>verde</b> es cuánto va), y lo que viene <b>después</b>. Tocalo para leer de qué se trata y ver lo que dan más tarde; para cerrar, tocá la <b>✕</b> o bajá la hoja con el dedo.</p>
          <p>Arriba podés <b>buscar</b> un canal o un programa: escribí «noticias», el nombre de un equipo o un tema («Mundial», «cocina»): también aparecen los canales que dan algo de eso ahora, aunque el título no lo diga. Al lado de la búsqueda, el botón <span class="inline-icon"><Icon name="list-filter" /></span> <b>filtra por categoría</b>: elegís una o más y quedan arriba como chips; tocá la <b>×</b> de cada uno para quitarlo.</p>
        </details>
        <details>
          <summary>Conexiones en uso<Icon name="chevron-down" /></summary>
          <p>«2 de 3 · Conexiones en uso» dice cuántas pantallas están mirando con esta cuenta y cuántas permite. Si están todas ocupadas, otra tele no va a poder abrir un canal. Tocalo para ver quién está mirando y qué canal.</p>
        </details>
        <details>
          <summary>Guía<Icon name="chevron-down" /></summary>
          <p>Abajo (en una pantalla grande, a la izquierda), <b>Guía</b> muestra la programación como en la tele. Arriba, al lado del título, elegís <b>Grilla</b> (canales y horas: deslizá de costado para ver más tarde; un programa muy corto es una franja angosta sin texto, tocala para ver cuál es) o <b>Próximos</b> (lo que empieza pronto). La tarjeta <b>Tu noche, armada para vos</b> (de día, tu mañana o tu tarde) abre lo mejor de tus canales para lo que queda de ese rato; la flecha de arriba te devuelve.</p>
          <p>El botón <span class="inline-icon"><Icon name="list-filter" /></span> de arriba, al lado de Grilla y Próximos (y en tu plan), abre la hoja para elegir <b>categorías</b> y <b>géneros</b> (Cine, Deportes, Infantil…): tocá uno o varios y quedan debajo del título como chips; la <b>×</b> de cada uno lo quita, o <b>Quitar todos</b>. En la Grilla solo quedan los canales que tienen algo de ese género en las horas que se ven (lo demás se apaga), en Próximos se saca y tu plan se arma solo con ese género; lo que todavía no tiene género no entra mientras haya uno elegido.</p>
                    <p>Tu plan también sube programas parecidos a lo que mirás, según el género («Como lo que mirás: deportes»), aunque sean de un canal que nunca abriste. La publicidad nunca se sugiere.</p>
          <p>Tocá un programa para leer de qué se trata; arriba del título dice su género cuando lo sabemos. Con <b>No me interesa</b> no aparece más en tu plan y con <b>Más como esto</b> te sugiere más parecidos y también lo de su mismo género; tocándolos otra vez se deshacen.</p>
        </details>
        <details>
          <summary>Configuración<Icon name="chevron-down" /></summary>
          <p>Tocá el engranaje, arriba a la derecha de Canales, y en <b>Configuración</b> elegí el <b>tema</b>: como el sistema, claro u oscuro. Queda guardado en este dispositivo.</p>
          <p>El modo ver no manda avisos ni tiene campana: eso es de quien arma la grilla. Los <b>avisos por gusto</b> («esta noche dan un documental») se prenden en la edición, en Configuración; acá, <b>Tu noche</b> te muestra lo mismo, con el porqué de cada sugerencia.</p>
          <p>Más abajo, en la misma hoja, está <b>Salir del modo ver</b>.</p>
        </details>
        <details>
          <summary>Perfil infantil<Icon name="chevron-down" /></summary>
          <p>Si este perfil es infantil, solo se ven programas aptos para chicos: lo demás dice <b>No disponible en este perfil</b>, con su horario, en los canales, en la Guía y en Tu plan, y no aparece en la búsqueda ni en Próximos. Quien armó la grilla elige qué géneros entran. Lo que todavía no se clasificó tampoco se muestra, así que al principio se ve poco y se va completando. Para cambiarlo hace falta la clave de edición, que este modo no tiene.</p>
        </details>
        <details>
          <summary>¿En la tele dan otra cosa?<Icon name="chevron-down" /></summary>
          <p>Abrí el canal y tocá <b>Lo que dan en la tele no es esto</b>. Le llega un aviso a quien arma tu grilla para que lo arregle.</p>
        </details>
        <details>
          <summary>Salir del modo ver<Icon name="chevron-down" /></summary>
          <p>Esta app abre siempre así. La de editar, si la tenés instalada aparte, sigue como siempre. Para salir, tocá el engranaje de Canales y después <b>Salir del modo ver</b> (también está al final de la lista de canales). Hace falta el <b>código de la casa</b>, el que usa quien arma la grilla.</p>
        </details>
      </div>
    </dialog>
  );
}

function Channels({ code, data, channels, onOpen, onHelp, onSettings, onLeave }: { code: string; data: ViewData; channels: GuideChannel[]; onOpen: (ch: GuideChannel) => void; onHelp: () => void; onSettings: () => void; onLeave: () => void }) {
  const now = useNow();
  const info = useNowNext(now);
  const [q, setQ] = useState('');
  // Las categorías que se ofrecen son las de los canales que ve este perfil (ya vienen sin las ocultas): mismo filtro que en la edición.
  const [cats, setCats] = useState<string[]>([]);
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of channels) m.set(c.cat, (m.get(c.cat) ?? 0) + 1);
    return [...m].map(([key, count]) => ({ key, label: key, count }));
  }, [channels]);
  const picked = cats.filter((c) => categories.some((x) => x.key === c));
  const model: FilterModel = { filter: 'todos', cats: picked, states: [], categories };
  // Género y temas del programa (se bajan la primera vez que se busca): «mundial» encuentra un partido sin decirlo.
  const [topics, setTopics] = useState<TopicSearch | null>(null);
  const searching = !!q.trim();
  useEffect(() => { if (searching && !data.kids) loadTopics().then((t) => t && setTopics(t)); }, [searching, data.kids]);
  const shown = useMemo(() => {
    const inCats = picked.length ? channels.filter((c) => picked.includes(c.cat)) : channels;
    const f = fold(q.trim());
    if (!f) return inCats;
    return inCats.filter((c) => fold(c.name).includes(f) || fold(c.cat).includes(f)
      || (c.epg && info?.get(c.epg)?.cur && !info.get(c.epg)!.cur!.m && (fold(info.get(c.epg)!.cur!.t).includes(f)
        || !!topics?.match(f).has(titleKey(info.get(c.epg)!.cur!.t)))));
  }, [q, channels, info, topics, picked.join('|')]);
  const out = [];
  let last = '';
  for (const ch of shown) {
    if (!q.trim() && ch.cat !== last) {
      out.push(<h2 key={`c:${ch.cat}`} class="vw-cat">{ch.cat}</h2>);
      last = ch.cat;
    }
    out.push(<Row key={ch.i} ch={ch} now={now} info={ch.epg ? (info ? info.get(ch.epg) ?? {} : undefined) : {}} open={() => onOpen(ch)} />);
  }
  return (
    <>
      <header class="app-header vw-head">
        <div class="title-row">
          <span class="title-left">
            <h1>Canales</h1>
            <button type="button" class="icon-btn help-btn" aria-label="Cómo se usa" title="Cómo se usa" onClick={onHelp}><Icon name="circle-help" /></button>
          </span>
          <span class="vw-head-r">
            <button type="button" class="icon-btn" aria-label="Configuración" title="Configuración" onClick={onSettings}><Icon name="settings" /></button>
            <span class="vw-who"><Icon name="eye" class="sm" />{data.name}</span>
          </span>
        </div>
      </header>
      <div class="vw-search">
        <div class="toolbar-row">
          <label class="search-field">
            <Icon name="search" />
            <input type="search" placeholder="Buscar canal o programa" enterkeyhint="search" aria-label="Buscar canal o programa"
              value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
          </label>
          {categories.length > 1 && <FilterToggle model={model} handlers={{ onState: () => {}, onCats: setCats }} />}
        </div>
        {picked.length > 0 && <div class="active-filters"><ActiveFilters model={model} handlers={{ onState: () => {}, onCats: setCats }} /></div>}
      </div>
      <main class="vw-list">
        {!q.trim() && <Connections code={code} />}
        {out.length ? out : <div class="empty"><Icon name="inbox" class="lg" /><strong>Nada por acá</strong>{q ? `Nada coincide con “${q}”.` : 'Este perfil no tiene canales.'}</div>}
        <BrandFoot />
        <p class="vw-foot">Modo «solo ver»: acá no se puede cambiar nada.
          <button type="button" class="link-btn" onClick={onLeave}>Salir del modo ver</button></p>
      </main>
    </>
  );
}

const HOME_RE = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{20,})$/;
/** ¿El código es el de la casa (el que deja editar)? Pregunta al Worker con su clave, que no cambia nada. */
async function isHomeCode(code: string): Promise<boolean> {
  const m = HOME_RE.exec(code.trim());
  if (!m) return false;
  try {
    const r = await fetch(`/api/home/${m[1]}`, { headers: { Authorization: `Bearer ${m[2]}` } });
    return r.ok;
  } catch { return false; }
}

/** Salir del modo ver pide el código de la casa: la misma hoja que «Pegar un código» en el editor (ask-sheet). */
function UnlockSheet({ close }: { close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'bad'>('idle');
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const submit = async (e: Event) => {
    e.preventDefault();
    setState('busy');
    if (!(await isHomeCode(code))) return setState('bad');
    // Con el código de la casa se sale: se borra el código para ver y se abre el inicio de nowline (el editor).
    try { localStorage.removeItem(CODE_KEY); } catch { /* sin storage */ }
    location.href = '/';
  };
  return (
    <dialog class="sheet ask-sheet" ref={dlg} onClose={close} aria-labelledby="vwUnlockTitle">
      <form class="sheet-body" onSubmit={submit}>
        <div class="title-row">
          <h2 id="vwUnlockTitle">Salir del modo ver</h2>
          <button type="button" class="icon-btn" aria-label="Cerrar" onClick={() => dlg.current?.close()}><Icon name="x" /></button>
        </div>
        <p>Para salir hace falta el código de la casa, el que usa quien arma la grilla. Sin ese código, este dispositivo sigue en modo «solo ver».</p>
        <label class="ch-field"><Icon name="arrow-right-left" />
          <input class="input" autocomplete="off" enterkeyhint="done" aria-label="Código de la casa" placeholder="Código de la casa" value={code}
            onInput={(e) => { setCode((e.currentTarget as HTMLInputElement).value); setState('idle'); }} />
          <button class="icon-btn" type="submit" aria-label="Salir del modo ver" disabled={!code.trim() || state === 'busy'}><Icon name="check" /></button>
        </label>
        {state === 'bad' && <p class="help" role="alert">Ese código no es el de la casa.</p>}
      </form>
    </dialog>
  );
}

function Problem({ title, text, retry, other }: { title: string; text: string; retry?: () => void; other?: () => void }) {
  return (
    <main class="vw-problem">
      <img src="img/icon.svg" alt="" width="64" height="64" />
      <h1>{title}</h1>
      <p>{text}</p>
      {retry && <button type="button" class="btn btn-primary" onClick={retry}><Icon name="refresh-cw" />Probar de nuevo</button>}
      {other && <button type="button" class="btn btn-primary" onClick={other}>Salir del modo ver</button>}
    </main>
  );
}

function App() {
  const code = useMemo(readCode, []);
  // El manifest de esta PWA lleva el código: «Agregar a inicio» abre iOS como una app (la misma ventana que la del editor) y el
  // ícono vuelve acá. Sin manifest, iOS la abre en un modo viejo y la barra de abajo queda más arriba que en la edición.
  useEffect(() => {
    if (!code || document.querySelector('link[rel="manifest"]')) return;
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = `/ver-app/${encodeURIComponent(code)}.webmanifest`;
    document.head.append(link);
  }, [code]);
  if (code) hourPath = `/api/view/${code}/hour`;
  const [data, setData] = useState<ViewData | null>(null);
  if (code && data?.kids) schedulePath = `/api/view/${code}/schedule`;
  const [err, setErr] = useState<{ status: number } | null>(null);
  const [tab, setTab] = useState<'canales' | 'guia'>('canales');
  const [open, setOpen] = useState<GuideChannel | null>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const guideEl = useRef<HTMLElement>(null);

  const load = () => {
    if (!code) return;
    setErr(null);
    // Con un tiempo máximo: el logo se queda mientras carga, así que una conexión colgada tiene que terminar en un aviso.
    fetch(`/api/view/${code}`, { signal: AbortSignal.timeout(15_000) })
      .then(async (r) => {
        if (!r.ok) return setErr({ status: r.status });
        setData(await r.json() as ViewData);
      })
      .catch(() => setErr({ status: 0 }));
  };
  useEffect(() => {
    load();
    // Los canales cambian poco: se vuelven a pedir cada media hora y al volver a la app.
    const t = setInterval(load, 30 * 60_000);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);

  const channels = useMemo<GuideChannel[]>(() => (data?.channels ?? []).map((c, i) => ({ i, name: c.name, cat: c.cat, epg: c.epg, logo: c.logo, quiet: !!c.quiet, q: null, qTitle: '' })), [data]);
  const host = useMemo<GuideHost>(() => ({
    viewer: true,
    channels: () => channels,
    openChannel: (i) => setOpen(channels[i] ?? null),
    schedule,
    reminders: async () => null,
    toggleReminder: () => {},
    habits: () => fetch(`/api/view/${code}/habits`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    feedback: async (title, kind, genre) => {
      const r = await fetch(`/api/view/${code}/habits`, { method: 'POST', body: JSON.stringify({ title, kind, genre }) });
      if (!r.ok) throw new Error('no se pudo guardar');
      return r.json();
    },
    help: () => setHelp(true),
    hourPath: code ? `/api/view/${code}/hour` : undefined,
  }), [channels]);

  useEffect(() => {
    if (tab === 'guia' && guideEl.current) showGuide(guideEl.current, host);
  }, [tab, host]);

  // El logo de inicio se va apenas la pantalla dibuja, igual que en la edición: el esqueleto ya es la pantalla.
  useEffect(() => { hideSplash(); }, []);

  if (!code) return <>
    <Problem title="Falta el código" text="Este dispositivo está en modo «solo ver», pero no tiene el código guardado." other={() => setUnlock(true)} />
    {unlock && <UnlockSheet close={() => setUnlock(false)} />}
  </>;
  if (err?.status === 404) return <>
    <Problem title="Este código ya no funciona" text="Pedile uno nuevo a quien te lo pasó." other={() => setUnlock(true)} />
    {unlock && <UnlockSheet close={() => setUnlock(false)} />}
  </>;
  if (err?.status === 409) return <Problem title="Todavía no hay canales" text="Probá de nuevo en un rato." retry={load} />;
  if (err && !data) return <Problem title="No se pudo cargar" text={err.status ? 'Algo falló del otro lado. Probá de nuevo.' : 'Revisá la conexión a internet.'} retry={load} other={() => setUnlock(true)} />;
  if (!data) return <main class="vw-skel" aria-busy="true" aria-label="Cargando los canales"><Skeleton /></main>;

  return (
    <>
      <section data-under={tab !== 'canales' ? '' : undefined} inert={tab !== 'canales'}><Channels code={code!} data={data} channels={channels} onOpen={setOpen} onHelp={() => setHelp(true)} onSettings={() => setSettings(true)} onLeave={() => setUnlock(true)} /></section>
      <section id="guide" aria-label="Guía" ref={guideEl} hidden={tab !== 'guia'} />
      <nav class="tabbar vw-tabbar" aria-label="Secciones" ref={(el) => { if (el) placeTabPill(el); }}>
        <img class="tab-brand" src="img/icon.svg" alt="nowline" width="40" height="40" />
        <span class="tab-pill" aria-hidden="true" />
        <button type="button" class={`tab${tab === 'canales' ? ' active' : ''}`} aria-current={tab === 'canales' ? 'page' : undefined} onClick={() => setTab('canales')}>
          <Icon name="tv" /><span>Canales</span>
        </button>
        <button type="button" class={`tab${tab === 'guia' ? ' active' : ''}`} aria-current={tab === 'guia' ? 'page' : undefined} onClick={() => setTab('guia')}>
          <Icon name="layout-grid" /><span>Guía</span>
        </button>
      </nav>
      {help && <HelpSheet close={() => setHelp(false)} />}
      {settings && <SettingsSheet close={() => setSettings(false)} leave={() => { setSettings(false); setUnlock(true); }} />}
      {unlock && <UnlockSheet close={() => setUnlock(false)} />}
      {open && <ChannelSheet key={open.i} ch={open} id={data.channels[open.i]?.id ?? ''} code={code!} now={Math.floor(Date.now() / 1000)} close={() => setOpen(null)} />}
    </>
  );
}

installSheets();
render(<App />, document.getElementById('app')!);
