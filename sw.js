// Scope the cache to this deployment; other apps may share the same origin.
const CACHE_PREFIX = `agent-team-shell:${self.registration.scope}:`;
const CACHE_NAME = CACHE_PREFIX + 'v2';
const APP_SHELL = ['./', './index.html', './manifest.json'].map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.addAll(APP_SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  // Only public shell assets belong in this cache, never APIs or arbitrary GETs.
  if (event.request.method !== 'GET' || !APP_SHELL.includes(event.request.url)) return;
  const responsePromise = fetch(event.request);
  // Clone before the response body can be consumed by the page.
  event.waitUntil(responsePromise.then(async response => {
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, copy);
    }
  }).catch(() => {}));
  event.respondWith(responsePromise.catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(event.request) ||
      (event.request.mode === 'navigate' && await cache.match(APP_SHELL[1])) || Response.error();
  }));
});
