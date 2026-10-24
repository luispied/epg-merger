// La lista de Canales, en Preact (ver planes/react.md): las filas (o tarjetas), con un encabezado de categoría cada vez
// que cambia, el vacío con su motivo, el esqueleto mientras carga, la tarjeta de revisión de arriba y el menú «…» de
// una fila. Qué canales se ven, en qué orden, y los gestos (tocar, mantener apretado para elegir varios, deslizar)
// siguen en app.ts, que escucha en #cards.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { stripDisplayPrefix } from '../../../core/src/index.ts';
import {
  eventLabel, eventOf, GOOD, groupLabel, groupOf, guideLabel, info, PAGE, qualityTitle, render as renderAll, sectionTitle,
  selection, state, viewMode, type Band,
} from '../app.ts';
import { Logo, RowNow } from './epg.tsx';
import { Icon } from './icon.tsx';
import { Progress, Skeleton } from './kit.tsx';

const box = () => document.getElementById('cards')!;

let lastList: number[] = [];

/** Dibuja la lista: las primeras `state.shown` filas de `list`. Es la misma instancia de Preact en cada dibujo (sin
 *  `key` que cambie): lo que ya está en pantalla no se vuelve a crear, y las alturas medidas se conservan. */
export function renderCards(list: number[]) {
  lastList = list;
  render(<Cards list={list} shown={state.shown} />, box());
}

/** Vuelve a dibujar las mismas filas, por ejemplo al elegir una en el modo selección o al sumar las siguientes al bajar. */
export function refreshCards() {
  render(<Cards list={lastList} shown={state.shown} />, box());
}

/** Mientras se abre la configuración. */
export function renderSkeleton() {
  lastList = [];
  render(<Skeleton />, box());
}

/** Lo que se dibuja, en orden: un encabezado de categoría cada vez que cambia (con búsqueda la lista es plana) y las filas. */
interface Item { key: string; i: number; head?: { g: string; n: number } }

function itemsOf(list: number[], shown: number, headers: boolean): Item[] {
  const counts = new Map<string, number>();
  if (headers) for (const i of list) if (!info(state.channels[i]).divider) counts.set(groupOf(state.channels[i]), (counts.get(groupOf(state.channels[i])) ?? 0) + 1);
  const out: Item[] = [];
  for (let k = 0; k < Math.min(shown, list.length); k++) {
    const ch = state.channels[list[k]];
    if (headers && !info(ch).divider) {
      const g = groupOf(ch);
      const prev = k > 0 ? state.channels[list[k - 1]] : null;
      if (!prev || info(prev).divider || groupOf(prev) !== g) out.push({ key: `h${k}`, i: -1, head: { g, n: counts.get(g) ?? 0 } });
    }
    out.push({ key: `c${list[k]}`, i: list[k] });
  }
  return out;
}

// ------------------------------------------------------------------ virtualización (vista de filas)
// Solo se pintan las filas que entran en pantalla, con un margen. Lo demás es un hueco de la altura que tendría (como en
// la Guía). Las alturas se miden al pintar y se recuerdan por fila; lo que todavía no se vio usa una estimación.

/** Margen en px arriba y abajo de la pantalla, para que al bajar rápido no aparezca un hueco. */
const OVERSCAN = 600;
/** Altura antes de medir: una fila o un encabezado de categoría. */
const EST = { row: 61, head: 34 };
/** Alturas medidas, por clave de fila, para el modo y el ancho actuales (si cambian, se miden de nuevo). */
let heights = new Map<string, number>();
let heightsSig = '';

/** `offs[k]` es la altura de todo lo que está antes de `items[k]`; `offs[n]` es el total. */
function offsetsOf(items: Item[]): number[] {
  const offs = new Array<number>(items.length + 1);
  let y = 0;
  items.forEach((it, k) => {
    offs[k] = y;
    y += heights.get(it.key) ?? (it.head ? EST.head : EST.row);
  });
  offs[items.length] = y;
  return offs;
}

/** Los ítems que entran en pantalla (con el margen): del primero visible (`a`) hasta `b` sin incluir. */
function windowOf(items: Item[], offs: number[]): [number, number] {
  const n = items.length;
  const top = box().getBoundingClientRect().top + window.scrollY; // dónde empieza la lista en el documento
  const vt = window.scrollY - top;
  const vb = vt + window.innerHeight;
  let a = 0;
  while (a < n - 1 && offs[a + 1] <= vt - OVERSCAN) a++;
  let b = a + 1;
  while (b < n && offs[b] < vb + OVERSCAN) b++;
  return [a, b];
}

/** Mide las filas pintadas. Devuelve true si alguna altura cambió (hay que volver a calcular los huecos). */
function measure(): boolean {
  let changed = false;
  for (const el of Array.from(box().children) as HTMLElement[]) {
    const key = el.dataset.i ? `c${el.dataset.i}` : el.dataset.k;
    if (!key) continue;
    const h = el.getBoundingClientRect().height;
    if (h && heights.get(key) !== h) {
      heights.set(key, h);
      changed = true;
    }
  }
  return changed;
}

const sameRange = (x: [number, number], y: [number, number]) => x[0] === y[0] && x[1] === y[1];

/** Filas con un encabezado de categoría (fijo al bajar) cada vez que cambia. Con búsqueda la lista es plana. */
function Cards({ list, shown }: { list: number[]; shown: number }) {
  const mode = viewMode();
  const windowed = mode !== 'grid'; // la vista de logos es una cuadrícula: se pinta entera, como antes
  const headers = !state.search.trim();
  const sig = `${mode}|${window.innerWidth}`;
  if (sig !== heightsSig) {
    heights = new Map();
    heightsSig = sig;
  }
  const items = list.length ? itemsOf(list, shown, headers) : [];
  const [win, setWin] = useState<[number, number]>([0, 40]);
  const [, bump] = useState(0);
  const latest = useRef({ items, windowed });
  latest.current = { items, windowed };

  // Al cambiar algo se calcula qué se ve, antes de pintar: no se ve el hueco.
  useLayoutEffect(() => {
    const v = latest.current;
    if (!v.windowed || !v.items.length) return;
    const changed = measure();
    const next = windowOf(v.items, offsetsOf(v.items));
    if (changed) bump((x) => x + 1);
    setWin((prev) => (sameRange(prev, next) ? prev : next));
  });

  // Al bajar (o subir), se recalcula como mucho una vez por cuadro.
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const v = latest.current;
      if (!v.windowed || !v.items.length) return;
      const next = windowOf(v.items, offsetsOf(v.items));
      setWin((prev) => (sameRange(prev, next) ? prev : next));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const onResize = () => bump((x) => x + 1);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  if (!list.length) return <Empty />;
  const n = items.length;
  const a = windowed ? Math.max(0, Math.min(win[0], n - 1)) : 0;
  const b = windowed ? Math.min(Math.max(win[1], a + 1), n) : n;
  const offs = windowed ? offsetsOf(items) : [];
  // El encabezado de la categoría de la primera fila visible se queda pegado arriba, como sin virtualizar: se pinta
  // aunque su categoría empiece antes del rango. Los huecos mantienen la altura de lo que no se pinta.
  let stuck = -1;
  if (windowed && headers) for (let h = a; h >= 0; h--) if (items[h].head) { stuck = h; break; }
  const row = (it: Item) => (it.head
    ? <div key={it.key} class="cat-head" data-k={it.key} role="heading" aria-level={3}><span>{groupLabel(it.head.g)}</span><small>{it.head.n}</small></div>
    : <Card key={it.key} i={it.i} />);
  const gap = (key: string, px: number) => (px > 0 ? <div key={key} class="cards-gap" aria-hidden="true" style={{ height: `${px}px` }} /> : null);
  const out = [];
  if (!windowed) for (const it of items) out.push(row(it));
  else {
    const from = stuck >= 0 ? stuck : a;
    out.push(gap('top', offs[from]));
    if (stuck >= 0 && stuck < a) {
      out.push(row(items[stuck]));
      out.push(gap('mid', offs[a] - offs[stuck + 1]));
    }
    for (let k = a; k < b; k++) out.push(row(items[k]));
    out.push(gap('bottom', offs[n] - offs[b]));
  }
  return <>{out}</>;
}

/** Estado a la derecha de la fila: solo lo que pide atención. Lo que está bien lleva una tilde. */
function StatusMark({ band, score }: { band: Band; score?: number }) {
  const pct = score && score > 0 ? Math.round(Math.min(score, 1) * 100) : 0;
  switch (band) {
    case 'ok': return <span class="ok-mark" title={`Coincidencia buena${pct ? `: ${pct} %` : ''}`}><Icon name="check" class="sm" /></span>;
    case 'warn': return <span class="pct warn" title="Coincidencia dudosa: conviene revisarla">{pct ? `${pct} %` : 'Dudoso'}</span>;
    case 'none': return <span class="tag bad">Sin EPG</span>;
    default: return null; // a mano o sin guía a propósito: se ve al abrir el canal
  }
}

function Card({ i }: { i: number }) {
  const ch = state.channels[i];
  const { edit, epg, hidden, band, suggestion, divider, auto, q } = info(ch);
  const ev = eventOf(ch);
  const shown = edit.name || ev?.clean || stripDisplayPrefix(ch.name, state.rules!)[0];
  const sel = selection.active;
  const picked = selection.items.has(i);
  const selBox = sel && <span class="sel-box" aria-hidden="true"><Icon name={picked ? 'square-check' : 'square'} /></span>;
  const cls = `${hidden ? ' is-hidden' : ''}${sel ? ' selectable' : ''}${picked ? ' selected' : ''}`;
  if (divider) {
    const title = sectionTitle(groupLabel(groupOf(ch)));
    return (
      <article class={`card section-card${cls}`} data-i={i} tabindex={0} role="button" aria-label={`Separador ${title}`}>
        {selBox}
        <div class="card-title"><div class="section-name">{title}</div>
          <div class="card-sub"><span>Separador de sección{shown !== groupOf(ch) && shown !== groupLabel(groupOf(ch)) ? ` · ${shown}` : ''}</span>
            {hidden && <span class="pill muted"><Icon name="eye-off" class="sm" />Oculto</span>}</div></div>
      </article>
    );
  }
  const guideName = epg ? guideLabel(epg) : '';
  const cc = epg ? state.index?.country.get(epg) : undefined;
  const sug = !epg && !edit.manual ? suggestion : null;
  const marks = [state.newNames.has(ch.name) ? 'nuevo' : '', edit.group ? 'movido' : '', hidden ? 'oculto' : '']
    .filter(Boolean).map((m) => <span key={m} class="mark">{m}</span>);
  let guide;
  if (sug) {
    guide = <span class="guide sug"><span class={`pct ${sug.score >= GOOD ? 'ok' : 'warn'}`}>{Math.round(Math.min(sug.score, 1) * 100)} %</span> <b>{guideLabel(sug.channelId)}</b></span>;
  } else if (epg) {
    guide = <span class="guide"><Icon name="arrow-right" class="sm" /><span class="guide-name">{guideName}</span>{cc && <span class="cc">{cc.toUpperCase()}</span>}</span>;
  } else if (ev && !edit.manual) {
    const l = eventLabel(ev.start);
    guide = <span class={`guide event ${l.cls}`} title="Hora de tu dispositivo (según la zona del proveedor)"><Icon name="clock" class="sm" />{l.text}</span>;
  } else {
    guide = <span class="guide none">{edit.manual ? 'Sin guía' : 'Sin guía asignada'}</span>;
  }
  const label = `${shown}${q ? `, ${q.label}` : ''}, ${epg ? `guía ${guideName}` : 'sin guía'}${hidden ? ', oculto' : ''}`;
  return (
    <article class={`card row-card${cls}`} data-i={i} tabindex={0} role="button" aria-label={label}>
      <span class="swipe-bg" aria-hidden="true"><span class="sw sw-r"><Icon name="ban" />Sin guía</span><span class="sw sw-l"><Icon name={hidden ? 'eye' : 'eye-off'} />{hidden ? 'Mostrar' : 'Ocultar'}</span></span>
      <div class="row-in">
        {selBox}
        <Logo id={epg} custom={edit.customLogo} label={shown} />
        <div class="card-title"><div class="card-name">{shown}</div><div class="row-sub">{q && <span class={`qtag${q.label === '4K' ? ' k4' : ''}`} title={qualityTitle(q)}>{q.label}</span>}{guide}{marks}
          {/* Con búsqueda la lista queda plana (sin encabezados de categoría): se muestra de cuál es. */}
          {state.search.trim() && <span class="where">{groupLabel(groupOf(ch))}</span>}</div>
          {viewMode() === 'detail' && epg && <RowNow id={epg} />}</div>
        {sug ? <button type="button" class="btn btn-gray sm" data-use={i}>Usar</button> : <StatusMark band={band} score={auto?.score} />}
        <button type="button" class="icon-btn sm row-more" data-more={i} aria-label={`Más acciones: ${shown}`} aria-haspopup="menu"><Icon name="ellipsis" /></button>
      </div>
    </article>
  );
}

/** Vacío con el motivo y, si hay algo para quitar, el botón que lo quita. */
function Empty() {
  if (!state.channels.length) {
    return <div class="empty"><Icon name="inbox" class="lg" /><strong>No hay canales</strong>Volvé a cargar la lista del proveedor (Configuración).</div>;
  }
  const f = state.filter;
  const q = state.search.trim();
  const why = q ? `Nada coincide con “${q}”.`
    : f === 'ocultos' ? 'No ocultaste ningún canal.'
    : f === 'manual' ? 'Todavía no elegiste ninguna guía a mano.'
    : f === 'editados' ? 'Todavía no editaste ningún canal.'
    : f === 'sin-epg' ? '¡Todos los canales tienen guía!'
    : f === 'sin-prog' ? '¡Todos los canales tienen programación!'
    : f === 'caidos' ? 'No hay canales caídos entre los que ya se probaron.'
    : f === 'revisar' ? '¡No queda nada por revisar!'
    : f === 'nuevos' ? 'No hay canales nuevos.'
    : 'Ningún canal coincide con el filtro.';
  const clear = () => {
    state.search = '';
    (document.getElementById('searchBox') as HTMLInputElement).value = '';
    state.filter = 'todos';
    state.shown = PAGE;
    renderAll();
  };
  return (
    <div class="empty"><Icon name="inbox" class="lg" /><strong>Nada por acá</strong>{why}
      {(q || f !== 'todos') && <button type="button" class="btn btn-tonal" data-clear-filters onClick={clear}>Ver todos los canales</button>}</div>
  );
}

// ------------------------------------------------------------------ tarjeta de revisión y canales nuevos
export interface ReviewCardProps {
  left: number; base: number; done: number; pct: number;
  /** Canales nuevos de esta apertura de la app (el aviso va solo la primera vez). */
  news: number; onNewFilter: boolean;
  onStart: () => void; onShowNew: () => void; onSeen: () => void;
}

/** Arriba de la lista: cuántos canales quedan por revisar, con la barra de avance, y el aviso de canales nuevos. */
export function renderReviewCard(p: ReviewCardProps) {
  const card = document.getElementById('reviewCard')!;
  card.hidden = !p.left && !p.news;
  render(card.hidden ? null : <ReviewCard {...p} />, card);
}

function ReviewCard({ left, base, done, pct, news, onNewFilter, onStart, onShowNew, onSeen }: ReviewCardProps) {
  return (
    <>
      {left > 0 && (
        <>
          <div class="rv-top">
            <div class="rv-text"><strong>{left === 1 ? '1 canal' : `${left} canales`} para revisar</strong>
              <small>{done ? `${done} de ${base} revisados` : 'Tienen una guía dudosa o sin asignar'}</small></div>
            <button type="button" class="btn btn-primary" onClick={onStart}>Empezar</button>
          </div>
          <Progress cls="rv-bar" value={pct} label="Progreso de la revisión" />
        </>
      )}
      {news > 0 && (
        <div class={`rv-new${left ? ' split' : ''}`}>
          <Icon name="sparkles" /><span class="grow">{news === 1 ? '1 canal nuevo' : `${news} canales nuevos`} en tu lista</span>
          {!onNewFilter && <button type="button" class="btn btn-tonal sm" onClick={onShowNew}>Ver</button>}
          <button type="button" class="btn btn-plain sm" onClick={onSeen}>Marcar como vistos</button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ menú «…» de una fila
export interface MenuItem { icon: string; text: string; run: () => void }

/** Menú flotante junto a `anchor` (el «…» de una fila, para usar con mouse): se cierra al elegir, al tocar afuera o
 *  con Esc (que devuelve el foco al «…»). */
export function openRowMenu(anchor: HTMLElement, items: MenuItem[]) {
  let host = document.getElementById('rowMenuHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'rowMenuHost';
    document.body.appendChild(host);
  }
  const h = host;
  render(null, h);
  render(<RowMenu anchor={anchor} items={items} close={() => render(null, h)} />, h);
}

function RowMenu({ anchor, items, close }: { anchor: HTMLElement; items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.querySelector<HTMLElement>('button')!.focus();
    const away = (ev: Event) => { if (!menu.contains(ev.target as Node)) close(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      close();
      anchor.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  }, []);
  return (
    <div class="row-menu" role="menu" ref={ref}>
      {items.map((it) => (
        <button key={it.text} type="button" role="menuitem" onClick={() => { close(); it.run(); }}><Icon name={it.icon} class="sm" />{it.text}</button>
      ))}
    </div>
  );
}
