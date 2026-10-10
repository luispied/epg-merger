// Categorías: la lista (con secciones plegables, arrastrar para ordenar y deslizar para ocultar o dejar sin guía), la hoja
// de una categoría y la de ordenar sus canales, en Preact (ver planes/react.md). Lo que cambia la configuración (mover,
// renombrar, ocultar, borrar, el orden de los canales) y los gestos de arrastrar y deslizar siguen en app.ts.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { stripDisplayPrefix } from '../../../core/src/index.ts';
import { parseEvent } from '../../src/events.ts';
import {
  applyRename, collapsedSections, createGroup, deleteGroup, eventTz, fold, groupChannels, groupLabel, groupOf, groups,
  isLoneHeader, moveGroup, openDock, openHelp, plural, saveCollapsed, sectionHeaders, sectionTitle, setChannelOrder, setupDrag,
  state, toggleGroupHidden, toggleGroupNoEpg, unrenameGroup, wireSwipe,
} from '../app.ts';
import { Icon } from './icon.tsx';

const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement;
const bodyOf = (id: string) => dlg(id).querySelector<HTMLElement>('.sheet-body')!;

// ------------------------------------------------------------------ la lista
let query = ''; // el buscador de la hoja (vacío al abrirla)

/** Abre Categorías desde la barra de abajo, sin filtro. */
export function openCategories() {
  query = '';
  renderCategories();
  openDock(dlg('categoriesDialog'));
}

/** Vuelve a dibujar la hoja (al cambiar algo de las categorías). Es sincrónico: el foco del teclado se puede mover
 *  enseguida a la fila que se acaba de mover. */
export function renderCategories() {
  render(<Categories q={query} />, bodyOf('categoriesDialog'));
}

function Categories({ q: rawQ }: { q: string }) {
  const titleRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const swiped = useRef<() => boolean>(() => false);

  useEffect(() => {
    // Las secciones quedan ancladas justo debajo del título fijo de la hoja.
    const title = titleRef.current!;
    let ro: ResizeObserver | undefined;
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(() => dlg('categoriesDialog').style.setProperty('--cat-title-h', `${title.offsetHeight}px`));
      ro.observe(title);
    }
    const box = boxRef.current!;
    setupDrag(box, '.cat-row:not([hidden])', (from, to) => moveGroup(Number(from.dataset.g), Number(to.dataset.g)), (row, up) => {
      const i = Number(row.dataset.g);
      const list = groups();
      const headers = sectionHeaders();
      let j = i + (up ? -1 : 1);
      // Una sección baja saltando la siguiente entera.
      if (!up && headers.has(list[i]) && !isLoneHeader(list, i, headers)) while (j < list.length && !headers.has(list[j])) j++;
      if (j < 0 || j >= list.length) return;
      const moved = list[i];
      moveGroup(i, j);
      const k = groups().indexOf(moved);
      box.querySelector<HTMLElement>(`.cat-row[data-g="${k}"] .drag-handle`)?.focus();
    });
    // Deslizar una categoría: izquierda = ocultar o mostrar, derecha = sin guía (no en las secciones).
    swiped.current = wireSwipe(box, '.cat-row', (row) => toggleGroupHidden(groups()[Number(row.dataset.g)]), (row) => {
      const g = groups()[Number(row.dataset.g)];
      if (!sectionHeaders().has(g)) toggleGroupNoEpg(g);
    }, (row) => !sectionHeaders().has(groups()[Number(row.dataset.g)]));
    return () => ro?.disconnect();
  }, []);

  const list = groups();
  const hidden = new Set(state.cfg!.groups.hidden);
  const noEpg = new Set(state.cfg!.groups.noEpg ?? []);
  const headers = sectionHeaders();
  const collapsed = collapsedSections();
  const counts = new Map<string, number>();
  for (const ch of state.channels) counts.set(groupOf(ch), (counts.get(groupOf(ch)) ?? 0) + 1);
  const q = fold(rawQ.trim());
  // Categorías que tiene cada sección (hasta la siguiente), y a qué sección pertenece cada una.
  const owner = new Map<string, string>();
  const size = new Map<string, number>();
  let current = '';
  for (const g of list) {
    if (headers.has(g)) {
      current = g;
      size.set(g, 0);
    } else if (current) {
      owner.set(g, current);
      size.set(current, (size.get(current) ?? 0) + 1);
    }
  }
  // Con un filtro el orden no se puede arrastrar (se movería entre categorías que no se ven).
  const rows = list.map((g, i) => ({ g, i })).filter(({ g }) => !q || fold(`${groupLabel(g)} ${g}`).includes(q));
  const folded = (g: string) => !q && !headers.has(g) && collapsed.has(owner.get(g) ?? '\u0000');
  const marks = (g: string) => [state.newGroups.has(g) ? 'nueva' : '', noEpg.has(g) ? 'sin guía' : '', hidden.has(g) ? 'oculta' : '']
    .filter(Boolean).map((m) => <span key={m} class="mark">{m}</span>);
  const swipe = (g: string, section: boolean) => (
    <span class="swipe-bg" aria-hidden="true">
      {!section && <span class="sw sw-r"><Icon name="ban" />{noEpg.has(g) ? 'Pedir guía' : 'Sin guía'}</span>}
      <span class="sw sw-l"><Icon name={hidden.has(g) ? 'eye' : 'eye-off'} />{hidden.has(g) ? 'Mostrar' : 'Ocultar'}</span>
    </span>
  );
  const nHidden = list.filter((g) => hidden.has(g) && !headers.has(g)).length;
  const nCats = list.filter((g) => !headers.has(g)).length;
  // Contraer o expandir todas las secciones, según lo que haya.
  const sections = list.filter((g) => headers.has(g) && (size.get(g) ?? 0) > 0);
  const allFolded = sections.length > 0 && sections.every((g) => collapsed.has(g));

  const foldAll = () => {
    const withMembers = list.filter((g, i) => headers.has(g) && i + 1 < list.length && !headers.has(list[i + 1]));
    saveCollapsed(allFolded ? new Set() : new Set(withMembers));
    renderCategories();
  };
  const onClick = (ev: MouseEvent) => {
    if (swiped.current()) return;
    const t = ev.target as HTMLElement;
    const foldBtn = t.closest<HTMLElement>('[data-fold]');
    if (foldBtn) {
      const g = groups()[Number(foldBtn.dataset.fold)];
      const set = collapsedSections();
      if (!set.delete(g)) set.add(g);
      saveCollapsed(set);
      renderCategories();
      return;
    }
    if (t.closest('.drag-handle')) return;
    const row = t.closest<HTMLElement>('.cat-row');
    if (row) openCategoryMenu(Number(row.dataset.g));
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement;
    if (ev.key === 'Enter' && t.matches('.cat-row')) openCategoryMenu(Number(t.dataset.g));
  };

  return (
    <>
      <div class="title-row" ref={titleRef}>
        <span class="title-left">
          <h2 id="categoriesTitle">Categorías</h2>
          <button type="button" class="icon-btn" aria-label="Cómo funciona" title="Cómo funciona" onClick={() => openHelp('categories', '#categoriesDialog')}><Icon name="circle-help" /></button>
        </span>
        <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        <p class="meta-line">{`${plural(nCats, 'categoría', 'categorías')}${nHidden ? ` · ${plural(nHidden, 'oculta', 'ocultas')}` : ''}`}</p>
      </div>
      <label class="search-field cat-filter">
        <Icon name="search" />
        <input type="search" placeholder="Buscar categoría" autocomplete="off" value={rawQ} onInput={(ev) => {
          query = ev.currentTarget.value;
          renderCategories();
        }} />
      </label>
      <div class="ch-chips cat-chips">
        <button type="button" class="chip-btn" onClick={() => createGroup('category')}><Icon name="folder-plus" />Categoría</button>
        <button type="button" class="chip-btn" onClick={() => createGroup('separator')}><Icon name="separator-horizontal" />Sección</button>
        <button type="button" class="chip-btn" hidden={!sections.length} onClick={foldAll}
          aria-label={allFolded ? 'Expandir todas las secciones' : 'Contraer todas las secciones'}>
          <Icon name={allFolded ? 'chevrons-up-down' : 'chevrons-down-up'} />{allFolded ? 'Desplegar todo' : 'Plegar todo'}
        </button>
      </div>
      <div class="menu" id="categoriesList" ref={boxRef} onClick={onClick} onKeyDown={onKeyDown}>
        {rows.length ? rows.map(({ g, i }) => {
          const section = headers.has(g);
          const name = section ? sectionTitle(groupLabel(g)) : groupLabel(g);
          return (
            <div key={g} class={`menu-row static cat-row${section ? ' section-row' : ''}${hidden.has(g) ? ' is-off' : ''}`} data-g={i} tabindex={0}
              role="button" aria-label={section ? `${name}, sección` : name} hidden={folded(g)}>
              {swipe(g, section)}
              <div class="row-in">
                {!q && (
                  <button type="button" class="drag-handle" title="Arrastrá para cambiar el orden"
                    aria-label={section ? `Mover la sección ${name}` : `Mover ${name} (arrastrá, o flechas del teclado)`}><Icon name="grip-vertical" /></button>
                )}
                {section && (
                  <button type="button" class="icon-btn sm fold-btn" data-fold={i} aria-expanded={!collapsed.has(g)}
                    aria-label={`${collapsed.has(g) ? 'Expandir' : 'Contraer'} la sección ${name}`}><Icon name={collapsed.has(g) ? 'chevron-right' : 'chevron-down'} /></button>
                )}
                {section
                  ? <span class="menu-text"><span class="section-name">{name}</span><small>{plural(size.get(g) ?? 0, 'categoría', 'categorías')}{marks(g)}</small></span>
                  : <span class="menu-text">{name}<small>{plural(counts.get(g) ?? 0, 'canal', 'canales')}{marks(g)}</small></span>}
                <Icon name="chevron-right" class="go" />
              </div>
            </div>
          );
        }) : <p class="help">Ninguna categoría coincide.</p>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ la hoja de una categoría
// Con el mismo patrón que la del canal: arriba el nombre (se edita tocándolo) con ‹ › para ir a la anterior o siguiente;
// después los interruptores y, al final, «Más opciones». Todo se guarda solo.
let catMoreOpen = false;
let menuIndex = 0;

export function openCategoryMenu(i: number) {
  menuIndex = i;
  render(<CategoryMenu i={i} />, bodyOf('catMenuDialog'));
  const d = dlg('catMenuDialog');
  if (!d.open) d.showModal();
}
const again = () => openCategoryMenu(menuIndex);

function CategoryMenu({ i }: { i: number }) {
  const list = groups();
  const g = list[i];
  const isSection = sectionHeaders().has(g);
  const noEpg = !!state.cfg!.groups.noEpg?.includes(g);
  const hidden = state.cfg!.groups.hidden.includes(g);
  const mine = new Set([...(state.cfg!.groups.custom ?? []), ...(state.cfg!.groups.separators ?? [])]);
  const members = state.channels.filter((ch) => groupOf(ch) === g).length;
  const renamed = !!state.cfg!.groups.rename?.[g];
  const label = isSection ? sectionTitle(groupLabel(g)) : groupLabel(g);
  const act = (fn: (g: string) => void) => () => {
    dlg('catMenuDialog').close();
    fn(g);
  };
  const row = (icon: string, text: string, onClick: () => void, cls = '') => (
    <button type="button" class={`menu-row ${cls}`} onClick={onClick}><span class="menu-icon"><Icon name={icon} /></span><span class="menu-text">{text}</span></button>
  );
  const sw = (text: string, small: string, cls: string, on: boolean, toggle: (g: string) => void) => (
    <label class="opt-row"><span>{text}{small && <small>{small}</small>}</span>
      <input type="checkbox" class={`switch ${cls}`} role="switch" checked={on} onChange={() => { toggle(g); again(); }} /></label>
  );
  // Ocultar y «sin guía» se hacen deslizando la fila; acá quedan plegados (teclado y lectores de pantalla).
  const extra = [
    renamed && row('rotate-ccw', 'Volver al nombre original', act(unrenameGroup)),
    mine.has(g) && members === 0 && row('trash-2', 'Borrar', act(deleteGroup), 'danger'),
  ].filter(Boolean);

  return (
    <>
      <div class="title-row ch-head">
        <button type="button" class="icon-btn" title="Anterior" aria-label="Categoría anterior" disabled={i <= 0} onClick={() => openCategoryMenu(i - 1)}><Icon name="chevron-left" /></button>
        <input id="catMenuName" class="ch-name" autocomplete="off" enterkeyhint="done" aria-label="Nombre en la playlist" value={label}
          placeholder={isSection ? sectionTitle(g) : g}
          onChange={(ev) => { applyRename(g, ev.currentTarget.value); again(); }}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); } }} />
        <button type="button" class="icon-btn" title="Siguiente" aria-label="Categoría siguiente" disabled={i >= list.length - 1} onClick={() => openCategoryMenu(i + 1)}><Icon name="chevron-right" /></button>
        <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
      </div>
      <div id="catMenuBody">
        <div class="ch-meta"><span class="prov">{isSection ? 'Sección' : plural(members, 'canal', 'canales')}{renamed ? ` · en el proveedor: ${isSection ? sectionTitle(g) : g}` : ''}</span></div>
        {!isSection && <div class="menu">{row('list-ordered', 'Ordenar los canales', act(openChannelOrder))}</div>}
        <div class="opt-group">
          {sw('Visible en la playlist', '', 'cat-visible', !hidden, toggleGroupHidden)}
          {!isSection && sw('Sin guía', 'No necesita guía de programación', 'cat-noepg', noEpg, toggleGroupNoEpg)}
        </div>
        {extra.length > 0 && (
          <details class="ch-more" open={catMoreOpen} onToggle={(ev) => { catMoreOpen = ev.currentTarget.open; }}>
            <summary>Más opciones<Icon name="chevron-down" class="sm" /></summary>
            <div class="menu">{extra}</div>
          </details>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ ordenar los canales de una categoría
// Se abre desde la hoja de la categoría: «‹» vuelve a esa hoja y «×» cierra.
let orderGroup = '';

export function openChannelOrder(g: string) {
  orderGroup = g;
  renderChannelOrder(g);
  dlg('orderDialog').showModal();
}

/** Vuelve a dibujar el orden (sincrónico: el foco pasa enseguida a la fila movida). */
export function renderChannelOrder(g: string) {
  render(<ChannelOrder g={g} />, bodyOf('orderDialog'));
}

function ChannelOrder({ g }: { g: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current!;
    const move = (from: number, to: number) => {
      const names = groupChannels(orderGroup);
      const [n] = names.splice(from, 1);
      names.splice(to, 0, n);
      setChannelOrder(orderGroup, names, 'Orden de canales guardado');
      body.querySelector<HTMLElement>(`.ord-row[data-k="${to}"] .drag-handle`)?.focus();
    };
    setupDrag(body, '.ord-row', (a, b) => move(Number(a.dataset.k), Number(b.dataset.k)), (row, up) => {
      const k = Number(row.dataset.k);
      const j = k + (up ? -1 : 1);
      if (j >= 0 && j < body.querySelectorAll('.ord-row').length) move(k, j);
    });
  }, []);

  const names = groupChannels(g);
  const custom = !!state.cfg!.groups.channels?.[g];
  return (
    <>
      <div class="title-row">
        <span class="title-left">
          <button type="button" class="icon-btn" aria-label="Volver" title="Volver" onClick={() => {
            const idx = groups().indexOf(g);
            dlg('orderDialog').close();
            if (idx >= 0) openCategoryMenu(idx);
          }}><Icon name="chevron-left" /></button>
          <h2 id="orderTitle" class="menu-title">{groupLabel(g)}</h2>
        </span>
        <button type="button" class="icon-btn" aria-label="Cerrar" title="Cerrar" onClick={() => dlg('orderDialog').close()}><Icon name="x" /></button>
      </div>
      <div id="orderBody" ref={bodyRef}>
        <p class="help">Arrastrá desde <span class="inline-icon"><Icon name="grip-vertical" /></span> para ordenar los canales de esta categoría en la playlist. Los canales nuevos del proveedor van al final.</p>
        <div class="menu" id="orderList">{names.map((n, k) => {
          const shown = state.cfg!.channels[n]?.name || parseEvent(n, eventTz(), Date.now())?.clean || stripDisplayPrefix(n, state.rules!)[0];
          return (
            <div key={n} class="menu-row static ord-row" data-k={k}>
              <button type="button" class="drag-handle" aria-label={`Mover ${shown}`}><Icon name="grip-vertical" /></button>
              <span class="menu-text">{shown}</span>
            </div>
          );
        })}</div>
        {custom && <div class="row-actions"><button type="button" class="btn btn-plain" onClick={() => setChannelOrder(g, null, 'Vuelve al orden del proveedor')}>Volver al orden del proveedor</button></div>}
      </div>
    </>
  );
}
