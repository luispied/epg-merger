// La Guía: grilla de canales × hora, como la de TiviMate (ver planes/react.md). Primera pantalla
// hecha en Preact. Lee la programación de los índices por hora que publica la corrida diaria
// (ui/schedule/hour/<AAAAMMDDHH>.json, con TODA la guía) y baja solo las horas que se ven.
// Se virtualiza en los dos ejes: solo se pintan las filas y los programas que entran en pantalla.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';
import { Progress } from './kit.tsx';
import { initials } from './mono.ts';
import { toast } from './toast.tsx';

export interface GuideChannel {
  i: number; // índice en la lista de canales de app.ts
  name: string;
  cat: string;
  epg: string | null;
  logo: string;
  /** Sin guía a propósito (o categoría «Sin guía»): el hueco se ve neutro, no como algo para arreglar. */
  quiet: boolean;
  /** Resolución real medida (SD, HD, FHD, 4K) y su detalle; sin medir, null. */
  q: string | null;
  qTitle: string;
}
/** [inicio, fin, título, descripción?, género?]: el género sale de la IA cuando ya clasificó el título. */
type Entry = [number, number, string, string?, string?];
export interface GuideHost {
  channels(): GuideChannel[];
  openChannel(i: number): void;
  /** El archivo del canal (con descripciones) de la ventana publicada. */
  schedule(epg: string): Promise<Entry[] | null>;
  reminders(): Promise<Set<string> | null>;
  toggleReminder(btn: HTMLElement, channel: string): void;
  /** Lo que se suele mirar (habits.ts del Worker), para «Tu noche». */
  habits?(): Promise<Habits | null>;
  /** «No me interesa», «Más como esto» o deshacer, para un título: devuelve los hábitos al día. */
  feedback?(title: string, kind: Feedback): Promise<Habits | null>;
  /** La ayuda de la Guía (el ? del título). */
  help?(): void;
  /** Modo «solo ver» (ver.tsx): sin avisos ni nada que lleve a editar. */
  viewer?: boolean;
  /** De dónde bajar el índice de cada hora con solo estos canales (/api/cfg/<id>/hour o /api/view/<código>/hour);
   *  sin esto, el de toda la guía. */
  hourPath?: string;
}
export type Feedback = 'no' | 'more' | 'clear';
/** Por epg: veces que se abrió el canal y por hora UTC; por título normalizado: emisiones vistas; y los pedidos. */
export interface Habits {
  ch: Record<string, { n: number; h: number[] }>;
  t: Record<string, { n: number; g?: string }>;
  no: Record<string, string>;
  more: Record<string, string>;
}

interface HourIndex { h: number; t: string[]; c: Record<string, [number, number, number][]> }
interface Prog { s: number; e: number; t: string; g?: string; gap?: boolean }

type Mode = 'grid' | 'next' | 'plan';
const HOUR = 3600;
const SLOT = 1800;
const SPAN_H = 30; // la guía publicada llega ~30 h adelante
const RULER = 32;
const CAT_H = 30;
const MIN_GAP = 10 * 60;
const TINY = 52; // px: una celda más angosta va sin texto

const hm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const left = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `quedan ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `quedan ${m} min`;
};
const dur = (sec: number) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`;
};
const startsIn = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `dentro de ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `dentro de ${m} min`;
};
const dayLabel = (t: number, now: number) => {
  const d = new Date(t * 1000);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now * 1000).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? 'Hoy' : days === 1 ? 'Mañana' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }).replace('.', '');
};

// Índices por hora, compartidos entre aperturas de la Guía (cada uno pesa ~350 KB comprimido).
const hours = new Map<number, HourIndex | null | 'loading'>();
let hourPath = '/api/ui/schedule/hour';

// «Llegás desde el principio»: el Worker dice qué vuelve a empezar más tarde, en el mismo canal o en
// otro de la lista (POST /api/ui/again). Clave `${guía}|${inicio}` → las próximas emisiones.
interface Airing { epg: string; s: number }
type AgainMap = Map<string, Airing[]>;
let againMemo: { key: string; at: number; data: Promise<AgainMap> } | null = null;
const AGAIN_TTL = 15 * 60_000;
const AGAIN_AFTER = 10 * 60; // el ↻ aparece cuando ya te perdiste un rato

function loadAgain(epgs: string[]): Promise<AgainMap> {
  const ids = [...new Set(epgs)].sort().slice(0, 400);
  const key = ids.join(',');
  if (againMemo && againMemo.key === key && Date.now() - againMemo.at < AGAIN_TTL) return againMemo.data;
  const data = !ids.length ? Promise.resolve(new Map()) : fetch('/api/ui/again', { method: 'POST', body: JSON.stringify({ ids }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((res: { ids: string[]; r: [number, number, [number, number][]][] } | null) => {
      const map: AgainMap = new Map();
      // Una misma emisión puede venir más de una vez (la guía trae dos títulos a la misma hora): se juntan, sin repetir,
      // y quedan en orden para que el ↻ muestre la repetición más cercana.
      for (const [i, s, later] of res?.r ?? []) {
        const key = `${res!.ids[i]}|${s}`;
        const all = [...map.get(key) ?? [], ...later.map(([j, s2]) => ({ epg: res!.ids[j], s: s2 }))];
        map.set(key, all.filter((a, k) => all.findIndex((b) => b.epg === a.epg && b.s === a.s) === k).sort((a, b) => a.s - b.s));
      }
      return map;
    })
    .catch(() => new Map());
  againMemo = { key, at: Date.now(), data };
  return data;
}

/** Baja (una vez) los índices de las horas que tocan [from, to) y avisa con `done` al llegar cada uno. */
function loadHours(from: number, to: number, done: () => void) {
  for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
    if (hours.has(h)) continue;
    hours.set(h, 'loading');
    fetch(`${hourPath}/${hourKey(h)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((idx: HourIndex | null) => { hours.set(h, idx); done(); });
  }
}

const fold = (t: string) => t.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** «Deportes», «Deportes y Películas», «Deportes, Cine y Series»; más de tres, «4 categorías». */
export function catsLabel(cats: string[]): string {
  if (cats.length > 3) return `${cats.length} categorías`;
  return cats.length > 1 ? `${cats.slice(0, -1).join(', ')} y ${cats.at(-1)}` : cats[0] ?? '';
}
// Con pocas categorías van todas en la fila; con más, las elegidas, las que más canales con guía tienen y «Más».
const MANY_CATS = 8;
const QUICK_CATS = 5;

// Preferencias de la Guía en este navegador (modo, rato libre y categorías); sin almacenamiento, los valores por defecto.
const pref = {
  get(k: string) { try { return localStorage.getItem(`grilla_guide_${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`grilla_guide_${k}`, v); } catch { /* sin almacenamiento */ } },
};
function savedCats(): string[] {
  try {
    const v = JSON.parse(pref.get('cats') || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Logo({ ch, cls = '' }: { ch: GuideChannel; cls?: string }) {
  const [ok, setOk] = useState(false);
  const ini = initials(ch.name);
  return (
    <span class={`logo ${cls}${ok ? ' has-img' : ''}`}>
      <span class="mono" aria-hidden="true">{ini || '·'}</span>
      {ch.logo && <img src={ch.logo} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onLoad={() => setOk(true)} />}
    </span>
  );
}

function Guide({ channels, host }: { channels: GuideChannel[]; host: GuideHost }) {
  const wide = matchMedia('(min-width: 900px)').matches;
  const PX = wide ? 6 : 3.6; // px por minuto
  const CHW = wide ? 184 : 76;
  const ROWH = wide ? 64 : 58;
  const now = useNow();
  const [t0] = useState(() => Math.floor((Date.now() / 1000 - HOUR) / SLOT) * SLOT);
  const t1 = t0 + SPAN_H * HOUR;
  const W = ((t1 - t0) / 60) * PX;
  const x = (t: number) => ((t - t0) / 60) * PX;

  const [mode, setModeState] = useState<Mode>(() => {
    const m = pref.get('mode');
    return m === 'next' || m === 'plan' ? m : 'grid';
  });
  const setMode = (m: Mode) => { setModeState(m); pref.set('mode', m); if (m !== 'plan') pref.set('base', m); };
  // Tu noche (el plan) se abre como una página propia desde su tarjeta; la flecha vuelve a la vista de antes (Grilla o Próximos).
  const base: Mode = mode !== 'plan' ? mode : pref.get('base') === 'next' ? 'next' : 'grid';
  const part = partOfDay(now);
  const partName = `Tu ${part.name}`;
  const [budgetOn, setBudgetOn] = useState(false);
  const [budget, setBudget] = useState(() => Math.min(360, Math.max(20, Number(pref.get('budget')) || 75)));
  const [view, setView] = useState({ x: 0, y: 0, w: 390, h: 700 });
  const [ver, setVer] = useState(0);
  const [open, setOpen] = useState<{ ch: GuideChannel; p: Prog } | null>(null);
  const [again, setAgain] = useState<AgainMap>(() => new Map());
  const [habits, setHabits] = useState<Habits | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { host.habits?.().then(setHabits).catch(() => {}); }, []);
  useEffect(() => { loadAgain(channels.flatMap((c) => (c.epg ? [c.epg] : []))).then(setAgain); }, [channels]);

  const cats = useMemo(() => [...new Set(channels.map((c) => c.cat))], [channels]);
  // Canales con guía por categoría: ordena las rápidas de la fila y se ve en la hoja.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of channels) if (c.epg && !c.quiet) m.set(c.cat, (m.get(c.cat) ?? 0) + 1);
    return m;
  }, [channels]);
  // Varias categorías a la vez, las mismas en Grilla, Próximos y Tu noche; se recuerdan en este navegador. Las que
  // ya no están en la lista no cuentan.
  const [selRaw, setSelRaw] = useState<string[]>(savedCats);
  const sel = useMemo(() => selRaw.filter((c) => cats.includes(c)), [selRaw, cats]);
  const setSel = (next: string[]) => {
    setSelRaw(next);
    pref.set('cats', JSON.stringify(next));
    box.current?.scrollTo({ top: 0 });
  };
  const toggleCat = (c: string) => setSel(sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]);
  const byCount = (a: string, b: string) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
  const many = cats.length > MANY_CATS;
  const quick = many ? cats.filter((c) => !sel.includes(c)).sort(byCount).slice(0, QUICK_CATS) : [];
  const [picking, setPicking] = useState(false);
  // Memo: una lista nueva en cada render volvería a disparar la carga de Tu noche.
  const shown = useMemo(() => (sel.length ? channels.filter((c) => sel.includes(c.cat)) : channels), [channels, sel]);

  // Filas: un encabezado por categoría (salvo con una sola elegida) y una fila por canal.
  const rows = useMemo(() => {
    const out: ({ top: number; cat: string } | { top: number; ch: GuideChannel })[] = [];
    let top = 0;
    let last = '';
    for (const ch of shown) {
      if (sel.length !== 1 && ch.cat !== last) { out.push({ top, cat: ch.cat }); top += CAT_H; last = ch.cat; }
      out.push({ top, ch });
      top += ROWH;
    }
    return { out, height: top };
  }, [shown, sel, ROWH]);

  const sync = () => {
    const el = box.current;
    if (el) setView({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
  };
  const goNow = (smooth = false) => {
    box.current?.scrollTo({ left: x(Math.floor(Date.now() / 1000 / SLOT) * SLOT) - 4, behavior: smooth ? 'smooth' : 'auto' });
  };
  useLayoutEffect(() => { if (mode === 'grid') { goNow(); sync(); } }, [mode]);
  useEffect(() => {
    const on = () => sync();
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);

  // Rango de tiempo a la vista (con media pantalla de margen a cada lado).
  const visFrom = t0 + ((view.x - view.w / 2) / PX) * 60;
  const visTo = t0 + ((view.x + view.w * 1.5) / PX) * 60;

  // Bajar las horas que se ven (y una de margen).
  useEffect(() => {
    if (mode !== 'grid') return;
    loadHours(Math.max(t0, visFrom - HOUR), Math.min(t1, visTo + HOUR), () => setVer((v) => v + 1));
  }, [mode, Math.floor(visFrom / HOUR), Math.floor(visTo / HOUR)]);

  // Horas visibles que todavía se están bajando: cada fila con guía muestra un bloque gris con brillo (esqueleto) en su
  // lugar, en vez de quedar vacía.
  // Las claves de `hours` son horas enteras; t0 puede caer en una media hora, así que se parte de la hora que lo contiene.
  const pendingHours: number[] = [];
  for (let h = Math.floor(Math.max(t0, visFrom) / HOUR) * HOUR; h < Math.min(t1, visTo); h += HOUR) {
    const v = hours.get(h);
    if (v === undefined || v === 'loading') pendingHours.push(h);
  }

  // Programas de un canal en el rango, desde las horas ya bajadas; los huecos de 10 min o más
  // dentro de horas bajadas se marcan («Sin programación»): así se ven las guías flojas.
  const progCache = useMemo(() => new Map<string, Prog[]>(), [ver, Math.floor(visFrom / HOUR), Math.floor(visTo / HOUR)]);
  const progsOf = (epg: string): Prog[] => {
    let ps = progCache.get(epg);
    if (ps) return ps;
    const seen = new Map<number, Prog>();
    const loaded: number[] = [];
    for (let h = Math.floor(visFrom / HOUR) * HOUR; h < visTo; h += HOUR) {
      const idx = hours.get(h);
      if (!idx || idx === 'loading') continue;
      loaded.push(h);
      for (const [s, e, t] of idx.c[epg] ?? []) {
        const p = { s: idx.h + s * 60, e: idx.h + e * 60, t: idx.t[t] };
        if (!seen.has(p.s)) seen.set(p.s, p);
      }
    }
    ps = [...seen.values()].sort((a, b) => a.s - b.s);
    for (let k = 1; k < ps.length; k++) if (ps[k].s < ps[k - 1].e) ps[k - 1] = { ...ps[k - 1], e: ps[k].s };
    const gaps: Prog[] = [];
    for (const h of loaded) {
      let cur = h;
      for (const p of ps) {
        if (p.e <= cur || p.s >= h + HOUR) continue;
        if (p.s > cur) gaps.push({ s: cur, e: p.s, t: '', gap: true });
        cur = Math.max(cur, p.e);
      }
      if (cur < h + HOUR) gaps.push({ s: cur, e: h + HOUR, t: '', gap: true });
    }
    const merged: Prog[] = [];
    for (const g of gaps) {
      const prev = merged[merged.length - 1];
      if (prev && prev.e === g.s) prev.e = g.e;
      else merged.push({ ...g });
    }
    ps = [...ps, ...merged.filter((g) => g.e - g.s >= MIN_GAP)].sort((a, b) => a.s - b.s);
    progCache.set(epg, ps);
    return ps;
  };

  // Ticks de la regla (cada media hora), solo los que se ven.
  const ticks = [];
  for (let t = Math.max(t0, Math.floor(visFrom / SLOT) * SLOT); t < Math.min(t1, visTo); t += SLOT) {
    const midnight = new Date(t * 1000).getHours() === 0 && new Date(t * 1000).getMinutes() === 0;
    // La píldora de la hora actual tapa el rótulo de la marca que tiene cerca: ahí queda solo la raya.
    const dx = x(now) - x(t);
    const hidden = now >= t0 && now < t1 && dx > -24 && dx < (midnight ? 120 : 76);
    ticks.push(
      <span key={t} class={`gd-tick${t % HOUR ? ' half' : ''}${midnight ? ' day' : ''}`} style={{ left: `${x(t)}px`, width: `${PX * 30}px` }}>
        {hidden ? '' : midnight ? `${dayLabel(t, now)} ${hm(t)}` : hm(t)}
      </span>,
    );
  }

  const top0 = view.y - 300;
  const bottom = view.y + view.h + 300;
  const lx = view.x; // borde izquierdo visible de la franja (después de la columna de canales)

  const cell = (ch: GuideChannel, p: Prog) => {
    const l = Math.max(x(p.s), 0);
    const r = Math.min(x(p.e), W);
    const live = !p.gap && p.s <= now && now < p.e;
    const past = !p.gap && p.e <= now;
    const shift = Math.max(0, Math.min(lx - l, r - l - 56)); // el título queda pegado al borde visible
    const tiny = r - l - 4 < TINY; // angosta: sin texto (se lee al tocarla), no letras sueltas
    const cls = `gd-cell${tiny ? ' tiny' : ''}${live ? ' live' : ''}${past ? ' past' : ''}${p.gap ? ' gap' : ''}${open?.ch === ch && open.p.s === p.s ? ' sel' : ''}`;
    const re = live && now - p.s >= AGAIN_AFTER ? again.get(`${ch.epg}|${p.s}`)?.[0] : undefined;
    const label = p.gap ? `${ch.name}: sin programación de ${hm(p.s)} a ${hm(p.e)}`
      : `${ch.name}: ${p.t}, de ${hm(p.s)} a ${hm(p.e)}${re ? `; vuelve a empezar a las ${hm(re.s)}` : ''}`;
    return (
      <button type="button" key={p.s} class={cls} aria-label={label} title={tiny ? label : undefined}
        style={{ left: `${l + 2}px`, width: `${Math.max(r - l - 4, 4)}px`, ...(live ? { '--p': `${Math.round(((now - p.s) / (p.e - p.s)) * 100)}%` } : {}) }}
        onClick={() => (p.gap ? host.openChannel(ch.i) : setOpen({ ch, p }))}>
        {!tiny && (
          <span class="gd-in" style={shift ? { paddingLeft: `${shift}px` } : undefined}>
            <span class="tt">{p.gap ? 'Sin programación' : p.t}</span>
            <span class="hh">{re && <span class="rp">↻ {hm(re.s)} · </span>}{hm(p.s)} – {hm(p.e)}</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <div class="gd-shell">
      <header class="app-header gd-head">
        <div class="title-row">
          {mode === 'plan' ? (
            <span class="title-left">
              <button type="button" class="icon-btn gd-back" aria-label={`Volver a ${base === 'next' ? 'Próximos' : 'Grilla'}`} onClick={() => setMode(base)}>
                <Icon name="chevron-left" />
              </button>
              <h1>{partName}</h1>
              {host.help && <button type="button" class="icon-btn help-btn" aria-label="Cómo usar la Guía" title="Ayuda" onClick={() => host.help!()}><Icon name="circle-help" /></button>}
            </span>
          ) : (
            <span class="title-left">
              <h1>Guía</h1>
              {host.help && <button type="button" class="icon-btn help-btn" aria-label="Cómo usar la Guía" title="Ayuda" onClick={() => host.help!()}><Icon name="circle-help" /></button>}
            </span>
          )}
          {mode !== 'plan' && (
            // En la misma fila que el título: la vista elegida en color pleno y subrayada, la otra apagada.
            <span class="gd-modes" role="radiogroup" aria-label="Cómo ver la Guía">
              {([['grid', 'Grilla'], ['next', 'Próximos']] as [Mode, string][]).map(([m, label]) => (
                <button type="button" key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{label}</button>
              ))}
            </span>
          )}
        </div>
      </header>
      <nav class="gd-chips" aria-label="Categorías">
        {mode === 'next' && (
          <button type="button" class="chip-btn gd-time-chip" aria-pressed={budgetOn} onClick={() => setBudgetOn(!budgetOn)}>
            <Icon name="clock" class="sm" />{budgetOn ? `Tengo ${dur(budget * 60)}` : 'Tengo tiempo'}
          </button>
        )}
        <button type="button" class="chip-btn" aria-pressed={!sel.length} onClick={() => setSel([])}>Todas</button>
        {(many ? sel : cats).map((c) => (
          <button type="button" key={c} class="chip-btn" aria-pressed={sel.includes(c)} onClick={() => toggleCat(c)}>
            {sel.includes(c) && <Icon name="check" class="sm" />}{c}
          </button>
        ))}
        {many && sel.length > 0 && <span class="gd-chips-sep" aria-hidden="true" />}
        {quick.map((c) => (
          <button type="button" key={c} class="chip-btn" aria-pressed="false" onClick={() => toggleCat(c)}>{c}</button>
        ))}
        {many && (
          <button type="button" class="chip-btn gd-more-chip" onClick={() => setPicking(true)} aria-haspopup="dialog">
            <Icon name="plus" class="sm" />Más · {cats.length}
          </button>
        )}
      </nav>
      {picking && <CatSheet cats={cats} counts={counts} sel={sel} toggle={toggleCat} clear={() => setSel([])} close={() => setPicking(false)} />}
      {mode !== 'plan' && channels.some((c) => c.epg && !c.quiet) && (
        <button type="button" class="gd-teaser" onClick={() => setMode('plan')}>
          <span class="ic"><Icon name="sparkles" /></span>
          <span class="tx">
            <b>{partName}, armada para vos</b>
            <span>Lo mejor de {sel.length ? catsLabel(sel) : 'tus canales'} hasta las {hm(part.end)}</span>
          </span>
          <Icon name="chevron-right" />
        </button>
      )}
      {!channels.length && <div class="empty">No hay canales para mostrar.</div>}
      {mode === 'next' && channels.length > 0 && (
        <Upcoming channels={shown} now={now} again={again} open={(ch, p) => setOpen({ ch, p })}
          budget={budgetOn ? budget : null} setBudget={(m) => { setBudget(m); pref.set('budget', String(m)); }} />
      )}
      {mode === 'plan' && channels.length > 0 && (
        <Plan channels={shown} now={now} host={host} habits={habits} open={(ch, p) => setOpen({ ch, p })} filter={sel}
          suggest={cats.filter((c) => !sel.includes(c) && counts.get(c)).sort(byCount)[0]}
          add={(c) => setSel([...sel, c])} pick={() => setPicking(true)} />
      )}
      <div class="gd" ref={box} hidden={mode !== 'grid'} onScroll={() => requestAnimationFrame(sync)}
        style={{ '--chw': `${CHW}px`, '--rowh': `${ROWH}px` }}>
        <div class="gd-inner" style={{ width: `${CHW + W}px`, height: `${RULER + rows.height}px` }}>
          <div class="gd-ruler">
            <div class="gd-corner" />
            <div class="gd-ticks" style={{ width: `${W}px` }}>
              {ticks}
              {now >= t0 && now < t1 && <span class="gd-now-pill" style={{ left: `${x(now)}px` }}>{hm(now)}</span>}
            </div>
          </div>
          {rows.out.filter((r) => r.top + ROWH > top0 && r.top < bottom).map((r) => ('cat' in r
            ? <div key={`c:${r.cat}`} class="gd-cat" style={{ top: `${RULER + r.top}px`, width: `${CHW + W}px` }}><span>{r.cat}</span></div>
            : (
              <div key={r.ch.i} class="gd-row" style={{ top: `${RULER + r.top}px`, width: `${CHW + W}px` }}>
                <button type="button" class="gd-ch" onClick={() => host.openChannel(r.ch.i)} aria-label={`Abrir ${r.ch.name}`}>
                  <Logo ch={r.ch} />
                  <span class="nm">{r.ch.name}</span>
                  {r.ch.q && <span class={`qtag${r.ch.q === '4K' ? ' k4' : ''}`} title={r.ch.qTitle}>{r.ch.q}</span>}
                </button>
                <div class="gd-track" style={{ width: `${W}px` }}>
                  {r.ch.epg
                    ? [...progsOf(r.ch.epg).filter((p) => p.e > visFrom && p.s < visTo).map((p) => cell(r.ch, p)),
                      ...pendingHours.map((h) => <span key={`s${h}`} class="gd-cell skel" aria-hidden="true"
                        style={{ left: `${x(Math.max(h, t0)) + 2}px`, width: `${((Math.min(h + HOUR, t1) - Math.max(h, t0)) / 60) * PX - 4}px` }} />)]
                    : (
                      <button type="button" class={`gd-cell gap${r.ch.quiet ? ' quiet' : ''}`} style={{ left: `${Math.max(lx, 0) + 2}px`, width: `${view.w - CHW - 4}px` }}
                        onClick={() => host.openChannel(r.ch.i)}>
                        <span class="gd-in">
                          <span class="tt">{r.ch.quiet || host.viewer ? 'Sin guía' : 'Sin guía asignada'}</span>
                          <span class="hh">{host.viewer ? 'Este canal no tiene programación' : r.ch.quiet ? 'Lo dejaste así a propósito' : 'Tocá para elegir una guía'}</span>
                        </span>
                      </button>
                    )}
                </div>
              </div>
            )))}
          {now >= t0 && now < t1 && <div class="gd-nowline" style={{ left: `${CHW + x(now)}px`, top: `${RULER}px`, height: `${rows.height}px` }} />}
        </div>
      </div>
      {/* «Ahora» aparece solo cuando la línea de ahora quedó fuera de la vista: vuelve a ella. */}
      {mode === 'grid' && now >= t0 && now < t1 && (x(now) < view.x || x(now) > view.x + view.w - CHW) && (
        <button type="button" class="btn btn-tonal sm gd-now-btn" onClick={() => goNow(true)}>
          <Icon name={x(now) < view.x ? 'arrow-left' : 'arrow-right'} class="sm" />Ahora
        </button>
      )}
      {open && <ProgramSheet ch={open.ch} p={open.p} now={now} host={host} channels={channels} habits={habits} setHabits={setHabits}
        again={open.p.s <= now && now < open.p.e ? again.get(`${open.ch.epg}|${open.p.s}`) ?? [] : []} close={() => setOpen(null)} />}
    </div>
  );
}

// Próximos: lo que empieza en las próximas horas en todos los canales, ordenado por hora, y arriba lo
// que empezó hace poco («todavía llegás»). Con «Tengo tiempo», solo cuenta lo que entra entero.
const NEXT_H = 3;            // cuánto adelante mira
const RECENT = 15 * 60;      // «recién empezado»
const SOON = 5 * 60;         // «empieza ya»
const MIN_UP = 10 * 60;      // fuera las franjas cortitas (cortes, avances)
const MAX_ROWS = 80;

interface UpItem { p: Prog; chs: GuideChannel[] }

function Upcoming({ channels, now, again, open, budget, setBudget }: {
  channels: GuideChannel[]; now: number; again: AgainMap; open: (ch: GuideChannel, p: Prog) => void;
  budget: number | null; setBudget: (m: number) => void;
}) {
  const [ver, setVer] = useState(0);
  const from = now - HOUR;
  const to = now + (NEXT_H + 1) * HOUR;
  useEffect(() => { loadHours(from, to, () => setVer((v) => v + 1)); }, [Math.floor(now / HOUR)]);
  const ready = [...Array(NEXT_H + 1).keys()].every((k) => {
    const v = hours.get(Math.floor(now / HOUR) * HOUR + k * HOUR);
    return v !== undefined && v !== 'loading';
  });
  const end = budget ? now + budget * 60 : Infinity;

  const { recent, next } = useMemo(() => {
    // Mismo programa a la misma hora en varios canales (HD, otra señal): una sola fila.
    const items = new Map<string, UpItem>();
    for (const ch of channels) {
      if (!ch.epg) continue;
      for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
        const idx = hours.get(h);
        if (!idx || idx === 'loading') continue;
        for (const [s, e, t] of idx.c[ch.epg] ?? []) {
          const p = { s: idx.h + s * 60, e: idx.h + e * 60, t: idx.t[t] };
          if (p.e - p.s < MIN_UP) continue;
          const isRecent = p.s <= now && now < p.e && now - p.s <= RECENT;
          if (!isRecent && !(p.s > now && p.s <= now + NEXT_H * HOUR)) continue;
          const key = `${p.t}|${p.s}`;
          const it = items.get(key);
          if (!it) items.set(key, { p, chs: [ch] });
          else if (!it.chs.includes(ch)) it.chs.push(ch);
        }
      }
    }
    const all = [...items.values()].sort((a, b) => a.p.s - b.p.s);
    return { recent: all.filter((x) => x.p.s <= now).reverse(), next: all.filter((x) => x.p.s > now) };
  }, [channels, ver, Math.floor(now / 60)]);

  const fits = (p: Prog) => p.e <= end + 120;
  const nextShown = (budget ? next.filter((x) => x.p.s < end) : next).slice(0, MAX_ROWS);

  const row = ({ p, chs }: UpItem) => {
    const d = p.s - now;
    const ch = chs[0];
    const re = d <= 0 ? again.get(`${ch.epg}|${p.s}`)?.[0] : undefined;
    const fit = budget ? fits(p) : true;
    const when = d <= 0 ? `Empezó hace ${dur(-d)}` : d <= SOON ? '' : `Empieza en ${dur(d)}`;
    return (
      <button type="button" key={`${p.t}|${p.s}`} class={`gd-up-row${fit ? '' : ' dim'}`} onClick={() => open(ch, p)}
        aria-label={`${p.t}, ${ch.name}, ${hm(p.s)} a ${hm(p.e)}`}>
        <span class="gd-up-time">{hm(p.s)}</span>
        <span class="gd-up-main">
          <span class="tt">{p.t}</span>
          <span class="sub">
            <Logo ch={ch} cls="sm" />
            <span class="nm">{ch.name}{chs.length > 1 ? ` y ${chs.length - 1} más` : ''}</span>
            <span class="meta">
              {when}
              {when && (budget || d > 0) && ' · '}
              {budget ? (fit ? <b class="ok">Entra</b> : `Se pasa ${dur(p.e - end)}`) : d > 0 && dur(p.e - p.s)}
            </span>
          </span>
        </span>
        {d > 0 && d <= SOON && <span class="gd-up-pill now">Empieza ya</span>}
        {re && <span class="gd-up-pill again">↻ {hm(re.s)}</span>}
      </button>
    );
  };

  return (
    <div class="gd-up">
      {budget && (
        <div class="gd-budget">
          <div class="lbl"><b>Hasta las {hm(end)}</b><span>{dur(budget * 60)}</span></div>
          <input type="range" min={20} max={360} step={5} value={budget} aria-label="Cuánto tiempo tenés"
            aria-valuetext={`${dur(budget * 60)}, hasta las ${hm(end)}`}
            onInput={(e) => setBudget(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
      )}
      {!ready && !recent.length && !next.length ? <p class="gd-up-empty">Cargando…</p> : (
        <>
          {recent.length > 0 && (
            <section>
              <h3>Recién empezados, todavía llegás</h3>
              <div class="gd-up-list">{recent.map(row)}</div>
            </section>
          )}
          <section>
            <h3>Lo que viene</h3>
            {nextShown.length
              ? <div class="gd-up-list">{nextShown.map(row)}</div>
              : <p class="gd-up-empty">{budget ? `Nada empieza antes de las ${hm(end)}. Probá con más tiempo.` : `Nada empieza en las próximas ${NEXT_H} horas.`}</p>}
          </section>
        </>
      )}
    </div>
  );
}

// Tu mañana / tarde / noche / madrugada: Grilla arma el rato que queda de esta parte del día
// encadenando programas de la lista sin que se pisen, saltando de canal, y avisa en cada cambio.
// Sin géneros en la guía, «lo mejor» sale del título y la duración: en vivo y partidos primero,
// películas largas después, y afuera el relleno, los noticieros y las repeticiones.
interface Part { name: string; end: number }
/** La parte del día de `t` y cuándo termina; si queda menos de hora y media, la que sigue. */
export function partOfDay(t: number): Part {
  const parts: [number, number, string][] = [[2, 6, 'madrugada'], [6, 12, 'mañana'], [12, 19, 'tarde'], [19, 26, 'noche']];
  const d = new Date(t * 1000);
  const day = new Date(d).setHours(0, 0, 0, 0) / 1000;
  let h = d.getHours() + d.getMinutes() / 60;
  if (h < 2) h += 24; // de 0 a 2 sigue siendo la noche de ayer
  const base = d.getHours() < 2 ? day - 86400 : day;
  const i = parts.findIndex(([a, b]) => h >= a && h < b);
  const at = (k: number) => ({ name: parts[k % 4][2], end: base + parts[k % 4][1] * 3600 + (k >= 4 ? 86400 : 0) });
  const cur = at(i < 0 ? 0 : i);
  return cur.end - t < 90 * 60 ? at((i < 0 ? 0 : i) + 1) : cur;
}

const FILLER = /canal no disponible|se[ñn]al no disponible|paid programming|programa pagado|programación pagada|no data|sin información|infomercial|televenta|fuera del aire|off air|cierre de emisi/i;
const LIVE = /\b(en vivo|vivo|live|vs\.?|final|semifinal|cl[aá]sico|gran premio|grand prix)\b/i;
const RERUN = /(-\s*rep\.?\s*$|\(r\)|\brepetici[oó]n\b|\bresumen\b)/i;
const NEWS = /\b(noticias|noticiero|news|sportscenter|informativo|el tiempo)\b/i;
const MOVIE_CAT = /pel[ií]cul|cine|movie|film/i;

interface Slot { ch: GuideChannel; p: Prog; alt?: { ch: GuideChannel; p: Prog }; why?: string }
type Cand = { ch: GuideChannel; p: Prog };
/** Lo que suma un programa por los gustos de la casa, y por qué; null = «No me interesa». */
export type Affinity = (c: Cand) => { bonus: number; why?: string } | null;

/** Como el Worker (again.ts): el mismo programa aunque cambien mayúsculas o espacios. */
export const normTitle = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Afinidad por hábitos: el programa que se mira seguido, el canal a esa hora (±1 h) y en general, la campana y lo
 *  pedido. Pesa como mucho lo que un partido en vivo: lo de siempre sube, pero no tapa todo lo demás. */
export function habitAffinity(h: Habits | null, marks: Set<string> | null): Affinity {
  const taste = genreTaste(h);
  return ({ ch, p }) => {
    const k = normTitle(p.t);
    if (h?.no[k]) return null;
    const reasons: [number, string][] = [];
    let bonus = 0;
    const add = (v: number, why: string, min = 0) => { bonus += v; if (v > min) reasons.push([v, why]); };
    if (h?.more[k]) add(3, 'Pediste más como esto');
    if (marks?.has(`${ch.epg}|${p.s}`)) add(3, 'Le pusiste la campana');
    const tn = h?.t[k]?.n ?? 0;
    if (tn) add(Math.min(4, 1.5 * Math.log2(1 + tn)), tn >= 3 ? 'Lo mirás seguido' : 'Ya lo miraste', 1);
    const c = ch.epg ? h?.ch[ch.epg] : undefined;
    if (c) {
      const hr = new Date(p.s * 1000).getUTCHours();
      const at = [-1, 0, 1].reduce((n, d) => n + (c.h[(hr + d + 24) % 24] ?? 0), 0);
      add(Math.min(3, 0.75 * at), 'Tu canal a esta hora', 1.4);
      add(Math.min(1.5, 0.5 * Math.log2(1 + c.n)), 'De tus canales', 0.9);
    }
    const gs = p.g ? taste.get(p.g) ?? 0 : 0;
    if (gs) add(gs, `Como lo que mirás: ${p.g!.toLowerCase()}`, 0.9);
    reasons.sort((a, b) => b[0] - a[0]);
    return { bonus, why: reasons[0]?.[1] };
  };
}

/** Géneros que ya se pueden sugerir y cuánto pesan en la casa: el género de los programas que se miraron (la
 *  corrida lo anota en los hábitos cuando la IA ya lo clasificó). Hasta +2,5 según qué parte de lo mirado es de ese
 *  género; con menos de dos veces no cuenta. */
export function genreTaste(h: Habits | null): Map<string, number> {
  const n = new Map<string, number>();
  let total = 0;
  for (const v of Object.values(h?.t ?? {})) {
    if (!v.g || v.g === NEVER_SUGGEST) continue;
    n.set(v.g, (n.get(v.g) ?? 0) + v.n);
    total += v.n;
  }
  const out = new Map<string, number>();
  for (const [g, c] of n) if (c >= 2) out.set(g, Math.min(2.5, (6 * c) / total));
  return out;
}

/** La publicidad (infomerciales, televenta) que la IA reconoce nunca se sugiere. */
const NEVER_SUGGEST = 'Publicidad';

/** Puntaje de un programa para el plan (más es mejor); null si no va. */
export function planScore(t: string, len: number, cat: string): number | null {
  if (len < 25 * 60 || FILLER.test(t)) return null;
  let sc = Math.min(len, 150 * 60) / 1800;
  if (LIVE.test(t)) sc += 4;
  if (MOVIE_CAT.test(cat) && len >= 80 * 60) sc += 2;
  if (RERUN.test(t)) sc -= 3;
  if (NEWS.test(t)) sc -= 2;
  return sc;
}

/** Encadena programas desde `now` hasta `end`: en cada paso, el mejor de los que empiezan cerca de donde
 *  terminó el anterior (el primero puede haber empezado hace un rato). `forced` fija la elección de un paso. */
export function buildPlan(cands: Cand[], now: number, end: number, forced: Map<number, Cand>, aff?: Affinity): Slot[] {
  const scored = cands.flatMap((c) => {
    const sc = c.p.g === NEVER_SUGGEST ? null : planScore(c.p.t, c.p.e - c.p.s, c.ch.cat);
    const a = aff ? aff(c) : { bonus: 0 };
    return sc === null || !a ? [] : [{ ...c, sc: sc + a.bonus, why: a.why }];
  });
  const plan: Slot[] = [];
  const used = new Set<string>();
  let t = now;
  while (t < end - 20 * 60 && plan.length < 12) {
    const first = !plan.length;
    const opts = scored
      .filter((c) => !used.has(c.p.t) && c.p.e > t + 20 * 60 && c.p.s >= t - (first ? 20 * 60 : 10 * 60) && c.p.s <= t + 45 * 60)
      .map((c) => ({ ...c, v: c.sc - Math.max(0, c.p.s - t) / 900 }))
      .sort((a, b) => b.v - a.v || a.p.s - b.p.s);
    const pick = forced.get(plan.length) ?? opts[0];
    if (!pick) { t += 15 * 60; continue; }
    const alt = opts.find((o) => o.ch.epg !== pick.ch.epg && o.p.t !== pick.p.t);
    const why: string | undefined = 'why' in pick ? (pick.why as string | undefined) : aff?.(pick)?.why;
    plan.push({ ch: pick.ch, p: pick.p, alt: alt && { ch: alt.ch, p: alt.p }, ...(why ? { why } : {}) });
    used.add(pick.p.t);
    t = pick.p.e;
  }
  return plan;
}

const MAX_PLAN_CHANNELS = 150;

function Plan({ channels, now, host, habits, open, filter, suggest, add, pick }: {
  channels: GuideChannel[]; now: number; host: GuideHost; habits: Habits | null; open: (ch: GuideChannel, p: Prog) => void;
  /** Las categorías elegidas (vacío = todas), la que conviene sumar si no alcanza, sumarla y abrir la hoja. */
  filter: string[]; suggest?: string; add: (c: string) => void; pick: () => void;
}) {
  const part = partOfDay(now);
  const [scheds, setScheds] = useState<Map<string, Entry[] | null>>(() => new Map());
  const [marks, setMarks] = useState<Set<string> | null>(null);
  const [forced, setForced] = useState<Map<number, { ch: GuideChannel; p: Prog }>>(() => new Map());
  const withGuide = useMemo(() => channels.filter((c) => c.epg && !c.quiet).slice(0, MAX_PLAN_CHANNELS), [channels]);
  useEffect(() => {
    let live = true;
    setForced(new Map());
    Promise.all(withGuide.map((c) => host.schedule(c.epg!).then((e) => [c.epg!, e] as const)))
      .then((list) => { if (live) setScheds(new Map(list)); });
    host.reminders().then((m) => live && setMarks(m));
    return () => { live = false; };
  }, [withGuide]);
  const loaded = withGuide.every((c) => scheds.has(c.epg!));

  const plan = useMemo(() => {
    const cands: { ch: GuideChannel; p: Prog }[] = [];
    for (const ch of withGuide) {
      for (const [s, e, t, , g] of scheds.get(ch.epg!) ?? []) {
        if (e > now && s < part.end) cands.push({ ch, p: { s, e, t, ...(g ? { g } : {}) } });
      }
    }
    return buildPlan(cands, now, part.end, forced, habitAffinity(habits, marks));
  }, [scheds, forced, Math.floor(now / 300), part.end, habits, marks]);
  const learned = !!habits && Object.keys(habits.ch).length > 0;
  // Con categorías elegidas, si el plan termina más de media hora antes del final del rato, se dice y se ofrece sumar.
  const lastEnd = plan.reduce((m, sl) => Math.max(m, sl.p.e), now);
  const short = filter.length > 0 && loaded && part.end - lastEnd > 30 * 60;

  const bell = (ch: GuideChannel, p: Prog) => {
    if (host.viewer) return null;
    const on = marks?.has(`${ch.epg}|${p.s}`) ?? false;
    return (
      <button type="button" class={`remind-btn${on ? ' on' : ''}`} data-epg={ch.epg!} data-start={p.s} data-title={p.t}
        aria-pressed={on} aria-label={`Avisarme: ${p.t}`} title="Avisarme antes de que empiece"
        onClick={(ev) => { ev.stopPropagation(); host.toggleReminder(ev.currentTarget as HTMLElement, ch.name); }}>
        <Icon name="bell" />
      </button>
    );
  };

  return (
    <div class="gd-up gd-plan">
      <p class="gd-plan-lead">Armé tu {part.name} con {learned ? 'lo que solés mirar y ' : ''}lo mejor de {filter.length ? <b>{catsLabel(filter)}</b> : 'tus canales'}, sin que nada se pise. {host.viewer ? 'Tocá un programa para ver de qué se trata o decir si te interesa, o una de las opciones para cambiarlo.' : 'Tocá la campana y te aviso en cada cambio.'}</p>
      {!loaded ? <p class="gd-up-empty">Armando tu {part.name}…</p> : !plan.length
        ? !filter.length && <p class="gd-up-empty">No encontré programas para armar tu {part.name} en estos canales.</p>
        : (
          <ol class="gd-plan-list">
            {plan.map((sl, i) => {
              const prev = plan[i - 1];
              const live = sl.p.s <= now;
              return (
                <li key={`${sl.ch.i}:${sl.p.s}`}>
                  {prev && prev.ch.epg !== sl.ch.epg && (
                    <p class="gd-plan-hop"><Icon name="refresh-cw" class="sm" />Cambio a <b>{sl.ch.name}</b> a las {hm(sl.p.s)}</p>
                  )}
                  <div class={`gd-plan-slot${live ? ' live' : ''}`}>
                    <span class="gd-plan-time">{hm(sl.p.s)}</span>
                    <button type="button" class="gd-plan-card" onClick={() => open(sl.ch, sl.p)} aria-label={`${sl.p.t}, ${sl.ch.name}, ${hm(sl.p.s)} a ${hm(sl.p.e)}`}>
                      <Logo ch={sl.ch} />
                      <span class="gd-up-main">
                        <span class="tt">{live && <span class="gd-plan-dot" aria-label="En el aire" />}{sl.p.t}</span>
                        <span class="sub"><span class="nm">{sl.ch.name}</span><span class="meta">{live ? `quedan ${dur(sl.p.e - now)}` : `${hm(sl.p.s)} – ${hm(sl.p.e)}`}</span></span>
                      </span>
                    </button>
                    {!live && bell(sl.ch, sl.p)}
                  </div>
                  {sl.why && <p class="gd-plan-why"><Icon name="sparkles" class="sm" />{sl.why}</p>}
                  {sl.alt && (
                    <button type="button" class="gd-plan-alt" onClick={() => setForced(new Map([...forced].filter(([k]) => k < i)).set(i, sl.alt!))}>
                      o <b>{sl.alt.p.t}</b> en {sl.alt.ch.name} ({hm(sl.alt.p.s)})
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      {short && (
        <div class="gd-plan-gap">
          <p class="t">De las {hm(Math.max(now, lastEnd))} a las {hm(part.end)} no encontré nada</p>
          <p class="d">Con {catsLabel(filter)} {plan.length ? `solo hay ${plural(plan.length, 'programa', 'programas')}` : 'no hay programas'} para
            tu {part.name}. Sumá otra categoría para completar el plan.</p>
          <div class="acts">
            {suggest && <button type="button" class="btn btn-tonal sm" onClick={() => add(suggest)}><Icon name="plus" class="sm" />Sumar {suggest}</button>}
            <button type="button" class="btn btn-gray sm" onClick={pick}>Elegir otras</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** La hoja para elegir categorías de la Guía: buscador, las elegidas arriba y todas con sus canales con guía. */
function CatSheet({ cats, counts, sel, toggle, clear, close }: {
  cats: string[]; counts: Map<string, number>; sel: string[]; toggle: (c: string) => void; clear: () => void; close: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const f = fold(q.trim());
  const match = (c: string) => !f || fold(c).includes(f);
  const chosen = sel.filter(match);
  const rest = cats.filter((c) => !sel.includes(c) && match(c));
  const row = (c: string) => (
    <label class="gc-row" key={c}>
      <input type="checkbox" checked={sel.includes(c)} onChange={() => toggle(c)} />
      <span class="gc-name">{c}</span>
      <span class="gc-count">{counts.get(c) ? plural(counts.get(c)!, 'canal', 'canales') : 'sin guía'}</span>
    </label>
  );
  return (
    <dialog class="sheet settings-sheet gc-sheet" ref={dlg} onClose={close} aria-labelledby="gcTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="gcTitle">Categorías</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <label class="search-field">
          <Icon name="search" />
          <input type="search" placeholder="Buscar categoría" aria-label="Buscar categoría" enterkeyhint="search"
            value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {chosen.length > 0 && (
          <>
            <h3 class="sec-title">Elegidas · {sel.length}</h3>
            <div class="gc-list">{chosen.map(row)}</div>
          </>
        )}
        <h3 class="sec-title">{f ? 'Resultados' : `Todas · ${cats.length}`}</h3>
        {rest.length ? <div class="gc-list">{rest.map(row)}</div> : <p class="help">{f ? `Ninguna otra categoría coincide con «${q}».` : 'Ya elegiste todas.'}</p>}
        <div class="gc-foot">
          <button type="button" class="btn btn-gray" onClick={clear} disabled={!sel.length}>Todas</button>
          <button type="button" class="btn btn-primary" onClick={() => dlg.current?.close()}>{sel.length ? `Listo · ${plural(sel.length, 'elegida', 'elegidas')}` : 'Listo'}</button>
        </div>
      </div>
    </dialog>
  );
}

function ProgramSheet({ ch, p, now, host, channels, habits, setHabits, again, close }: {
  ch: GuideChannel; p: Prog; now: number; host: GuideHost; channels: GuideChannel[]; habits: Habits | null;
  setHabits: (h: Habits) => void; again: Airing[]; close: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<Entry[] | null | undefined>(undefined);
  const [marks, setMarks] = useState<Set<string> | null>(null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  useEffect(() => {
    if (ch.epg) host.schedule(ch.epg).then(setEntries);
    host.reminders().then(setMarks);
  }, []);
  const mine = entries?.find(([s]) => s === p.s);
  const next = (entries ?? []).filter(([s]) => s >= p.e).slice(0, 4);
  const live = p.s <= now && now < p.e;
  const bell = (s: number, t: string, primary: boolean | string = false, on_ = ch) => {
    if (host.viewer) return null;
    const on = marks?.has(`${on_.epg}|${s}`) ?? false;
    return (
      <button type="button" class={primary ? `btn btn-tonal gd-remind${on ? ' on' : ''}` : `remind-btn${on ? ' on' : ''}`}
        data-epg={on_.epg!} data-start={s} data-title={t} aria-pressed={on}
        aria-label={primary ? undefined : `Avisarme: ${t}`} title="Avisarme antes de que empiece"
        onClick={(ev) => host.toggleReminder(ev.currentTarget as HTMLElement, on_.name)}>
        <Icon name="bell" />{primary && (typeof primary === 'string' ? primary : 'Avisarme')}
      </button>
    );
  };
  // La repetición se muestra en el canal de la lista que tiene esa guía (el primero, si hay varios).
  const byEpg = (epg: string) => (epg === ch.epg ? ch : channels.find((c) => c.epg === epg));
  const reruns = again.flatMap((a) => { const c = byEpg(a.epg); return c ? [{ c, s: a.s }] : []; });
  const first = reruns[0];
  return (
    <dialog class="sheet settings-sheet gd-sheet" ref={dlg} onClose={close} aria-label={p.t}>
      <div class="sheet-body">
        <div class="title-row">
          <div class="gd-sh-ch"><Logo ch={ch} cls="lg" /><div><strong>{ch.name}</strong><small>{ch.cat}</small></div></div>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <h2 class="gd-sh-title">{p.t}</h2>
        <p class="gd-sh-when">
          {live ? <b>En el aire</b> : <span>{dayLabel(p.s, now)}</span>} · {hm(p.s)} – {hm(p.e)}{live ? ` · ${left(p.e - now)}` : ''}
        </p>
        {live && <Progress cls="np-bar gd-sh-bar" value={((now - p.s) / (p.e - p.s)) * 100} />}
        {entries === undefined ? <p class="gd-sh-desc muted">Cargando…</p> : mine?.[3] && <p class="gd-sh-desc">{mine[3]}</p>}
        {first && (
          <section class="gd-again" aria-label="Llegás desde el principio">
            <p class="k"><Icon name="refresh-cw" class="sm" />Llegás desde el principio</p>
            <p class="big">Vuelve a empezar {dayLabel(first.s, now) === 'Hoy' ? '' : `${dayLabel(first.s, now).toLowerCase()} `}a las {hm(first.s)}</p>
            <p class="where"><Logo ch={first.c} cls="sm" />{first.c === ch ? 'En este canal' : `En ${first.c.name}`} · {startsIn(first.s - now)}</p>
            {bell(first.s, p.t, 'Avisarme', first.c)}
            {reruns.slice(1).map((r) => (
              <p key={`${r.c.i}:${r.s}`} class="also">También {dayLabel(r.s, now) === 'Hoy' ? '' : `${dayLabel(r.s, now).toLowerCase()} `}a las <b>{hm(r.s)}</b>{r.c === ch ? '' : ` en ${r.c.name}`}</p>
            ))}
          </section>
        )}
        {!live && p.s > now && ch.epg && !host.viewer && <div class="gd-sh-actions">{bell(p.s, p.t, true)}</div>}
        {host.feedback && <Taste title={p.t} host={host} habits={habits} setHabits={setHabits} />}
        {next.length > 0 && (
          <div class="gd-sh-next">
            <h3>Después</h3>
            {next.map(([s, , t]) => (
              <div key={s} class="gd-sh-row"><b>{hm(s)}</b><span>{t}</span>{bell(s, t)}</div>
            ))}
          </div>
        )}
        {!host.viewer && <button type="button" class="link-btn gd-sh-fix" onClick={() => { dlg.current?.close(); host.openChannel(ch.i); }}>
          <Icon name="pencil" class="sm" />¿No coincide con lo que ves? Cambiar la guía de este canal
        </button>}
      </div>
    </dialog>
  );
}

/** «Más como esto» / «No me interesa» de un programa: cambia Tu noche al momento, con Deshacer. */
function Taste({ title, host, habits, setHabits }: { title: string; host: GuideHost; habits: Habits | null; setHabits: (h: Habits) => void }) {
  const k = normTitle(title);
  const cur: Feedback = habits?.no[k] ? 'no' : habits?.more[k] ? 'more' : 'clear';
  const send = async (kind: Feedback, quiet = false) => {
    const prev = cur;
    try {
      const h = await host.feedback!(title, kind);
      if (h) setHabits(h);
    } catch {
      toast('No se pudo guardar. Probá de nuevo.', 'bad');
      return;
    }
    if (quiet) return;
    const msg = kind === 'no' ? 'Listo: no te lo sugiero más en tu plan.' : kind === 'more' ? 'Listo: te lo voy a sugerir más.' : 'Listo: lo dejé como antes.';
    toast(msg, 'ok', 3500, kind === 'clear' ? undefined : () => send(prev, true));
  };
  const btn = (kind: 'more' | 'no', icon: string, label: string) => (
    <button type="button" class={`chip-btn gd-taste-btn${cur === kind ? ' on' : ''}`} aria-pressed={cur === kind}
      onClick={() => send(cur === kind ? 'clear' : kind)}>
      <Icon name={icon} class="sm" />{label}
    </button>
  );
  return (
    <div class="gd-taste" role="group" aria-label="Para tu plan">
      {btn('more', 'thumbs-up', 'Más como esto')}
      {btn('no', 'thumbs-down', 'No me interesa')}
    </div>
  );
}

/** Pinta (o actualiza, con los canales de ahora) la Guía en `el`. */
export function showGuide(el: HTMLElement, host: GuideHost) {
  const path = host.hourPath ?? '/api/ui/schedule/hour';
  // Otra configuración, otros canales: lo bajado no sirve.
  if (path !== hourPath) {
    hours.clear();
    hourPath = path;
  }
  render(<Guide channels={host.channels()} host={host} />, el);
}
