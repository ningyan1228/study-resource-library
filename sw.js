/* Keep HTML navigations fresh. GitHub Pages caches index.html for several minutes;
   this worker deliberately bypasses that document cache after its first install. */
self.addEventListener("message", function (event) {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    await self.clients.claim();
    /* A previous worker could keep an old index.html alive. Reload its windows once
       when this repair activates so the user does not have to discover a cache bug. */
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(windows.map(function (client) { return client.navigate(client.url); }));
  })());
});

async function freshNavigation(request) {
  const response = await fetch(new Request(request, { cache: "reload" }));
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  const source = await response.text();
  const blueLock = '<link rel="stylesheet" href="/room-blue-lock-20260912-v1.css">';
  const html = source.includes("room-blue-lock-20260912-v1.css")
    ? source
    : source.replace("</head>", blueLock + "</head>");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(html, { status: response.status, statusText: response.statusText, headers: headers });
}

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);
  const isLocalThemeAsset = url.origin === self.location.origin &&
    (url.pathname.endsWith("/styles.css") || url.pathname.endsWith("/final-theme.css") || url.pathname.endsWith("/room-blue-lock-20260912-v1.css") || url.pathname.endsWith("/app.js"));
  if (event.request.mode !== "navigate" && !isLocalThemeAsset) return;
  // Never fulfill page/theme requests from an older browser cache.  This is what
  // keeps a newly deployed theme from mixing with a cached legacy stylesheet.
  event.respondWith(event.request.mode === "navigate"
    ? freshNavigation(event.request)
    : fetch(new Request(event.request, { cache: "reload" })));
});
