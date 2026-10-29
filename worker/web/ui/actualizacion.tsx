// Aviso de versión nueva: cuando el service worker nuevo ya bajó, aparece encima de la barra de abajo con «Actualizar».
// Tocarlo deja que la versión nueva tome la página y la recarga. Sin aviso, la versión nueva se ve al abrir la app.
// Igual que en homeschool records: el service worker no se activa solo (sin skipWaiting), así la persona decide cuándo.
import { render } from 'preact';

function Aviso({ onUpdate }: { onUpdate: () => void }) {
  return (
    <div class="update-pill" role="status">
      <span class="msg">Hay una versión nueva</span>
      <button type="button" class="btn btn-primary" onClick={onUpdate}>Actualizar</button>
    </div>
  );
}

/** Registra el service worker y, si ya hay una versión nueva esperando, muestra el aviso. */
export function setupActualizacion() {
  if (!('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  // La primera instalación no tiene versión abierta: no hay que recargar entonces.
  const hadController = Boolean(container.controller);
  let reloading = false;
  let registration: ServiceWorkerRegistration | undefined;
  let host: HTMLElement | null = null;

  const show = (worker: ServiceWorker) => {
    if (!host) {
      host = document.createElement('div');
      host.id = 'updateHost';
      document.body.appendChild(host);
    }
    render(<Aviso onUpdate={() => worker.postMessage({ type: 'SKIP_WAITING' })} />, host);
  };

  container.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration?.update().catch(() => {});
  });

  window.addEventListener('load', () => container.register('/sw.js').then((reg) => {
    registration = reg;
    if (reg.waiting && hadController) show(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && container.controller) show(worker);
      });
    });
  }).catch(() => { /* sin SW: anda igual */ }));
}
