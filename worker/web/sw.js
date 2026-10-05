// Service worker de Grilla web: la app abre y se puede editar sin conexión.
// - La app (HTML, JS, CSS, íconos): de la red si hay; si no, la última guardada.
// - Datos para mirar y editar (guía, programación, tu configuración y tu lista): igual,
//   red primero y la copia guardada si no hay conexión.
// - Nunca se guardan los links de reproducción (/p, /s, /l, /g: llevan el token) ni el estado
//   de la guía ni los pedidos que no son GET.
const VERSION = '__VERSION__';
const SHELL = `grilla-shell-${VERSION}`;
const DATA = 'grilla-data-v1';
const SHELL_FILES = ['/', `/app.js?v=${VERSION}`, `/app.css?v=${VERSION}`,
  '/fonts/inter-latin.woff2', `/icons.js?v=${VERSION}`, `/manifest.webmanifest?v=${VERSION}`, '/img/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('grilla-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isData = (path) => path.startsWith('/api/guide/') || path.startsWith('/api/ui/')
  || /^\/api\/cfg\/[A-Za-z0-9_-]+(\/list)?$/.test(path);

async function networkFirst(request, cacheName, key = request) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key, { ignoreSearch: false });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, '/'));
  } else if (isData(url.pathname)) {
    event.respondWith(networkFirst(req, DATA));
  } else if (!url.pathname.startsWith('/api/') && !/^\/(p|s|l|g)\//.test(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || networkFirst(req, SHELL)));
  }
});

// Avisos push (los manda el Worker, ver src/push.ts): siempre se muestra algo; al tocarlo se abre la app.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Grilla', {
    body: data.body || '', icon: '/img/icon-192.png', badge: '/img/icon-192.png', tag: 'grilla', data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) {
        if ('navigate' in c) c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
