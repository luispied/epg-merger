// Píldora de selección de la barra de abajo: un solo elemento que se desliza hasta la pestaña activa. Es el mismo en la
// edición y en el modo ver. Se mide con offset*, así que sirve tanto en la cápsula del celular como en la barra lateral
// del escritorio ancho.
export function placeTabPill(nav: HTMLElement) {
  const pill = nav.querySelector<HTMLElement>('.tab-pill');
  const on = nav.querySelector<HTMLElement>('.tab.active');
  if (!pill || !on) return;
  if (!nav.dataset.pill) {
    nav.dataset.pill = '1';
    // Al girar el celular, pasar al escritorio ancho o mostrar la barra, se vuelve a medir.
    new ResizeObserver(() => placeTabPill(nav)).observe(nav);
    initTabDrag(nav, pill);
  }
  // Mientras se arrastra, la píldora la mueve el dedo (initTabDrag).
  if (nav.classList.contains('dragging')) return;
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.height = `${on.offsetHeight}px`;
  pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  // Recién cuando tiene tamaño (la barra visible) se habilitan las transiciones.
  if (!nav.classList.contains('placed') && on.offsetWidth > 0) requestAnimationFrame(() => nav.classList.add('placed'));
}

/** Un movimiento de este tamaño es un arrastre y no un toque. */
const DRAG_THRESHOLD = 6;

/**
 * Arrastrar a lo largo de la barra (celular): la píldora sigue el dedo, se agranda y se afina; al soltar, se va a la
 * pestaña más cercana con el mismo resorte que al tocar. En el escritorio ancho la barra es vertical, así que no aplica.
 */
function initTabDrag(nav: HTMLElement, pill: HTMLElement) {
  const tabs = [...nav.querySelectorAll<HTMLElement>('.tab')];
  if (tabs.length === 0) return;
  const wide = () => matchMedia('(min-width: 1100px) and (hover: hover)').matches;
  let drag: { id: number; x: number; y: number; on: boolean; pos: number } | null = null;
  let suppressClick = false;

  // Posición a lo largo de la barra como índice de pestaña: 0 la primera, tabs.length - 1 la última, con fracciones.
  function positionAt(clientX: number) {
    const w = tabs[0]!.offsetWidth;
    const x = clientX - nav.getBoundingClientRect().left - tabs[0]!.offsetLeft - w / 2;
    return Math.min(tabs.length - 1, Math.max(0, x / w));
  }

  function setPill(pos: number, scale: number) {
    const w = tabs[0]!.offsetWidth;
    pill.style.width = `${w}px`;
    pill.style.transform = `translate(${tabs[0]!.offsetLeft + pos * w}px, ${tabs[0]!.offsetTop}px) scale(${scale})`;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (wide()) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, pos: 0 };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.on) {
      const dx = Math.abs(e.clientX - d.x);
      const dy = Math.abs(e.clientY - d.y);
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
      // Un movimiento sobre todo vertical es un desplazamiento de la página: se deja pasar.
      if (dy > dx) return endDrag(false);
      d.on = true;
      suppressClick = true;
      nav.classList.add('dragging');
    }
    d.pos = positionAt(e.clientX);
    setPill(d.pos, 1.14);
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    endDrag(drag.on);
  }

  // Suelta el arrastre. Si hubo arrastre, la píldora cae en la pestaña más cercana y la app va a ahí.
  function endDrag(moved: boolean) {
    const d = drag;
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (!d || !d.on || !moved) {
      suppressClick = false;
      return;
    }
    nav.classList.remove('dragging');
    const snap = Math.round(d.pos);
    setPill(snap, 1);
    // El clic que cierra el arrastre no debe seguir también el botón que quedó debajo del dedo.
    setTimeout(() => { suppressClick = false; }, 0);
    const on = tabs.findIndex((t) => t.classList.contains('active'));
    if (snap !== on) tabs[snap]!.click();
  }

  nav.addEventListener('pointerdown', onPointerDown);
  nav.addEventListener('click', (e) => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
