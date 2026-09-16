// Kayhost service worker — caches static assets for offline use
const CACHE = "kayhost-v1";
const ASSETS = ["/icon-192.png", "/icon-512.png", "/manifest.json", "/qr-lib.js"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("cloudinary.com")) return;
  if (req.mode === "navigate") return;
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => { caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {}); return res; })));
  }
});
