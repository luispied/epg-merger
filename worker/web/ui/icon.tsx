// Ícono de la app (los trazos de icons.js en window.ICONS).
import { render } from 'preact';
export function Icon({ name, class: cls = '' }: { name: string; class?: string }) {
  return (
    <svg class={`icon ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: window.ICONS[name] || '' }} />
  );
}

/** Cambia cada `<span data-icon="…">` del HTML estático (index.html, ver.html) por su ícono, con las clases del span. */
export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const tmp = document.createElement('div');
    render(<Icon name={el.dataset.icon!} class={el.className} />, tmp);
    el.replaceWith(tmp.firstChild!);
  }
}
