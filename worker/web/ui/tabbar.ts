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
  }
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.height = `${on.offsetHeight}px`;
  pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  // Recién cuando tiene tamaño (la barra visible) se habilitan las transiciones.
  if (!nav.classList.contains('placed') && on.offsetWidth > 0) requestAnimationFrame(() => nav.classList.add('placed'));
}
