// El aviso de arriba («Listo…», «No se pudo…»), en Preact: la primera pieza de la web hecha con
// componentes (ver planes/react.md). Se ve y se comporta igual que el de antes.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon } from './icon.tsx';

type Kind = 'ok' | 'bad' | 'info';
const KIND_ICON: Record<Kind, string> = { ok: 'circle-check', bad: 'circle-x', info: 'info' };

/** Lo que hace el botón del aviso: «Deshacer» (una función) o una acción con su propio texto. */
type Action = (() => void) | { label: string; run: () => void };

function Toast({ text, kind, ms, undo, close }: { text: string; kind: Kind; ms: number; undo?: Action; close: () => void }) {
  useEffect(() => {
    const t = setTimeout(close, ms);
    return () => clearTimeout(t);
  }, []);
  return (
    <div class={`toast ${kind}`} role={kind === 'bad' ? 'alert' : undefined}>
      <Icon name={KIND_ICON[kind]} />
      <span class="msg">{text}</span>
      {undo && (
        <button type="button" class="btn btn-plain" data-undo onClick={() => { close(); (typeof undo === 'function' ? undo : undo.run)(); }}>
          {typeof undo === 'function' ? 'Deshacer' : undo.label}
        </button>
      )}
      <button type="button" class="icon-btn toast-close" aria-label="Cerrar el aviso" title="Cerrar" onClick={close}>
        <Icon name="x" />
      </button>
    </div>
  );
}

let seq = 0;

/** `undo`: agrega "Deshacer" (o, con { label, run }, un botón con ese texto); el aviso dura más. */
export function toast(text: string, kind: Kind = 'info', ms = 3500, undo?: Action) {
  ms = Math.max(ms, Math.min(12000, 2500 + text.length * 45)); // los largos se leen enteros
  if (undo) ms = Math.max(ms, 7000);
  // Dentro del diálogo abierto, si hay uno: si no, queda tapado por el fondo del diálogo.
  const host = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop() ?? document.body;
  let box = host.querySelector<HTMLElement>('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('aria-live', 'polite'); // dentro de una hoja también se anuncia
    host.appendChild(box);
  }
  // En la capa de arriba de todo (popover): así no lo tapa la página o la hoja que esté abierta ni la barra de abajo.
  // Cerrarlo y abrirlo de nuevo lo pone encima de lo último que se abrió. Los navegadores sin popover lo dejan fijo, como antes.
  if (typeof box.showPopover === 'function') {
    box.setAttribute('popover', 'manual');
    try {
      if (box.matches(':popover-open')) box.hidePopover();
      box.showPopover();
    } catch { /* sin popover: queda fijo arriba igual */ }
  }
  // Un solo aviso a la vez: el nuevo reemplaza al anterior (no se apilan sobre la lista). La key
  // nueva hace que sea otro componente, con su propio tiempo.
  const id = ++seq;
  const target = box;
  const close = () => { if (target.dataset.toast === String(id)) render(null, target); };
  target.dataset.toast = String(id);
  render(<Toast key={id} text={text} kind={kind} ms={ms} undo={undo} close={close} />, target);
}
