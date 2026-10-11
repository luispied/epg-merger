/** La pantalla de inicio (#splash en index.html y ver.html): el logo mientras abre la app. Se saca cuando la app ya
 *  dibujó su primera pantalla, con un fundido. Si la app estuvo lista muy rápido, espera a que la página lleve MIN_MS
 *  abierta, para que el logo no sea un parpadeo; la app ya está debajo y se puede tocar. */
const MIN_MS = 450;
const FADE_MS = 320; // un poco más que --dur-3, lo que dura el fundido

let hiding = false;

export function hideSplash() {
  const el = document.getElementById('splash');
  if (!el || hiding) return;
  hiding = true;
  if (document.documentElement.classList.contains('no-splash')) { el.remove(); return; }
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), FADE_MS);
  }, Math.max(0, MIN_MS - performance.now()));
}
