// La ayuda de nowline: una sola página para el editor (Perfil > Aplicación) y para el modo ver (su Configuración). El
// contenido está en ayuda.html, una sección por pantalla; acá se muestra la del modo que corresponde y el buscador.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import AYUDA from './ayuda.html';
import { Icon, hydrateIcons } from './icon.tsx';

export function AyudaPage({ modo }: { modo: 'editor' | 'ver' }) {
  const body = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [vacia, setVacia] = useState(false);
  useLayoutEffect(() => {
    hydrateIcons(body.current!);
  }, []);
  // Filtra por texto: oculta las secciones del otro modo y las que no coinciden; con una búsqueda abre lo que coincide.
  useLayoutEffect(() => {
    const termino = q.trim().toLowerCase();
    let visibles = 0;
    for (const sec of body.current!.querySelectorAll<HTMLElement>('section[data-pantalla]')) {
      const coincide = !termino || sec.textContent!.toLowerCase().includes(termino);
      sec.hidden = sec.dataset.modo !== modo || !coincide;
      if (!sec.hidden) visibles++;
      for (const d of sec.querySelectorAll('details')) {
        d.dataset.abierta ??= d.open ? '1' : '';
        d.open = termino ? d.textContent!.toLowerCase().includes(termino) : d.dataset.abierta === '1';
      }
    }
    setVacia(visibles === 0);
  }, [q, modo]);
  return (
    <div class="ayuda">
      <label class="ayuda-buscar">
        <Icon name="search" />
        <input type="search" placeholder="Buscar en la ayuda" autocomplete="off" aria-label="Buscar en la ayuda" value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </label>
      {vacia ? <p class="help">Ninguna sección coincide con «{q.trim()}».</p> : null}
      <div ref={body} dangerouslySetInnerHTML={{ __html: AYUDA }} />
    </div>
  );
}
