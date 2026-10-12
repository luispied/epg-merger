// Los filtros de la lista de Canales y del modo ver, en Preact (ver planes/react.md): el botón de filtros con su contador,
// la fila de chips de lo que está puesto (cada uno se quita con su ×) y la hoja para elegir el estado y las categorías.
// Lo que filtra la lista lo decide quien la dibuja (app.ts o ver.tsx); acá solo se muestra y se avisa lo que se toca.
// En el modo ver no hay estados (no se cambia nada): la hoja muestra solo las categorías, igual que en la edición.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';

export interface FilterOption { key: string; label: string; count?: number }
export interface FilterModel {
  /** El estado elegido ('todos' si ninguno). */
  filter: string;
  /** Las categorías elegidas (vacío = todas). */
  cats: string[];
  /** Los estados que se ofrecen; vacío = la hoja no muestra la sección de estado (modo ver). */
  states: FilterOption[];
  /** Las categorías visibles que se ofrecen. */
  categories: FilterOption[];
  /** Los géneros elegidos y los que se ofrecen (solo la Guía: Canales no los usa; sin `genres`, no hay sección). */
  genres?: string[];
  genreOptions?: FilterOption[];
}
export interface FilterHandlers {
  onState: (key: string) => void;
  onCats: (cats: string[]) => void;
  onGenres?: (genres: string[]) => void;
}

/** Cuántos filtros hay puestos: el estado (si no es «Todos»), cada categoría y cada género. */
function activeCount(m: FilterModel) {
  return (m.filter !== 'todos' ? 1 : 0) + m.cats.length + (m.genres?.length ?? 0);
}
const clearAll = (h: FilterHandlers) => { h.onState('todos'); h.onCats([]); h.onGenres?.([]); };
const countOf = (c: FilterOption) => (c.count === undefined ? null : <span class="n">{c.count}</span>);

/** Dibuja los dos controles en su sitio: el botón (en la barra de la búsqueda) y la fila de chips debajo. */
export function renderFilterBar(m: FilterModel, h: FilterHandlers, button: HTMLElement, row: HTMLElement) {
  render(<FilterToggle model={m} handlers={h} />, button);
  row.hidden = activeCount(m) === 0;
  render(<ActiveFilters model={m} handlers={h} />, row);
}

/** El botón de filtros con su contador, y la hoja que abre (la hoja la controla el propio botón). */
export function FilterToggle({ model: m, handlers: h, openSignal }: { model: FilterModel; handlers: FilterHandlers; openSignal?: number }) {
  const [open, setOpen] = useState(false);
  // Quien dibuja puede pedir abrir la hoja (por ejemplo, desde el aviso de Tu noche) con un número nuevo.
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const n = activeCount(m);
  return (
    <>
      <button type="button" class="icon-btn filter-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={n ? `Filtrar, ${n} ${n === 1 ? 'activo' : 'activos'}` : 'Filtrar'} title="Filtrar" onClick={() => setOpen(true)}>
        <Icon name="list-filter" />
        {n > 0 && <span class="count" aria-hidden="true">{n}</span>}
      </button>
      {open && <FilterSheet model={m} handlers={h} close={() => setOpen(false)} />}
    </>
  );
}

/** La fila de chips de lo puesto, debajo de la búsqueda. Sin nada puesto, no ocupa lugar. */
export function ActiveFilters({ model: m, handlers: h }: { model: FilterModel; handlers: FilterHandlers }) {
  const n = activeCount(m);
  if (!n) return null;
  const clear = () => clearAll(h);
  const stateLabel = m.states.find((s) => s.key === m.filter)?.label ?? m.filter;
  return (
    <>
      {m.filter !== 'todos' && (
        <button type="button" class="chip-btn" aria-pressed="true" onClick={() => h.onState('todos')}>
          {stateLabel}<span class="x" aria-hidden="true"><Icon name="x" /></span><span class="sr-only">Quitar</span>
        </button>
      )}
      {m.cats.map((c) => {
        const name = m.categories.find((x) => x.key === c)?.label ?? c;
        return (
          <button type="button" class="chip-btn" aria-pressed="true" key={c} onClick={() => h.onCats(m.cats.filter((x) => x !== c))}>
            {name}<span class="x" aria-hidden="true"><Icon name="x" /></span><span class="sr-only">Quitar</span>
          </button>
        );
      })}
      {(m.genres ?? []).map((g) => (
        <button type="button" class="chip-btn" aria-pressed="true" key={`g:${g}`} onClick={() => h.onGenres?.(m.genres!.filter((x) => x !== g))}>
          {g}<span class="x" aria-hidden="true"><Icon name="x" /></span><span class="sr-only">Quitar</span>
        </button>
      ))}
      {n > 1 && <button type="button" class="clear-all" onClick={clear}>Quitar todos</button>}
    </>
  );
}

function FilterSheet({ model: m, handlers: h, close }: { model: FilterModel; handlers: FilterHandlers; close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const pick = (c: string) => h.onCats(m.cats.includes(c) ? m.cats.filter((x) => x !== c) : [...m.cats, c]);
  const pickGenre = (g: string) => h.onGenres?.(m.genres!.includes(g) ? m.genres!.filter((x) => x !== g) : [...m.genres!, g]);
  const n = activeCount(m);
  return (
    <dialog class="sheet settings-sheet filter-sheet" ref={dlg} onClose={close} aria-labelledby="filterTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="filterTitle">Filtrar</h2>
          <button type="button" class="icon-btn" aria-label="Cerrar" onClick={() => dlg.current?.close()}><Icon name="x" /></button>
        </div>
        {m.states.length > 0 && (
          <>
            <h3 class="sec-title">Estado</h3>
            <div class="filter-chips">
              {m.states.map((s) => (
                <button type="button" class="chip-btn" key={s.key} aria-pressed={m.filter === s.key} onClick={() => h.onState(s.key)}>
                  {s.label}{countOf(s)}
                </button>
              ))}
            </div>
          </>
        )}
        <h3 class="sec-title">Categorías</h3>
        <div class="filter-chips">
          {m.categories.map((c) => (
            <button type="button" class="chip-btn" key={c.key} aria-pressed={m.cats.includes(c.key)} onClick={() => pick(c.key)}>
              {c.label}{countOf(c)}
            </button>
          ))}
        </div>
        {m.genreOptions && m.genres && (
          <>
            <h3 class="sec-title">Géneros</h3>
            {m.genreOptions.length
              ? (
                <div class="filter-chips">
                  {m.genreOptions.map((g) => (
                    <button type="button" class="chip-btn" key={g.key} aria-pressed={m.genres!.includes(g.key)} onClick={() => pickGenre(g.key)}>
                      {g.label}{countOf(g)}
                    </button>
                  ))}
                </div>
              )
              : <p class="help">Todavía no hay géneros para elegir en lo que se ve.</p>}
          </>
        )}
        <div class="gc-foot">
          <button type="button" class="btn btn-gray" onClick={() => clearAll(h)} disabled={!n}>Quitar filtros</button>
          <button type="button" class="btn btn-primary" onClick={() => dlg.current?.close()}>Listo</button>
        </div>
      </div>
    </dialog>
  );
}
