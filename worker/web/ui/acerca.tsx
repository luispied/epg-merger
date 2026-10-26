import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icon.tsx';

/** El botón «Acerca de» al pie de Configuración (edición y modo ver): abre la hoja de abajo. */
export function AcercaDeLink() {
  const [abierta, setAbierta] = useState(false);
  return (
    <>
      <button type="button" class="link-btn" onClick={() => setAbierta(true)}>Acerca de</button>
      {abierta && <AcercaDe close={() => setAbierta(false)} />}
    </>
  );
}

/** «Acerca de»: de dónde vienen las sinopsis. Es el único lugar de la app que nombra la fuente. */
function AcercaDe({ close }: { close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  return (
    <dialog class="sheet settings-sheet" ref={dlg} onClose={close} aria-label="Acerca de">
      <div class="sheet-body">
        <div class="title-row">
          <h2>Acerca de</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <p>Las sinopsis de películas y series en español vienen de <b>The Movie Database (TMDB)</b>, guardadas para que la guía
          no tenga que consultarlas en vivo. Si una película o serie no tiene sinopsis ahí, se muestra el texto de la guía.</p>
        <p class="muted">nowline usa la API de TMDB, pero no está avalado ni certificado por TMDB.
          <a href="https://www.themoviedb.org" target="_blank" rel="noopener"> themoviedb.org</a></p>
      </div>
    </dialog>
  );
}
