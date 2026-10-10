// La lista de Canales, en Preact (ver planes/react.md): las filas (o tarjetas), con un encabezado de categoría cada vez
// que cambia, el vacío con su motivo, el esqueleto mientras carga, la tarjeta de revisión de arriba y el menú «…» de
// una fila. Qué canales se ven, en qué orden, y los gestos (tocar, mantener apretado para elegir varios, deslizar)
// siguen en app.ts, que escucha en #cards.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { stripDisplayPrefix } from '../../../core/src/index.ts';
import {
  eventLabel, eventOf, GOOD, groupLabel, groupOf, guideLabel, info, PAGE, qualityTitle, render as renderAll, sectionTitle,
  selection, state, viewMode, type Band,
} from '../app.ts';
import { Logo, RowNow } from './epg.tsx';
import { Icon } from './icon.tsx';

const box = () => document.getElementById('cards')!;

let seq = 0;
let lastList: number[] = [];

/** Dibuja la lista de cero (como antes el innerHTML): las primeras `state.shown` filas de `list`. */
export function renderCards(list: number[]) {
  lastList = list;
  render(<Cards key={++seq} list={list} shown={state.shown} />, box());
}

/** Vuelve a dibujar las mismas filas, por ejemplo al elegir una en el modo selección o al sumar las siguientes al bajar:
 *  las que ya estaban no se tocan. */
export function refreshCards() {
  render(<Cards key={seq} list={lastList} shown={state.shown} />, box());
}

/** Mientras se abre la configuración. */
export function renderSkeleton() {
  lastList = [];
  render(<Skeleton key={++seq} />, box());
}

function Skeleton() {
  return (
    <>
      {[0, 1, 2, 3].map((k) => <div key={k} class="skeleton"><div class="bar w60" /><div class="bar w40" /><div class="bar block" /></div>)}
    </>
  );
}

/** Filas con un encabezado de categoría (fijo al bajar) cada vez que cambia. Con búsqueda la lista es plana. */
function Cards({ list, shown }: { list: number[]; shown: number }) {
  if (!list.length) return <Empty />;
  const headers = !state.search.trim();
  const counts = new Map<string, number>();
  if (headers) for (const i of list) if (!info(state.channels[i]).divider) counts.set(groupOf(state.channels[i]), (counts.get(groupOf(state.channels[i])) ?? 0) + 1);
  const out = [];
  for (let k = 0; k < Math.min(shown, list.length); k++) {
    const ch = state.channels[list[k]];
    if (headers && !info(ch).divider) {
      const g = groupOf(ch);
      const prev = k > 0 ? state.channels[list[k - 1]] : null;
      if (!prev || info(prev).divider || groupOf(prev) !== g) {
        out.push(<div key={`h${k}`} class="cat-head" role="heading" aria-level={3}><span>{groupLabel(g)}</span><small>{counts.get(g) ?? 0}</small></div>);
      }
    }
    out.push(<Card key={list[k]} i={list[k]} />);
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
          <div class="rv-bar" role="progressbar" aria-label="Progreso de la revisión" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
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
