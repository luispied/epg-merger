// La Guía: grilla de canales × hora, como la de TiviMate (ver planes/react.md). Primera pantalla
// hecha en Preact. Lee la programación de los índices por hora que publica la corrida diaria
// (ui/schedule/hour/<AAAAMMDDHH>.json, con TODA la guía) y baja solo las horas que se ven.
// Se virtualiza en los dos ejes: solo se pintan las filas y los programas que entran en pantalla.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';

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
type Entry = [number, number, string, string?];
export interface GuideHost {
  channels(): GuideChannel[];
  openChannel(i: number): void;
  /** El archivo del canal (con descripciones) de la ventana publicada. */
  schedule(epg: string): Promise<Entry[] | null>;
  reminders(): Promise<Set<string> | null>;
  toggleReminder(btn: HTMLElement, channel: string): void;
  /** Modo «solo ver» (ver.tsx): sin avisos ni nada que lleve a editar. */
  viewer?: boolean;
}

interface HourIndex { h: number; t: string[]; c: Record<string, [number, number, number][]> }
interface Prog { s: number; e: number; t: string; gap?: boolean }

type Mode = 'grid' | 'next' | 'plan';
const HOUR = 3600;
const SLOT = 1800;
const SPAN_H = 30; // la guía publicada llega ~30 h adelante
const RULER = 32;
const CAT_H = 30;
const MIN_GAP = 10 * 60;

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
      for (const [i, s, later] of res?.r ?? []) map.set(`${res!.ids[i]}|${s}`, later.map(([j, s2]) => ({ epg: res!.ids[j], s: s2 })));
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
    fetch(`/api/ui/schedule/hour/${hourKey(h)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((idx: HourIndex | null) => { hours.set(h, idx); done(); });
  }
}

// Preferencias de la Guía en este navegador (modo y rato libre); sin almacenamiento, los valores por defecto.
const pref = {
  get(k: string) { try { return localStorage.getItem(`grilla_guide_${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`grilla_guide_${k}`, v); } catch { /* sin almacenamiento */ } },
};

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
  const ini = ch.name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
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

  const [cat, setCat] = useState('');
  const [mode, setModeState] = useState<Mode>(() => {
    const m = pref.get('mode');
    return m === 'next' || m === 'plan' ? m : 'grid';
  });
  const setMode = (m: Mode) => { setModeState(m); pref.set('mode', m); };
  const [budgetOn, setBudgetOn] = useState(false);
  const [budget, setBudget] = useState(() => Math.min(360, Math.max(20, Number(pref.get('budget')) || 75)));
  const [view, setView] = useState({ x: 0, y: 0, w: 390, h: 700 });
  const [ver, setVer] = useState(0);
  const [open, setOpen] = useState<{ ch: GuideChannel; p: Prog } | null>(null);
  const [again, setAgain] = useState<AgainMap>(() => new Map());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { loadAgain(channels.flatMap((c) => (c.epg ? [c.epg] : []))).then(setAgain); }, [channels]);

  const cats = useMemo(() => [...new Set(channels.map((c) => c.cat))], [channels]);
  const shown = cat ? channels.filter((c) => c.cat === cat) : channels;

  // Filas: un encabezado por categoría (en «Todas») y una fila por canal.
  const rows = useMemo(() => {
    const out: ({ top: number; cat: string } | { top: number; ch: GuideChannel })[] = [];
    let top = 0;
    let last = '';
    for (const ch of shown) {
      if (!cat && ch.cat !== last) { out.push({ top, cat: ch.cat }); top += CAT_H; last = ch.cat; }
      out.push({ top, ch });
      top += ROWH;
    }
    return { out, height: top };
  }, [shown, cat, ROWH]);

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
    ticks.push(
      <span key={t} class={`gd-tick${t % HOUR ? ' half' : ''}${midnight ? ' day' : ''}`} style={{ left: `${x(t)}px`, width: `${PX * 30}px` }}>
        {midnight ? `${dayLabel(t, now)} ${hm(t)}` : hm(t)}
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
    const cls = `gd-cell${live ? ' live' : ''}${past ? ' past' : ''}${p.gap ? ' gap' : ''}${open?.ch === ch && open.p.s === p.s ? ' sel' : ''}`;
    const re = live && now - p.s >= AGAIN_AFTER ? again.get(`${ch.epg}|${p.s}`)?.[0] : undefined;
    const label = p.gap ? `${ch.name}: sin programación de ${hm(p.s)} a ${hm(p.e)}`
      : `${ch.name}: ${p.t}, de ${hm(p.s)} a ${hm(p.e)}${re ? `; vuelve a empezar a las ${hm(re.s)}` : ''}`;
    return (
      <button type="button" key={p.s} class={cls} aria-label={label}
        style={{ left: `${l + 2}px`, width: `${Math.max(r - l - 4, 4)}px`, ...(live ? { '--p': `${Math.round(((now - p.s) / (p.e - p.s)) * 100)}%` } : {}) }}
        onClick={() => (p.gap ? host.openChannel(ch.i) : setOpen({ ch, p }))}>
        <span class="gd-in" style={shift ? { paddingLeft: `${shift}px` } : undefined}>
          <span class="tt">{p.gap ? 'Sin programación' : p.t}</span>
          <span class="hh">{re && <span class="rp">↻ {hm(re.s)} · </span>}{hm(p.s)} – {hm(p.e)}</span>
        </span>
      </button>
    );
  };

  return (
    <div class="gd-shell">
      <header class="app-header gd-head">
        <div class="title-row">
          <h1>Guía</h1>
          {mode === 'grid' && <button type="button" class="btn btn-tonal sm gd-now-btn" onClick={() => goNow(true)}>Ahora</button>}
        </div>
        <div class="gd-modes" role="radiogroup" aria-label="Cómo ver la Guía">
          {([['grid', 'Grilla'], ['next', 'Próximos'], ['plan', `Tu ${partOfDay(now).name}`]] as [Mode, string][]).map(([m, label]) => (
            <button type="button" key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
              {mode === m && <Icon name="check" class="sm" />}{label}
            </button>
          ))}
        </div>
      </header>
      <nav class="gd-chips" aria-label="Categorías">
        {mode === 'next' && (
          <button type="button" class="chip-btn gd-time-chip" aria-pressed={budgetOn} onClick={() => setBudgetOn(!budgetOn)}>
            <Icon name="clock" class="sm" />{budgetOn ? `Tengo ${dur(budget * 60)}` : 'Tengo tiempo'}
          </button>
        )}
        {['', ...cats].map((c) => (
          <button type="button" key={c} class="chip-btn" aria-pressed={c === cat}
            onClick={() => { setCat(c); box.current?.scrollTo({ top: 0 }); }}>{c || 'Todas'}</button>
        ))}
      </nav>
      {!channels.length && <div class="empty">No hay canales para mostrar.</div>}
      {mode === 'next' && channels.length > 0 && (
        <Upcoming channels={shown} now={now} again={again} open={(ch, p) => setOpen({ ch, p })}
          budget={budgetOn ? budget : null} setBudget={(m) => { setBudget(m); pref.set('budget', String(m)); }} />
      )}
      {mode === 'plan' && channels.length > 0 && (
        <Plan channels={shown} now={now} host={host} open={(ch, p) => setOpen({ ch, p })} />
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
                    ? progsOf(r.ch.epg).filter((p) => p.e > visFrom && p.s < visTo).map((p) => cell(r.ch, p))
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
      {open && <ProgramSheet ch={open.ch} p={open.p} now={now} host={host} channels={channels}
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

const FILLER = /paid programming|programa pagado|programación pagada|no data|sin información|infomercial|televenta|fuera del aire|off air|cierre de emisi/i;
const LIVE = /\b(en vivo|vivo|live|vs\.?|final|semifinal|cl[aá]sico|gran premio|grand prix)\b/i;
const RERUN = /(-\s*rep\.?\s*$|\(r\)|\brepetici[oó]n\b|\bresumen\b)/i;
const NEWS = /\b(noticias|noticiero|news|sportscenter|informativo|el tiempo)\b/i;
const MOVIE_CAT = /pel[ií]cul|cine|movie|film/i;

interface Slot { ch: GuideChannel; p: Prog; alt?: { ch: GuideChannel; p: Prog } }

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
export function buildPlan(cands: { ch: GuideChannel; p: Prog }[], now: number, end: number, forced: Map<number, { ch: GuideChannel; p: Prog }>): Slot[] {
  const scored = cands.flatMap((c) => {
    const sc = planScore(c.p.t, c.p.e - c.p.s, c.ch.cat);
    return sc === null ? [] : [{ ...c, sc }];
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
    plan.push({ ch: pick.ch, p: pick.p, alt: alt && { ch: alt.ch, p: alt.p } });
    used.add(pick.p.t);
    t = pick.p.e;
  }
  return plan;
}

const MAX_PLAN_CHANNELS = 150;

function Plan({ channels, now, host, open }: {
  channels: GuideChannel[]; now: number; host: GuideHost; open: (ch: GuideChannel, p: Prog) => void;
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
      for (const [s, e, t] of scheds.get(ch.epg!) ?? []) {
        if (e > now && s < part.end) cands.push({ ch, p: { s, e, t } });
      }
    }
    return buildPlan(cands, now, part.end, forced);
  }, [scheds, forced, Math.floor(now / 300), part.end]);

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
      <p class="gd-plan-lead">Armé tu {part.name} con lo mejor de tus canales, sin que nada se pise. {host.viewer ? 'Tocá un programa para ver de qué se trata, o una de las opciones para cambiarlo.' : 'Tocá la campana y te aviso en cada cambio.'}</p>
      {!loaded ? <p class="gd-up-empty">Armando tu {part.name}…</p> : !plan.length
        ? <p class="gd-up-empty">No encontré programas para armar tu {part.name} en estos canales.</p>
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
    </div>
  );
}

function ProgramSheet({ ch, p, now, host, channels, again, close }: {
  ch: GuideChannel; p: Prog; now: number; host: GuideHost; channels: GuideChannel[]; again: Airing[]; close: () => void;
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
        {live && <div class="np-bar gd-sh-bar"><i style={{ width: `${Math.round(((now - p.s) / (p.e - p.s)) * 100)}%` }} /></div>}
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

/** Pinta (o actualiza, con los canales de ahora) la Guía en `el`. */
export function showGuide(el: HTMLElement, host: GuideHost) {
  render(<Guide channels={host.channels()} host={host} />, el);
}
