// Los filtros de la lista de Canales, en Preact (ver planes/react.md): el botón de filtros con su contador, la fila de
// chips de lo que está puesto (cada uno se quita con su ×) y la hoja para elegir el estado y las categorías. Lo que
// filtra la lista lo decide app.ts; acá solo se dibuja y se avisa lo que se toca.
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';

export interface FilterOption { key: string; label: string; count: number }
export interface FilterModel {
  /** El estado elegido ('todos' si ninguno). */
  filter: string;
  /** Las categorías elegidas (vacío = todas). */
  cats: string[];
  states: FilterOption[];
  categories: FilterOption[];
}
export interface FilterHandlers {
  onState: (key: string) => void;
  onCats: (cats: string[]) => void;
}

let handlers: FilterHandlers | null = null;
let model: FilterModel | null = null;
let sheetOpen = false;

/** Dónde se dibuja cada parte: el botón en la barra, la fila de chips debajo y la hoja al final de la página. */
export function setupFilters(h: FilterHandlers) {
  handlers = h;
}

export function renderFilters(m: FilterModel) {
  model = m;
  const btn = document.getElementById('filterMount');
  const row = document.getElementById('activeFilters');
  const sheet = document.getElementById('filterSheetMount');
  if (btn) render(<FilterButton />, btn);
  if (row) {
    row.hidden = activeCount(m) === 0;
    render(<ActiveFilters />, row);
  }
  if (sheet) render(<FilterSheet />, sheet);
}

/** Cuántos filtros hay puestos: el estado (si no es «Todos») y cada categoría. */
function activeCount(m: FilterModel) {
  return (m.filter !== 'todos' ? 1 : 0) + m.cats.length;
}

function label(m: FilterModel, key: string) {
  return m.states.find((s) => s.key === key)?.label ?? key;
}

function FilterButton() {
  const m = model!;
  const n = activeCount(m);
  const open = () => { sheetOpen = true; renderFilters(m); };
  return (
    <button type="button" class="icon-btn filter-btn" aria-haspopup="dialog" aria-expanded={sheetOpen}
      aria-label={n ? `Filtrar, ${n} activos` : 'Filtrar'} title="Filtrar" onClick={open}>
      <Icon name="list-filter" />
      {n > 0 && <span class="count" aria-hidden="true">{n}</span>}
    </button>
  );
}

function ActiveFilters() {
  const m = model!;
  const n = activeCount(m);
  if (!n) return null;
  const clear = () => { handlers!.onState('todos'); handlers!.onCats([]); };
  return (
    <>
      {m.filter !== 'todos' && (
        <button type="button" class="chip-btn" aria-pressed="true" onClick={() => handlers!.onState('todos')}>
          {label(m, m.filter)}<span class="x" aria-hidden="true"><Icon name="x" /></span><span class="sr-only">Quitar</span>
        </button>
      )}
      {m.cats.map((c) => {
        const name = m.categories.find((x) => x.key === c)?.label ?? c;
        return (
          <button type="button" class="chip-btn" aria-pressed="true" key={c}
            onClick={() => handlers!.onCats(m.cats.filter((x) => x !== c))}>
            {name}<span class="x" aria-hidden="true"><Icon name="x" /></span><span class="sr-only">Quitar</span>
          </button>
        );
      })}
      {n > 1 && <button type="button" class="clear-all" onClick={clear}>Quitar todos</button>}
    </>
  );
}

function FilterSheet() {
  const m = model!;
  const dlg = useRef<HTMLDialogElement>(null);
  const [, bump] = useState(0);
  useLayoutEffect(() => {
    if (sheetOpen && !dlg.current?.open) dlg.current?.showModal();
  });
  const close = () => { sheetOpen = false; dlg.current?.close(); };
  const pick = (c: string) => handlers!.onCats(m.cats.includes(c) ? m.cats.filter((x) => x !== c) : [...m.cats, c]);
  const n = activeCount(m);
  return (
    <dialog class="sheet settings-sheet filter-sheet" ref={dlg} onClose={() => { sheetOpen = false; bump((v) => v + 1); }} aria-labelledby="filterTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="filterTitle">Filtrar</h2>
          <button type="button" class="icon-btn" aria-label="Cerrar" onClick={close}><Icon name="x" /></button>
        </div>
        <h3 class="sec-title">Estado</h3>
        <div class="filter-chips">
          {m.states.map((s) => (
            <button type="button" class="chip-btn" key={s.key} aria-pressed={m.filter === s.key}
              onClick={() => handlers!.onState(s.key)}>{s.label}<span class="n">{s.count}</span></button>
          ))}
        </div>
        <h3 class="sec-title">Categorías</h3>
        <div class="filter-chips">
          {m.categories.map((c) => (
            <button type="button" class="chip-btn" key={c.key} aria-pressed={m.cats.includes(c.key)} onClick={() => pick(c.key)}>
              {c.label}<span class="n">{c.count}</span>
            </button>
          ))}
        </div>
        <div class="gc-foot">
          <button type="button" class="btn btn-gray" onClick={() => { handlers!.onState('todos'); handlers!.onCats([]); }} disabled={!n}>Quitar filtros</button>
          <button type="button" class="btn btn-primary" onClick={close}>Listo</button>
        </div>
      </div>
    </dialog>
  );
}
