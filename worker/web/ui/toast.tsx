// El aviso de abajo («Listo…», «No se pudo…»), en Preact: la primera pieza de la web hecha con
// componentes (ver planes/react.md). Se ve y se comporta igual que el de antes.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon } from './icon.tsx';

type Kind = 'ok' | 'bad' | 'info';
const KIND_ICON: Record<Kind, string> = { ok: 'circle-check', bad: 'circle-x', info: 'info' };

function Toast({ text, kind, ms, undo, close }: { text: string; kind: Kind; ms: number; undo?: () => void; close: () => void }) {
  useEffect(() => {
    const t = setTimeout(close, ms);
    return () => clearTimeout(t);
  }, []);
  return (
    <div class={`toast ${kind}`}>
      <Icon name={KIND_ICON[kind]} />
      <span class="msg">{text}</span>
      {undo && (
        <button type="button" class="btn btn-plain" data-undo onClick={() => { close(); undo(); }}>Deshacer</button>
      )}
      <button type="button" class="icon-btn toast-close" aria-label="Cerrar el aviso" title="Cerrar" onClick={close}>
        <Icon name="x" />
      </button>
    </div>
  );
}

let seq = 0;

/** `undo`: agrega "Deshacer" (el aviso dura más). */
export function toast(text: string, kind: Kind = 'info', ms = 3500, undo?: () => void) {
  ms = Math.max(ms, Math.min(12000, 2500 + text.length * 45)); // los largos se leen enteros
  if (undo) ms = Math.max(ms, 7000);
  // Dentro del diálogo abierto, si hay uno: si no, queda tapado por el fondo del diálogo.
  const host = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop() ?? document.body;
  let box = host.querySelector<HTMLElement>('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    host.appendChild(box);
  }
  // Un solo aviso a la vez: el nuevo reemplaza al anterior (no se apilan sobre la lista). La key
  // nueva hace que sea otro componente, con su propio tiempo.
  const id = ++seq;
  const target = box;
  const close = () => { if (target.dataset.toast === String(id)) render(null, target); };
  target.dataset.toast = String(id);
  render(<Toast key={id} text={text} kind={kind} ms={ms} undo={undo} close={close} />, target);
}
