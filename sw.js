/* Service Worker for Offline Mode Serial: #003 */
const CACHE_NAME = 'barbershop-calculator-v3';
// Paths are relative to this script's own URL (always the site root), not origin-absolute --
// origin-absolute paths would resolve to the wrong place under a GitHub Pages project subpath
// (e.g. https://user.github.io/repo/).
const ASSETS = [
  './',
  'help/',
  'analysis/',
  'score/',
  'static/js/main.js',
  'static/js/state.js',
  'static/js/theory.js',
  'static/js/audio.js',
  'static/js/notation.js',
  'static/js/spelling.js',
  'static/js/ui-controls.js',
  'static/js/score.js',
  'static/js/score-store.js',
  'engine/barbershop-engine.js',
  'https://cdn.jsdelivr.net/npm/vexflow@4.2.2/build/cjs/vexflow.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Network First strategy for HTML/JS to ensure UI updates are seen immediately
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // Fallback to cache if offline
  );
});