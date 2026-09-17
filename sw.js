// Kayhost service worker — minimal, skips ALL /api/* routes
// Self-unregisters on next activation to clear stale caches
const CACHE = "kayhost-final";

self.addEventListener("install", (e) => { self.skipWaiting(); });

self.addEventListener("activate", (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
      self.registration.unregister(),
    ])
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // NEVER intercept API calls — let them go straight to the server
  if (url.pathname.startsWith("/api/")) return;

  // NEVER intercept navigations — always fetch fresh
  if (req.mode === "navigate") return;

  // For everything else — just let the browser handle it (no caching)
  // This prevents stale content issues
  return;
});
