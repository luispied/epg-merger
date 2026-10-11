// La hoja de un canal (o de un separador de sección), en Preact (ver planes/react.md). Arriba el nombre (se edita
// tocándolo) con ‹ › para ir al anterior o siguiente y, debajo, de qué proveedor es y su categoría; después la guía
// asignada y las otras opciones; al final, «Más opciones». Todo se guarda solo. En modo «Revisar» recorre los canales
// dudosos de a uno, con «Está bien» como acción principal.
//
// La guía asignada y las opciones usan las piezas de ui/epg.tsx (logo, lo que está dando, opción elegible, buscador
// y programación del día), las mismas que la lista de canales y la hoja de la selección.
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { flagToCountryCode, stripDisplayPrefix } from '../../../core/src/index.ts';
import {
  autoEpg, chooseEpg, editChannels, eventLabel, eventOf, GOOD, groupLabel, groupOf, groups, guideLabel, info, matchesFilter,
  newCategoryName, noEpg, openDock, reviewList, reviewProgress, sectionHeaders, sectionTitle, state, visibleChannels, type ChannelEdit,
} from '../app.ts';
import { Candidate, DayProgram, GuideSearch, Logo, NowLine } from './epg.tsx';
import { Icon } from './icon.tsx';
import { Progress } from './kit.tsx';
import { toast } from './toast.tsx';

const dialog = () => document.getElementById('channelDialog') as HTMLDialogElement;

/** Canales entre los que se puede ir con ‹ › (la lista que se estaba viendo al abrir). */
let sheetList: number[] = [];
/** Modo «Revisar»: la hoja recorre los canales dudosos de a uno. */
let sheetReview = false;
let sheetMoreOpen = false;
let current = -1;
let seq = 0;

/** Vuelve a dibujar la hoja abierta (después de deshacer un cambio). */
export function refreshChannelSheet() {
  if (dialog().open && current >= 0) openChannel(current);
}

/** Empieza la revisión de los canales dudosos, desde el primero. */
export function startReview() {
  sheetList = reviewList();
  if (!sheetList.length) return;
  sheetReview = true;
  openChannel(sheetList[0]);
}

export function openChannel(i: number) {
  const ch = state.channels[i];
  if (!sheetList.includes(i)) {
    sheetList = visibleChannels().filter((k) => !info(state.channels[k]).divider);
    if (info(ch).divider || !sheetList.includes(i)) sheetList = [i];
  }
  current = i;
  const dlg = dialog();
  render(<ChannelSheet i={i} seq={++seq} />, dlg.querySelector('.sheet-body')!);
  if (!dlg.open) {
    dlg.addEventListener('close', () => { current = -1; sheetList = []; sheetReview = false; }, { once: true });
    openDock(dlg);
  }
}

function ChannelSheet({ i, seq: key }: { i: number; seq: number }) {
  const ch = state.channels[i];
  const { edit, divider } = info(ch);
  const evSheet = eventOf(ch);
  const defaultName = evSheet?.clean || stripDisplayPrefix(ch.name, state.rules!)[0];
  const shownDefault = divider ? sectionTitle(groupLabel(groupOf(ch))) : defaultName;
  const pos = sheetList.indexOf(i);
  const prev = sheetList[pos - 1];
  const next = sheetList[pos + 1];
  const rp = !divider && sheetReview ? reviewProgress() : null;

  const commitName = (input: HTMLInputElement) => {
    const v = input.value.trim();
    const name = v && v !== shownDefault ? v : undefined;
    if (name === (edit.name || undefined)) {
      input.value = edit.name || shownDefault;
      return;
    }
    editChannels([ch], (e) => { e.name = name; }, name ? 'Nombre guardado' : 'Vuelve al nombre del proveedor');
    openChannel(i);
  };

  return (
    <>
      <div class="title-row ch-head">
        <button type="button" class="icon-btn" id="channelPrev" title="Canal anterior" aria-label="Canal anterior" disabled={prev === undefined}
          onClick={() => { if (prev !== undefined) openChannel(prev); }}><Icon name="chevron-left" /></button>
        <input id="channelName" class="ch-name" autocomplete="off" enterkeyhint="done" aria-label="Nombre del canal"
          value={edit.name || shownDefault} placeholder={shownDefault}
          onChange={(ev) => commitName(ev.currentTarget)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); } }} />
        <button type="button" class="icon-btn" id="channelNext" title="Canal siguiente" aria-label="Canal siguiente" disabled={next === undefined}
          onClick={() => { if (next !== undefined) openChannel(next); }}><Icon name="chevron-right" /></button>
        <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        {/* El progreso va en el encabezado fijo de la hoja (no se tapa al desplazar). */}
        <div class="rv-progress" id="channelProgress" hidden={!rp}>
          {rp && <>
            <span>Revisando · {pos + 1} de {sheetList.length} · quedan {rp.left}</span>
            <Progress cls="rv-bar" value={rp.pct} label="Progreso de la revisión" />
          </>}
        </div>
      </div>
      <ChannelBody key={key} i={i} pos={pos} />
    </>
  );
}

function ChannelBody({ i, pos }: { i: number; pos: number }) {
  const ch = state.channels[i];
  const { edit, auto, epg, hidden, divider, suggestion } = info(ch);
  const categoryLabel = groupLabel(groupOf(ch));
  const catHidden = hidden && !edit.hidden;
  const needsReview = !divider && matchesFilter(ch, 'revisar');
  const headers = sectionHeaders();

  const update = (fn: (e: ChannelEdit) => void, msg?: string) => editChannels([ch], fn, msg);
  const again = () => openChannel(i);
  /** Después de resolver un canal: en la revisión pasa al siguiente que falta; si no, cierra. */
  const afterReview = () => {
    if (sheetReview) {
      const nextUp = sheetList.slice(pos + 1).find((k) => matchesFilter(state.channels[k], 'revisar'));
      if (nextUp !== undefined) {
        openChannel(nextUp);
        return;
      }
      dialog().close();
      toast('¡Listo! Revisaste todos los canales', 'ok');
      return;
    }
    dialog().close();
  };

  const onClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    const rv = t.closest<HTMLElement>('[data-rv]')?.dataset.rv;
    if (rv) {
      if (rv === 'ok') {
        const target = epg ?? suggestion?.channelId;
        if (target) chooseEpg(ch, target, epg ? 'Guía confirmada' : 'Sugerencia aplicada');
      } else if (rv === 'no-epg') {
        update(noEpg, 'Quedó sin guía');
      }
      afterReview();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'auto') {
      update((e) => autoEpg(e, ch), 'Volvió a la guía automática');
      again();
    } else if (act === 'no-epg') {
      update(noEpg, 'Quedó sin guía');
      again();
    }
  };
  const pick = (id: string) => {
    chooseEpg(ch, id, 'Guía elegida');
    if (sheetReview) afterReview();
    else again();
  };

  // De qué proveedor es y su categoría (se cambia desde el chip).
  const hiddenCats = new Set(state.cfg!.groups.hidden);
  const categories = groups().filter((g) => g === groupOf(ch) || (!headers.has(g) && !hiddenCats.has(g)));
  const meta = (
    <div class="ch-meta"><span class="prov" title="Nombre en el proveedor">{ch.name}</span>
      <label class="cat-chip" title="Categoría"><Icon name="folder-input" class="sm" /><span class="cat-chip-text">{categoryLabel}</span><Icon name="chevron-down" class="sm" />
        <select class="move" aria-label="Categoría" value={groupOf(ch)} onChange={async (ev) => {
          const select = ev.currentTarget;
          let target = select.value;
          if (target === '__new__') {
            target = (await newCategoryName()) ?? '';
            if (!target) {
              select.value = groupOf(ch);
              return;
            }
          }
          update((e) => { e.group = target === ch.category ? undefined : target; }, `Movido a ${target}`);
          again();
        }}>
          {categories.map((g) => <option key={g} value={g}>{headers.has(g) ? sectionTitle(groupLabel(g)) : groupLabel(g)}</option>)}
          <option value="__new__">Nueva categoría…</option>
        </select></label>
    </div>
  );
  const more = (
    <details class="ch-more" open={sheetMoreOpen || !!edit.hidden || !!edit.customLogo} onToggle={(ev) => { sheetMoreOpen = ev.currentTarget.open; }}>
      <summary>Más opciones{edit.hidden ? ' · oculto' : ''}{edit.customLogo ? ' · logo propio' : ''}<Icon name="chevron-down" class="sm" /></summary>
      <label class="opt-row"><span>Visible en la playlist{catHidden && <small>Oculto porque su categoría está oculta</small>}</span>
        <input type="checkbox" class="switch ch-visible" role="switch" checked={!hidden} disabled={catHidden} onChange={(ev) => {
          const on = ev.currentTarget.checked;
          update((e) => { e.hidden = on ? undefined : true; }, on ? 'Visible' : 'Oculto');
        }} /></label>
      {!divider && (
        <label class="field"><span>Logo propio</span>
          <input class="input custom-logo" type="url" inputmode="url" value={edit.customLogo ?? ''} placeholder="https://…/logo.png" aria-label="Dirección de la imagen del logo"
            onChange={(ev) => {
              const v = ev.currentTarget.value.trim();
              if (v && !/^https?:\/\/\S+$/i.test(v)) {
                toast('Tiene que ser una dirección http:// o https://', 'bad');
                return;
              }
              update((e) => { e.customLogo = v || undefined; }, v ? 'Logo guardado' : 'Vuelve al logo de la guía');
              again();
            }} />
          <small class="help">Dirección de una imagen. Se guarda al terminar de escribir.</small></label>
      )}
    </details>
  );

  if (divider) {
    return (
      <div id="channelBody" onClick={onClick}>
        {meta}<p class="help">Separador de sección del proveedor: no es un canal y no lleva guía.</p>{more}
      </div>
    );
  }

  // Con varias opciones de igual puntaje, primero las del país de la categoría (marcado en la etiqueta).
  const home = flagToCountryCode(ch.category, state.rules!)?.toLowerCase() ?? null;
  const isHome = (id: string) => !!home && state.index?.country.get(id)?.toLowerCase() === home;
  const ranked = (auto?.ranked ?? []).filter((c) => c.channelId !== edit.epg)
    .map((c, k) => ({ c, k })).sort((a, b) => (Math.abs(b.c.score - a.c.score) < 0.02 ? Number(isHome(b.c.channelId)) - Number(isHome(a.c.channelId)) : 0) || a.k - b.k)
    .map(({ c }) => c);
  // El resalte solo aporta cuando hay opciones de otros países mezcladas.
  const mixedCountries = ranked.slice(0, 5).some((c) => !isHome(c.channelId));
  // Con pie de revisión, las decisiones (usar sugerencia, sin guía, saltar) viven solo ahí.
  const hasActions = needsReview || sheetReview;
  const footerNoEpg = hasActions && !(!epg && edit.manual);
  const useSuggestion = !epg && !!suggestion;
  const okLabel = useSuggestion ? 'Usar sugerencia' : needsReview || epg ? 'Está bien' : 'Siguiente';

  return (
    <div id="channelBody" onClick={onClick}>
      {meta}
      <h3 class="sec-title">Guía asignada</h3>
      <div class={`ch-current${epg ? '' : ' none'}`}><Current i={i} hasActions={hasActions} onPick={pick} /></div>
      <h3 class="sec-title">Otras opciones</h3>
      <GuideSearch placeholder="Buscar otra guía: canal o programa" label="Buscar otra guía" onPick={pick}>
        <div class="ch-chips">
          <button type="button" class="chip-btn" data-act="auto" disabled={!edit.manual}><Icon name="undo-2" class="sm" />Automática</button>
          {!footerNoEpg && <button type="button" class="chip-btn" data-act="no-epg" disabled={!epg && !!edit.manual}><Icon name="ban" class="sm" />Sin guía</button>}
        </div>
      </GuideSearch>
      {ranked.length > 0 && <div class="list opts">
        {ranked.slice(0, 5).map((c) => <Candidate key={c.channelId} id={c.channelId} score={c.score} home={mixedCountries ? home : null} onPick={pick} />)}
      </div>}
      {more}
      {hasActions && (
        <div class="rv-actions">
          <button type="button" class="btn btn-primary" data-rv="ok"><Icon name="check" />{okLabel}</button>
          {footerNoEpg && <button type="button" class="btn btn-gray" data-rv="no-epg">Sin guía</button>}
          {sheetReview && <button type="button" class="btn btn-gray" data-rv="skip">Saltar</button>}
        </div>
      )}
    </div>
  );
}

/** La guía asignada (o la nota de que no tiene, con la sugerencia), con lo que está dando y la programación del día. */
function Current({ i, hasActions, onPick }: { i: number; hasActions: boolean; onPick: (id: string) => void }) {
  const ch = state.channels[i];
  const { edit, auto, epg, suggestion } = info(ch);
  const evSheet = eventOf(ch);
  if (epg) {
    const guideName = guideLabel(epg);
    const cc = state.index?.country.get(epg);
    // Estado de la guía asignada: un chip arriba a la derecha (la tarjeta es neutra; el color va solo en el chip).
    const score = !edit.manual && auto?.cid === edit.epg && auto ? Math.round(Math.min(auto.score, 1) * 100) : 0;
    const stateChip = edit.manual
      ? <span class="gc-chip"><Icon name="user-check" class="sm" />Elegida por vos</span>
      : score ? (auto!.score >= GOOD
        ? <span class="gc-chip ok" title="Coincidencia buena"><Icon name="check" class="sm" />{score} %</span>
        : <span class="gc-chip warn" title="Coincidencia dudosa: conviene revisarla">{score} % · dudosa</span>) : null;
    return (
      <>
        <div class="gc-top"><Logo id={epg} label={guideName} /><div class="gc-main"><div class="gc-name"><span>{guideName}</span>{cc && <span class="cc">{cc.toUpperCase()}</span>}</div></div>{stateChip}</div>
        <NowLine id={epg} cls="gc-now" />
        <DayProgram id={epg} />
      </>
    );
  }
  const l = evSheet && !edit.manual ? eventLabel(evSheet.start) : null;
  return (
    <>
      <div class="card-note">{edit.manual ? 'Sin guía, a propósito.' : 'Sin guía asignada.'}</div>
      {l && <div class={`gc-event ${l.cls}`}><Icon name="clock" class="sm" /><span>{l.text}</span><small>hora de tu dispositivo</small></div>}
      {suggestion && (
        <div class="gc-sug">Sugerencia: <b>{guideLabel(suggestion.channelId)}</b> <span class={`pct ${suggestion.score >= GOOD ? 'ok' : 'warn'}`}>{Math.round(Math.min(suggestion.score, 1) * 100)} %</span>
          {!hasActions && <button type="button" class="btn btn-gray sm" data-pick={suggestion.channelId} onClick={() => onPick(suggestion.channelId)}>Usar</button>}</div>
      )}
    </>
  );
}
