/**
 * Delivery NaMão Entregador — Service Worker
 *
 * - PWA installability (offline shell + iOS add-to-home-screen).
 * - FCM push notifications (iOS 16.4+ quando instalado na tela inicial).
 * - Notification click: foca a janela existente ou abre uma nova.
 *
 * NOTA: FCM ja gerencia o subscription/token via firebase-messaging-sw.js
 * separadamente. Esse SW e o "shell" geral; o FCM tem o seu proprio.
 */

const CACHE = 'namao-driver-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './icons/namao-logo-192.png',
  './icons/namao-logo-256.png',
  './icons/namao-logo-512.png',
  './icons/namao-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => null)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Apenas GET — POSTs (login, etc.) sempre vao pra rede.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Nao cachear chamadas pra Firebase / Firestore / Storage / Functions.
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('cloudfunctions.net') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('unpkg.com')
  ) {
    return;
  }
  // Network-first com fallback pro cache (mais seguro pra entregador).
  event.respondWith(
    fetch(req)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => null);
        return resp;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('./index.html'))),
  );
});

// Notification click — foca a janela existente ou abre uma.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(self.location.origin) && 'focus' in w) return w.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    }),
  );
});
