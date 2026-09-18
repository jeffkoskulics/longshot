// Cache the app shell so Longshot opens and works with no network at all. The
// app never talks to a server once loaded, so offline is the normal case rather
// than a degraded one.

const CACHE = 'longshot-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/capture.js',
  'js/roi.js',
  'js/register.js',
  'js/docmap.js',
  'js/stitch.js',
  'js/pipeline.js',
  'js/export.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first so a deploy is picked up promptly, falling back to cache when
// offline. The shell is small enough that the extra request costs nothing.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
