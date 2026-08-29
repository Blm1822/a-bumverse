// Deliberately does no caching - the catalog changes constantly (funnel +
// background imports), so stale-serving would actively hurt. This exists
// purely to satisfy the "has a fetch handler" requirement browsers use to
// decide whether a site is installable as an app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
