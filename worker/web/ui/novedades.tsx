// Novedades: lo nuevo de cada versión (sale de public/novedades.json, que arma build.mjs a partir del CHANGELOG).
// Se abre desde Configuración («Ver novedades»); no aparece sola al abrir la app.
import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './icon.tsx';

export interface Novedad { version: string; items: string[] }

async function load(): Promise<Novedad[]> {
  try {
    const r = await fetch('/novedades.json', { cache: 'no-store' });
    return r.ok ? await r.json() as Novedad[] : [];
  } catch {
    return [];
  }
}

/** Desde Configuración: las últimas versiones, aunque ya se hayan visto. */
export async function openNovedades(current: string) {
  open((await load()).slice(0, 6), current);
}

function open(list: Novedad[], current: string) {
  let host = document.getElementById('novedadesHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'novedadesHost';
    document.body.appendChild(host);
  }
  const h = host;
  render(<Sheet key={Date.now()} list={list} close={() => render(null, h)} />, h);
}

/** **negrita** del CHANGELOG como <b>; el resto, texto. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p))}</>;
}

/** La primera frase (o el **título** del principio) se ve siempre; el resto, al tocarla. */
export function splitItem(text: string): [string, string] {
  // «**Título.** detalle»: la negrita es el título (solo si cierra con punto o dos puntos).
  const bold = /^\*\*([^*]+[.:])\*\*\s*(.*)$/.exec(text);
  if (bold) return [bold[1].replace(/[.:]$/, ''), bold[2]];
  // El primer corte (punto seguido de mayúscula, o dos puntos) que no quede dentro de un paréntesis.
  for (const m of text.matchAll(/(?:\.\s+(?=[A-ZÁÉÍÓÚÑ«¿])|:\s+)/g)) {
    const head = text.slice(0, m.index);
    if (head.length < 12 || (head.match(/\(/g)?.length ?? 0) !== (head.match(/\)/g)?.length ?? 0)) continue;
    const rest = text.slice(m.index + m[0].length);
    return [head, rest.replace(/^./, (c) => c.toUpperCase())];
  }
  return [text, ''];
}

function Item({ text }: { text: string }) {
  const [head, rest] = splitItem(text);
  if (!rest) return <span class="nv-head"><Rich text={head} /></span>;
  return (
    <details class="nv-item">
      <summary><span class="nv-head"><Rich text={head} /></span><Icon name="chevron-down" class="sm" /></summary>
      <p class="nv-more"><Rich text={rest} /></p>
    </details>
  );
}

function Sheet({ list, close }: { list: Novedad[]; close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  return (
    <dialog class="sheet settings-sheet nv-sheet" ref={dlg} onClose={close} aria-labelledby="nvTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="nvTitle">Novedades</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        {list.length ? list.map((n) => (
          <section class="nv-ver" key={n.version}>
            <h3 class="sec-title">Versión {n.version}</h3>
            <ul class="nv-list">{n.items.map((it, i) => <li key={i}><Item text={it} /></li>)}</ul>
          </section>
        )) : <p class="help">No se pudieron cargar las novedades. Probá de nuevo con conexión.</p>}
        <div class="nv-foot">
          <button type="button" class="btn btn-primary btn-block" onClick={() => dlg.current?.close()}>Listo</button>
        </div>
      </div>
    </dialog>
  );
}
