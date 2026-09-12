/* Keep HTML navigations fresh. GitHub Pages caches index.html for several minutes;
   this worker deliberately bypasses that document cache after its first install. */
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(new Request(event.request, { cache: "no-store" })));
});
