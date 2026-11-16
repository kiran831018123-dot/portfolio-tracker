// Portfolio Tracker v17.0 PWA Service Worker
const CACHE_NAME = 'portfolio-tracker-v17';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './1-state-render.js',
  './2-parsers.js',
  './3-auth-ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  if (url.includes('api.mfapi.in') || url.includes('npsnav.in') || url.includes('script.google.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
