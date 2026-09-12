/* Keep HTML navigations fresh. GitHub Pages caches index.html for several minutes;
   this worker deliberately bypasses that document cache after its first install. */
self.addEventListener("message", function (event) {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
