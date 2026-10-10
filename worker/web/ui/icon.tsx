// Ícono de la app (los trazos de icons.js en window.ICONS), igual al icon() de app.ts.
export function Icon({ name, class: cls = '' }: { name: string; class?: string }) {
  return (
    <svg class={`icon ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: window.ICONS[name] || '' }} />
  );
}
