const CACHE = 'yeye-v5';
self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  const url = new URL(req.url);
  // index.html et racine : toujours réseau (jamais de cache) pour avoir le code à jour
  if(url.pathname === '/' || url.pathname === '/index.html'){
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  // Autres assets : cache en premier, réseau en fallback
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(req, clone));
      return resp;
    }))
  );
});
// ============================================================
// NOTIFICATIONS PUSH (Firebase Cloud Messaging) — app fermée / arrière-plan
// ============================================================
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyB2AhjG3Zw46zO3C_GPaqBHuTVvjJJESe8",
  authDomain: "yeyemarket-a3d09.firebaseapp.com",
  projectId: "yeyemarket-a3d09",
  storageBucket: "yeyemarket-a3d09.firebasestorage.app",
  messagingSenderId: "232655346156",
  appId: "1:232655346156:web:631ba36770df0415c548c9"
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'YéyéMarket';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {},
    vibrate: [200, 100, 200]
  };
  self.registration.showNotification(title, options);
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
