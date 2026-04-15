const CACHE = "genesis-accounting-v1";
const ASSETS = ["./index.html", "./manifest.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", e => { if (e.request.url.includes("firebase") || e.request.url.includes("gstatic")) return; e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); });
