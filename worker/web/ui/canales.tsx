// La lista de Canales, en Preact (ver planes/react.md): las filas (o tarjetas), con un encabezado de categoría cada vez
// que cambia, el vacío con su motivo y el esqueleto mientras carga. Qué canales se ven, en qué orden, y los gestos
// (tocar, mantener apretado para elegir varios, deslizar, el menú «…») siguen en app.ts, que escucha en #cards.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { stripDisplayPrefix } from '../../../core/src/index.ts';
import {
  eventLabel, eventOf, GOOD, groupLabel, groupOf, guideLabel, info, logosOn, PAGE, render as renderAll, sectionTitle, selection,
  state, viewMode, type Band,
} from '../app.ts';
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

/** Sin imagen: iniciales sobre un color que sale del nombre (se distingue una fila de otra). */
function Mono({ label }: { label: string }) {
  const words = label.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return <Icon name="tv" />;
  const ini = (words[0][0] + (words.length > 1 ? words[1][0] : (words[0][1] ?? ''))).toUpperCase();
  let h = 0;
  for (const c of words.join(' ')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span class="mono" style={`--h:${h}`} aria-hidden="true">{ini}</span>;
}

/** El logo del canal (el propio, o el de la guía), sobre las iniciales mientras carga o si no hay. */
function Logo({ id, custom, label }: { id: string | null; custom?: string; label: string }) {
  const url = !logosOn() ? '' : custom || (id ? state.index?.icon.get(id) : '');
  return (
    <span class="logo ">
      <Mono label={label} />
      {url && <img src={url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />}
    </span>
  );
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
  const { edit, epg, hidden, band, suggestion, divider, auto } = info(ch);
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
  const label = `${shown}, ${epg ? `guía ${guideName}` : 'sin guía'}${hidden ? ', oculto' : ''}`;
  return (
    <article class={`card row-card${cls}`} data-i={i} tabindex={0} role="button" aria-label={label}>
      <span class="swipe-bg" aria-hidden="true"><span class="sw sw-r"><Icon name="ban" />Sin guía</span><span class="sw sw-l"><Icon name={hidden ? 'eye' : 'eye-off'} />{hidden ? 'Mostrar' : 'Ocultar'}</span></span>
      <div class="row-in">
        {selBox}
        <Logo id={epg} custom={edit.customLogo} label={shown} />
        <div class="card-title"><div class="card-name">{shown}</div><div class="row-sub">{guide}{marks}
          {/* Con búsqueda la lista queda plana (sin encabezados de categoría): se muestra de cuál es. */}
          {state.search.trim() && <span class="where">{groupLabel(groupOf(ch))}</span>}</div>
          {viewMode() === 'detail' && epg && <div class="row-now"><span class="epg-now" data-now-for={epg} data-compact="row" /></div>}</div>
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
