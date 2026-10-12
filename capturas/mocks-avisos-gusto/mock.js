// Íconos y tema del mock: cambia cada <span data-icon> por su SVG (los de icons.js y los extra de app.ts) y toma el tema
// de ?tema=claro|oscuro (sin parámetro, el del sistema).
const t = new URLSearchParams(location.search).get('tema');
if (t) document.documentElement.dataset.theme = t === 'oscuro' ? 'dark' : 'light';
const ICONS = { ...window.ICONS, ...window.ICONS_EXTRA };
for (const el of document.querySelectorAll('[data-icon]')) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', `icon ${el.className}`.trim());
  s.setAttribute('viewBox', '0 0 24 24');
  for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  s.innerHTML = ICONS[el.dataset.icon] || '';
  el.replaceWith(s);
}
