// Hojas (<dialog class="sheet">): que se vayan con una animación y no de golpe, y que en el celular se bajen arrastrando
// la manija o el encabezado, como una hoja de iOS. Va para todas las hojas sin tocar cada una: la ✕ (los
// <form method="dialog">), Esc, el arrastre y también dlg.close() desde el código (se envuelve HTMLDialogElement.close:
// la hoja sigue abierta los 180 ms de la salida; si se vuelve a abrir mientras sale, la salida se cancela). No aplica a
// las páginas (Categorías, Perfil) ni al panel anclado del escritorio.

const OUT_MS = 180;          // lo que dura la salida (en web.css, .closing)
const DRAG_CLOSE = 110;      // px hacia abajo para que, al soltar, se cierre
const FLING = 0.6;           // px/ms: un tirón rápido cierra aunque se haya movido poco
const HANDLE = 36;           // px desde el borde de arriba de la hoja que cuentan como manija

// Lo que había antes de installSheets (app.ts ya envuelve showModal y show para acomodar el foco): se envuelve encima.
let nativeClose = HTMLDialogElement.prototype.close;
const pending = new WeakMap<HTMLDialogElement, number>();

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => matchMedia('(max-width: 600px)').matches;
const docked = (d: HTMLDialogElement) => d.classList.contains('docked') && matchMedia('(min-width: 1100px) and (hover: hover)').matches;

function isSheet(el: unknown): el is HTMLDialogElement {
  return el instanceof HTMLDialogElement && el.open && el.classList.contains('sheet') && !el.classList.contains('page') && !docked(el);
}

/** Cierra la hoja con su animación de salida (con «reducir movimiento», enseguida). */
export function closeSheet(d: HTMLDialogElement, value?: string) {
  if (!d.open || pending.has(d)) return;
  if (reduced() || !d.isConnected) {
    nativeClose.call(d, value);
    return;
  }
  d.classList.add('closing');
  pending.set(d, window.setTimeout(() => {
    pending.delete(d);
    d.classList.remove('closing');
    d.style.removeProperty('translate');
    if (d.open) nativeClose.call(d, value);
  }, OUT_MS));
}

/** Si una hoja que está saliendo se vuelve a abrir, se queda: se cancela la salida. */
function cancelClosing(d: HTMLDialogElement): boolean {
  const t = pending.get(d);
  if (t === undefined) return false;
  clearTimeout(t);
  pending.delete(d);
  d.classList.remove('closing');
  d.style.removeProperty('translate');
  return true;
}

/** Arrastre de la hoja hacia abajo, desde la manija o el encabezado (no desde un botón o un campo). */
function startDrag(e: PointerEvent) {
  if (e.button !== 0 || !phone()) return;
  const target = e.target as HTMLElement;
  const d = target.closest('dialog');
  if (!isSheet(d) || pending.has(d)) return;
  if (target.closest('button, a, input, select, textarea, label, summary, [contenteditable]')) return;
  const top = d.getBoundingClientRect().top;
  // El encabezado es la primera fila de título de la hoja (en algunas, adentro de un cuerpo que pinta Preact).
  const row = target.closest('.title-row');
  const inHead = !!row && d.querySelector('.title-row') === row;
  if (!inHead && e.clientY - top > HANDLE) return;
  const y0 = e.clientY;
  let dy = 0;
  let last = { y: y0, t: e.timeStamp };
  let speed = 0;
  d.classList.add('dragging');
  const move = (ev: PointerEvent) => {
    dy = Math.max(0, ev.clientY - y0);
    speed = (ev.clientY - last.y) / Math.max(1, ev.timeStamp - last.t);
    last = { y: ev.clientY, t: ev.timeStamp };
    d.style.translate = `0 ${dy}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    d.classList.remove('dragging');
    if (dy > DRAG_CLOSE || (dy > 24 && speed > FLING)) {
      closeSheet(d);
    } else if (dy > 0) {
      // Vuelve a su lugar.
      d.classList.add('settling');
      d.style.translate = '0 0';
      setTimeout(() => { d.classList.remove('settling'); d.style.removeProperty('translate'); }, 200);
    } else {
      d.style.removeProperty('translate');
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** showModal() y show() enfocan el primer elemento de la hoja (la ✕, el ojo, la ayuda, el nombre editable del
 *  canal o el buscador) y queda el aro de foco o el teclado abierto sin que nadie haya tocado nada. Si el foco
 *  cae en un botón, en el nombre de un canal o categoría o en un buscador, pasa a la hoja misma; los demás
 *  campos (por ejemplo, el de un diálogo que pide un nombre) conservan su foco. */
function settleFocus(dlg: HTMLDialogElement) {
  const a = document.activeElement;
  const field = a instanceof HTMLElement && a.matches('input, textarea, select') && !a.classList.contains('ch-name') && !a.closest('.search-field');
  if (a instanceof HTMLElement && dlg.contains(a) && !field) {
    dlg.tabIndex = -1;
    dlg.focus({ preventScroll: true });
  }
}

let installed = false;

/** Se llama una vez al arrancar (editor y modo ver). */
export function installSheets() {
  if (installed) return;
  installed = true;
  nativeClose = HTMLDialogElement.prototype.close;
  const prevShowModal = HTMLDialogElement.prototype.showModal;
  const prevShow = HTMLDialogElement.prototype.show;
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, value?: string) {
    if (isSheet(this)) closeSheet(this, value);
    else nativeClose.call(this, value);
  };
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    if (!cancelClosing(this)) prevShowModal.call(this);
    settleFocus(this);
  };
  HTMLDialogElement.prototype.show = function (this: HTMLDialogElement) {
    if (!cancelClosing(this)) prevShow.call(this);
    settleFocus(this);
  };
  // Al cerrar una hoja el navegador devuelve el foco a la fila que la abrió y queda marcada en la grilla:
  // se lo saca (el teclado sigue pudiendo moverse con Tab desde ahí).
  document.addEventListener('close', (ev) => {
    if (!(ev.target instanceof HTMLDialogElement)) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.matches('.card, .cat-row, .row-card, .section-card')) a.blur();
  }, true);
  // Esc.
  document.addEventListener('cancel', (e) => {
    if (!isSheet(e.target)) return;
    e.preventDefault();
    closeSheet(e.target);
  }, true);
  // La ✕ y los botones de las hojas que cierran (<form method="dialog">), con su valor (lo usa «¿Seguro?»).
  document.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (form.method !== 'dialog') return;
    const d = form.closest('dialog');
    if (!isSheet(d)) return;
    e.preventDefault();
    closeSheet(d, (e.submitter as HTMLButtonElement | null)?.value ?? '');
  }, true);
  document.addEventListener('pointerdown', startDrag, true);
}
