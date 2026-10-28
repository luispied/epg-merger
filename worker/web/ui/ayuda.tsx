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
  // Filtra por texto: oculta las secciones del otro modo y, dentro de cada una, solo los párrafos y pasos que tienen la
  // palabra (o todos, si la coincidencia está en el título de la pantalla). Lo que coincide se abre y se resalta.
  useLayoutEffect(() => {
    const raiz = body.current!;
    const termino = q.trim().toLowerCase();
    sinResaltado(raiz);
    let visibles = 0;
    for (const sec of raiz.querySelectorAll<HTMLElement>('section[data-pantalla]')) {
      const titulo = sec.querySelector(':scope > h3');
      const tituloCoincide = !!termino && !!titulo?.textContent!.toLowerCase().includes(termino);
      let bloqueCoincide = false;
      for (const bloque of sec.children) {
        if (bloque === titulo) continue;
        const coincide = !termino || tituloCoincide || bloque.textContent!.toLowerCase().includes(termino);
        (bloque as HTMLElement).hidden = !coincide;
        if (coincide) bloqueCoincide = true;
        if (bloque instanceof HTMLDetailsElement) {
          bloque.dataset.abierta ??= bloque.open ? '1' : '';
          bloque.open = termino ? coincide : bloque.dataset.abierta === '1';
        }
      }
      sec.hidden = sec.dataset.modo !== modo || !(!termino || tituloCoincide || bloqueCoincide);
      if (!sec.hidden) {
        visibles++;
        if (termino) resaltar(sec, termino);
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

/** Saca los resaltados de la búsqueda anterior y deja el texto como estaba. */
function sinResaltado(raiz: HTMLElement) {
  for (const marca of raiz.querySelectorAll('mark.ayuda-hit')) marca.replaceWith(marca.textContent!);
  raiz.normalize();
}

/** Envuelve en `<mark>` cada aparición del término (sin distinguir mayúsculas) dentro del texto de `el`. */
function resaltar(el: HTMLElement, termino: string) {
  const re = new RegExp(termino.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const textos: Text[] = [];
  const recorrido = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let nodo = recorrido.nextNode(); nodo; nodo = recorrido.nextNode()) textos.push(nodo as Text);
  for (const texto of textos) {
    const hits = [...texto.data.matchAll(re)];
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let desde = 0;
    for (const hit of hits) {
      frag.append(texto.data.slice(desde, hit.index));
      const marca = document.createElement('mark');
      marca.className = 'ayuda-hit';
      marca.textContent = hit[0];
      frag.append(marca);
      desde = hit.index! + hit[0].length;
    }
    frag.append(texto.data.slice(desde));
    texto.replaceWith(frag);
  }
}
