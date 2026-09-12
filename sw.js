/* Keep HTML navigations fresh. GitHub Pages caches index.html for several minutes;
   this worker deliberately bypasses that document cache after its first install. */
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);
  const isLocalThemeAsset = url.origin === self.location.origin &&
    (url.pathname.endsWith("/styles.css") || url.pathname.endsWith("/final-theme.css") || url.pathname.endsWith("/app.js"));
  if (event.request.mode !== "navigate" && !isLocalThemeAsset) return;
  // Never fulfill page/theme requests from an older browser cache.  This is what
  // keeps a newly deployed theme from mixing with a cached legacy stylesheet.
  event.respondWith(fetch(new Request(event.request, { cache: "reload" })));
});
