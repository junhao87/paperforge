const CACHE_NAME = 'paperforge-shell-v2-6';
const SHELL = [
  './', './index.html', './styles.css', './upgrade.css', './membership.css',
  './manifest.webmanifest', './assets/paperforge-icon.svg',
  './assets/paperforge-icon-192.png', './assets/paperforge-icon-512.png',
  './assets/paperforge-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('paperforge-shell-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  // Never cache user-provided documents, Supabase sessions, membership data,
  // conversion scripts, or live JS/configuration. Always fetch those freshly.
  if (!SHELL.some((entry) => new URL(entry, self.registration.scope).pathname === url.pathname)) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(async () => (await caches.match(request)) || Response.error()));
});
