// Service Worker minimal — Yéyé Market
const CACHE = 'yeye-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Passer toutes les requêtes réseau normalement (pas de cache offline)
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
