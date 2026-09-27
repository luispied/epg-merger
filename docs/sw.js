/* Service worker de la interfaz de corrección. Solo guarda la "cáscara" de la app (HTML, CSS,
   JS, íconos) para que abra rápido y funcione como app instalada. Siempre intenta primero la red
   (network-first): así un cambio publicado en GitHub Pages se ve en la próxima apertura, y la
   copia guardada se usa solo sin conexión. Los datos (API de GitHub, raw.githubusercontent.com)
   no pasan por acá: son de otro origen y siempre van a la red. */
const CACHE = 'epg-ui-v14';
const SHELL = [
  './', './index.html', './app.css', './app.js', './icons.js', './manifest.webmanifest',
  './img/icon.svg', './img/icon-192.png', './img/icon-512.png', './img/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // cache: 'no-cache' revalida contra el servidor en vez de usar la caché HTTP del navegador
  // (GitHub Pages manda max-age=600): sin esto, justo después de publicar podía llegar el
  // index.html nuevo con el app.js viejo, y un botón nuevo quedaba sin hacer nada.
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./index.html'))),
  );
});
