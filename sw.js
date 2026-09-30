/* Service worker : garde les fichiers de l'appli en cache pour qu'elle
   s'ouvre vite (et même sans réseau). Les données Firebase ne sont jamais
   mises en cache : elles viennent toujours du réseau.
   Pour forcer une mise à jour chez tout le monde, change VERSION. */
const VERSION = 'meteo-v2';
const FICHIERS = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'uplot.min.js',
  'uplot.min.css',
  'icone-192.png',
  'icone-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== VERSION).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Fichiers de l'appli : réseau d'abord (pour avoir la dernière version), cache si hors ligne
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copie = r.clone();
        caches.open(VERSION).then(c => c.put(e.request, copie));
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./')))
  );
});
